#!/usr/bin/env python3
"""
Shared Nostr utilities for all bots in this repo.
"""

import csv
import json
import re
import time
import hashlib
from datetime import datetime
from pathlib import Path
import bech32
import requests
import websocket
from pynostr.key import PrivateKey

# Small, fast bootstrap set used for metadata lookups (kind 0, kind 3, kind
# 10002). This is a READ set: a member that holds nothing costs latency on every
# lookup, so it's kept lean and re-measured rather than grown by reputation.
# Re-derived 2026-08-12 against the 92 booster pubkeys on the boost megathread
# (kind 0 / kind 3 / kind 10002 hit rate per relay):
#   nos.lol 92/97/84 · relay.ditto.pub 89/90/50 · nostr.mom 79/78/62
# Dropped: purplepag.es (41/59/35 — added zero marginal coverage once nos.lol
# and ditto were in, despite being the dedicated profile aggregator),
# relay.primal.net (12/22/7), relay.damus.io (71/78/45 but intermittently
# answers the WebSocket connect with HTTP 503, so it's a timeout on the
# critical path of every lookup).
BOOTSTRAP_RELAYS = [
    "wss://nos.lol",
    "wss://relay.ditto.pub",
    "wss://nostr.mom",
]

# Kind-1 publish set. Unioned with the author's kind-10002 outbox by
# `publish_to_nostr` (see there) — it is no longer a fallback that only fires
# when an account has no 10002, because the LB show account HAS a 10002 whose
# write set (damus / ditto / primal / pyramid) misses three of the four relays
# the website reads notes back from.
#
# A publish set answers "who will see this", which can't be measured from
# outside: an extra member costs one socket, an omission costs reach nobody can
# observe. So this list is deliberately generous — EXCEPT that everything here
# must be able to store what we send it. Re-derived 2026-08-12; the first four
# are exactly what localbitcoiners.com reads (399/399 known boosts from relays
# alone), so they are the audience this list has to reach:
#   relay.fountain.fm 92% of the megathread · relay.ditto.pub 88% ·
#   nos.lol 50% · nostr.mom 38%
# relay.damus.io (52%) and relay.primal.net stay for reach beyond the site —
# primal serves the mobile clients' cache even though it returns ~none of our
# notes on a direct REQ.
#
# Dropped 2026-08-12:
#   relay.getalby.com/v1 — NWC transport, not a general relay. It and the bare
#     host answer EVERY REQ with `blocked: Request rejected`, so a note
#     published there can never be read back by anyone. (NWC is unaffected: a
#     wallet connection carries its own relay in the connection string and
#     never consults this list.)
#   purplepag.es — accepts kinds 0/3/10002 only; measured 0% on kind 1 and has
#     never stored a boost note.
NOSTR_RELAYS = [
    "wss://relay.fountain.fm",
    "wss://relay.ditto.pub",
    "wss://nos.lol",
    "wss://nostr.mom",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
]

# Relays that accept kind 1 and nothing else. relay.fountain.fm answers a REQ
# for 30078 / 39089 / kind 0 with `kinds not supported` and returns no profile
# data at all — it's a note relay only. `publish_to_nostr` drops these for
# kind != 1 so the note path can keep fountain (mandatory: ~90% of Fountain
# boosts live only there) without the follow-pack and receipt paths wasting a
# socket on a guaranteed rejection.
#
# Reading from fountain has a second trap: it does NOT send EOSE on an
# unfiltered kind-1 REQ, so always filter by author, id or #e or the query
# hangs until timeout.
KIND1_ONLY_RELAYS = {
    "wss://relay.fountain.fm",
}

# Read-only base relay set for the community-scan boost/feed collector. This is
# NOT a publish set — keep it separate from NOSTR_RELAYS (the kind-1 publish
# set). It also answers a different question: where OTHER podcasts' boosts land,
# an audience whose relay ranking does not transfer to ours (chadf.nostr1.com
# and podtards.com score ~0% on our own notes; relay.ditto.pub is 88% for us
# against 32% there, because our boost notes have one bot author rather than
# dozens of distinct boosters). Re-measure per audience; never copy a table over.
# Chosen empirically 2026-07-24 by probing where NIP-73 podcast-boost notes
# actually land (see bots/boost-relay-landscape.md). Dropped purplepag.es /
# getalby / primal (profile/relay-list relays, ~0 boost notes) and added the
# bitcoin/podcasting relays that carry the most boost content. relay.fountain.fm
# is mandatory: ~90% of Fountain boosts live only there.
BOOST_SCAN_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.fountain.fm",
    "wss://nostr21.com",
    "wss://chadf.nostr1.com",
    "wss://podtards.com",
    "wss://nostr.mom",
    "wss://relay.wavlake.com",
]

