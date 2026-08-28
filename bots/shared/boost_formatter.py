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

import html
import json
import re
import sys
import time
import bech32
import requests
import websocket
from datetime import datetime
from pathlib import Path

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))
from nostr_utils import hex_to_npub, npub_to_hex, scrape_fountain_episode

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

# Relay set for V4V 2.0 kind-30078 boostagrams / boost receipts (see
# v4v-2.0-spec-update.md at the repo root, "Relay Set"). Donation publishers
# write here; recipient bots query here. Keep in lockstep with the website —
# a receipt we can't read is a boost we mis-report.
#
# This is the one read set where a missing relay silently discards data rather
# than costing latency: `_merge_receipt_outcomes` rebuilds a boost's true total
# by unioning every receipt sharing a boost_session, and since the 2026-07
# retry fix those receipts are signed by DIFFERENT per-round burner keys, so
# they don't replace each other on relays. Miss the relay holding the retry
# round and the boost silently under-reports — the same failure mode as the
# 2026-07 under-report bug, arriving from the read side instead.
#
# Re-measured 2026-08-12 against the last 40 website boost legs
# (#d=payment_hash) and their 39 boost_sessions:
#   nos.lol 97% (39/40 legs, 38/39 sessions, misses 0 of 38 receipt events)
#   relay.damus.io 75% — flaky, but holds pre-2026-08 history
#   relay.ditto.pub 22% and climbing: it has the newest receipts, which is the
#     website's post-lb-v50 write set landing
#   nostr.mom 0% today, but accepts kind 30078 and is in the website's write
#     set now, so it fills in going forward
#   relay.primal.net 0% (accepts the kind, holds none of ours — kept only
#     because the website still writes there)
# Dropped purplepag.es: it stores no kind 30078 from ANY author (kinds 0/3/
# 10002 only), so it could never have answered one of these queries.
# Order matters — fetch_kind_30078 returns on the first relay that answers.
V4V_RELAYS = [
    "wss://nos.lol",
    "wss://relay.ditto.pub",
    "wss://nostr.mom",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
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

# RSS <podcast:guid> for the Local Bitcoiners feed. Used for NIP-73
# external-content identity tags (i/k) on the published boost note so
# GUID-aware podcast clients (Fountain, Primal, BoostMeBitch) can associate
# the note with the show / episode. See build_podcast_guid_tags.
LB_FEED_GUID  = "56fbb1aa-da79-5e4b-bebc-3b934ab8914c"

# Podcast Index feed id for the Local Bitcoiners feed (byfeedid=7683299).
# The most spoof-resistant of the feed-identity signals a boostagram carries.
# Confirmed against the PI API alongside LB_FEED_GUID / RSS_FEED. See
# LB_FEED_IDENTITY and feed_verdict for how these gate incoming boosts.
LB_FEED_ID    = "7683299"

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

def record_reply_event(events, payment_hash, reply_id):
    """Patch the boost-board reply's event id onto an existing record.

    Separate from record_published_event rather than a parameter on it because
    the two ids are known at different moments: the standalone note is recorded
    and persisted the instant it lands (it's irreversibly on the relays by then,
    so the record can't wait on the reply succeeding), and the reply publishes
    after. The reply id is what boost_wall.json / the website's mega-thread key
    on — the standalone note is not part of that thread."""
    if not payment_hash or not reply_id:
        return
    rec = events.get(payment_hash)
    if rec is None:
        return
    rec["reply_id"] = reply_id

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


# Every Lightning address that has represented OUR leg of the value split, past
# and present: the legacy node lud16, Reed's Alby address the feed has carried
# since era 3, and the self-hosted lnbits address the value block migrated to
# (see lnbits_source.py). Matched case-insensitively. All three are listed
# because the feed and the node have not always agreed on which one is live,
# and a boost is reconstructed against whichever the block actually names.
OUR_VALUE_ADDRESSES = frozenset({
    "reed@getalby.com",
    "reed@localbitcoiners.com",
    "localbitcoiners@getalby.com",
})

# Below this, a back-calculated total is dominated by sat-granularity rounding
# on our own leg rather than by the split: at a 1-sat quantum, a leg of N sats
# carries roughly 1/N relative uncertainty, so a 10-sat leg reconstructs the
# total to only ~±10%. Boosts under this threshold still publish — they're real
# sats and skipping them would lose the donor's message — but they're flagged so
# a suspicious total is traceable rather than mysterious.
LOW_PRECISION_LEG_MSATS = 20_000  # 20 sats


def resolve_divisor(settled_at, cache, item_guid=None, episode_number=None,
                    show_level=False, our_msats=0, label=""):
    """Our leg's share of a boost, taken from the episode's own <podcast:value>
    block — the per-episode replacement for the flat `get_divisor()`.

    The flat divisor hardcodes the assumption that our leg is 33% of every
    boost. That assumption breaks the moment an episode's split is edited: at a
    1% leg it under-states every reconstructed total by ~33x. Reading the block
    instead means a split change needs no code change, and stays right for
    episodes whose split never matches the channel default.

    Renormalizes over ALL recipients (not just lnaddress ones) because the rails
    that reach this path — Fountain BOLT11, keysend, Castamatic, Tardbox — pay
    every leg, unlike the website's browser flow.

    Returns (divisor, method) where method is "rss split" when the feed
    answered and "sat math" when it fell back to the flat historical value.
    CAVEAT: reads the CURRENT feed, so a boost classified long after a split
    edit reconstructs against the new weights. In practice the bots classify
    within minutes of settlement, and sats-log snapshots the result thereafter.
    """
    # Era guard. Per-item <podcast:value> blocks only became the source of
    # truth at SPLIT_CUTOFF_V3; before that the show ran flat 98% / 49% splits
    # the current feed knows nothing about. Reading today's weights for an
    # older boost would silently restate it at 33%. Mirrors the ERA3_CUTOFF
    # condition in sats-log's _resolve_pcts().
    if settled_at < SPLIT_CUTOFF_V3:
        return get_divisor(settled_at), "sat math"

    recips = []
    try:
        build_rss_item_index(cache)
        if show_level:
            recips = cache.get("channel_value_all") or []
        else:
            entry = None
            if item_guid:
                entry = (cache.get("guid_to_fountain") or {}).get(item_guid)
            if not entry and episode_number:
                entry = (cache.get("num_to_rss_item") or {}).get(episode_number)
            recips = (entry or {}).get("value_all") or cache.get("channel_value_all") or []
    except Exception as e:
        print(f"  [warn] {label} — RSS divisor lookup failed ({e}); using flat divisor")

    total_weight = sum(r["split"] for r in recips)
    our_weight   = sum(r["split"] for r in recips
                       if r["address"].lower() in OUR_VALUE_ADDRESSES)

    if total_weight <= 0 or our_weight <= 0:
        # No block, or the block names none of our addresses — the flat
        # historical divisor is the only estimate left. Worth surfacing: it
        # means the feed and OUR_VALUE_ADDRESSES have drifted apart.
        if total_weight > 0:
            print(f"  [warn] {label} — RSS value block names none of "
                  f"{sorted(OUR_VALUE_ADDRESSES)}; falling back to flat divisor")
        return get_divisor(settled_at), "sat math"

    divisor = our_weight / total_weight
    if our_msats and our_msats < LOW_PRECISION_LEG_MSATS and divisor < 1.0:
        print(f"  [warn] {label} — our leg is only {our_msats / 1000:.3f} sats at a "
              f"{divisor:.4%} split; reconstructed total is ±{1000 / our_msats:.0%} "
              f"and may be materially off")
    return divisor, "rss split"

# ─────────────────────────────────────────────────────────────────────────────
# Feed-identity gating
# ─────────────────────────────────────────────────────────────────────────────
# The node (reed@localbitcoiners.com) is a SHARED Lightning value-split
# recipient: Reed guests on other shows that split to this address, and a new
# podcast is spinning up on the same address. So a boost landing here is NOT
# automatically Local Bitcoiners — it has to positively identify our feed.
#
# Real-world finding (surveyed off the live node): keysend boostagrams carry NO
# podcast:guid. The signals that DO appear are `feedId`, feed `url`, and the
# `podcast` title — and none is populated by every app (LB boosts show
# feedId=7683299 from some apps but 0 from others; url present from some, empty
# from others; only the title is near-universal). So identity is a multi-signal
# bundle and the verdict treats a missing/placeholder signal as ABSENT, never as
# a mismatch. `guid` is kept for forward-compat even though no app sends it yet.
#
# feed_verdict is deliberately generic (takes an `identity`) so a future bot for
# the OTHER podcasts can reuse it with its own identity bundle rather than
# hardcoding Local Bitcoiners.
LB_FEED_IDENTITY = {
    "feed_ids":  {LB_FEED_ID},                 # "7683299"
    "feed_urls": {RSS_FEED},                    # feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU
    "titles":    {LB_SHOW_TITLE.lower()},       # "local bitcoiners"
    "guids":     {LB_FEED_GUID.lower()},        # 56fbb1aa-...
}

FEED_MATCH  = "match"    # a present signal positively names the target feed
FEED_OTHER  = "other"    # a present signal positively names a DIFFERENT feed
FEED_ABSENT = "absent"   # no usable feed signal present

def _norm_feed_url(u):
    return (u or "").strip().lower().rstrip("/")

def _norm_feed_id(v):
    """feedId of 0 / '' / None means 'not provided' — treat as absent, not a
    mismatch. (Fountain and PodcastGuru send 0 even for real LB boosts.)"""
    s = str(v or "").strip()
    return "" if s in ("", "0") else s

def feed_verdict(meta, identity):
    """Decide whether a boost's feed-identity `meta` belongs to `identity`.

    `meta` — loosely-typed signals pulled off a boostagram / fetched boost page:
    any of `feed_id`, `feed_url`, `title`, `guid` (missing keys are fine).
    `identity` — bundle of `feed_ids` / `feed_urls` / `titles` / `guids` sets
    (titles + guids compared lowercased; urls normalized).

    Each PRESENT signal votes match (names the target feed) or other (names a
    different feed); missing / placeholder signals abstain. A single `other`
    vote is decisive even if another signal matches — mixed signals are treated
    as untrustworthy and rejected. If nothing names the target and nothing
    contradicts it, the verdict is ABSENT and the caller decides what to do."""
    saw_match = saw_other = False

    def _vote(present, is_match):
        nonlocal saw_match, saw_other
        if not present:
            return
        if is_match:
            saw_match = True
        else:
            saw_other = True

    fid = _norm_feed_id(meta.get("feed_id"))
    _vote(fid, fid in {str(x) for x in identity["feed_ids"]})

    url = _norm_feed_url(meta.get("feed_url"))
    _vote(url, url in {_norm_feed_url(u) for u in identity["feed_urls"]})

    title = (meta.get("title") or "").strip().lower()
    _vote(title, title in {t.lower() for t in identity["titles"]})

    guid = (meta.get("guid") or "").strip().lower()
    _vote(guid, guid in {g.lower() for g in identity["guids"]})

    if saw_other:
        return FEED_OTHER
    if saw_match:
        return FEED_MATCH
    return FEED_ABSENT

def lb_feed_verdict(meta):
    """feed_verdict specialized to the Local Bitcoiners feed."""
    return feed_verdict(meta, LB_FEED_IDENTITY)

def _keysend_feed_meta(boostagram):
    """Extract feed-identity signals from a Podcasting 2.0 keysend boostagram.
    Field-name casing varies by app, so check the known variants."""
    return {
        "feed_id":  (boostagram.get("feedId") or boostagram.get("feedID")
                     or boostagram.get("feed_id")),
        "feed_url": boostagram.get("url"),
        "title":    boostagram.get("podcast"),
        "guid":     (boostagram.get("guid") or boostagram.get("feedGuid")
                     or boostagram.get("podcastGuid")),
    }

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

# Fountain (since ~May 2026) appends a machine-generated trailer to the stored
# comment text of every boost: the episode permalink followed by a nostr: quote
# of the boost's own zap receipt (kind 9735). The donor never types this — it's
# Fountain boilerplate — and carrying it into our boost note both duplicates the
# 🔗 episode link and renders as a broken "Quoted note not available" card on
# the site (a zap receipt isn't a quotable note). Strip it, but ONLY when the
# trailing nevent really decodes to a kind-9735 zap receipt, so a donor-authored
# fountain link + genuine note quote is never touched.
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_FOUNTAIN_TRAILER_RE = re.compile(
    r'\s*https?://fountain\.fm/episode/\S+\s+(?:nostr:)?'
    r'(nevent1[02-9ac-hj-np-z]+)\s*$'
)

def _nevent_kind(entity):
    """Return the kind TLV (type 3) of an nevent1... bech32 string, or None.
    Decodes without a length cap — the stdlib bech32_decode rejects strings
    over 90 chars, which nevents routinely exceed."""
    try:
        s = entity.lower()
        if not s.startswith("nevent1"):
            return None
        five = [_BECH32_CHARSET.find(c) for c in s[s.rfind("1") + 1:]]
        if any(v < 0 for v in five):
            return None
        tlv = bech32.convertbits(five[:-6], 5, 8, False)  # drop 6-char checksum
        if tlv is None:
            return None
        i = 0
        while i + 1 < len(tlv):
            t, ln = tlv[i], tlv[i + 1]
            if t == 3:
                return int.from_bytes(bytes(tlv[i + 2:i + 2 + ln]), "big")
            i += 2 + ln
    except Exception:
        return None
    return None

def strip_fountain_trailer(message):
    """Remove Fountain's auto-appended episode-link + zap-receipt-quote trailer
    from a Fountain boost comment. No-op unless the trailing nevent is a
    kind-9735 zap receipt, so donor-authored content is left verbatim."""
    if not message:
        return message
    m = _FOUNTAIN_TRAILER_RE.search(message)
    if not m or _nevent_kind(m.group(1)) != 9735:
        return message
    return message[:m.start()].rstrip()

# NIP-52 calendar event kinds: 31922 date-based, 31923 time-based. (sats-log's
# meetups pass imports these so the two paths agree on what counts as a meetup.)
NIP52_KINDS = {31922, 31923}

# NIP-23 long-form article. Boosted articles are "featured" on the site's
# Articles tab the same way boosted calendar events are featured on the Events
# tab — same row schema, same log file — so the kind gate widens rather than
# forking a parallel pipeline. Keep NIP52_KINDS meaning strictly NIP-52; the
# Events-tab reader still filters on it.
KIND_ARTICLE     = 30023
# NIP-99 classified listing — the Market tab's featured slot.
KIND_LISTING     = 30402
FEATURABLE_KINDS = NIP52_KINDS | {KIND_ARTICLE, KIND_LISTING}

# Match an naddr1 bech32 token anywhere — bare, nostr:-prefixed, or embedded in
# a URL (njump.me/naddr1..., etc.). The lookbehind skips naddr1 glued to a
# preceding word char. Data charset excludes bech32's 1/b/i/o.
_NADDR_RE = re.compile(r'(?<!\w)naddr1[02-9ac-hj-np-z]+', re.IGNORECASE)

# A podcast episode featured via its OnlyBoosts page. The site's Feature boost
# message ends with `https://onlyboosts.social/episode/<urlencoded item guid>`;
# sats-log's meetups pass turns that into a `podcast:item:guid:<guid>` row.
# Item guids are opaque — some contain slashes, some are full URLs — so the
# capture runs to whitespace and the consumer urldecodes it whole, never splits.
_OB_EPISODE_URL_RE = re.compile(r'https://onlyboosts\.social/episode/([^\s]+)')

# Web-view URLs for the addressable events a boost can carry, so clients that
# don't render an embedded naddr still give readers something to click.
#   plektos.app (NIP-52 calendar client) — createEventUrl builds
#     `${origin}/event/${naddr}`; it's calendar-only, no article view.
#   mynostr.app renders a NIP-23 article at the bare bech32 root.
#   shopstr.store renders a NIP-99 listing at /listing/<naddr>.
PLEKTOS_EVENT_URL   = "https://plektos.app/event/{naddr}"   # 31922 / 31923
MYNOSTR_ARTICLE_URL = "https://mynostr.app/{naddr}"         # 30023
SHOPSTR_LISTING_URL = "https://shopstr.store/listing/{naddr}"  # 30402

# Per featurable kind: (line emoji, URL template). Calendar output stays
# byte-identical to the old plektos-only path; articles get 📄 + a MyNostr
# link, listings 🛒 + a Shopstr link. The site's own signed note
# (buildShowSiteNoteTemplate in login-widget/src/lib/boostagram.js) emits the
# same lines — keep the two in step. Featured podcast episodes get no line:
# the OnlyBoosts URL is already the message body.
_WEB_LINK_BY_KIND = {
    31922: ("📅", PLEKTOS_EVENT_URL),
    31923: ("📅", PLEKTOS_EVENT_URL),
    30023: ("📄", MYNOSTR_ARTICLE_URL),
    30402: ("🛒", SHOPSTR_LISTING_URL),
}

def decode_naddr(entity):
    """Decode a NIP-19 naddr1... into {kind, pubkey, identifier, relays}, or
    None if it isn't a well-formed naddr. Decodes without a length cap — the
    stdlib bech32_decode rejects strings over 90 chars, which naddrs exceed.

    naddr TLV: type 0 = identifier / d-tag (UTF-8, variable), type 1 = relay
    (UTF-8), type 2 = author pubkey (32 bytes), type 3 = kind (4-byte BE int).
    kind, pubkey and identifier are all required for a valid naddr."""
    try:
        s = entity.lower()
        if not s.startswith("naddr1"):
            return None
        five = [_BECH32_CHARSET.find(c) for c in s[s.rfind("1") + 1:]]
        if len(five) < 7 or any(v < 0 for v in five):
            return None
        data = bech32.convertbits(five[:-6], 5, 8, False)  # drop 6-char checksum
        if data is None:
            return None
        kind = pubkey = identifier = None
        relays = []
        i = 0
        while i + 1 < len(data):
            t, ln = data[i], data[i + 1]
            val = bytes(data[i + 2:i + 2 + ln])
            if len(val) != ln:
                return None
            if t == 0:
                identifier = val.decode("utf-8", "replace")
            elif t == 1:
                relays.append(val.decode("utf-8", "replace"))
            elif t == 2:
                pubkey = val.hex()
            elif t == 3:
                kind = int.from_bytes(val, "big")
            i += 2 + ln
        if kind is None or pubkey is None or identifier is None or len(pubkey) != 64:
            return None
        return {"kind": kind, "pubkey": pubkey, "identifier": identifier, "relays": relays}
    except Exception:
        return None

def web_links_for_message(message):
    """(emoji, url) for each distinct featurable naddr in `message`, in
    first-seen order. Many Nostr clients don't render an embedded naddr, so the
    boost note carries a web link too — a plektos.app view for NIP-52 calendar
    events, a mynostr.app view for NIP-23 articles, a shopstr.store view for
    NIP-99 listings. naddrs whose kind isn't in
    _WEB_LINK_BY_KIND and malformed tokens are skipped; an event referenced
    twice in one message yields one link (dedupe on coordinate)."""
    if not message or "naddr1" not in message.lower():
        return []
    links, seen = [], set()
    for m in _NADDR_RE.finditer(message):
        token = m.group(0).lower()
        decoded = decode_naddr(token)
        link = decoded and _WEB_LINK_BY_KIND.get(decoded["kind"])
        if not link:
            continue
        coordinate = f'{decoded["kind"]}:{decoded["pubkey"]}:{decoded["identifier"]}'
        if coordinate in seen:
            continue
        seen.add(coordinate)
        emoji, url_tmpl = link
        links.append((emoji, url_tmpl.format(naddr=token)))
    return links

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

# Episode-title values that carry no episode: an app that couldn't resolve what
# the listener was playing sends a placeholder rather than omitting the field.
# PodcastGuru sends "0" (the same sentinel it uses for feedId), others send the
# JS/JSON primitives. Treated as "no episode" everywhere, never as a title.
JUNK_EPISODE_TITLES = {"", "0", "00", "000", "-", "--", "n/a", "na",
                       "none", "null", "undefined", "unknown"}

def is_junk_episode_title(title):
    return (title or "").strip().lower() in JUNK_EPISODE_TITLES

# Shortest title fragment allowed to match an RSS episode by containment. A
# boostagram title is either the full episode title or a truncation of it, so a
# genuine match always shares a long run of characters; anything shorter is a
# coincidence. This is the guard that was missing when a title of "0" matched
# "…| Ep. 024" and linked a boost to an episode nobody boosted.
MIN_TITLE_MATCH_CHARS = 10

def get_episode_url_from_rss(ep_title, cache=None):
    """Title-based RSS lookup used as a fallback for keysend boosts that come
    in with an episode title but no URL. Returns the user-facing Fountain URL
    from `<podcast:contentLink href="...">`, which carries the page-id used at
    fountain.fm/episode/{id}. (The enclosure URL pattern
    `items/{id}/files/...mp3` carries an unrelated audio-file id and was a
    previous source of broken links.)

    Matching, most trustworthy first:
      1. `Ep. NNN` in the boostagram title → the RSS item with that number.
      2. Containment either way, but only when the shorter of the two strings
         is at least MIN_TITLE_MATCH_CHARS long.

    Returns None when nothing matches. A boost with no resolvable episode is
    published as a show-level boost — which NIP-73 represents natively — and
    that is strictly better than linking a plausible wrong episode."""
    if is_junk_episode_title(ep_title):
        return None

    index = build_rss_item_index(cache if cache is not None else make_cache())

    num = _extract_episode_number(ep_title)
    if num:
        entry = next((e for e in index.values() if e.get("episode_number") == num), None)
        if entry and entry.get("fountain_id"):
            return f"https://fountain.fm/episode/{entry['fountain_id']}"

    want = " ".join(ep_title.split()).casefold()
    for entry in index.values():
        rss_title = " ".join((entry.get("title") or "").split()).casefold()
        if not rss_title or not entry.get("fountain_id"):
            continue
        if ((want in rss_title or rss_title in want)
                and min(len(want), len(rss_title)) >= MIN_TITLE_MATCH_CHARS):
            return f"https://fountain.fm/episode/{entry['fountain_id']}"
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
        "kind_30078_by_d":       {},    # d-tag value -> list of ALL kind 30078 events sharing that #d
        "event_author":          {},    # event id -> author pubkey hex (or None if unfetchable)
        "title_cache":           {},    # episode_id  -> (title, guests) for Fountain pages
        "episode_id_map":        None,  # zero-padded ep number -> fountain_id (lazy disk-backed)
        "episode_id_map_dirty":  False,
        "castamatic_boosts":     {},    # boost url -> Castamatic JSON metadata
        "tardbox_boosts":        {},    # boost url -> parsed Tardbox HTML fields
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
                # A relay that won't serve the kind (e.g. `kinds not supported`)
                # answers CLOSED and then nothing — without this the loop blocks
                # on recv until the socket timeout, once per query.
                elif msg[0] in ("CLOSED", "NOTICE"):
                    print(f"  [warn] {relay} refused the 30078 query: "
                          f"{' '.join(str(x) for x in msg[1:])[:80]}")
                    ws.close()
                    break
            if event:
                break
        except Exception as e:
            print(f"  [warn] relay query failed {relay}: {e}")
    if cache is not None:
        cache["kind_30078"][payment_hash] = event
    return event

def fetch_all_kind_30078(d_value, relays=None, cache=None):
    """Query the V4V relay set for ALL kind 30078 events whose `d` tag matches
    d_value, unioned by event id across relays. Unlike fetch_kind_30078 (first
    match only), this collects every event to EOSE — required for boost_session
    reconciliation: since the 2026-07 widget retry fix, one logical boost emits
    one boost_receipt per round (parent + each retry), all sharing the same
    `d=boost_session` but signed by DIFFERENT per-round burner keys, so they do
    NOT replace each other on relays. Returns a list (possibly empty). Cached by
    d_value. Per-leg events use d=payment_hash, so a #d=boost_session query
    returns only receipts."""
    if cache is not None and d_value in cache["kind_30078_by_d"]:
        return cache["kind_30078_by_d"][d_value]
    if relays is None:
        relays = V4V_RELAYS
    by_id = {}
    for relay in relays:
        try:
            ws = websocket.create_connection(relay, timeout=10)
            ws.send(json.dumps(["REQ", "boostall", {"kinds": [30078], "#d": [d_value]}]))
            while True:
                msg = json.loads(ws.recv())
                if msg[0] == "EVENT":
                    by_id[msg[2]["id"]] = msg[2]
                elif msg[0] == "EOSE":
                    ws.close()
                    break
                elif msg[0] in ("CLOSED", "NOTICE"):   # see fetch_kind_30078
                    print(f"  [warn] {relay} refused the 30078 query: "
                          f"{' '.join(str(x) for x in msg[1:])[:80]}")
                    ws.close()
                    break
        except Exception as e:
            print(f"  [warn] relay query failed {relay}: {e}")
    events = list(by_id.values())
    if cache is not None:
        cache["kind_30078_by_d"][d_value] = events
    return events

def fetch_event_author(event_id, relays, cache=None):
    """Author pubkey (hex) of a Nostr event, looked up by id across `relays`.
    Returns None when no relay in the set returns the event — the caller
    decides whether that means retry or degrade.

    Built for the ob-boost-flow site-signed share notes (2026-08-24): a
    boost_receipt's share_status=published can't say WHO signed the share note
    (the site's own show key vs the donor's), and the publisher must not post
    its standalone next to a show-key note, so it checks the note's author
    here. Cached by event id, negatives included — within one run a re-query
    seconds later would answer the same.
    """
    if not event_id:
        return None
    if cache is not None and event_id in cache["event_author"]:
        return cache["event_author"][event_id]
    author = None
    for relay in relays:
        try:
            ws = websocket.create_connection(relay, timeout=10)
            ws.send(json.dumps(["REQ", "evauthor", {"ids": [event_id]}]))
            while True:
                msg = json.loads(ws.recv())
                if msg[0] == "EVENT":
                    author = msg[2].get("pubkey") or None
                    ws.close()
                    break
                elif msg[0] in ("EOSE", "CLOSED", "NOTICE"):
                    ws.close()
                    break
        except Exception as e:
            print(f"  [warn] relay query failed {relay}: {e}")
        if author:
            break
    if cache is not None:
        cache["event_author"][event_id] = author
    return author


def _receipt_share_info(receipts):
    """What the login widget did with the donor's own kind-1 boost note.

    The widget pre-signs that note BEFORE payment and stamps the outcome onto
    the boost_receipt, so the answer is known without a relay or API lookup:
    `share_status` is published / failed / declined / unavailable / anon, and
    `share_note` carries the note's event id whenever one was signed.

    Only "published" means a donor note exists. A receipt that predates these
    tags returns (None, None, None), which sends the boost down the OnlyBoosts
    lookup path instead — so shipping this ahead of the widget change is a
    no-op, not a wrong answer.

    `sender_name` (added with the ob-boost-flow site-signed notes, 2026-08-24)
    is the donor's typed display name, ≤40 chars — the widget stamps
    "A Local Bitcoiner" when left blank and an empty tag when `sender` carries
    an npub, so a non-empty value is exactly what the site's own note displays.

    Retries emit one receipt per round under the same boost_session; take the
    newest receipt that carries each tag, since a later round can only know
    more about the share than an earlier one did.
    """
    status = note_id = sender_name = None
    for r in sorted(receipts, key=lambda e: e.get("created_at", 0), reverse=True):
        tags = {t[0]: t[1] for t in r.get("tags", []) if len(t) >= 2}
        if not status and (tags.get("share_status") or "").strip():
            status  = tags["share_status"].strip()
            note_id = (tags.get("share_note") or "").strip() or None
        if not sender_name and (tags.get("sender_name") or "").strip():
            sender_name = tags["sender_name"].strip()
        if status and sender_name:
            break
    return status, note_id, sender_name


def _merge_receipt_outcomes(receipts, our_payment_hash):
    """Collapse every boost_receipt sharing a boost_session into one true outcome.

    Since 2026-07 the login widget retries a failed leg as a NEW single-leg
    boost that REUSES the parent boost_session and re-stamps the parent's full
    amount_total. So a logical boost can span several receipts under one
    `d=boost_session`, each covering a subset of the legs. We rebuild:

      intended    = max `amount` across receipts (the parent total; they agree)
      landed      = sum over recipients of the settled amount, resolving each
                    recipient (by address) to its BEST status across all
                    receipts (paid > uncertain > failed) so a leg that
                    failed-then-retried counts once, as paid. Distinct paid
                    payment_hashes for one address (a genuine double-pay) sum.
      uncertain   = same, for recipients whose best status is uncertain
      legs_failed = recipients whose best status is exactly `failed` (post-retry;
                    non-paid/uncertain/failed statuses e.g. skipped are ignored,
                    matching the receipt's own legs_failed = confirmed-only count)

    `our_payment_hash` is the leg that SETTLED on our node: whatever any receipt
    claims about it, it really paid, so its address is forced to paid (the node
    supersedes the receipt for our own leg; other legs land on nodes we can't
    see, so the receipts stay authoritative for them).

    Backward-compatible: a boost with no retries has exactly one receipt and this
    returns its own amount / amount_paid / amount_uncertain / legs_failed.

    Returns (intended_msats, paid_msats, uncertain_msats, legs_failed, sender).
    """
    receipts = [r for r in receipts
                if any(t[0] == "type" and len(t) >= 2 and t[1] == "boost_receipt"
                       for t in r.get("tags", []))]
    if not receipts:
        return 0, 0, 0, 0, ""

    RANK = {"paid": 3, "uncertain": 2, "failed": 1}
    intended = 0
    sender = ""
    by_addr = {}   # address -> {"rank", "status", "amt", "paid_hashes": {ph: msats}}

    for r in receipts:
        rtags = {t[0]: t[1] for t in r.get("tags", []) if len(t) >= 2}
        try:
            intended = max(intended, int(rtags.get("amount", 0) or 0))
        except Exception:
            pass
        if not sender:
            sender = (rtags.get("sender", "") or "").strip()
        for t in r.get("tags", []):
            if t[0] != "leg_result" or len(t) < 4:
                continue
            addr   = t[1] or ""
            try:    msats = int(t[2] or 0)
            except Exception: msats = 0
            status = t[3] or "failed"
            ph     = t[4] if len(t) >= 5 else ""
            # Our own leg really paid, regardless of what the receipt recorded.
            if our_payment_hash and ph == our_payment_hash:
                status = "paid"
            slot = by_addr.setdefault(addr, {"rank": 0, "status": "", "amt": 0,
                                             "paid_hashes": {}})
            if status == "paid" and ph:
                slot["paid_hashes"][ph] = msats
            if RANK.get(status, 0) > slot["rank"]:
                slot["rank"]   = RANK[status]
                slot["status"] = status
                slot["amt"]    = msats

    paid_msats = uncertain_msats = legs_failed = 0
    for slot in by_addr.values():
        if slot["status"] == "paid":
            paid_msats += sum(slot["paid_hashes"].values()) or slot["amt"]
        elif slot["status"] == "uncertain":
            uncertain_msats += slot["amt"]
        elif slot["status"] == "failed":
            legs_failed += 1
    return intended, paid_msats, uncertain_msats, legs_failed, sender

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

    Returns (npub_or_None, full_message_str, satoshis_or_None). `satoshis` is
    the donor's full intended boost amount as Fountain records it on the
    matched comment's `action` (present only on boost-type comments; None on
    plain Nostr replies). It's the exact donor intent — preferred over the
    fee-shrunk, divisor-back-calculated estimate for the published total."""
    if not episode_id:
        return None, "", None
    comments = fetch_fountain_comments(episode_id, cache)
    if not comments:
        return None, "", None

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
        return npub, (action.get("message", "") or ""), action.get("satoshis")

    if truncated_message:
        for item in comments:
            action = item.get("action", {})
            fmsg   = action.get("message", "") or ""
            if truncated_message in fmsg:
                pubkey = action.get("pubkey")
                npub   = hex_to_npub(pubkey) if pubkey else None
                return npub, fmsg, action.get("satoshis")
    return None, "", None

def _parse_value_lnaddress(value_block_xml):
    """Extract [{address, split}] for type='lnaddress' recipients from a
    <podcast:value> block. Node/keysend recipients are intentionally skipped —
    that mirrors what the website drops before renormalizing its split across
    the remaining lnaddress legs (the browser LNURL flow can't pay a keysend
    node), so the reconstructed weights match the legs that actually paid."""
    out = []
    if not value_block_xml:
        return out
    for attrs in re.findall(r'<podcast:valueRecipient\b([^>]*?)/?>', value_block_xml):
        if 'type="lnaddress"' not in attrs:
            continue
        a = re.search(r'address="([^"]*)"', attrs)
        s = re.search(r'split="([^"]*)"', attrs)
        if a and s and s.group(1).isdigit():
            out.append({"address": a.group(1), "split": int(s.group(1))})
    return out

def _parse_value_recipients(value_block_xml):
    """Extract [{address, split}] for EVERY recipient in a <podcast:value>
    block, regardless of type.

    Deliberately different from `_parse_value_lnaddress`, which drops node/
    keysend recipients because the website's browser LNURL flow can't pay them.
    Every other rail (Fountain BOLT11, keysend boostagrams, Castamatic, Tardbox)
    pays all the legs, so reconstructing a total from one of them has to
    renormalize over the whole block or it over-states the total."""
    out = []
    if not value_block_xml:
        return out
    for attrs in re.findall(r'<podcast:valueRecipient\b([^>]*?)/?>', value_block_xml):
        a = re.search(r'address=["\']([^"\']*)["\']', attrs)
        s = re.search(r'split=["\']([^"\']*)["\']', attrs)
        if not a or not s:
            continue
        try:
            weight = float(s.group(1))
        except ValueError:
            continue
        if weight <= 0:
            continue
        out.append({"address": a.group(1).strip(), "split": weight})
    return out


def _rss_text(s):
    """Decode the handful of XML entities that appear in LB feed titles."""
    return ((s or "").replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
            .strip())

def build_rss_item_index(cache):
    """Parse the LB RSS feed once per run and return a dict keyed by the
    item's <guid>. Each value is a dict with:

      title        str | None  the item's <title>, entity-decoded. Lets a boost
                               that arrives with an episode guid but no usable
                               title (some keysend apps) still name its episode.
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
      value_lnaddress list[{address,split}]  per-item <podcast:value> lnaddress
                               recipients + weights, used by
                               `_website_intended_from_rss` to reconstruct a
                               website boost's intended total from one leg.

    Also stashes the channel-level lnaddress value block on
    `cache["channel_value_lnaddress"]` (for show-level website boosts).

    Cached on the per-run cache dict so the RSS parse only runs once. Used by
    `_classify_website` to (a) link website boosts to the right Fountain page
    and (b) merge their per-episode aggregation buckets with Fountain BOLT11
    boosts on the same episode, plus to populate guest npubs in the boost
    note's 🎙️ line so guest zap splits get included automatically."""
    if cache["guid_to_fountain"] is not None:
        return cache["guid_to_fountain"]
    index = {}
    num_index = {}
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
            vb = re.search(r'<podcast:value\b.*?</podcast:value>', item_xml, re.DOTALL)
            vb_xml = vb.group(0) if vb else ""
            tm    = re.search(r'<title[^>]*>([^<]*)</title>', item_xml)
            title = _rss_text(tm.group(1)) if tm else None
            num   = _extract_episode_number(title) if title else None
            index[guid] = {
                "guid":            guid,
                "fountain_id":     fountain_id,
                "title":           title,
                "guests":          guests,
                "value_lnaddress": _parse_value_lnaddress(vb_xml),
                "value_all":       _parse_value_recipients(vb_xml),
                "episode_number":  num,
            }
            # Secondary index — the non-website classifiers know the episode
            # number (off the title) but not always the RSS <guid>.
            if num:
                num_index.setdefault(num, index[guid])
        # Channel-level value block (outside any <item>) for show-level boosts.
        chan_xml = re.sub(r'<item>.*?</item>', '', rss, flags=re.DOTALL)
        chan_vb  = re.search(r'<podcast:value\b.*?</podcast:value>', chan_xml, re.DOTALL)
        chan_vb_xml = chan_vb.group(0) if chan_vb else ""
        cache["channel_value_lnaddress"] = _parse_value_lnaddress(chan_vb_xml)
        cache["channel_value_all"]       = _parse_value_recipients(chan_vb_xml)
    except Exception as e:
        print(f"  [warn] RSS item index build failed: {e}")
        # Publishers check this: with no RSS the feed gate and episode lookups
        # run blind, and "accept on uncertainty" would misfile other shows.
        cache["rss_index_failed"] = True
    cache["guid_to_fountain"] = index
    cache["num_to_rss_item"]  = num_index
    return index

