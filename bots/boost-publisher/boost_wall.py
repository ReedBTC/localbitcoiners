#!/usr/bin/env python3
"""boost_wall.json — the boost mega-thread as a static file.

The website used to rebuild the whole thread in the browser on every page load
(boosts.html, index.html, stats.html and every /ep### page), which cost a ~5 MB
Primal `thread_view` call plus four relay sockets per visit. This file is that
same corpus, pre-assembled: every kind-1 event in the thread as its raw signed
event, so the site's existing renderNoteCard/verifyEvent path is unchanged and
nothing has to be trusted just because it came from us.

Shape: a JSON array, newest first, of

    {
      "event": { ...raw signed kind-1, byte-for-byte as published... },
      "payment_hash": "...", "sats": 2100, "sender_npub": "npub1...",
      "sender_name": "...", "episode_id": "...", "episode_num": "019",
      "episode_title": "...", "app": "Fountain", "source": "fountain_boost",
      "settled_at": "...", "show_level": false, "standalone_id": "..."
    }

Only `event` is guaranteed. The payment-side fields exist for the boosts this
bot published and could join to a payment; they are ABSENT (not null) on the
thread root, on notes Reed published by hand, and on replies from other people
— all of which the website renders today and so all of which belong here.

`episode_num` is a zero-padded STRING ("019", "001") — that's the shape
`_extract_episode_number` produces and the shape data/sats.csv already carries.
It is not an int, and it's absent rather than 0 when unknown.

Two writers, one shape, both going through this module:
  - local_bitcoiners_boosts.py appends each boost as it publishes (near-real-time)
  - build_boost_wall.py rebuilds from a relay scan (backfill + reconcile)
The appender can only ever know about its own notes, so the reconcile pass is
what keeps manual corrections and third-party replies on the wall.
"""

import json
import sys
from pathlib import Path

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))
from collector_common import push_file_to_vps  # noqa: E402

REPO_ROOT    = _BOTS_ROOT.parent
DATA_DIR     = REPO_ROOT / "data"
WALL_FILE    = "boost_wall.json"
WALL_PATH    = DATA_DIR / WALL_FILE
VPS_KEY_FILE = Path.home() / ".ssh" / "relay_mynostr_ed25519"

# The boost mega-thread root. Also in credentials.env as
# LOCAL_BITCOINERS_BOOST_BOARD; hardcoded here as the default so the rebuild
# tool runs without credentials, and overridable from config by callers that
# have them.
BOOST_BOARD_ROOT = "e36cb32dad0e08cfc6f1e2519f4c955a67c2a6bbc2797922626b3078eaaf3fd4"

# Bot notes that should never be on the wall — mirrors EXCLUDED_NOTE_IDS in
# assets/js/boosts-thread.js. Dropped on save so a relay-reconcile (which
# upserts everything in the thread) can't resurrect them. Kept here rather
# than deleted from published_events.json: that file is the dedupe gate, and
# the payment hashes must stay there so the boosts aren't re-published.
EXCLUDED_EVENT_IDS = {
    # 2026-08-19 DNS flap: two Chad & Reed boosts (ep ogeiYJaW9UdBT3d1aXUd)
    # published as LB while the feed gate ran blind.
    "24f53bb20d243b27d5356fa7f40955006511f4abf3ceecb797d1114a9e5bbf12",  # ph 76164cf8 reply
    "9b91a3bb306faae58873e08d86cf8cd11e04f58dee2ed44b7d1a10b12780c22a",  # ph eb26275d reply (0 relays)
}

# Payment-side fields, in the order they're written. Anything falsy is dropped
# rather than serialized as null — a backfilled record simply doesn't have them,
# and `"episode_id" in rec` is a cleaner test for the site than `!== null`.
_META_FIELDS = (
    "payment_hash", "sats", "sender_npub", "sender_name",
    "episode_id", "episode_num", "episode_title", "show_level",
    "app", "source", "settled_at", "standalone_id",
)


def load_wall(path=None):
    """Existing records as a dict keyed by event id. Missing/corrupt file → {}."""
    p = Path(path or WALL_PATH)
    if not p.exists():
        return {}
    try:
        records = json.loads(p.read_text())
    except Exception as e:
        print(f"  [warn] {p.name} unreadable ({e}) — starting from empty")
        return {}
    out = {}
    for rec in records if isinstance(records, list) else []:
        ev = rec.get("event") or {}
        if ev.get("id"):
            out[ev["id"]] = rec
    return out


def build_record(event, info=None, standalone_id=None):
    """One wall record. `info` is a BoostInfo (or a data/sats.csv row — the field
    names overlap by design); omit it for events with no payment behind them."""
    rec = {"event": event}
    if info:
        meta = {
            "payment_hash":  info.get("payment_hash"),
            "sats":          info.get("total_sats"),
            "sender_npub":   info.get("sender_npub"),
            "sender_name":   info.get("sender_name"),
            "episode_id":    info.get("episode_id"),
            # BoostInfo says episode_number, sats.csv says episode_num; the
            # file speaks sats.csv's name since that's the website's vocabulary.
            "episode_num":   info.get("episode_num") or info.get("episode_number"),
            "episode_title": info.get("episode_title"),
            "show_level":    info.get("show_level"),
            "app":           info.get("app_name") or info.get("app"),
            "source":        info.get("source"),
            "settled_at":    info.get("settled_at"),
        }
        meta["standalone_id"] = standalone_id
        for k in _META_FIELDS:
            v = meta.get(k)
            # show_level is a real False for most boosts — keep it; drop only
            # the unknowns (None / "" / a 0-sat placeholder).
            if k == "show_level":
                if isinstance(v, bool):
                    rec[k] = v
                elif isinstance(v, str) and v:
                    rec[k] = v.lower() == "true"
            elif v not in (None, "", []):
                rec[k] = int(v) if k == "sats" else v
    return rec


def upsert(wall, rec):
    """Add or replace by event id, preserving payment fields an earlier writer
    already established — a reconcile scan sees the event but not the payment,
    so it must not blank out what the publisher recorded live."""
    ev = rec.get("event") or {}
    eid = ev.get("id")
    if not eid:
        return
    existing = wall.get(eid)
    if existing:
        merged = dict(existing)
        merged["event"] = ev
        for k in _META_FIELDS:
            if k in rec:
                merged[k] = rec[k]
        wall[eid] = merged
    else:
        wall[eid] = rec


def save_wall(wall, path=None):
    """Write newest-first. Sorted by created_at desc with the id as tiebreak so
    the output is byte-stable across runs (an unstable sort would make every
    push a full-file diff for no reason)."""
    p = Path(path or WALL_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    records = sorted(
        (r for eid, r in wall.items() if eid not in EXCLUDED_EVENT_IDS),
        key=lambda r: (-(r.get("event", {}).get("created_at") or 0),
                       r.get("event", {}).get("id") or ""),
    )
    p.write_text(json.dumps(records, separators=(",", ":"), ensure_ascii=False))
    return len(records), p.stat().st_size


def push_wall(config, path=None):
    return push_file_to_vps(config, Path(path or WALL_PATH), WALL_FILE, VPS_KEY_FILE)
