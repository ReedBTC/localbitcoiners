#!/usr/bin/env python3
"""Boost-note formatting + Local Bitcoiners transaction classification.

`classify_lb_tx(tx, cache)` is the single entry point all four LB bots
(boost-publisher, top-boosts, boost-leaders, episodesats) use to recognize
and normalize an Alby Hub transaction. It dispatches to one of five sources:

  - fountain_boost   Fountain BOLT11 boost   (description: rss::payment::boost ...)
  - fountain_stream  Fountain BOLT11 stream  (description: rss::payment::stream ...)
  - keysend          Podcast 2.0 keysend     (boostagram.action == "boost")
  - website          localbitcoiners.com     (description: LocalBitcoinersEpNNN)
  - lb_donation      localbitcoiners.com     (general V4V 2.0 donation, no episode tie)

Each call returns a normalized BoostInfo dict (see `classify_lb_tx` docstring
for the full shape) so downstream bots can aggregate without re-doing source
detection. `build_note_from_tx` is preserved as a thin wrapper for the boost
publisher and top-boosts regen path."""

import json
import re
import sys
import time
import requests
import websocket
from datetime import datetime
from pathlib import Path

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))
from nostr_utils import hex_to_npub, scrape_fountain_episode

PUBLISHED_EVENTS_FILE = _BOTS_ROOT / "boost-publisher/published_events.json"

# Separate paymentHash → event_id index for lb_donations published by the
# `local_bitcoiners_donations` bot. Kept distinct from PUBLISHED_EVENTS_FILE
# so the donations bot and boost-publisher (both running every 10min) aren't
# concurrent writers on the same file. Top-boosts reads both files when
# resolving event_ids for its reply chain.
DONATION_EVENTS_FILE = _BOTS_ROOT / "localbitcoiners-publisher/donation_events.json"

# Alby Hub appIds that route to the LB donations lightning address
# (localbitcoiners@getalby.com — appId 28). Any settled tx on these apps
# with `descriptionHash` set, that doesn't match an earlier classifier
# source (LocalBitcoinersEpNNN, rss::payment::*, keysend), is treated as a
# candidate lb_donation and confirmed via kind 30078 lookup. Deployment-
# specific — change here if the LB Alby Hub gets a new wallet connection.
LB_DONATION_APP_IDS = {28}

# Shared map of zero-padded episode_number → Fountain page id (the id used
# in fountain.fm/episode/{id} URLs). Populated organically whenever any LB bot
# processes a Fountain-derived boost tx (BOLT11 boost, BOLT11 stream, or
# keysend with a Fountain boostLink). Read by `_classify_website` as a fallback
# when the RSS feed doesn't yet expose <podcast:contentLink> for the episode —
# Fountain backfills that tag a few days after publish, but website boosts can
# arrive before that, so the map gives us a path to the right Fountain URL
# even on a fresh episode (provided at least one Fountain-source boost has
# already been seen for it). Last-writer-wins across concurrent bot runs;
# losing an entry to a race just means the next run re-adds it.
EPISODE_ID_MAP_FILE = _BOTS_ROOT / "shared/lb_episode_ids.json"

# Fixed relay set defined by the V4V 2.0 spec (see v4v-2.0-spec-update.md at
# the repo root, "Relay Set"). Donation publishers write kind-30078 events
# here; recipient bots query here. Keep in lockstep with the spec — changes
# affect every V4V 2.0 bot.
V4V_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://purplepag.es",
]

# Localbitcoiners.com website boosts arrive as BOLT11 with this exact LNURL
# comment in the description. Episode-tied boosts use `LocalBitcoinersEpNNN`
# (3-digit episode number, captured); show-level boosts use the literal
# `LocalBitcoinersShow`. The kind 30078 attached carries the rich metadata
# (sender, message, item_guid for episodes; show name for show-level). See
# `_classify_website` for the lookup flow.
LB_WEBSITE_RE = re.compile(r"^LocalBitcoiners(?:Ep(\d{3})|Show)$")

# Show-level website boosts route through the website's own 33/33/34 split
# (not the RSS zap split). LB's leg is the 33% to reed@getalby.com — the
# kind 30078's `amount` tag is that leg's pre-fee msats, and we divide by
# this divisor to recover the donor's full intended amount for display.
# Independent from `get_divisor()` (which tracks RSS-zap-split history) so
# that future RSS-divisor changes don't accidentally shift website show
# boost displays.
WEBSITE_SHOW_DIVISOR = 0.33

# LB show identity used for show-level website boosts. The id matches the
# Fountain show URL used elsewhere in the bots; mirrored here so show-level
# website boosts render with the same 🎙️/🔗 lines as show-level Fountain
# boosts.
LB_SHOW_ID    = "Q48WBr6nT3mrbwMZ8ydY"
LB_SHOW_TITLE = "Local Bitcoiners"
LB_SHOW_URL   = f"https://fountain.fm/show/{LB_SHOW_ID}"

# Production gate for the website-boost path. While True, every bot that
# detects a `source=website` BoostInfo routes its publish through write_dry_run_event
# regardless of the bot's own DRY_RUN setting. Flip to False only after eyeballing
# a real test boost's dry-run JSON and confirming the format. Other sources
# (Fountain BOLT11, keysend) are unaffected.
WEBSITE_DRY_RUN = False

def load_published_events():
    if PUBLISHED_EVENTS_FILE.exists():
        return json.loads(PUBLISHED_EVENTS_FILE.read_text())
    return {}

def save_published_events(events):
    PUBLISHED_EVENTS_FILE.write_text(json.dumps(events, indent=2))