_FOUNTAIN_SHOW_RE = re.compile(r'fountain\.fm/show/([A-Za-z0-9_-]+)')

def _fountain_episode_feed(episode_url, cache):
    """Positively classify a Fountain episode's FEED by reading its page.

    Returns:
      'lb'      — the page carries LB's show id or feed guid
      'other'   — the page loaded and links a different show (positively not LB)
      'unknown' — the page couldn't be fetched/parsed (caller must NOT reject)

    Used to gate episode-level Fountain boosts/streams whose page id isn't a
    known LB RSS episode. Reading the page directly (rather than trusting the
    RSS item set) means an RSS-fetch failure — which empties that set — can't
    turn every Fountain boost into a false 'other'. Cached per-run by url; only
    consulted for un-recognized episodes, so the common LB case pays nothing."""
    fc = cache.setdefault("fountain_episode_feed", {})
    if episode_url in fc:
        return fc[episode_url]
    verdict = "unknown"
    try:
        html = requests.get(episode_url, timeout=10).text
        if LB_SHOW_ID in html or LB_FEED_GUID in html:
            verdict = "lb"
        elif _FOUNTAIN_SHOW_RE.search(html):
            verdict = "other"
        # page loaded but carries no show marker at all → stay 'unknown'
    except Exception as e:
        print(f"  [warn] Fountain feed check failed for {episode_url}: {e}")
    fc[episode_url] = verdict
    return verdict

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
      total_sats     int (rounded total_msats / 1000 — the headline figure;
                     for website boosts this is the sats that LANDED = confirmed
                     paid + uncertain, since uncertain legs are credited)
      intended_sats  int (donor's intended total; == total_sats unless a
                     website boost had a CONFIRMED-failed leg — then full intent)
      legs_failed    int (website only; count of CONFIRMED-failed legs, 0
                     otherwise — drives the "(N intended; M legs failed)" note.
                     Uncertain legs are NOT counted here — they're credited.)
      uncertain_sats int (website only; the portion of total_sats on UNCERTAIN
                     legs — credited but kept separate for audit; 0 otherwise)
      divisor        float (split divisor used; 1.0 for keysend / exact-intent)
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
        "intended_sats":  round(total_msats / 1000),
        "legs_failed":    0,
        "uncertain_sats": 0,
        "amount_method":  "",
        "divisor":        divisor,
        "sender_npub":    None,
        "sender_name":    None,
        "message":        "",
        "episode_id":     None,
        "episode_title":  None,
        "episode_url":    None,
        "episode_number": None,
        "item_guid":      None,
        "guests":         [],
        "app_name":       "",
        "boostagram":     None,
        "show_level":     False,
        "fountain_comment_pending": False,
        # Website only: what the login widget did with the donor's own
        # kind-1 share note, read off the kind-30078 boost_receipt. Decides
        # whether our standalone note claims the boost — see
        # onlyboosts_coverage.decide. None on every other source, and on
        # website boosts whose receipt predates the tag.
        "share_status":   None,
        "share_note_id":  None,
        "raw_tx":         None,
    }