def load_config(config_file):
    config = {}
    with open(config_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                config[k.strip()] = v.strip()
    return config

def scrape_fountain_episode(episode_url, timeout=10):
    """Fetch a Fountain episode page and pull out (title, guests).
    title   — the raw og:title with trailing ' • Listen on Fountain' stripped
              and standard HTML entities decoded; None on failure.
    guests  — list of npub1... strings parsed from a '[guests: npub1..., npub1...]'
              marker in the page HTML (empty list if no marker)."""
    title  = None
    guests = []
    try:
        resp = requests.get(episode_url, timeout=timeout)
        m = re.search(r'<meta property="og:title" content="([^"]+)"', resp.text)
        if m:
            t = m.group(1)
            t = re.sub(r'\s*•\s*Listen on Fountain$', '', t)
            t = (t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                  .replace('&quot;', '"').replace('&#x27;', "'"))
            title = t
        g = re.search(r'\[guests:\s*([^\]]*)\]', resp.text)
        if g and g.group(1).strip():
            guests = [n.strip() for n in g.group(1).split(",") if n.strip()]
    except Exception as e:
        print(f"  [warn] Fountain scrape failed for {episode_url}: {e}")
    return title, guests

def hex_to_npub(hex_pubkey):
    data      = bytes.fromhex(hex_pubkey)
    converted = bech32.convertbits(data, 8, 5)
    return bech32.bech32_encode('npub', converted)

def npub_to_hex(npub):
    """Convert npub bech32 to hex pubkey. Returns None if `npub` isn't one.

    Malformed npubs are routine, not exceptional: they reach us verbatim from
    donor boost comments and from the RSS [guests:] marker, and a single typo'd
    character makes bech32 undecodable. Returning None lets callers skip the one
    bad npub instead of aborting a whole publish run — a trailing 'j' on Ep. 019's
    guest npub crash-looped boost-publisher for 3.5 days (2026-07-09 → 07-12)."""
    try:
        hrp, data = bech32.bech32_decode(npub)
    except Exception:
        return None
    if hrp != "npub" or data is None:
        return None
    decoded = bech32.convertbits(data, 5, 8, False)
    if decoded is None or len(decoded) != 32:
        return None
    return bytes(decoded).hex()

def event_id_to_nevent(event_id_hex, author_hex=None):
    """Encode an event id as a NIP-19 nevent1... bech32 string.
    TLV payload: type 0 = event id (required), type 2 = author pubkey
    (optional, but strongly recommended — clients use it as a hint when
    fetching the referenced event from relays)."""
    tlv = bytearray()
    event_bytes = bytes.fromhex(event_id_hex)
    tlv.append(0x00)
    tlv.append(len(event_bytes))
    tlv.extend(event_bytes)
    if author_hex:
        author_bytes = bytes.fromhex(author_hex)
        tlv.append(0x02)
        tlv.append(len(author_bytes))
        tlv.extend(author_bytes)
    converted = bech32.convertbits(bytes(tlv), 8, 5)
    return bech32.bech32_encode('nevent', converted)


def record_published_leaderboard(leaderboard_name, event_id_hex, author_hex):
    """Append a row to the leaderboard publish log at <repo>/data/leaderboards.csv
    so we have a chronological record of every leaderboard nevent. The data/
    directory lives at the repo root (sibling of bots/) so the website can
    consume it directly. Schema: Date (local, human-readable), Leaderboard
    (script base name), nevent. Creates the file with a header if it doesn't
    exist."""
    log_file = Path(__file__).resolve().parent.parent.parent / "data/leaderboards.csv"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    nevent   = event_id_to_nevent(event_id_hex, author_hex=author_hex)
    # Match the existing CSV's date format ("Friday, May 1, 2026 · 8:34 PM").
    date_str = datetime.now().strftime("%A, %B %-d, %Y · %-I:%M %p")
    is_new   = not log_file.exists()
    with log_file.open("a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["Date", "Leaderboard", "nevent"])
        writer.writerow([date_str, leaderboard_name, f"nostr:{nevent}"])


def get_lud16(hex_pubkey, relays=None):
    """Query relays for a kind 0 profile and return the lud16 if present."""
    if relays is None:
        relays = BOOTSTRAP_RELAYS
    for relay in relays:
        try:
            ws     = websocket.create_connection(relay, timeout=10)
            sub_id = "lud16_" + hex_pubkey[:8]
            ws.send(json.dumps(["REQ", sub_id, {"kinds": [0], "authors": [hex_pubkey], "limit": 1}]))
            while True:
                msg    = ws.recv()
                parsed = json.loads(msg)
                if parsed[0] == "EVENT" and len(parsed) >= 3:
                    content = json.loads(parsed[2].get("content", "{}"))
                    lud16   = content.get("lud16", "")
                    ws.close()
                    return lud16 if lud16 else None
                elif parsed[0] == "EOSE":
                    ws.close()
                    break
        except Exception:
            continue
    return None

def get_follow_list(author_hex, relays=None):
    """Query relays for the author's most recent kind-3 (NIP-02 contact list).
    Returns (follows_hex, content, created_at, tags) from the latest event seen
    across all queried relays, or ([], "", 0, []) if no kind-3 was found.
    Callers should treat the returned tags as authoritative current state and
    append to it — do not replace."""
    if relays is None:
        relays = BOOTSTRAP_RELAYS
    best = None
    for relay in relays:
        try:
            ws     = websocket.create_connection(relay, timeout=10)
            sub_id = "follows_" + author_hex[:8]
            ws.send(json.dumps(["REQ", sub_id, {"kinds": [3], "authors": [author_hex], "limit": 1}]))
            while True:
                msg    = ws.recv()
                parsed = json.loads(msg)
                if parsed[0] == "EVENT" and len(parsed) >= 3:
                    event = parsed[2]
                    if best is None or event.get("created_at", 0) > best.get("created_at", 0):
                        best = event
                elif parsed[0] == "EOSE":
                    ws.close()
                    break
        except Exception:
            continue
    if not best:
        return [], "", 0, []
    tags    = best.get("tags", [])
    follows = [t[1] for t in tags if len(t) >= 2 and t[0] == "p"]
    return follows, best.get("content", ""), best.get("created_at", 0), tags

def follow_all(target_npubs, nsec, relays=None, dry_run=False):
    """Ensure the author's kind-3 follow list includes every npub in target_npubs.
    Fetches the most recent kind-3 across relays, appends a p-tag for each target
    npub not already followed, and republishes (or writes a dry-run preview).
    The author's own pubkey is skipped. Malformed npubs are skipped with a warning.
    Returns True if a kind-3 update was published/previewed, False if no-op."""
    if not target_npubs:
        return False

    pk         = PrivateKey.from_nsec(nsec)
    author_hex = pk.public_key.hex()

    target_hexes = []
    for n in target_npubs:
        h = npub_to_hex(n)
        if h is None:
            print(f"  [follow] skipping malformed npub: {n}")
            continue
        if h != author_hex:
            target_hexes.append(h)

    if not target_hexes:
        return False

    follows, content, _, tags = get_follow_list(author_hex, relays)
    follow_set = set(follows)

    # Dedupe target_hexes preserving order, then filter to only new additions.
    new_hexes = [h for h in dict.fromkeys(target_hexes) if h not in follow_set]
    if not new_hexes:
        print(f"  [follow] already following all {len(target_hexes)} target(s); no kind-3 update needed")
        return False

    new_tags = list(tags)
    for h in new_hexes:
        new_tags.append(["p", h])

    print(f"  [follow] adding {len(new_hexes)} new follow(s); prior list had {len(follows)} p-tags, new list has {sum(1 for t in new_tags if t and t[0] == 'p')}")

    if dry_run:
        path, _ = write_dry_run_event(
            content, nsec, prefix="follow-list", extra_tags=new_tags, kind=3,
        )
        print(f"  [dry-run] follow-list → {path}")
    else:
        print("  [follow] publishing updated kind-3...")
        publish_to_nostr(content, nsec, kind=3, extra_tags=new_tags, relays=relays)
    return True

def build_zap_split_tags(npubs, relays=None):
    """Build NIP-57 zap split tags for npubs that have a lud16.
    Equal weight for all. Skips npubs without a lightning address.
    `relays` doubles as the lookup pool (for kind 0 / lud16 resolution) AND the
    relay hint baked into each zap tag — defaults to BOOTSTRAP_RELAYS for both."""
    if relays is None:
        relays = BOOTSTRAP_RELAYS
    tags = []
    for npub in npubs:
        hex_pk = npub_to_hex(npub)
        if hex_pk is None:
            print(f"  [zap] skipping malformed npub: {npub[:24]}...")
            continue
        lud16  = get_lud16(hex_pk, relays)
        if lud16:
            tags.append(["zap", hex_pk, relays[0], "1"])
        else:
            print(f"  [zap] skipping {npub[:20]}... — no lud16 found")
    return tags

def build_zap_splits_for_note(note_text, nsec, relays=None):
    """Extract npubs mentioned in note text, add the author, and build zap split tags."""
    mentioned   = re.findall(r'nostr:(npub1[a-z0-9]+)', note_text)
    pk          = PrivateKey.from_nsec(nsec)
    author_npub = hex_to_npub(pk.public_key.hex())
    all_npubs   = list(dict.fromkeys(mentioned + [author_npub]))  # dedupe, preserve order
    return build_zap_split_tags(all_npubs, relays)

# Module-level cache: NIP-65 outbox relays per pubkey, populated on first lookup
# in a script run. Each bot is one-shot (systemd timer fires it as a fresh process)
# so the cache lifetime ≈ run lifetime, which is fine.
_OUTBOX_CACHE = {}

def get_outbox_relays(hex_pubkey, bootstrap_relays=None):
    """NIP-65 outbox lookup. Queries the bootstrap relay set for the latest kind 10002
    authored by hex_pubkey and returns the `r`-tagged URLs that are NOT marked `read`
    (i.e. write-marked or unmarked → publishable outbox).
    Returns [] if no 10002 is found or it has no usable relays."""
    if hex_pubkey in _OUTBOX_CACHE:
        return _OUTBOX_CACHE[hex_pubkey]
    if bootstrap_relays is None:
        bootstrap_relays = BOOTSTRAP_RELAYS

    best = None
    for relay in bootstrap_relays:
        try:
            ws = websocket.WebSocket()
            ws.connect(relay, timeout=8)
            ws.send(json.dumps(["REQ", "outbox",
                {"kinds": [10002], "authors": [hex_pubkey], "limit": 5}]))
            while True:
                msg = json.loads(ws.recv())
                if msg[0] == "EVENT":
                    ev = msg[2]
                    if best is None or ev.get("created_at", 0) > best.get("created_at", 0):
                        best = ev
                elif msg[0] == "EOSE":
                    break
            ws.close()
        except Exception:
            pass

    relays = []
    if best:
        for tag in best.get("tags", []):
            if len(tag) >= 2 and tag[0] == "r":
                marker = tag[2] if len(tag) >= 3 else ""
                if marker != "read":
                    relays.append(tag[1])

    _OUTBOX_CACHE[hex_pubkey] = relays
    return relays

def build_zap_splits_for_v4v(sender_npub, nsec, relays=None):
    """V4V 2.0 receipt note: equal-weight split between the boostagram sender
    and the publishing account. Sender is dropped if empty (anonymous boost) or
    if they have no lud16 — which collapses the split to 100% to the publisher.
    Two npubs with lud16 → 50/50."""
    pk          = PrivateKey.from_nsec(nsec)
    author_npub = hex_to_npub(pk.public_key.hex())
    npubs       = [sender_npub, author_npub] if sender_npub else [author_npub]
    return build_zap_split_tags(npubs, relays)

# Banner images prepended to STANDALONE notes so Nostr clients render them as a
# header above the text. Applied ONLY to top-level notes — never to
# megathread/board replies or leaderboard reply chains. Most clients (Damus,
# Primal, Amethyst) detect a bare image URL in content and render it inline;
# putting it first → top. One image per note type:
STANDALONE_BOOST_IMAGE = "https://i.nostr.build/a6G5FkkfTlSyfJ7z.png"  # boost-publisher standalone note
TOPEPISODES_IMAGE      = "https://i.nostr.build/FrGf0Ed65wBNuFxF.png"  # episodesats leaderboard parent
TOPBOOSTS_IMAGE        = "https://i.nostr.build/s9WPcUfwPI4x3n5Q.png"  # top-boosts leaderboard parent
BOOSTLEADERS_IMAGE     = "https://i.nostr.build/AQ6JrQJ5c2vwO5u0.png"  # boost-leaders leaderboard parent

def with_header_image(note_text, image_url):
    """Prepend the banner image URL on its own line so clients render it as a
    header image above the note. No-op if image_url is falsy. The URL adds no
    nostr: mentions or #hashtags, so build zap-split / note tags from the
    plain note text and wrap with this only at publish time."""
    if not image_url:
        return note_text
    return f"{image_url}\n{note_text}"

def write_dry_run_event(note_text, nsec, prefix, extra_tags=None, reply_to_event_id=None, suffix=None, kind=1, created_at=None):
    """Build an unsigned event preview and write it to <repo>/bots/dry-run/.
    Mirrors the tag assembly of publish_to_nostr so the preview reflects what would
    be published. Returns (path, event_id) — event_id is the deterministic NIP-01
    sha256 over the canonical serialization, usable for threading replies.
    kind defaults to 1 (text note); pass kind=3 for contact-list previews, etc.
    Pass `created_at` to override the timestamp (e.g. backdating a corrected
    republish to its original note's time); defaults to now."""
    tags = []
    if reply_to_event_id:
        tags.append(["e", reply_to_event_id, "", "root"])
    if extra_tags:
        tags.extend(extra_tags)

    pk         = PrivateKey.from_nsec(nsec)
    pubkey     = pk.public_key.hex()
    if created_at is None:
        created_at = int(time.time())

    event_data = [0, pubkey, created_at, kind, tags, note_text]
    event_json = json.dumps(event_data, separators=(",", ":"), ensure_ascii=False)
    event_id   = hashlib.sha256(event_json.encode()).hexdigest()

    event = {
        "kind":       kind,
        "pubkey":     pubkey,
        "created_at": created_at,
        "content":    note_text,
        "tags":       tags,
    }

    dry_dir = Path(__file__).resolve().parent.parent / "dry-run"
    dry_dir.mkdir(exist_ok=True)
    ts   = int(time.time() * 1000)
    name = f"{prefix}-{ts}" + (f"-{suffix}" if suffix else "") + ".json"
    path = dry_dir / name
    path.write_text(json.dumps(event, indent=2, ensure_ascii=False))
    return path, event_id

def _send_event(relay, msg, timeout=10):
    """Send one pre-serialized ["EVENT", …] frame to one relay.

    Returns (accepted, detail). NIP-20's reply is ["OK", <id>, <accepted>, <msg>]
    — the third element is the verdict, so `parsed[0] == "OK"` alone is NOT
    acceptance: a relay that refuses the event still answers with an OK frame
    (`["OK", id, false, "blocked: …"]`). Reading only the frame name printed a ✓
    for every rejection, which is how a kind the relay doesn't store looks
    exactly like a successful publish.

    `detail` is prefixed with "!" for a transport-level failure (worth a retry)
    and unprefixed for a relay's own refusal (retrying can't change it)."""
    try:
        ws = websocket.create_connection(relay, timeout=timeout)
        ws.settimeout(timeout)
        try:
            ws.send(msg)
            # Some relays send an AUTH/NOTICE frame ahead of the OK.
            for _ in range(4):
                parsed = json.loads(ws.recv())
                if parsed[0] == "OK":
                    ok = bool(parsed[2]) if len(parsed) > 2 else False
                    return ok, (parsed[3] if len(parsed) > 3 else "") or ""
                if parsed[0] in ("NOTICE", "CLOSED"):
                    return False, " ".join(str(x) for x in parsed[1:])[:120]
            return False, "no OK frame"
        finally:
            ws.close()
    except Exception as e:
        return False, f"!{type(e).__name__}: {e}"


def publish_to_nostr(note_text, nsec, reply_to_event_id=None, relays=None, extra_tags=None, kind=1, created_at=None, return_event=False):
    """Sign and broadcast a Nostr event. Returns the event_id on success, None on failure.
    kind defaults to 1 (text note); pass kind=3 for a contact list, etc.

    `return_event=True` returns the full signed event dict instead of just the id
    (the id is still `event["id"]`). Opt-in so the 16 existing callers keep the
    id-or-None contract they were written against. Use it when the event itself
    has to be persisted — boost_wall.json ships the raw signed reply so the
    website can render and `verifyEvent` it without a relay round-trip.
    Pass `created_at` to override the timestamp (e.g. backdating a corrected
    republish to its original note's time); defaults to now.

    When `relays` is None, the publish target is resolved per NIP-65: the author's
    kind 10002 outbox is fetched. For kind 1 that outbox is UNIONED with
    NOSTR_RELAYS (order: outbox first, then the extras) — the show's 10002 write
    set reaches only one of the four relays localbitcoiners.com reads notes back
    from, so outbox-only publishing left the site depending on propagation. For
    replaceable / non-kind-1 events the outbox is used alone, and a missing 10002
    refuses to publish rather than scatter copies across a hardcoded set their
    author hasn't opted into.
    Pass `relays=` explicitly to override entirely."""
    try:
        pk         = PrivateKey.from_nsec(nsec)
        pubkey     = pk.public_key.hex()

        if relays is None:
            outbox = get_outbox_relays(pubkey)
            if kind == 1:
                if not outbox:
                    print(f"  [warn] No kind 10002 outbox for {pubkey[:12]}... — publishing to NOSTR_RELAYS only")
                relays = list(dict.fromkeys(outbox + NOSTR_RELAYS))
            elif outbox:
                relays = outbox
            else:
                raise RuntimeError(
                    f"No kind 10002 outbox for {pubkey[:12]}... — refusing to publish "
                    f"kind {kind} (replaceable) to fallback relays. Pass relays= explicitly "
                    f"or publish a kind 10002 for this account first.")

        # Kind-1-only relays reject everything else outright, and they arrive
        # here from three directions (NOSTR_RELAYS, an author's 10002, or an
        # explicit list), so filter at the publish boundary rather than at each
        # caller. See KIND1_ONLY_RELAYS.
        if kind != 1:
            kept = [r for r in relays if r not in KIND1_ONLY_RELAYS]
            for r in relays:
                if r in KIND1_ONLY_RELAYS:
                    print(f"    – {r.split('/')[2]} (kind-1 only, skipped for kind {kind})")
            if not kept:
                raise RuntimeError(
                    f"Every relay in the publish list is kind-1 only — nowhere to "
                    f"publish kind {kind}. Pass relays= explicitly.")
            relays = kept
        if created_at is None:
            created_at = int(time.time())
        tags       = []

        if reply_to_event_id:
            tags.append(["e", reply_to_event_id, "", "root"])
        if extra_tags:
            tags.extend(extra_tags)

        event_data = [0, pubkey, created_at, kind, tags, note_text]
        event_json = json.dumps(event_data, separators=(",", ":"), ensure_ascii=False)
        event_id   = hashlib.sha256(event_json.encode()).hexdigest()
        sig        = pk.sign(bytes.fromhex(event_id)).hex()

        event = {
            "id":         event_id,
            "pubkey":     pubkey,
            "created_at": created_at,
            "kind":       kind,
            "tags":       tags,
            "content":    note_text,
            "sig":        sig,
        }

        msg = json.dumps(["EVENT", event])

        accepted = 0
        for relay in relays:
            ok, detail = _send_event(relay, msg)
            retried = False
            # One retry on a transport failure only (relay.damus.io intermittently
            # answers the WebSocket connect with HTTP 503 — on a publish that's a
            # lost note, not a slow query). A relay that answered with OK-false
            # made a decision; re-sending won't change it.
            if not ok and detail.startswith("!"):
                retried = True
                time.sleep(2)
                ok, detail = _send_event(relay, msg)
            accepted += 1 if ok else 0
            status = "✓" if ok else "✗"
            note   = detail.removeprefix("!") if not ok else ""
            if retried:
                note = (note + " " if note else "") + "(after retry)"
            print(f"    {status} {relay.split('/')[2]}{': ' + note if note else ''}")

        if accepted == 0:
            print(f"  [warn] kind {kind} event {event_id[:12]}… was accepted by 0 of "
                  f"{len(relays)} relays — it is not readable anywhere")

        return event if return_event else event_id

    except Exception as e:
        print(f"  [error] Nostr publish failed: {e}")
        return None