def load_donation_events():
    if DONATION_EVENTS_FILE.exists():
        return json.loads(DONATION_EVENTS_FILE.read_text())
    return {}

def save_donation_events(events):
    DONATION_EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    DONATION_EVENTS_FILE.write_text(json.dumps(events, indent=2))

def load_episode_id_map():
    if EPISODE_ID_MAP_FILE.exists():
        try:
            return json.loads(EPISODE_ID_MAP_FILE.read_text())
        except Exception:
            return {}
    return {}

def save_episode_id_map(m):
    EPISODE_ID_MAP_FILE.write_text(json.dumps(m, indent=2, sort_keys=True))

def record_published_event(events, payment_hash, event_id, settled_at):
    """Record the standalone boost-note event id so downstream bots (e.g.
    topboosts) can reference historical boosts as nostr:nevent embeds without
    having to republish the note."""
    if not payment_hash or not event_id:
        return
    events[payment_hash] = {
        "event_id":     event_id,
        "settled_at":   settled_at,
        "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

FOUNTAIN_VIEWER = "c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592"
RSS_FEED        = "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU"
SPLIT_CUTOFF_V2 = "2026-03-29T13:10:00Z"   # 98% → 49%
SPLIT_CUTOFF_V3 = "2026-04-20T20:23:25Z"   # 49% → 33%
DIVISOR_V1      = 0.98
DIVISOR_V2      = 0.49
DIVISOR_V3      = 0.33

def get_divisor(settled_at):
    if settled_at >= SPLIT_CUTOFF_V3:
        return DIVISOR_V3
    if settled_at >= SPLIT_CUTOFF_V2:
        return DIVISOR_V2
    return DIVISOR_V1

# Match @npub1.../npub1.../@nevent1.../nevent1.../@naddr1.../naddr1... and
# rewrite to the canonical nostr: URI so Nostr clients render as mentions.
# Bech32 charset is 0-9 + a-z minus b, i, o (1 is the separator).
# Lookbehinds: skip entities already prefixed with nostr:, and skip matches
# glued to a preceding word char (e.g. the "npub" inside a longer word).
NOSTR_MENTION_RE = re.compile(
    r'(?<!nostr:)(?<!\w)@?(n(?:pub|event|addr)1[02-9ac-hj-np-z]+)'
)

# Some upstream clients (notably some Nostr-driven Fountain wrappers) construct
# the BOLT11 description like `rss::payment::boost {url} ${comment}` where the
# comment is the JavaScript primitive `undefined`. Template-string coercion turns
# that into the literal nine-character word "undefined", which lands in Alby Hub's
# description field and ends up as the boost's "message" after parsing. When we
# detect that pattern, we render this placeholder (italic in markdown-aware Nostr
# clients) instead of the bogus literal text or a missing 💬 line.
NO_COMMENT_PLACEHOLDER = "*no comment with boost*"

def nostrify_mentions(text):
    if not text:
        return text
    return NOSTR_MENTION_RE.sub(r'nostr:\1', text)

def parse_description(description):
    pattern = r"^rss::payment::(\w+)\s+(https://[^\s?]+)(?:\?payment=\S+)?\s*(.*)?$"
    match   = re.match(pattern, description.strip(), re.DOTALL)
    if not match:
        return None
    return {
        "action":      match.group(1),
        "episode_url": match.group(2),
        "episode_id":  match.group(2).rstrip("/").split("/")[-1],
        "message":     match.group(3).strip() if match.group(3) else "",
    }

def get_episode_url_from_rss(ep_title):
    """Title-based RSS lookup used as a fallback for keysend boosts that come
    in with an episode title but no URL. Linear scan, no caching — keysend
    boosts are infrequent enough that this isn't hot.

    Pulls the user-facing Fountain URL from `<podcast:contentLink href="...">`,
    which carries the page-id used at fountain.fm/episode/{id}. The enclosure
    URL pattern (items/{id}/files/...mp3) carries an unrelated audio-file id
    and was a previous source of broken links."""
    try:
        rss = requests.get(RSS_FEED, timeout=10).text
        for item in re.findall(r'<item>(.*?)</item>', rss, re.DOTALL):
            t = re.search(r'<title>(.*?)</title>', item)
            c = re.search(r'<podcast:contentLink[^>]*href="(https://fountain\.fm/episode/[^"]+)"', item)
            if t and c:
                rss_title = (t.group(1).replace("&amp;", "&").replace("&lt;", "<")
                              .replace("&gt;", ">").replace("&quot;", '"'))
                if ep_title in rss_title or rss_title in ep_title:
                    return c.group(1)
    except Exception as e:
        print(f"  [warn] RSS episode URL lookup failed: {e}")
    return None

# ─────────────────────────────────────────────────────────────────────────────
# Classifier
# ─────────────────────────────────────────────────────────────────────────────

def make_cache():
    """Per-run cache for classify_lb_tx. Bots that paginate large transaction
    sets (boost-leaders, top-boosts, weekly-recap) should create one cache at
    the start of the run and pass it to every classify_lb_tx call to amortize
    the Fountain comments / RSS / kind 30078 lookups across the run.

    `episode_id_map` is loaded lazily on first need (so a bot run that never
    classifies a relevant tx pays nothing for it). After the run, callers
    invoke `persist_cache(cache)` to write back any newly-discovered
    episode_number→fountain_id pairs."""
    return {
        "fountain_comments":     {},    # episode_id  -> list of Fountain comment dicts
        "guid_to_fountain":      None,  # item_guid   -> {fountain_id, guests} (RSS index, lazy)
        "kind_30078":            {},    # payment_hash -> kind 30078 event dict (or None)
        "title_cache":           {},    # episode_id  -> (title, guests) for Fountain pages
        "episode_id_map":        None,  # zero-padded ep number -> fountain_id (lazy disk-backed)
        "episode_id_map_dirty":  False,
        "castamatic_boosts":     {},    # boost url -> Castamatic JSON metadata
    }

def _ensure_episode_id_map(cache):
    """Lazy-load the shared episode_id map into the cache on first use."""
    if cache["episode_id_map"] is None:
        cache["episode_id_map"] = load_episode_id_map()
    return cache["episode_id_map"]

def _record_episode_id(cache, episode_number, fountain_id):
    """Capture an (episode_number → fountain_id) pair on the cache for later
    persistence. No-op when either field is missing or the existing mapping
    already matches."""
    if not episode_number or not fountain_id:
        return
    m = _ensure_episode_id_map(cache)
    if m.get(episode_number) != fountain_id:
        m[episode_number] = fountain_id
        cache["episode_id_map_dirty"] = True

def persist_cache(cache):
    """End-of-run hook for bots: write back anything in the cache that should
    survive across runs. Today: the episode_id_map (when modified). Safe to
    call even if nothing was modified — it's a no-op."""
    if cache.get("episode_id_map_dirty") and cache.get("episode_id_map") is not None:
        EPISODE_ID_MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
        save_episode_id_map(cache["episode_id_map"])
        cache["episode_id_map_dirty"] = False

def is_dry_run(bot_dry_run, source):
    """Effective dry-run flag for a single tx in a bot. True if either the bot
    is in DRY_RUN, or this is a `source=website` boost during the WEBSITE_DRY_RUN
    rollout window. Bots branch their publish/dry-run-event call on this."""
    if bot_dry_run:
        return True
    if source == "website" and WEBSITE_DRY_RUN:
        return True
    return False

def fetch_kind_30078(payment_hash, relays=None, cache=None):
    """Query the V4V relay set for the kind 30078 boostagram event whose `d`
    tag matches payment_hash. Returns the event dict or None. When `cache` is
    passed, hits and misses are cached by payment_hash."""
    if cache is not None and payment_hash in cache["kind_30078"]:
        return cache["kind_30078"][payment_hash]
    if relays is None:
        relays = V4V_RELAYS
    filter_ = {"kinds": [30078], "#d": [payment_hash]}
    event   = None
    for relay in relays:
        try:
            ws = websocket.create_connection(relay, timeout=10)
            ws.send(json.dumps(["REQ", "boost", filter_]))
            while True:
                msg = json.loads(ws.recv())
                if msg[0] == "EVENT":
                    event = msg[2]
                    ws.close()
                    break
                elif msg[0] == "EOSE":
                    ws.close()
                    break
            if event:
                break
        except Exception as e:
            print(f"  [warn] relay query failed {relay}: {e}")
    if cache is not None:
        cache["kind_30078"][payment_hash] = event
    return event

def fetch_fountain_comments(episode_id, cache):
    """Cached Fountain comments fetch."""
    fc = cache["fountain_comments"]
    if episode_id in fc:
        return fc[episode_id]
    try:
        resp = requests.post(
            "https://relay.fountain.fm/api/load-content-comments",
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            json={"entity": {"type": "EPISODE", "_id": episode_id}, "viewer": FOUNTAIN_VIEWER},
            timeout=15,
        )
        resp.raise_for_status()
        fc[episode_id] = resp.json().get("feed", []) or []
    except Exception as e:
        print(f"  [warn] Fountain API failed for {episode_id}: {e}")
        fc[episode_id] = []
    return fc[episode_id]

def lookup_fountain_sender(episode_id, settled_at, truncated_message, cache):
    """Match a Fountain BOLT11 boost to its (sender_npub, full_message).

    Primary: timestamp match within ±10 seconds. Fountain and Alby timestamps
    are consistently 2–9 seconds apart, so exact-second matching never works;
    we pick the closest match within the window. If the match has no pubkey,
    the sender is treated as anonymous.

    Fallback: message substring match if no comment falls within ±10s. This
    covers cases where the timestamp gap is larger but the message is long
    enough to be unique.

    Returns (npub_or_None, full_message_str)."""
    if not episode_id:
        return None, ""
    comments = fetch_fountain_comments(episode_id, cache)
    if not comments:
        return None, ""

    try:
        settled_dt = datetime.fromisoformat(settled_at.replace("Z", "+00:00"))
    except Exception:
        settled_dt = None

    best, best_delta = None, float("inf")
    if settled_dt is not None:
        for item in comments:
            ts_str = (item.get("action") or {}).get("timestamp", "")
            if not ts_str:
                continue
            try:
                ts_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                delta = abs((ts_dt - settled_dt).total_seconds())
                if delta <= 10 and delta < best_delta:
                    best, best_delta = item, delta
            except Exception:
                continue

    if best is not None:
        action = best.get("action", {})
        pubkey = action.get("pubkey")
        npub   = hex_to_npub(pubkey) if pubkey else None
        return npub, (action.get("message", "") or "")

    if truncated_message:
        for item in comments:
            action = item.get("action", {})
            fmsg   = action.get("message", "") or ""
            if truncated_message in fmsg:
                pubkey = action.get("pubkey")
                npub   = hex_to_npub(pubkey) if pubkey else None
                return npub, fmsg
    return None, ""

def build_rss_item_index(cache):
    """Parse the LB RSS feed once per run and return a dict keyed by the
    item's <guid>. Each value is a dict with:

      fountain_id  str | None  Fountain page id from <podcast:contentLink href=
                               "https://fountain.fm/episode/{id}">. None when
                               Fountain hasn't yet backfilled the contentLink
                               for a freshly-published episode (the audio-file
                               id from the enclosure URL is a different id and
                               cannot substitute here — using it produces
                               broken fountain.fm/episode/{id} links).
      guests       list[str]   npub1... values from the [guests: ...] marker
                               LB embeds in the episode description. Empty
                               list when the marker is absent or empty.

    Cached on the per-run cache dict so the RSS parse only runs once. Used by
    `_classify_website` to (a) link website boosts to the right Fountain page
    and (b) merge their per-episode aggregation buckets with Fountain BOLT11
    boosts on the same episode, plus to populate guest npubs in the boost
    note's 🎙️ line so guest zap splits get included automatically."""
    if cache["guid_to_fountain"] is not None:
        return cache["guid_to_fountain"]
    index = {}
    try:
        rss = requests.get(RSS_FEED, timeout=10).text
        for item_xml in re.findall(r'<item>(.*?)</item>', rss, re.DOTALL):
            g = re.search(r'<guid[^>]*>([^<]+)</guid>', item_xml)
            if not g:
                continue
            guid = g.group(1).strip()
            c = re.search(r'<podcast:contentLink[^>]*href="(?:https://fountain\.fm/episode/)([^"]+)"', item_xml)
            fountain_id = c.group(1) if c else None
            # The [guests:] marker lives inside the HTML-encoded RSS description,
            # same convention scrape_fountain_episode reads off the Fountain page.
            # Match against the raw item XML — works whether the marker is
            # encoded as &lt;p&gt;[guests:...]&lt;/p&gt; or plain bracketed text.
            gm = re.search(r'\[guests:\s*([^\]]*)\]', item_xml)
            guests = []
            if gm and gm.group(1).strip():
                guests = [n.strip() for n in gm.group(1).split(",") if n.strip()]
            index[guid] = {"fountain_id": fountain_id, "guests": guests}
    except Exception as e:
        print(f"  [warn] RSS item index build failed: {e}")
    cache["guid_to_fountain"] = index
    return index

def _extract_episode_number(title):
    """Pull a zero-padded episode number from an LB title string. None if absent.
    Matches the convention used by episodesats / topboosts."""
    if not title:
        return None
    if title.startswith("001."):
        return "001"
    m = re.search(r'Ep\.\s*(\d+)', title)
    if m:
        return m.group(1).zfill(3)
    return None

def classify_lb_tx(tx, cache=None):
    """Examine an Alby Hub transaction and return a normalized BoostInfo dict
    if it's a Local Bitcoiners boost or stream payment, or None otherwise.

    Source dispatch (mutually exclusive — order matters because the website
    regex is exact-match and won't collide with rss::payment:: descriptions,
    and keysend is the last fallback):

      1. description matches `^LocalBitcoinersEp(\\d{3})$` → website
      2. description starts with "rss::payment::boost"   → fountain_boost
      3. description starts with "rss::payment::stream"  → fountain_stream
      4. boostagram.action == "boost"                    → keysend

    BoostInfo dict fields:
      source         "fountain_boost" | "fountain_stream" | "keysend" | "website"
      payment_hash   str (paymentHash, "" if missing)
      settled_at     str (ISO timestamp from tx.settledAt)
      our_msats      int (amount this node received, raw from tx.amount)
      total_msats    int (full intended boost — our_msats / divisor for split-routed sources)
      our_sats       int (rounded our_msats / 1000)
      total_sats     int (rounded total_msats / 1000)
      divisor        float (split divisor used; 1.0 for keysend)
      sender_npub    str | None (None for anonymous)
      sender_name    str | None (keysend only — display name when no npub is known)
      message        str (boost message, may be empty)
      episode_id     str | None (canonical Fountain episode id for cross-source merging)
      episode_title  str | None
      episode_url    str | None
      episode_number str | None (zero-padded "008" or None)
      guests         list[str] (Fountain only; npubs scraped from episode page)
      app_name       str (display label: "Fountain", "localbitcoiners.com", or keysend app name)
      boostagram     dict | None (raw keysend boostagram, only for source=keysend)
      show_level     bool (True only for show-level fountain_stream payments)
      raw_tx         dict (the original Alby Hub tx, for callers that need fields the BoostInfo doesn't expose)

    `cache` is an optional dict produced by `make_cache()`. Passing one across
    many classify_lb_tx calls reuses Fountain comments / RSS / kind 30078
    lookups; without it each call builds a fresh single-use cache."""
    if cache is None:
        cache = make_cache()
    if tx.get("type") != "incoming" or tx.get("state") != "settled":
        return None

    desc         = tx.get("description", "") or ""
    boostagram   = tx.get("boostagram") or {}
    payment_hash = tx.get("paymentHash", "") or ""
    settled_at   = tx.get("settledAt", "") or ""
    our_msats    = int(tx.get("amount", 0) or 0)

    m = LB_WEBSITE_RE.match(desc.strip())
    if m:
        return _classify_website(tx, m.group(1), payment_hash, settled_at, our_msats, cache)

    if desc.startswith("rss::payment::boost"):
        return _classify_fountain_boost(tx, desc, payment_hash, settled_at, our_msats, cache)

    if desc.startswith("rss::payment::stream"):
        return _classify_fountain_stream(tx, desc, payment_hash, settled_at, our_msats, cache)

    if boostagram.get("action") == "boost":
        return _classify_keysend(tx, boostagram, payment_hash, settled_at, our_msats, cache)

    # General LB donations: V4V 2.0 boosts to localbitcoiners@getalby.com that
    # don't carry an episode tag (LocalBitcoinersEp NNN). Confirmed by the
    # presence of a kind 30078 keyed on paymentHash. Vanilla LN-address tips
    # without a kind 30078 fall through to None just like any other unmatched
    # tx. Last-resort dispatch — earlier branches handle episode-tied boosts.
    if tx.get("appId") in LB_DONATION_APP_IDS and tx.get("descriptionHash"):
        return _classify_lb_donation(tx, payment_hash, settled_at, our_msats, cache)

    return None

def _new_info(source, payment_hash, settled_at, our_msats, total_msats, divisor):
    """Build a BoostInfo with the per-source overlay fields zeroed out. Each
    source-specific classifier overlays the fields it knows about."""
    return {
        "source":         source,
        "payment_hash":   payment_hash,
        "settled_at":     settled_at,
        "our_msats":      our_msats,
        "total_msats":    total_msats,
        "our_sats":       round(our_msats / 1000),
        "total_sats":     round(total_msats / 1000),
        "divisor":        divisor,
        "sender_npub":    None,
        "sender_name":    None,
        "message":        "",
        "episode_id":     None,
        "episode_title":  None,
        "episode_url":    None,
        "episode_number": None,
        "guests":         [],
        "app_name":       "",
        "boostagram":     None,
        "show_level":     False,
        "raw_tx":         None,
    }

def _classify_website(tx, ep_num_padded, payment_hash, settled_at, our_msats, cache):
    """Localbitcoiners.com website boost. Pulls the kind 30078 by payment_hash
    and reads sender / message / episode metadata from its tags.

    Two flavors, dispatched by whether `ep_num_padded` is set:
    - **Episode-tied** (`ep_num_padded` is a "NNN" string from the website
      regex): uses the RSS-zap-split divisor (same path as Fountain BOLT11
      boosts arriving via the show's RSS feed). Looks up the Fountain page
      via item_guid → contentLink → fallback chain.
    - **Show-level** (`ep_num_padded is None`): the website applies its own
      33/33/34 split independent of the RSS feed; LB's 33% leg is the only
      one that lands here. Uses `WEBSITE_SHOW_DIVISOR` to back-calculate
      the donor's full intent. Sets `show_level=True` so episodesats routes
      to SHOW_BUCKET and boost-leaders skips, matching show-level Fountain
      boost handling. Top-boosts treats it like any other entry."""
    event = fetch_kind_30078(payment_hash, cache=cache)
    if not event:
        # Without the 30078 we'd be publishing a note with no sender / no episode
        # / no message — better to skip and let it surface in logs than emit a
        # malformed note. The bot's last_seen will still advance, so a missed
        # website boost stays missed; flag a clear warning.
        print(f"  [warn] website boost {payment_hash[:12]}... — no kind 30078 found on V4V relays, skipping")
        return None

    tags = {t[0]: t[1] for t in event.get("tags", []) if len(t) >= 2}

    # The 30078's signing pubkey is a per-session burner per the spec — donor
    # identity lives only in the `sender` tag. Empty sender = anonymous.
    sender = tags.get("sender", "") or ""
    sender_npub = sender if sender else None

    # Common: parse the leg's pre-fee msats from the 30078's `amount` tag.
    # Used by both branches; only the divisor differs.
    try:
        leg_msats = int(tags.get("amount", 0)) or our_msats
    except Exception:
        leg_msats = our_msats
    if leg_msats <= 0:
        leg_msats = our_msats

    # ── Show-level branch ──
    if ep_num_padded is None:
        divisor     = WEBSITE_SHOW_DIVISOR
        total_msats = round(leg_msats / divisor) if divisor else leg_msats

        info = _new_info("website", payment_hash, settled_at, our_msats, total_msats, divisor)
        info.update({
            "sender_npub":   sender_npub,
            "message":       event.get("content", "") or "",
            "episode_id":    LB_SHOW_ID,
            "episode_title": LB_SHOW_TITLE,
            "episode_url":   LB_SHOW_URL,
            "guests":        [],
            "app_name":      "localbitcoiners.com",
            "show_level":    True,
            "raw_tx":        tx,
        })
        return info

    # ── Episode-tied branch (existing behavior) ──
    item_guid = tags.get("item_guid", "")
    episode_title = tags.get("episode_title")

    # Look up the RSS item by guid for (a) Fountain page URL and (b) guests.
    # Without the contentLink we'd be guessing the Fountain id; better to
    # publish the note with no 🔗 line than a broken link. Guests still come
    # through whenever the [guests: ...] marker is present, even if Fountain
    # hasn't yet backfilled the contentLink.
    rss_index   = build_rss_item_index(cache)
    rss_entry   = rss_index.get(item_guid) or {}
    fountain_id = rss_entry.get("fountain_id")
    guests      = rss_entry.get("guests", [])
    if not fountain_id:
        # Fallback: shared episode_number → fountain_id map populated by every
        # other LB bot whenever it processes a Fountain-derived boost.
        # Covers the case where Fountain hasn't yet exposed contentLink in the
        # RSS feed but at least one Fountain BOLT11/keysend boost on the same
        # episode has been seen by the bots before.
        fallback_map = _ensure_episode_id_map(cache)
        fountain_id  = fallback_map.get(ep_num_padded)
        if fountain_id:
            print(f"  [info] website boost {payment_hash[:12]}... — using episode_id_map fallback for Ep {ep_num_padded} → {fountain_id}")
    if fountain_id:
        episode_url = f"https://fountain.fm/episode/{fountain_id}"
        episode_id  = fountain_id
    else:
        if item_guid and item_guid not in rss_index:
            print(f"  [warn] website boost {payment_hash[:12]}... — item_guid {item_guid!r} not in RSS feed and no episode_id_map fallback; using synthetic ep key, omitting 🔗")
        else:
            print(f"  [info] website boost {payment_hash[:12]}... — RSS has guid but no <podcast:contentLink> yet and no episode_id_map fallback; omitting 🔗 line")
        episode_url = None
        episode_id  = f"lb_website_{ep_num_padded}"

    # leg_msats was parsed above (common to both branches). For episode-tied
    # boosts, the divisor follows the show's RSS-zap-split history: the
    # 30078 amount tag is more accurate than tx.amount (which has LN routing
    # fees baked out, ~0.5% short).
    divisor     = get_divisor(settled_at)
    total_msats = round(leg_msats / divisor) if divisor else leg_msats

    info = _new_info("website", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    sender_npub,
        "message":        event.get("content", "") or "",
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": ep_num_padded,
        "guests":         guests,
        "app_name":       "localbitcoiners.com",
        "raw_tx":         tx,
    })
    return info