_RECEIPT_NPUB_RE = re.compile(r"^npub1[02-9ac-hj-np-z]{58}$")

def _website_intended_from_rss(leg_msats, leg_recipient, item_guid, show_level, cache):
    """Reconstruct a website boost's intended total from a single leg using the
    episode's RSS <podcast:value> split, mirroring the website's distribution:
    keep only lnaddress recipients (the browser flow drops node/keysend legs)
    and renormalize across the rest, so total = leg_msats × Σweights ÷ leg_weight.

    This is what fixes the class of error where LB's leg isn't 33% of the total
    — e.g. an episode with a keysend-node guest recipient gets that recipient
    dropped and the remaining lnaddress weights renormalized, pushing reed's
    share above 33%. The flat divisor can't see that; the RSS weights can.

    Returns (intended_msats, leg_fraction) — (0, 0.0) when the leg recipient
    isn't in the block. CAVEAT: reads the CURRENT feed weights, so a split
    edited after the boost settled would skew it; still far better than the
    flat historical divisor for the common unchanged case, and only reached
    when neither a receipt nor an amount_total tag is available."""
    if leg_msats <= 0 or not leg_recipient:
        return 0, 0.0
    build_rss_item_index(cache)  # ensures item + channel value blocks parsed
    if show_level:
        recips = cache.get("channel_value_lnaddress") or []
    else:
        entry  = (cache.get("guid_to_fountain") or {}).get(item_guid or "") or {}
        recips = entry.get("value_lnaddress") or []
    total_weight = sum(r["split"] for r in recips)
    leg_weight   = next((r["split"] for r in recips
                         if r["address"].lower() == leg_recipient.lower()), 0)
    if leg_weight <= 0 or total_weight <= 0:
        return 0, 0.0
    intended = round(leg_msats * total_weight / leg_weight / 1000) * 1000
    return intended, leg_weight / total_weight

