#!/usr/bin/env python3
"""Local Bitcoiners — community podcast-boosts collector.

Read-only research/data bot — never signs or publishes anything to Nostr.
Scans the wider Nostr network for kind:1 podcast-boost notes authored by
everyone in the LB community (every npub currently on the supporters page,
i.e. the union of every follow-pack in bots/follow-packs/state.json), then
compiles what it finds into <repo>/data/community_boosts.json so the website
can build "episodes our community recommends" cards. This deliberately
excludes LB's own show (already covered by the episode pages) and is
podcasts-only for v1 (music apps like stablekraft are dropped once their
show's Podcast Index `medium` resolves to something other than "podcast").

Deliberately a SEPARATE bot, not a new sats-log pass — sats-log's timer also
drives the Tuesday leaderboard LIVE-publish on a strict schedule, and this is
a much slower/flakier network-wide relay scan that shouldn't risk that path.

## Boost detection

A kind:1 note qualifies as a community podcast boost when ALL of:
  1. It carries a NIP-73 `i` tag `podcast:item:guid:<guid>` (episode-level —
     bare `podcast:guid:<guid>` show-level mentions don't qualify).
  2. Its `podcast:guid` isn't LB_FEED_GUID (LB's own show).
  3. It has actual payment signal, one of:
       - a `t` tag of `boostagram` or `value4value`
       - a positive `amount` tag (msats)
       - it quote-references a kind:9735 zap receipt via a `q`/`e` tag or an
         inline nostr:nevent1.../note1... in the content — the real amount is
         read off that receipt's `amount` tag, falling back to its `bolt11`
         tag's encoded amount.
This last rule is what catches Fountain-style narrative notes with no
`amount` tag that actually wrap a real zap receipt (confirmed during design
research on one of Reed's own sample boosts — see project memory).

Network-wide discovery filters relays on `#k: [podcast:guid,
podcast:item:guid]` + authors — relay tag filters are exact-match only, so
`#i` filtering only works once a specific guid is already known. Known gap:
not every app emits the `k` tag (stablekraft doesn't) — low-stakes since
scope is podcasts-only and that's a music app anyway.

## Incremental state

bots/community-boosts/state.json (gitignored) holds `last_processed`, the
since-cursor for the next run. First run has no state file and backfills all
the way to SINCE_CUTOFF (10am EST Feb 2 2026 — per Reed, when the show
started). Subsequent runs re-query from a small overlap window before
last_processed; output is deduped by event_id so overlap is harmless.

state.json also holds `item_url_map` (item_guid -> canonical listen URL),
accumulated across every run. Each boost record carries `item_url`/
`show_url` — the third element of the NIP-73 `i` tag, when the booster's app
provides one (Fountain does; BoostMeBitch/BowlAfterBowl/PV4V don't). Every
run harvests any newly-seen URL for a given item_guid into the map, then
fills `item_url: null` on any boost of the same episode from an app that
didn't provide one — so an episode boosted via a URL-less app today still
picks up its link the next time anyone boosts it via Fountain.
"""

import html
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import bech32
import requests
import websocket
from pynostr.key import PrivateKey  # noqa: F401  (kept consistent with other bots' imports)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import load_config, hex_to_npub, NOSTR_RELAYS
from boost_formatter import strip_fountain_trailer, LB_FEED_GUID

REPO_ROOT         = Path(__file__).resolve().parent.parent.parent
CREDENTIALS_FILE  = Path.home() / ".config/nostr-bots/credentials.env"
FOLLOWPACKS_STATE = Path(__file__).resolve().parent.parent / "follow-packs" / "state.json"
STATE_FILE        = Path(__file__).resolve().parent / "state.json"
OUTPUT_FILE       = REPO_ROOT / "data" / "community_boosts.json"

# Dedicated deploy key for the VPS push — separate from github_ed25519,
# passphrase-less since it runs unattended from the hourly systemd timer.
# Restricted on the VPS side to a forced `rrsync` command scoped to one
# directory (see project memory), so this key can't do anything beyond
# overwriting community_boosts.json even if this box were compromised.
VPS_KEY_FILE      = Path.home() / ".ssh" / "relay_mynostr_ed25519"