def _classify_fountain_boost(tx, desc, payment_hash, settled_at, our_msats, cache):
    """Podcasting 2.0 BOLT11 boost (the `rss::payment::boost` LNURL-comment
    convention). Despite the function name, this is the dispatch entry for
    BOLT11 boosts from any podcasting app — Fountain, Castamatic, etc. —
    that follow the same description format. Branches by URL host to pick
    the right metadata-extraction strategy:

    - **Fountain** (`fountain.fm/episode/...` or `fountain.fm/show/...`):
      look up sender + full message via the Fountain comments API. Show-
      level URLs (`/show/`) get `show_level=True`.
    - **Castamatic** (`castamatic.com/boost/<uuid>`): fetch the URL itself
      (returns JSON boost metadata) and read sender_name + episode +
      donor's full intent directly. See `_classify_castamatic_boost`.
    - **Other / unknown hosts**: existing Fountain-style flow runs and
      typically yields a sparse boost (no sender, no message) since the
      Fountain-specific lookups silently fail.

    The `source` field stays `"fountain_boost"` for all variants — they're
    the same kind of payment from a downstream-aggregation standpoint;
    `app_name` distinguishes the actual app."""
    parsed = parse_description(desc)
    show_level = False
    if parsed:
        episode_url = parsed.get("episode_url")
        episode_id  = parsed.get("episode_id")

        # Castamatic dispatch — its URL is a public boost-metadata endpoint.
        if episode_url and "castamatic.com" in episode_url:
            return _classify_castamatic_boost(tx, parsed, payment_hash, settled_at, our_msats, cache)

        show_level  = "/show/" in (episode_url or "")
        title_pair  = cache["title_cache"].get(episode_id) if episode_id else None
        if title_pair is None and episode_url:
            title_pair = scrape_fountain_episode(episode_url)
            if episode_id:
                cache["title_cache"][episode_id] = title_pair
        episode_title, guests = title_pair or (None, [])

        message      = parsed.get("message", "") or ""
        is_undefined = message.strip().lower() == "undefined"
        if is_undefined:
            message = ""

        sender_npub, full_message = lookup_fountain_sender(episode_id, settled_at, message, cache)
        if full_message:
            full_message = re.sub(r'nostr:\S+', '', full_message).strip()
            full_message = re.sub(r'https?://\S+', '', full_message).strip()
            message = full_message
        if is_undefined and not message:
            message = NO_COMMENT_PLACEHOLDER
    else:
        episode_url, episode_id, episode_title, guests = None, None, None, []
        message, sender_npub = "", None

    divisor     = get_divisor(settled_at)
    total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_boost", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    sender_npub,
        "message":        message,
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": _extract_episode_number(episode_title),
        "guests":         guests or [],
        "app_name":       "Fountain",
        "show_level":     show_level,
        "raw_tx":         tx,
    })
    # Show-level boosts return the show id as episode_id; don't record into
    # the episode_number → fountain_id map (episode_number is None anyway,
    # so _record_episode_id would no-op, but the explicit guard makes intent
    # clear and protects against future title-parsing changes).
    if not show_level:
        _record_episode_id(cache, info["episode_number"], info["episode_id"])
    return info

