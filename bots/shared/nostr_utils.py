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

# Small, fast, reliable bootstrap set used for metadata lookups (kind 0, kind 3,
# kind 10002). All are popular general-purpose relays that respond within a few
# seconds. purplepag.es is a profile aggregator — specifically useful for finding
# kind 0 / kind 10002 events that haven't propagated widely.
BOOTSTRAP_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://purplepag.es",
]

# Kind-1 fallback set used by `publish_to_nostr` when an account has no kind 10002
# outbox to resolve. Trimmed in 2026-04 to drop chronically-flaky relays
# (nostr.band, snort.social, oxtr.dev, current.fyi) — they timed out on every run.
# Notes are no longer routinely broadcast to this set; the outbox model handles
# the normal publish path. relay.fountain.fm is retained because Fountain users
# often have profiles there.
NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://purplepag.es",
    "wss://nos.lol",
    "wss://relay.getalby.com/v1",
    "wss://relay.primal.net",
    "wss://relay.fountain.fm",
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
    """Convert npub bech32 to hex pubkey."""
    hrp, data = bech32.bech32_decode(npub)
    decoded   = bech32.convertbits(data, 5, 8, False)
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
        try:
            h = npub_to_hex(n)
        except Exception:
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

def write_dry_run_event(note_text, nsec, prefix, extra_tags=None, reply_to_event_id=None, suffix=None, kind=1):
    """Build an unsigned event preview and write it to <repo>/bots/dry-run/.
    Mirrors the tag assembly of publish_to_nostr so the preview reflects what would
    be published. Returns (path, event_id) — event_id is the deterministic NIP-01
    sha256 over the canonical serialization, usable for threading replies.
    kind defaults to 1 (text note); pass kind=3 for contact-list previews, etc."""
    tags = []
    if reply_to_event_id:
        tags.append(["e", reply_to_event_id, "", "root"])
    if extra_tags:
        tags.extend(extra_tags)

    pk         = PrivateKey.from_nsec(nsec)
    pubkey     = pk.public_key.hex()
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

def publish_to_nostr(note_text, nsec, reply_to_event_id=None, relays=None, extra_tags=None, kind=1):
    """Sign and broadcast a Nostr event. Returns the event_id on success, None on failure.
    kind defaults to 1 (text note); pass kind=3 for a contact list, etc.

    When `relays` is None, the publish target is resolved per NIP-65: the author's
    kind 10002 outbox is fetched and used. If no 10002 is found, kind-1 falls back
    to NOSTR_RELAYS with a warning; replaceable / non-kind-1 events refuse to publish
    rather than scatter copies across a hardcoded set their author hasn't opted into.
    Pass `relays=` explicitly to override entirely."""
    try:
        pk         = PrivateKey.from_nsec(nsec)
        pubkey     = pk.public_key.hex()

        if relays is None:
            relays = get_outbox_relays(pubkey)
            if not relays:
                if kind == 1:
                    print(f"  [warn] No kind 10002 outbox for {pubkey[:12]}... — falling back to NOSTR_RELAYS")
                    relays = NOSTR_RELAYS
                else:
                    raise RuntimeError(
                        f"No kind 10002 outbox for {pubkey[:12]}... — refusing to publish "
                        f"kind {kind} (replaceable) to fallback relays. Pass relays= explicitly "
                        f"or publish a kind 10002 for this account first.")
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

        for relay in relays:
            try:
                ws = websocket.create_connection(relay, timeout=10)
                ws.send(msg)
                result = ws.recv()
                ws.close()
                parsed = json.loads(result)
                status = "✓" if parsed[0] == "OK" else "✗"
                print(f"    {status} {relay.split('/')[2]}")
            except Exception as e:
                print(f"    ✗ {relay.split('/')[2]}: {e}")

        return event_id

    except Exception as e:
        print(f"  [error] Nostr publish failed: {e}")
        return None