# Backfill floor for the very first run — 10am EST Feb 2 2026, per Reed
# ("when the show first started"). Computed via zoneinfo rather than a raw
# UTC literal so it's correct regardless of DST (moot in Feb, but keeps the
# constant self-documenting if this script is ever adapted).
SINCE_CUTOFF = int(datetime(2026, 2, 2, 10, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp())

# Small re-query overlap on incremental runs so a note that lands right at
# the boundary between two runs is never missed. Output dedupes by event_id
# so re-fetching the same note twice is harmless.
OVERLAP_SECONDS = 300

AUTHOR_BATCH_SIZE = 50   # conservative per-filter author count (relay limits vary)
RELAY_TIMEOUT      = 15

PODCAST_INDEX_BASE = "https://api.podcastindex.org/api/1.0"


# ── relay I/O ────────────────────────────────────────────────────────────────
def query_relay(relay, filt, timeout=RELAY_TIMEOUT, max_wall_seconds=60, max_events=20000):
    """REQ a single filter against one relay, return whatever EVENTs arrive
    before EOSE, the socket times out, or a hard wall-clock/event-count cap is
    hit (partial results are kept, not discarded).

    The per-recv() timeout alone isn't enough: a relay that dribbles messages
    slower than `timeout` apart but never sends EOSE can otherwise hang a
    single query indefinitely (observed live against nos.lol — a run sat on
    one relay connection for over an hour). `max_wall_seconds` bounds total
    time regardless of how the traffic is paced; `max_events` is a second
    safety net against a relay streaming an unbounded backlog."""
    got = []
    deadline = time.monotonic() + max_wall_seconds
    try:
        ws = websocket.create_connection(relay, timeout=timeout)
        sub = "cb"
        ws.send(json.dumps(["REQ", sub, filt]))
        while time.monotonic() < deadline and len(got) < max_events:
            remaining = deadline - time.monotonic()
            ws.settimeout(max(0.1, min(timeout, remaining)))
            try:
                msg = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException:
                break
            except Exception:
                break
            if not isinstance(msg, list) or not msg:
                continue
            if msg[0] == "EVENT" and len(msg) >= 3:
                got.append(msg[2])
            elif msg[0] == "EOSE":
                break
        if len(got) >= max_events:
            print(f"    [warn] {relay}: hit max_events cap ({max_events}) — filter may be too broad")
        elif time.monotonic() >= deadline:
            print(f"    [warn] {relay}: hit {max_wall_seconds}s wall-clock cap without EOSE — taking partial results")
        try:
            ws.send(json.dumps(["CLOSE", sub]))
        except Exception:
            pass
        ws.close()
    except Exception as e:
        print(f"    [warn] {relay}: {e}")
    return got


def fetch_event_by_id(event_id, relays, timeout=8, max_wall_seconds=15):
    for relay in relays:
        try:
            ws = websocket.create_connection(relay, timeout=timeout)
            sub = "ev_" + event_id[:8]
            ws.send(json.dumps(["REQ", sub, {"ids": [event_id]}]))
            found = None
            deadline = time.monotonic() + max_wall_seconds
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                ws.settimeout(max(0.1, min(timeout, remaining)))
                try:
                    msg = json.loads(ws.recv())
                except websocket.WebSocketTimeoutException:
                    break
                except Exception:
                    break
                if not isinstance(msg, list) or not msg:
                    continue
                if msg[0] == "EVENT" and len(msg) >= 3:
                    found = msg[2]
                elif msg[0] == "EOSE":
                    break
            ws.close()
            if found:
                return found
        except Exception:
            continue
    return None


def fetch_boost_candidate_events(author_hexes, since):
    """Network-wide #k-tag scan across NOSTR_RELAYS, batched by author count.
    Dedupes by event id across relays/batches."""
    batches = [author_hexes[i:i + AUTHOR_BATCH_SIZE]
               for i in range(0, len(author_hexes), AUTHOR_BATCH_SIZE)]
    seen = {}
    for relay in NOSTR_RELAYS:
        for batch in batches:
            filt = {
                "kinds": [1],
                "authors": batch,
                "#k": ["podcast:guid", "podcast:item:guid"],
                "since": since,
            }
            for ev in query_relay(relay, filt):
                if ev.get("id"):
                    seen[ev["id"]] = ev
        print(f"    {relay.split('/')[2]}: {len(seen)} unique events so far")
    return list(seen.values())


# ── bech32 quote-ref decoding (note1.../nevent1... embedded in content) ──────
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_QUOTE_RE = re.compile(r'(?:nostr:)?(?<!\w)(note1[02-9ac-hj-np-z]+|nevent1[02-9ac-hj-np-z]+)', re.IGNORECASE)


def decode_note_or_nevent(token):
    """Decode a bare note1... or nevent1... token to its 32-byte event id
    (hex), or None. Manual bech32 split (not pynostr's bech32_decode) since
    that rejects strings over 90 chars, which nevents routinely exceed —
    same approach as boost_formatter._nevent_kind."""
    s = token.lower()
    if s.startswith("note1"):
        is_note = True
    elif s.startswith("nevent1"):
        is_note = False
    else:
        return None
    five = [_BECH32_CHARSET.find(c) for c in s[s.rfind("1") + 1:]]
    if len(five) < 7 or any(v < 0 for v in five):
        return None
    data = bech32.convertbits(five[:-6], 5, 8, False)  # drop 6-char checksum
    if data is None:
        return None
    if is_note:
        return bytes(data).hex() if len(data) == 32 else None
    i = 0
    while i + 1 < len(data):
        t, ln = data[i], data[i + 1]
        val = bytes(data[i + 2:i + 2 + ln])
        if t == 0 and len(val) == 32:
            return val.hex()
        i += 2 + ln
    return None


_BOLT11_RE = re.compile(r'^ln(?:bc|tb)(\d+)([munp]?)', re.IGNORECASE)
_BOLT11_MULT = {"": 1, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12}


def bolt11_amount_msats(bolt11):
    """Fallback amount parse straight off a bolt11 invoice string when a zap
    receipt has no explicit `amount` tag."""
    m = _BOLT11_RE.match((bolt11 or "").strip())
    if not m:
        return None
    amount, unit = m.group(1), m.group(2).lower()
    btc = int(amount) * _BOLT11_MULT.get(unit, 1)
    return round(btc * 1e11)  # 1 BTC = 1e8 sats = 1e11 msats


def resolve_zap_amount(receipt_event):
    tags = {t[0]: t[1] for t in receipt_event.get("tags", []) if len(t) >= 2}
    try:
        v = int(tags.get("amount", 0) or 0)
        if v > 0:
            return v
    except Exception:
        pass
    return bolt11_amount_msats(tags.get("bolt11"))


# ── boost classification ─────────────────────────────────────────────────────
def classify_boost(event, receipt_cache):
    tags = event.get("tags", [])
    i_tags = [t for t in tags if len(t) >= 2 and t[0] == "i"]
    podcast_guid = item_guid = None
    item_url = show_url = None
    for t in i_tags:
        v = t[1]
        url = t[2] if len(t) >= 3 and t[2] else None
        if v.startswith("podcast:item:guid:"):
            item_guid = v[len("podcast:item:guid:"):]
            item_url = url
        elif v.startswith("podcast:guid:"):
            podcast_guid = v[len("podcast:guid:"):]
            show_url = url

    if not item_guid:            # episode-level only, no show-level mentions
        return None
    if podcast_guid == LB_FEED_GUID:   # exclude LB's own show
        return None

    t_vals = {t[1] for t in tags if len(t) >= 2 and t[0] == "t"}
    amount_msats = None
    amount_source = None
    is_boost = bool(t_vals & {"boostagram", "value4value"})
    if is_boost:
        amount_source = "t_tag"

    amt_tag = next((t[1] for t in tags if len(t) >= 2 and t[0] == "amount"), None)
    if amt_tag:
        try:
            v = int(amt_tag)
            if v > 0:
                amount_msats, amount_source, is_boost = v, "amount_tag", True
        except Exception:
            pass

    if amount_msats is None:
        candidate_ids = [t[1] for t in tags
                          if len(t) >= 2 and t[0] in ("q", "e") and len(t[1]) == 64]
        for m in _QUOTE_RE.finditer(event.get("content", "") or ""):
            eid = decode_note_or_nevent(m.group(1))
            if eid:
                candidate_ids.append(eid)
        for cid in dict.fromkeys(candidate_ids):
            if cid not in receipt_cache:
                receipt_cache[cid] = fetch_event_by_id(cid, NOSTR_RELAYS)
            receipt = receipt_cache[cid]
            if receipt and receipt.get("kind") == 9735:
                is_boost = True
                v = resolve_zap_amount(receipt)
                if v:
                    amount_msats, amount_source = v, "zap_receipt"
                break

    if not is_boost:
        return None

    client = next((t[1] for t in tags if len(t) >= 2 and t[0] == "client"), None)
    r_urls = [t[1] for t in tags if len(t) >= 2 and t[0] == "r"]

    return {
        "event_id":        event["id"],
        "booster_pubkey":  event["pubkey"],
        "booster_npub":    hex_to_npub(event["pubkey"]),
        "created_at":      event["created_at"],
        "sats":            round(amount_msats / 1000) if amount_msats else None,
        "amount_source":   amount_source or "none",
        "message":         strip_fountain_trailer(event.get("content", "") or ""),
        "client":          client,
        "podcast_guid":    podcast_guid,
        "item_guid":       item_guid,
        "item_url":        item_url,
        "show_url":        show_url,
        "r_urls":          r_urls,
    }


# ── Podcast Index metadata resolution ────────────────────────────────────────
def pi_headers(key, secret):
    import hashlib
    epoch = str(int(time.time()))
    auth = hashlib.sha1((key + secret + epoch).encode()).hexdigest()
    return {
        "X-Auth-Date": epoch,
        "X-Auth-Key":  key,
        "Authorization": auth,
        "User-Agent":  "LocalBitcoiners-CommunityBoosts/1.0",
    }


def pi_get(path, params, key, secret):
    r = requests.get(f"{PODCAST_INDEX_BASE}/{path}", params=params,
                      headers=pi_headers(key, secret), timeout=15)
    r.raise_for_status()
    return r.json()


def resolve_show(podcast_guid, key, secret):
    try:
        data = pi_get("podcasts/byguid", {"guid": podcast_guid}, key, secret)
        feed = data.get("feed") or {}
        if not feed:
            return None
        return {
            "podcast_guid": podcast_guid,
            "title":        feed.get("title"),
            "image":        feed.get("image") or feed.get("artwork"),
            "feed_url":     feed.get("url"),
            "itunes_id":    feed.get("itunesId"),
            "feed_id":      feed.get("id"),
            "medium":       feed.get("medium") or "podcast",
        }
    except Exception as e:
        print(f"  [warn] Podcast Index show lookup failed for {podcast_guid}: {e}")
        return None


# Podcast Index episode descriptions are frequently HTML; the website only
# renders a short teaser and links out for the full text, so we store a
# plain-text, length-capped version — strips tags, unescapes entities,
# collapses whitespace, truncates on a character boundary with an ellipsis.
# Keeps community_boosts.json small (~400 chars vs full HTML bodies).
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def clean_description(raw, limit=400):
    if not raw:
        return None
    text = _HTML_TAG_RE.sub(" ", raw)     # tags → space so words don't fuse
    text = html.unescape(text)            # &amp; etc. → literal chars
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text or None


def resolve_episode(item_guid, feed_id, key, secret):
    try:
        params = {"guid": item_guid}
        if feed_id:
            params["feedid"] = feed_id
        data = pi_get("episodes/byguid", params, key, secret)
        ep = data.get("episode") or {}
        if not ep or not ep.get("id"):
            return None
        return {
            "item_guid":       item_guid,
            "title":           ep.get("title"),
            "image":           ep.get("image") or ep.get("feedImage"),
            "published":       ep.get("datePublished"),
            "duration":        ep.get("duration"),
            "episode_number":  ep.get("episode"),
            "podcast_guid":    ep.get("podcastGuid") or None,
            "feed_id":         ep.get("feedId"),
            "enclosure_url":   ep.get("enclosureUrl"),
            "enclosure_type":  ep.get("enclosureType"),
            "description":     clean_description(ep.get("description")),
        }
    except Exception as e:
        print(f"  [warn] Podcast Index episode lookup failed for {item_guid}: {e}")
        return None


# ── state / output I/O ───────────────────────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def load_output():
    if OUTPUT_FILE.exists():
        try:
            return json.loads(OUTPUT_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_output(output):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, indent=2, ensure_ascii=False, sort_keys=True))