def _classify_castamatic_boost(tx, parsed, payment_hash, settled_at, our_msats, cache):
    """Castamatic BOLT11 boost — dispatched from `_classify_fountain_boost`
    when the URL host is `castamatic.com`. Castamatic exposes per-boost
    metadata as JSON at the URL embedded in the description, so we fetch
    it directly to recover sender_name, item_title, item_guid, and the
    donor's full intended amount (`value_msat_total`).

    Maps `item_guid` to a Fountain page id via the same RSS-index lookup
    the website-boost path uses, with the `lb_episode_ids.json` map as a
    second-tier fallback (keyed on `Ep. NNN` extracted from `item_title`).

    No `message` field — Castamatic doesn't expose donor messages publicly,
    so the boost note's 💬 line is omitted. `source` stays "fountain_boost"
    so downstream aggregation flows are unchanged; `app_name` is set to
    "Castamatic" (or whatever the JSON's `app_name` says) for accurate
    display."""
    boost_url = parsed.get("episode_url") or ""
    fc        = cache.setdefault("castamatic_boosts", {})
    if boost_url in fc:
        boost_data = fc[boost_url]
    else:
        boost_data = {}
        try:
            resp = requests.get(boost_url, timeout=10)
            resp.raise_for_status()
            boost_data = resp.json()
        except Exception as e:
            print(f"  [warn] Castamatic fetch failed for {boost_url}: {e}")
        fc[boost_url] = boost_data

    sender_name = boost_data.get("sender_name") or None
    item_title  = boost_data.get("item_title")
    item_guid   = boost_data.get("item_guid", "")
    app_name    = boost_data.get("app_name") or "Castamatic"

    # Map item_guid → Fountain page id via the existing RSS index. Same
    # lookup the website-boost path uses; reuses the cache.
    rss_index   = build_rss_item_index(cache)
    rss_entry   = rss_index.get(item_guid) or {}
    fountain_id = rss_entry.get("fountain_id")
    guests      = rss_entry.get("guests", [])

    # Fallback: lb_episode_ids.json keyed on the episode number extracted
    # from the title (covers fresh episodes where Fountain hasn't yet
    # populated <podcast:contentLink>).
    episode_number = _extract_episode_number(item_title)
    if not fountain_id and episode_number:
        fallback_map = _ensure_episode_id_map(cache)
        fountain_id  = fallback_map.get(episode_number)
        if fountain_id:
            print(f"  [info] castamatic boost {payment_hash[:12]}... — using episode_id_map fallback for Ep {episode_number} → {fountain_id}")

    if fountain_id:
        episode_id  = fountain_id
        episode_url = f"https://fountain.fm/episode/{fountain_id}"
    else:
        episode_id  = None
        episode_url = None

    # Prefer the donor's full intended total directly from the JSON. Fall
    # back to dividing tx.amount by the RSS-zap-split divisor if the fetch
    # failed (Castamatic offline, network error, etc.) — same approximation
    # the old miscategorized path used to produce.
    try:
        total_from_json = int(boost_data.get("value_msat_total") or 0)
    except Exception:
        total_from_json = 0
    if total_from_json > 0:
        total_msats = total_from_json
        divisor     = 1.0  # we have donor intent directly; no back-calc needed
    else:
        divisor     = get_divisor(settled_at)
        total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_boost", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    None,
        "sender_name":    sender_name,
        "message":        "",   # Castamatic doesn't expose donor messages
        "episode_id":     episode_id,
        "episode_title":  item_title,
        "episode_url":    episode_url,
        "episode_number": episode_number,
        "guests":         guests,
        "app_name":       app_name,
        "raw_tx":         tx,
    })
    if episode_id:
        _record_episode_id(cache, episode_number, episode_id)
    return info