def _resolve_website_amounts(receipt_paid, receipt_uncertain, receipt_intended,
                             receipt_legs_failed, leg_amount_total, rss_intended,
                             rss_frac, leg_msats, fallback_divisor):
    """Resolve a website boost's headline + intended totals from the best
    available source, in descending order of trust:

      1. boost_receipt → headline = amount_paid + amount_uncertain (sats that
                         LANDED). UNCERTAIN legs (payment couldn't be confirmed
                         — e.g. an NWC reply was lost) are credited as
                         successful per policy: no-confirmation ≠ no-payment, and
                         we'd rather over-credit a rare phantom than under-credit
                         a real boost. Only CONFIRMED `failed` legs are excluded
                         (and surface in legs_failed → the note's "(N intended;
                         M legs failed)"). The uncertain portion is returned
                         separately so the ledger keeps the audit split.
      2. 30078 amount_total → the donor's exact intended total, stamped on the
                         per-leg event, which is presigned + published BEFORE
                         payment — as reliable as the leg event the bot already
                         requires. No per-leg outcome on a presigned event, so
                         we assume full payment: headline = intended.
      3. RSS-split reconstruction → per-episode weights (handles episodes whose
                         LB leg isn't 33%). headline = intended.
      4. flat divisor → last resort (the historical coarse estimate).

    Returns (total_msats, intended_msats, legs_failed, divisor, method,
    uncertain_msats). `method` is the audit label in total_sats_method;
    `uncertain_msats` is the unconfirmed portion of the headline (0 outside
    the receipt tier)."""
    landed = receipt_paid + receipt_uncertain
    if landed > 0:
        intended = receipt_intended if receipt_intended > 0 else landed
        return landed, intended, max(receipt_legs_failed, 0), 1.0, "boost receipt", receipt_uncertain
    if leg_amount_total > 0:
        return leg_amount_total, leg_amount_total, 0, 1.0, "30078 amount_total", 0
    if rss_intended > 0:
        return rss_intended, rss_intended, 0, round(rss_frac, 4), "rss split", 0
    total = round(leg_msats / fallback_divisor) if fallback_divisor else leg_msats
    return total, total, 0, fallback_divisor, "sat math", 0

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

    # The donor's intended total, stamped on the per-leg 30078 (presigned +
    # published before payment, so reliably present). Primary fallback when
    # the receipt is missing. The recipient address keys the RSS-split
    # reconstruction below.
    try:
        leg_amount_total = int(tags.get("amount_total", 0) or 0)
    except Exception:
        leg_amount_total = 0
    leg_recipient = tags.get("recipient", "") or ""

    # Exact donor intent + actual outcome, MERGED across every boost_receipt
    # sharing this boost_session. Receipts use d=boost_session; per-leg events
    # use d=payment_hash, so #d=boost_session returns only receipts. Since the
    # 2026-07 retry fix a logical boost emits one receipt per round (parent +
    # each retry — distinct burner authors, same session), so we union them:
    # intended = parent total, landed = distinct settled legs resolved per
    # recipient (paid>uncertain>failed), our own node leg forced to paid. See
    # _merge_receipt_outcomes. _resolve_website_amounts then makes the headline
    # the actual-landed figure, falling back to the leg amount_total / divisor
    # when no receipt is on relays yet (indexing race, or a pre-receipt boost).
    boost_session = tags.get("boost_session", "") or ""
    receipts = fetch_all_kind_30078(boost_session, cache=cache) if boost_session else []
    (r_intended_msats, r_paid_msats, r_uncertain_msats,
     r_legs_failed, r_sender) = _merge_receipt_outcomes(receipts, payment_hash)
    share_status, share_note_id, receipt_sender_name = _receipt_share_info(receipts)

    # Recover attribution for an anon (burner-signed) leg from the boost
    # receipt's claimed sender npub. When a donor's signer is unavailable (e.g.
    # a mobile wallet that pays over NWC but can't sign), the per-leg 30078
    # falls back to a burner key with an EMPTY sender — published as Anon — even
    # though the donor was logged in. The receipt, published from the same boost
    # session, still carries their npub as a claimed tag. We only reach this code
    # because the node RECEIVED this leg as a SETTLED payment, so a forged
    # receipt with no payment behind it never gets here; the sole residual risk
    # is a donor spending real sats while claiming someone else's npub — a
    # self-funded, pointless attack. So for a real paid boost we trust the claim.
    # A cryptographically-signed leg sender (non-empty) always takes precedence.
    if not sender_npub and _RECEIPT_NPUB_RE.match(r_sender):
        sender_npub = r_sender
        print(f"  [info] website boost {payment_hash[:12]}... — anon leg; "
              f"attributed to receipt's claimed sender {r_sender[:20]}...")

    # Display name for boosts with no npub, from the receipt's sender_name tag
    # ("A Local Bitcoiner" when the donor typed nothing). Gated on no npub to
    # keep the sats.csv convention that sender_npub and sender_name are
    # mutually exclusive; _sender_display prefers the npub anyway. Receipts
    # predating the tag leave this None → _sender_display's "Anon" fallback.
    sender_name = receipt_sender_name if not sender_npub else None

    # ── Show-level branch ──
    if ep_num_padded is None:
        rss_intended, rss_frac = _website_intended_from_rss(
            leg_msats, leg_recipient, None, True, cache)
        total_msats, intended_msats, legs_failed, divisor, amount_method, uncertain_msats = _resolve_website_amounts(
            r_paid_msats, r_uncertain_msats, r_intended_msats, r_legs_failed,
            leg_amount_total, rss_intended, rss_frac, leg_msats, WEBSITE_SHOW_DIVISOR)

        info = _new_info("website", payment_hash, settled_at, our_msats, total_msats, divisor)
        info.update({
            "sender_npub":   sender_npub,
            "sender_name":   sender_name,
            "message":       event.get("content", "") or "",
            "episode_id":    LB_SHOW_ID,
            "episode_title": LB_SHOW_TITLE,
            "episode_url":   LB_SHOW_URL,
            "guests":        [],
            "app_name":      "localbitcoiners.com",
            "show_level":    True,
            "share_status":  share_status,
            "share_note_id": share_note_id,
            "intended_sats": round(intended_msats / 1000),
            "legs_failed":   legs_failed,
            "uncertain_sats": round(uncertain_msats / 1000),
            "amount_method": amount_method,
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

    # Resolve the headline (actual-landed) + intended totals via the fallback
    # chain: boost_receipt → 30078 amount_total → RSS-split reconstruction →
    # flat divisor. See _resolve_website_amounts.
    rss_intended, rss_frac = _website_intended_from_rss(
        leg_msats, leg_recipient, item_guid, False, cache)
    total_msats, intended_msats, legs_failed, divisor, amount_method, uncertain_msats = _resolve_website_amounts(
        r_paid_msats, r_uncertain_msats, r_intended_msats, r_legs_failed,
        leg_amount_total, rss_intended, rss_frac, leg_msats, get_divisor(settled_at))

    info = _new_info("website", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    sender_npub,
        "sender_name":    sender_name,
        "message":        event.get("content", "") or "",
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": ep_num_padded,
        "item_guid":      item_guid or None,
        "guests":         guests,
        "app_name":       "localbitcoiners.com",
        "share_status":   share_status,
        "share_note_id":  share_note_id,
        "intended_sats":  round(intended_msats / 1000),
        "legs_failed":    legs_failed,
        "uncertain_sats": round(uncertain_msats / 1000),
        "amount_method":  amount_method,
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
    feed_unverified = False   # feed gate couldn't positively place the episode
    if parsed:
        episode_url = parsed.get("episode_url")
        episode_id  = parsed.get("episode_id")

        # Castamatic dispatch — its URL is a public boost-metadata endpoint.
        if episode_url and "castamatic.com" in episode_url:
            return _classify_castamatic_boost(tx, parsed, payment_hash, settled_at, our_msats, cache)

        # Tardbox / BoostMeBitch dispatch — its URL is a public HTML boost page.
        if episode_url and "tardbox.com/boost/" in episode_url:
            return _classify_tardbox_boost(tx, parsed, payment_hash, settled_at, our_msats, cache)

        show_level  = "/show/" in (episode_url or "")

        # Feed gate (genuine Fountain URLs only — Castamatic/Tardbox already
        # dispatched above). Show-level URLs carry the show id inline; reject a
        # non-LB show outright. Episode-level URLs carry a Fountain page id: if
        # it's a known LB RSS episode we're done; otherwise positively check the
        # episode page's feed and reject only a confirmed OTHER show (a fresh LB
        # episode or an unreachable page is kept — never dropped on uncertainty).
        if episode_url and "fountain.fm" in episode_url:
            if show_level:
                sid = episode_url.rstrip("/").split("/show/")[-1].split("/")[0]
                if sid and sid != LB_SHOW_ID:
                    print(f"  [skip] Fountain show boost {payment_hash[:12]}… "
                          f"not Local Bitcoiners (show={sid!r})")
                    return None
            elif episode_id:
                _lb_ids = {v.get("fountain_id") for v in build_rss_item_index(cache).values()
                           if v.get("fountain_id")}
                if episode_id not in _lb_ids:
                    feed = _fountain_episode_feed(episode_url, cache)
                    if feed == "other":
                        print(f"  [skip] Fountain boost {payment_hash[:12]}… episode "
                              f"{episode_id!r} belongs to another show — not Local Bitcoiners")
                        return None
                    if feed == "unknown":
                        feed_unverified = True
                        print(f"  [review] Fountain boost {payment_hash[:12]}… episode "
                              f"{episode_id!r} not in LB RSS and feed unconfirmed — "
                              f"accepting; verify if unexpected")

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

        sender_npub, full_message, fountain_sats = lookup_fountain_sender(episode_id, settled_at, message, cache)
        if full_message:
            message = strip_fountain_trailer(full_message.strip())
        if is_undefined and not message:
            message = NO_COMMENT_PLACEHOLDER

        # The donor left a BOLT11 memo but lookup_fountain_sender found no
        # matching Fountain comment — almost always a propagation race: the
        # comment was posted seconds ago and Fountain's API hasn't indexed it
        # yet. Flag it so boost-publisher defers and retries on a later poll,
        # recovering the sender npub and the full (often truncated) message.
        comment_pending = (
            not full_message
            and not is_undefined
            and bool((parsed.get("message") or "").strip())
        )
    else:
        episode_url, episode_id, episode_title, guests = None, None, None, []
        message, sender_npub = "", None
        comment_pending = False
        fountain_sats = None

    # Prefer Fountain's recorded donor intent (the matched comment's
    # `action.satoshis` — the full boost amount the donor entered, exact)
    # over back-calculating from the fee-shrunk leg via the split divisor.
    # Fall back to the divisor estimate for anonymous / no-comment boosts
    # where no comment matched (and for show-level boosts, whose comment
    # lookup keys on the show id and returns nothing).
    episode_number = _extract_episode_number(episode_title)
    if fountain_sats and int(fountain_sats) > 0:
        total_msats = int(fountain_sats) * 1000
        divisor     = 1.0
        amount_method = "fountain api"
    else:
        divisor, amount_method = resolve_divisor(
            settled_at, cache, episode_number=episode_number,
            show_level=show_level, our_msats=our_msats,
            label=f"fountain boost {payment_hash[:12]}...")
        total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_boost", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    sender_npub,
        "message":        message,
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": episode_number,
        "amount_method":  amount_method,
        "guests":         guests or [],
        "app_name":       "Fountain",
        "show_level":     show_level,
        "fountain_comment_pending": comment_pending,
        "feed_unverified": feed_unverified,
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

    Donor `message` comes from the JSON (full text), falling back to the
    BOLT11 LNURL-comment if the fetch fails. `source` stays "fountain_boost"
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

    # Feed gate. Castamatic's JSON can carry feed identity (title / url / id);
    # reject only when it POSITIVELY names a different feed. Unlike keysend we
    # don't reject on ABSENT here — BOLT11 boost metadata is spottier and the
    # item_guid→LB-RSS resolution below is the positive-LB path, so an
    # absent-feed-field Castamatic boost must not be dropped.
    # Castamatic's JSON uses `feed_title` + `feed_guid` (confirmed against live
    # boost payloads); the other key spellings are defensive for other apps that
    # reuse this rss::payment::boost <json-url> convention.
    _cm_verdict = lb_feed_verdict({
        "feed_id":  (boost_data.get("feed_id") or boost_data.get("feedID")
                     or boost_data.get("feedId")),
        "feed_url": (boost_data.get("feed_url") or boost_data.get("feedUrl")
                     or boost_data.get("url")),
        "title":    (boost_data.get("feed_title") or boost_data.get("podcast")
                     or boost_data.get("podcast_title")),
        "guid":     (boost_data.get("feed_guid") or boost_data.get("guid")
                     or boost_data.get("podcast_guid") or boost_data.get("feedGuid")),
    })
    if _cm_verdict == FEED_OTHER:
        print(f"  [skip] Castamatic boost {payment_hash[:12]}… not Local Bitcoiners "
              f"(feed=other, title={boost_data.get('podcast')!r})")
        return None

    sender_name = boost_data.get("sender_name") or None
    item_title  = boost_data.get("item_title")
    item_guid   = boost_data.get("item_guid", "")
    app_name    = boost_data.get("app_name") or "Castamatic"

    # Donor message. Castamatic DOES expose it — both in the JSON `message`
    # field and (truncation aside) in the BOLT11 LNURL-comment that
    # parse_description already pulled into parsed["message"]. Prefer the
    # JSON (full, untruncated); fall back to the description so a failed
    # Castamatic fetch (boost_data == {}) still recovers the memo. Same
    # `undefined` → placeholder handling the keysend / Fountain paths use.
    message = boost_data.get("message") or parsed.get("message", "") or ""
    if message.strip().lower() == "undefined":
        message = NO_COMMENT_PLACEHOLDER

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
        amount_method = "castamatic api"
    else:
        divisor, amount_method = resolve_divisor(
            settled_at, cache, item_guid=item_guid or None,
            episode_number=episode_number, our_msats=our_msats,
            label=f"castamatic boost {payment_hash[:12]}...")
        total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_boost", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    None,
        "sender_name":    sender_name,
        "message":        message,
        "episode_id":     episode_id,
        "episode_title":  item_title,
        "episode_url":    episode_url,
        "episode_number": episode_number,
        "amount_method":  amount_method,
        "item_guid":      item_guid or None,
        "guests":         guests,
        "app_name":       app_name,
        "raw_tx":         tx,
    })
    if episode_id:
        _record_episode_id(cache, episode_number, episode_id)
    return info

# Tardbox renders its per-boost page as server-side HTML (no JSON API). Each
# row is a `<div class="boost-field"><strong class="boost-label">Label:</strong>
# <span class="boost-value...">Value</span></div>`. We pull the rows we care
# about by label.
TARDBOX_FIELD_RE = re.compile(
    r'<div class="boost-field">'
    r'<strong class="boost-label">([^<]+):</strong>'
    r'<span class="boost-value[^"]*">([^<]*)</span>'
    r'</div>'
)
# "⚡ 420 sats" → 420. Tolerant to commas in case Tardbox ever formats them.
TARDBOX_SATS_RE = re.compile(r'([\d,]+)\s*sats?', re.IGNORECASE)

def _parse_tardbox_page(html_text):
    """Pull the labeled rows off a Tardbox boost page into a dict. Returns {}
    on a page that doesn't match the expected layout (Tardbox redesign, error
    page, etc.) so callers can degrade gracefully."""
    out = {}
    for label, value in TARDBOX_FIELD_RE.findall(html_text):
        out[label.strip()] = html.unescape(value).strip()
    return out

def _classify_tardbox_boost(tx, parsed, payment_hash, settled_at, our_msats, cache):
    """Tardbox / BoostMeBitch BOLT11 boost — dispatched from
    `_classify_fountain_boost` when the URL host is `tardbox.com/boost/`.
    Tardbox has no JSON API, so we fetch the boost page and regex out the
    labeled fields (From, Amount, Episode, App, Message). Sender identity
    arrives as `nostr:npub1...` in the "From:" field; we strip the prefix and
    let the standard render path turn it into a mention.

    Maps the episode title's "Ep. NNN" to a Fountain page id via the same
    `lb_episode_ids.json` fallback the Castamatic path uses, so the published
    note still links to fountain.fm. `source` stays "fountain_boost"; app_name
    comes off the page (typically "BoostMeBitch"). The sat total is read
    directly from the page rather than back-calculated from the split divisor,
    since the page reports donor intent exactly."""
    boost_url = parsed.get("episode_url") or ""
    fc        = cache.setdefault("tardbox_boosts", {})
    if boost_url in fc:
        page = fc[boost_url]
    else:
        page = {}
        try:
            resp = requests.get(boost_url, timeout=10)
            resp.raise_for_status()
            page = _parse_tardbox_page(resp.text)
        except Exception as e:
            print(f"  [warn] Tardbox fetch failed for {boost_url}: {e}")
        fc[boost_url] = page

    # Feed gate. Tardbox/BMB renders the feed title (and sometimes a feed URL)
    # as labeled rows; reject only when they POSITIVELY name a different feed.
    # As with Castamatic, don't drop on ABSENT — the episode-number→Fountain-id
    # resolution below is the positive-LB path.
    # Tardbox labels the feed/show name row `Show` (confirmed against live boost
    # pages); it exposes no feed URL or guid row, so title is the only signal.
    _tb_verdict = lb_feed_verdict({
        "feed_id":  None,
        "feed_url": page.get("Feed") or page.get("URL") or page.get("Feed URL"),
        "title":    page.get("Show") or page.get("Podcast"),
        "guid":     page.get("GUID") or page.get("Podcast GUID"),
    })
    if _tb_verdict == FEED_OTHER:
        print(f"  [skip] Tardbox/BMB boost {payment_hash[:12]}… not Local Bitcoiners "
              f"(feed=other, title={page.get('Podcast')!r})")
        return None

    sender_npub = None
    sender_name = None
    raw_from    = page.get("From", "")
    if raw_from.startswith("nostr:npub1"):
        sender_npub = raw_from[len("nostr:"):]
    elif raw_from:
        sender_name = raw_from

    item_title  = page.get("Episode") or None
    app_name    = page.get("App") or "BoostMeBitch"
    # Pass the donor's message through unchanged. Unlike the Fountain comments
    # API (which appends nostr:/URL metadata we have to strip), Tardbox renders
    # exactly what the donor typed — any nostr: mention or URL in there is
    # intentional and should render as written. nostrify_mentions in the note
    # formatter will leave already-prefixed nostr: entities alone.
    message = (page.get("Message") or "").strip()

    # Map "Ep. NNN" → Fountain page id via the shared fallback map. (No RSS
    # item_guid available from Tardbox, so this map is the only path.)
    episode_number = _extract_episode_number(item_title)
    fountain_id    = None
    guests         = []
    if episode_number:
        fallback_map = _ensure_episode_id_map(cache)
        fountain_id  = fallback_map.get(episode_number)
        if fountain_id:
            # Fountain page also yields the guest list, so reuse the cached
            # scrape if we have one (built up by Fountain-source boosts on the
            # same episode); otherwise leave guests empty rather than paying
            # the scrape on a Tardbox-only run.
            title_pair = cache["title_cache"].get(fountain_id)
            if title_pair:
                guests = title_pair[1] or []

    if fountain_id:
        episode_id  = fountain_id
        episode_url = f"https://fountain.fm/episode/{fountain_id}"
    else:
        episode_id  = None
        episode_url = None

    # Prefer the page's reported total (donor intent). Fall back to the split-
    # divisor calc if the page didn't yield a parseable "Amount:" row.
    total_msats = 0
    sats_raw    = page.get("Amount", "")
    if sats_raw:
        m = TARDBOX_SATS_RE.search(sats_raw)
        if m:
            try:
                total_msats = int(m.group(1).replace(",", "")) * 1000
            except Exception:
                total_msats = 0
    if total_msats > 0:
        divisor = 1.0
        amount_method = "tardbox"
    else:
        divisor, amount_method = resolve_divisor(
            settled_at, cache, episode_number=episode_number,
            our_msats=our_msats,
            label=f"tardbox boost {payment_hash[:12]}...")
        total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_boost", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "sender_npub":    sender_npub,
        "sender_name":    sender_name,
        "message":        message,
        "episode_id":     episode_id,
        "episode_title":  item_title,
        "episode_url":    episode_url,
        "episode_number": episode_number,
        "amount_method":  amount_method,
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

    # Feed gate — mirror the boost path so streams to OTHER Fountain-hosted
    # podcasts that split to this address don't land in LB stats. Show-level
    # streams for a different show are rejected; episode-level streams for an
    # unknown episode get the positive page check and are rejected only on a
    # confirmed OTHER show (fresh LB episode / unreachable page is kept).
    if show_level:
        sid = show_match.group(1).split("/")[0]
        if sid and sid != LB_SHOW_ID:
            print(f"  [skip] Fountain show stream {payment_hash[:12]}… "
                  f"not Local Bitcoiners (show={sid!r})")
            return None
    elif episode_id:
        _lb_ids = {v.get("fountain_id") for v in build_rss_item_index(cache).values()
                   if v.get("fountain_id")}
        if episode_id not in _lb_ids:
            feed = _fountain_episode_feed(episode_url, cache)
            if feed == "other":
                print(f"  [skip] Fountain stream {payment_hash[:12]}… episode "
                      f"{episode_id!r} belongs to another show — not Local Bitcoiners")
                return None
            if feed == "unknown":
                print(f"  [review] Fountain stream {payment_hash[:12]}… episode "
                      f"{episode_id!r} not in LB RSS and feed unconfirmed — accepting")

    episode_number = _extract_episode_number(episode_title)
    divisor, amount_method = resolve_divisor(
        settled_at, cache, episode_number=episode_number, show_level=show_level,
        our_msats=our_msats, label=f"fountain stream {payment_hash[:12]}...")
    total_msats = round(our_msats / divisor) if divisor else our_msats

    info = _new_info("fountain_stream", payment_hash, settled_at, our_msats, total_msats, divisor)
    info.update({
        "episode_id":     episode_id,
        "episode_title":  episode_title,
        "episode_url":    episode_url,
        "episode_number": episode_number,
        "amount_method":  amount_method,
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
    # Feed gate. The node is a shared LN split recipient, so a keysend boost is
    # only ours if the boostagram positively identifies the LB feed. Reject
    # anything that names a different feed AND the (near-impossible) case where
    # no feed signal is present at all — every real keysend boost observed on
    # the node carries at least the `podcast` title, so ABSENT here is a red
    # flag worth logging rather than silently trusting.
    verdict = lb_feed_verdict(_keysend_feed_meta(boostagram))
    if verdict != FEED_MATCH:
        print(f"  [skip] keysend boost {payment_hash[:12]}… not Local Bitcoiners "
              f"(feed={verdict}, podcast={boostagram.get('podcast')!r}, "
              f"feedId={boostagram.get('feedId')!r}, url={boostagram.get('url')!r})")
        return None

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

    # RSS item GUID for the episode, if the boostagram TLV carries it. Key name
    # varies by app (Podcasting 2.0 spec uses `episode_guid`; some send camelCase
    # or `item_guid`). Feeds the NIP-73 podcast:item:guid tag.
    item_guid = (boostagram.get("episode_guid") or boostagram.get("episodeGuid")
                 or boostagram.get("item_guid") or boostagram.get("itemGuid") or "")

    # An app that couldn't resolve what the listener was playing sends a
    # placeholder title ("0", "undefined") rather than omitting the field.
    episode_title_raw = boostagram.get("episode", "") or ""
    if is_junk_episode_title(episode_title_raw):
        episode_title_raw = ""

    episode_url = boostagram.get("boostLink") or boostagram.get("boost_link", "") or ""

    # A guid identifies the episode exactly even when the title doesn't — the
    # feed knows both, so recover the title/link the boostagram failed to send.
    if item_guid:
        entry = build_rss_item_index(cache).get(item_guid) or {}
        if not episode_title_raw:
            episode_title_raw = entry.get("title") or ""
        if not episode_url and entry.get("fountain_id"):
            episode_url = f"https://fountain.fm/episode/{entry['fountain_id']}"

    if not episode_url and episode_title_raw:
        episode_url = get_episode_url_from_rss(episode_title_raw, cache) or ""

    guests = []
    if episode_url and "fountain.fm" in episode_url:
        _, guests = scrape_fountain_episode(episode_url)

    episode_id = None
    if episode_url and "fountain.fm" in episode_url:
        em = re.search(r'fountain\.fm/episode/([^/?\s]+)', episode_url)
        if em:
            episode_id = em.group(1)

    # Nothing identifies an episode: no guid, no usable title, no boost link.
    # That's a boost on the SHOW, which NIP-73 represents natively as the
    # feed-level podcast:guid pair — the same shape show-level Fountain and
    # website boosts already take. Publishing it this way is honest; the
    # alternative (guess an episode from a placeholder title) is what put a
    # boost on Ep. 024 that nobody made.
    show_level = not (item_guid or episode_id or episode_title_raw)
    if show_level:
        episode_id        = LB_SHOW_ID
        episode_title_raw = LB_SHOW_TITLE
        episode_url       = LB_SHOW_URL

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
        "item_guid":      item_guid or None,
        "guests":         guests or [],
        "app_name":       app_name,
        "show_level":     show_level,
        "boostagram":     boostagram,
        "raw_tx":         tx,
    })
    # Show-level boosts carry the show id in episode_id — never let it into the
    # episode_number → fountain_id map (mirrors the Fountain show-boost guard).
    if not show_level:
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

def resolve_item_guid(info, cache=None):
    """The RSS <guid> of the episode a boost is for, or None.

    Most sources hand us one directly (website, Castamatic, keysend
    boostagrams). Fountain and Tardbox/BMB boosts don't: they resolve to a
    Fountain page id or an "Ep. NNN" title, which is why their notes used to
    carry only the feed-level pair and landed on onlyboosts.social as
    show-level boosts with no episode. Both of those DO resolve through the
    RSS index we already build once per run — by episode number, else by
    Fountain page id — so the episode tag is recoverable for every source.

    Needs the per-run cache to reach the index; without one it can only return
    what the BoostInfo already carried.
    """
    if info.get("item_guid"):
        return info["item_guid"]
    # A show-level boost belongs to no episode, and its episode_id is the SHOW
    # id — never resolve one, or the fountain_id sweep below could pair it with
    # an episode. (No show id matches an item's fountain_id today; this keeps
    # that from being load-bearing.)
    if info.get("show_level"):
        return None
    if cache is None:
        return None

    index = build_rss_item_index(cache)          # cached after the first call
    num = info.get("episode_number")
    if num:
        entry = (cache.get("num_to_rss_item") or {}).get(num) or {}
        if entry.get("guid"):
            return entry["guid"]

    # episode_id is the Fountain page id for every Fountain-derived source.
    fountain_id = info.get("episode_id")
    if fountain_id:
        for guid, entry in index.items():
            if entry.get("fountain_id") == fountain_id:
                return guid
    return None


def build_podcast_guid_tags(info, cache=None):
    """NIP-73 external-content identity tags for a boost note.

    Feed-level GUID is always present (every boost is for Local Bitcoiners);
    the episode-level item GUID is added whenever one can be resolved — see
    resolve_item_guid. Mirrors the i/k pairs BoostMeBitch emits."""
    tags = [["i", f"podcast:guid:{LB_FEED_GUID}"], ["k", "podcast:guid"]]
    item_guid = resolve_item_guid(info, cache)
    if item_guid:
        tags.append(["i", f"podcast:item:guid:{item_guid}"])
        tags.append(["k", "podcast:item:guid"])
    return tags


def build_boost_claim_tags(info):
    """Payment-evidence tags that make our standalone note count AS the boost.

    Published ONLY when no donor-side note exists for the payment (see
    onlyboosts_coverage) and ONLY on the standalone note — never on the
    boost-board reply, which is the same text from the same npub and would
    double-count.

    What each tag is for:
      t=boost / boostagram / value4value   the topic tags NIP-73 boost
          consumers test for. Any one of them is sufficient; all three are what
          the website widget already emits, so a claimed note and a donor note
          look the same to a consumer.
      amount                                millisats, NIP-57 convention. THE
          FULL BOOST, not our node's split — the figure the note's own 💰 line
          shows, so text and tag can never disagree.
      client                                who published it. Honest: the show
          account published this note; the app the donor actually boosted from
          is named in the note's `📱 via X` line, which is the convention
          chadf_boostbot established and OnlyBoosts already parses into
          `client_via`.
      P                                     the donor's pubkey when we know it,
          uppercase per the NIP-57 sender convention. Deliberately NOT a
          lowercase `p`: bot boost notes have never notified donors and this
          must not change that.
    """
    tags = [
        ["t", "boost"],
        ["t", "boostagram"],
        ["t", "value4value"],
        ["amount", str(int(info.get("total_sats") or 0) * 1000)],
        ["client", "localbitcoiners.com"],
    ]
    # npub_to_hex returns None on a malformed npub (they arrive verbatim from
    # donor comments), so a typo costs the attribution tag, not the claim.
    hex_pk = npub_to_hex(info.get("sender_npub") or "")
    if hex_pk:
        tags.append(["P", hex_pk])
    return tags

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
    amount_line = f"💰 {info['total_sats']} sats 📱 via {info['app_name']}"
    # Partial website boost: the headline is the sats that ACTUALLY landed;
    # annotate with the donor's intended total and the failed-leg count. Only
    # website boosts expose per-leg outcomes, so legs_failed is 0 for every
    # other source and this parenthetical never fires for them.
    failed = info.get("legs_failed", 0) or 0
    if failed > 0:
        leg_word = "leg" if failed == 1 else "legs"
        amount_line += f" ({info['intended_sats']} sats intended; {failed} {leg_word} failed)"
    lines.append(amount_line)

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

    # Booster pasted an addressable event (naddr) into their message — a NIP-52
    # calendar event or a NIP-23 article — so add a web link for clients that
    # don't render an embedded naddr. One line per distinct event; the emoji is
    # kind-specific (📅 calendar / 📄 article). See web_links_for_message.
    for emoji, url in web_links_for_message(message):
        lines.append(f"{emoji} {url}")

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