def push_to_vps(config):
    """rsync the freshly-written output file to the VPS deploy directory so
    Caddy can serve it statically for the website — avoids an hourly git
    push/rebuild for data that only needs to be fetched, not version
    controlled. Best-effort: a push failure is logged and swallowed rather
    than failing the run, since data/community_boosts.json is still written
    locally (and committed to the repo on whatever cadence Reed pushes it)
    regardless of whether the VPS copy succeeds this run."""
    host        = config.get("RELAY_VPS_HOST")
    port        = config.get("RELAY_VPS_PORT")
    user        = config.get("RELAY_VPS_USER")
    deploy_path = config.get("RELAY_VPS_DEPLOY_PATH")
    if not all([host, port, user, deploy_path]):
        print("  [warn] RELAY_VPS_* fields missing from credentials.env — skipping VPS push")
        return False
    if not VPS_KEY_FILE.exists():
        print(f"  [warn] {VPS_KEY_FILE} not found — skipping VPS push")
        return False

    # rrsync's forced command on the VPS side already fixes the root directory
    # (see RELAY_VPS_DEPLOY_PATH / bots/CLAUDE.md) — the client must send a path
    # RELATIVE to that root, not absolute, or rrsync doubles it up and 404s.
    dest = f"{user}@{host}:community_boosts.json"
    ssh_cmd = f"ssh -i {VPS_KEY_FILE} -p {port} -o StrictHostKeyChecking=accept-new"
    try:
        result = subprocess.run(
            ["rsync", "-a", "-e", ssh_cmd, str(OUTPUT_FILE), dest],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            print(f"  [warn] VPS push failed (exit {result.returncode}): {result.stderr.strip()[-300:]}")
            return False
        print("  VPS push OK")
        return True
    except Exception as e:
        print(f"  [warn] VPS push failed: {e}")
        return False


def load_community_npubs():
    packs = json.loads(FOLLOWPACKS_STATE.read_text())
    hexes = sorted({h for pack in packs.values() for h in pack.get("members", [])})
    return hexes


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    config = load_config(CREDENTIALS_FILE)
    pi_key    = config.get("LOCAL_BITCOINERS_INDEX_KEY")
    pi_secret = config.get("LOCAL_BITCOINERS_INDEX_SECRET")
    if not pi_key or not pi_secret:
        print("[warn] Podcast Index credentials missing — episode/show metadata will be skipped")

    author_hexes = load_community_npubs()
    print(f"{len(author_hexes)} unique community npubs (all follow packs)")

    state = load_state()
    last_processed = state.get("last_processed")
    since = SINCE_CUTOFF if not last_processed else max(SINCE_CUTOFF, last_processed - OVERLAP_SECONDS)
    print(f"Querying since {since} ({datetime.fromtimestamp(since, tz=timezone.utc).isoformat()})")

    print("Fetching candidate podcast-tagged notes...")
    events = fetch_boost_candidate_events(author_hexes, since)
    print(f"{len(events)} candidate kind:1 notes fetched")

    receipt_cache = {}
    new_boosts = []
    for ev in events:
        b = classify_boost(ev, receipt_cache)
        if b:
            new_boosts.append(b)
    print(f"{len(new_boosts)} classified as real episode-level boosts (LB's own show excluded)")

    existing = load_output()
    boosts_by_id = {b["event_id"]: b for b in existing.get("boosts", [])}
    for b in new_boosts:
        boosts_by_id[b["event_id"]] = b
    all_boosts = sorted(boosts_by_id.values(), key=lambda b: b["created_at"])

    # Schema normalization: older records (written before item_url/show_url
    # existed) won't have these keys at all if their raw event wasn't
    # re-fetched this run. Backfill the keys as null so every record in the
    # output has a consistent shape regardless of when it was last (re)seen.
    for b in all_boosts:
        b.setdefault("item_url", None)
        b.setdefault("show_url", None)

    # Persistent item_guid -> item_url map (state.json). Apps other than
    # Fountain emit the same item_guid but no URL hint on their own boosts;
    # once ANY boost for that item_guid carries a real URL (almost always a
    # Fountain-sourced one), every other boost of that same episode inherits
    # it here — including ones from apps that boosted it before Fountain did,
    # on a later run. Last-write-wins per Reed/website-agent's verification
    # that no item_guid maps to conflicting URLs in practice; still logs a
    # warning if that ever turns out false, rather than trusting it silently.
    item_url_map = dict(state.get("item_url_map") or {})
    for b in all_boosts:
        ig, url = b.get("item_guid"), b.get("item_url")
        if ig and url:
            prev = item_url_map.get(ig)
            if prev and prev != url:
                print(f"  [warn] item_url_map conflict for {ig}: {prev!r} vs {url!r} — keeping newest")
            item_url_map[ig] = url
    filled = 0
    for b in all_boosts:
        if not b.get("item_url") and b.get("item_guid") in item_url_map:
            b["item_url"] = item_url_map[b["item_guid"]]
            filled += 1
    if filled:
        print(f"  Backfilled item_url on {filled} boost(s) from the persistent guid→url map")

    show_cache = dict(existing.get("shows", {}))
    guids_needed = {b["podcast_guid"] for b in all_boosts if b.get("podcast_guid")}
    for pg in guids_needed:
        if pg not in show_cache and pi_key and pi_secret:
            show_cache[pg] = resolve_show(pg, pi_key, pi_secret)

    excluded_shows = {pg for pg, info in show_cache.items()
                       if info and info.get("medium") not in (None, "podcast")}
    for pg in excluded_shows:
        print(f"  [exclude] {pg} medium={show_cache[pg].get('medium')!r} — dropping (not a podcast)")
    all_boosts = [b for b in all_boosts if b.get("podcast_guid") not in excluded_shows]

    # Resolve each boosted episode's metadata. An episode is (re)resolved when
    # it's not cached yet, OR it's cached from before the enclosure_url/
    # enclosure_type/description fields existed — a one-time backfill that
    # enriches historical episodes in place (byguid works for episodes older
    # than a feed's most recent 50). Episodes PI genuinely can't find stay
    # cached as None so we don't re-query them every run, and a transient miss
    # on a re-resolve never clobbers good existing data.
    episode_cache = dict(existing.get("episodes", {}))
    if pi_key and pi_secret:
        for b in all_boosts:
            ig, pg = b.get("item_guid"), b.get("podcast_guid")
            if not ig:
                continue
            cached = episode_cache.get(ig)
            needs = ig not in episode_cache or (
                isinstance(cached, dict) and "enclosure_url" not in cached)
            if not needs:
                continue
            feed_id = (show_cache.get(pg) or {}).get("feed_id") if pg else None
            resolved = resolve_episode(ig, feed_id, pi_key, pi_secret)
            if resolved is not None:
                episode_cache[ig] = resolved
            elif ig not in episode_cache:
                episode_cache[ig] = None

    output = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "since_cutoff":  SINCE_CUTOFF,
        "boosts":        all_boosts,
        "episodes":      episode_cache,
        "shows":         {k: v for k, v in show_cache.items() if k not in excluded_shows},
    }
    save_output(output)
    print(f"Wrote {len(all_boosts)} boosts, {len(episode_cache)} episodes, "
          f"{len(output['shows'])} shows → {OUTPUT_FILE}")

    push_to_vps(config)

    new_last_processed = max((e["created_at"] for e in events), default=since)
    state["last_processed"] = max(last_processed or 0, new_last_processed, since)
    state["item_url_map"] = item_url_map
    save_state(state)
    print(f"  item_url_map: {len(item_url_map)} known item_guid→url entries")
    print(f"State saved → {STATE_FILE} (last_processed={state['last_processed']})")


if __name__ == "__main__":
    main()