def _classify_fountain_stream(tx, desc, payment_hash, settled_at, our_msats, cache):
    """Fountain BOLT11 streaming sats. Can be show-level (rss::payment::stream
    https://fountain.fm/show/...) or episode-level (https://fountain.fm/episode/...).
    Streams have no message or sender attribution — they're per-minute drips —
    so all those fields stay None/empty."""
    show_match    = re.search(r'https://fountain\.fm/show/([^\s?]+)', desc)
    episode_match = re.search(r'https://fountain\.fm/episode/([^\s?]+)', desc)

    episode_id    = None
    episode_title = None
    episode_url   = None
    show_level    = False

    if episode_match:
        episode_id  = episode_match.group(1)
        episode_url = f"https://fountain.fm/episode/{episode_id}"
        title_pair  = cache["title_cache"].get(episode_id)
        if title_pair is None:
            title_pair = scrape_fountain_episode(episode_url)
            cache["title_cache"][episode_id] = title_pair
        episode_title = title_pair[0]
    elif show_match:
        show_level = True
    else:
        return None

    divisor     = get_divisor(settled_at)
    total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_stream", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": _extract_episode_number(episode_title),
        "app_name":       "Fountain",
        "show_level":     show_level,
        "raw_tx":         tx,
    })
    if not show_level:
        _record_episode_id(cache, info["episode_number"], info["episode_id"])
    return info

def _classify_keysend(tx, boostagram, payment_hash, settled_at, our_msats, cache):
    """Podcast 2.0 keysend boost. The TLV boostagram has all metadata inline —
    no external lookups required. Total sats = boostagram.valueMsatTotal (the
    sender's full intended amount) when present, since keysend payments do not
    pass through the RSS zap split — the full amount lands here."""
    message = boostagram.get("message", "") or ""
    if message.strip().lower() == "undefined":
        message = NO_COMMENT_PLACEHOLDER

    app_name    = boostagram.get("appName") or boostagram.get("app_name", "unknown app")
    sender_name = boostagram.get("senderName") or boostagram.get("sender_name", "") or None

    pubkey = (boostagram.get("senderPubkey") or
              boostagram.get("sender_pub_key") or
              boostagram.get("pubkey"))
    sender_npub = None
    if pubkey:
        try:
            sender_npub = hex_to_npub(pubkey)
        except Exception:
            sender_npub = None

    episode_title_raw = boostagram.get("episode", "") or ""
    episode_url       = boostagram.get("boostLink") or boostagram.get("boost_link", "") or ""
    if not episode_url and episode_title_raw:
        episode_url = get_episode_url_from_rss(episode_title_raw) or ""

    guests = []
    if episode_url and "fountain.fm" in episode_url:
        _, guests = scrape_fountain_episode(episode_url)

    episode_id = None
    if episode_url and "fountain.fm" in episode_url:
        em = re.search(r'fountain\.fm/episode/([^/?\s]+)', episode_url)
        if em:
            episode_id = em.group(1)

    value_msat  = boostagram.get("valueMsatTotal") or boostagram.get("value_msat_total") or 0
    total_msats = int(value_msat) if value_msat else our_msats

    info = _new_info("keysend", payment_hash, settled_at, our_msats, total_msats, 1.0)
    info.update({
        "sender_npub":    sender_npub,
        "sender_name":    sender_name,
        "message":        message,
        "episode_id":     episode_id,
        "episode_title":  episode_title_raw or None,
        "episode_url":    episode_url or None,
        "episode_number": _extract_episode_number(episode_title_raw),
        "guests":         guests or [],
        "app_name":       app_name,
        "boostagram":     boostagram,
        "raw_tx":         tx,
    })
    _record_episode_id(cache, info["episode_number"], info["episode_id"])
    return info

def _classify_lb_donation(tx, payment_hash, settled_at, our_msats, cache):
    """General V4V 2.0 donation to localbitcoiners@getalby.com — distinct
    from website episode boosts (which match LocalBitcoinersEpNNN) because
    these aren't tied to any specific episode. The donations bot already
    publishes a real-time receipt note for these; the classifier surfaces
    them so top-boosts can include big donations on its all-time leaderboard
    while episodesats / boost-leaders / boost-publisher filter them out.

    Sat math: donations don't pass through any RSS zap split (direct
    payment to the lightning address), so total_msats = our_msats with a
    divisor of 1.0. Vanilla LN-address tips (no kind 30078) return None,
    matching the donations bot's own behavior."""
    event = fetch_kind_30078(payment_hash, cache=cache)
    if not event:
        return None

    tags = {t[0]: t[1] for t in event.get("tags", []) if len(t) >= 2}

    sender = tags.get("sender", "") or ""
    sender_npub = sender if sender else None

    info = _new_info("lb_donation", payment_hash, settled_at, our_msats, our_msats, 1.0)
    info.update({
        "sender_npub":   sender_npub,
        "message":       event.get("content", "") or "",
        "episode_title": "localbitcoiners.com",
        "app_name":      "localbitcoiners.com",
        "raw_tx":        tx,
    })
    return info

# ─────────────────────────────────────────────────────────────────────────────
# Note formatting
# ─────────────────────────────────────────────────────────────────────────────

def _sender_display(info):
    """Map a BoostInfo's sender fields to the display string used after the
    👤 emoji. None means omit the line entirely.

    - sender_npub set:                  nostr:{npub} mention (renders as profile)
    - sender_name set (any source):     the bare display name (keysend
                                         boostagrams, Castamatic public boost
                                         JSON, etc. — anywhere we got a name
                                         but no cryptographic identity)
    - website with no sender or name:   explicit "Anon" (V4V 2.0 convention)
    - everything else:                  None (line omitted)"""
    if info["sender_npub"]:
        return f"nostr:{info['sender_npub']}"
    if info.get("sender_name"):
        return info["sender_name"]
    if info["source"] == "website":
        return "Anon"
    return None

def format_note_from_info(info):
    """Build the boost-publisher kind-1 note text from a BoostInfo dict.
    Matches the prior format_note layout exactly so production note format is
    unchanged for Fountain / keysend. Website boosts use the same template
    with app_name='localbitcoiners.com' and an explicit 'Anon' sender line
    when the kind 30078 sender tag is empty."""
    sender_display = _sender_display(info)
    message        = info["message"]

    lines = ["⚡ New boost on Local Bitcoiners!"]
    lines.append(f"💰 {info['total_sats']} sats 📱 via {info['app_name']}")

    if sender_display:
        lines.append(f"👤 {sender_display}")

    if message:
        # No surrounding quotes — quotes glued to a leading/trailing
        # nostr:npub1... / nevent1... / naddr1... mention break entity rendering
        # in some clients (the bech32 alphabet excludes ", but loose parsers
        # still trip). The 💬 emoji is enough delineation.
        if message == NO_COMMENT_PLACEHOLDER:
            lines.append(f'💬 {message}')
        else:
            lines.append(f'💬 {nostrify_mentions(message)}')

    if info["episode_title"]:
        line = f"🎙️ {info['episode_title']}"
        if info["guests"]:
            line += " - Guest(s): " + " & ".join(f"nostr:{n}" for n in info["guests"])
        lines.append(line)

    if info["episode_url"]:
        lines.append(f"🔗 {info['episode_url']}")

    lines.append("")
    lines.append("#LocalBitcoiners")
    return "\n".join(lines)

def build_note_from_tx(tx, cache=None):
    """Turn a raw Alby Hub transaction for an incoming boost into the kind-1
    note the boost publisher would post. Returns a dict:

      note_text    (str)          ready-to-publish note text
      sender_npub  (str | None)   sender's npub (None for keysend / anon / unresolved)
      episode_url  (str | None)   episode URL if identifiable
      payment_hash (str)          tx.paymentHash ('' if missing)
      app_name     (str)          'Fountain', 'localbitcoiners.com', or keysend app name
      sats         (int)          total intended sats sent (post-divisor for split-routed sources)
      info         (dict)         the full BoostInfo (callers wanting more fields)

    Returns None if the tx isn't a recognized boost (or is a Fountain stream —
    streams are aggregated by episodesats only, never published as a note —
    or an lb_donation, which the donations bot publishes via its own note
    format; double-publishing here would emit a duplicate)."""
    info = classify_lb_tx(tx, cache=cache)
    if not info or info["source"] in ("fountain_stream", "lb_donation"):
        return None
    note_text = format_note_from_info(info)
    return {
        "note_text":    note_text,
        "sender_npub":  info["sender_npub"],
        "episode_url":  info["episode_url"],
        "payment_hash": info["payment_hash"],
        "app_name":     info["app_name"],
        "sats":         info["total_sats"],
        "info":         info,
    }
