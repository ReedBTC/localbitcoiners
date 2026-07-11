#!/usr/bin/env python3
"""Local Bitcoiners — community feeds collector.

Read-only research/data bot — never signs or publishes anything to Nostr.
Scans Nostr for addressable content authored by everyone in the LB community
(the union of every follow pack in bots/follow-packs/state.json — the same set
community-boosts uses and feeds.js resolves live) and caches the FULL raw
events into per-kind JSON files the website reads, so the community feeds load
from one static fetch instead of a live relay crawl on every page load.

Three passes, one shared member + scan-relay resolution:
  • events   — NIP-52 calendar events (kinds 31922 date, 31923 time)
  • market   — NIP-99 marketplace (30402 listing, 30405 collection, 30406 shipping)
  • articles — NIP-23 long-form (kind 30023)

Why cache RAW events: feeds.js / feeds-market.js already parse, grade, group,
dedup and deletion-filter raw events client-side. Storing the whole event
(nothing truncated) means the frontend keeps all that logic and just swaps its
source from a relay subscription to this JSON. Each file also carries a
`profiles` map (newest kind-0 per author present in that file) so the frontend
drops its second round-trip for organizer/seller/author identity (and, for the
marketplace, the lud16 that drives Buy-Now).

Addressable-event mechanics (vs community-boosts' immutable kind-1 notes):
  • dedup by COORDINATE kind:pubkey:d-tag, newest created_at wins
  • NIP-09 (kind-5) deletions honoured against the whole accumulated store,
    accumulated in state so a deleted item never resurfaces on a later scan
  • every cached event is signature-verified before we trust/serve it

Incremental state: bots/community-feeds/state.json (gitignored) holds, per
pass, `last_processed` (the since-cursor) plus accumulated `deleted_ids` /
`deleted_coords`. First run per pass has no cursor and does a FULL-HISTORY
backfill (no `since` floor — content here can be arbitrarily old). Subsequent
runs re-query from a small overlap before last_processed; output dedupes by
coordinate so overlap is harmless.

The house store publishes from the show account itself (MERCHANT_NPUB in
merch.js == the show pubkey), so it needs NO special-casing here: once the
show account is a member of a follow pack, its listings ride in like any
other member's.
"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import load_config, NOSTR_RELAYS  # noqa: E402
from collector_common import (  # noqa: E402
    fetch_events_by_authors,
    verify_raw_event,
    newest_per_coord,
    collect_deletions,
    is_deleted,
    load_community_npubs,
    resolve_scan_relays,
    push_file_to_vps,
)

# ── config / paths ────────────────────────────────────────────────────────────
# Outward action (VPS push) — ON: the backfill was reviewed and the hourly
# timer is live. Each run rsyncs the three JSON files to the VPS (Caddy serves
# them; CF Pages Functions proxy them to the site), same as community-boosts.
PUSH_TO_VPS = True

# Resolve every member's NIP-65 outbox and scan those relays too — slower, but
# finds content a member only published to their own relays. On for the
# complete backfill.
RESOLVE_OUTBOX = True

# Small re-query overlap on incremental runs so a note landing right at a run
# boundary is never missed. Output dedupes by coordinate, so overlap is harmless.
OVERLAP_SECONDS = 300

# Per-relay query wall-clock caps. Incremental runs fetch a tiny since-window,
# so a relay that hasn't EOSE'd in ~20s is effectively dead — no reason to wait
# the full backfill budget. The backfill (full history) gets the longer budget.
INCREMENTAL_WALL_SECONDS = 20
BACKFILL_WALL_SECONDS = 60

# The resolved scan-relay set (base + every member's NIP-65 outbox) barely
# changes hour to hour, and resolving it costs ~5 min. Cache it in state and
# only re-resolve when older than this, so hourly runs skip the cost.
RELAY_CACHE_TTL_SECONDS = 24 * 60 * 60

# Incremental runs filter on `since` (event created_at), so an edit/deletion
# that takes longer than the hourly window to propagate to any relay we query
# could slip through. Once a day, force a full-history scan (since=None) to
# re-sweep everything — catches any missed replacement/deletion and keeps the
# cache self-healing. Cheap now that the scan is parallel (~a few min).
FULL_RECONCILE_TTL_SECONDS = 24 * 60 * 60

KIND_DELETION = 5
KIND_PROFILE = 0

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
FOLLOWPACKS_STATE = Path(__file__).resolve().parent.parent / "follow-packs" / "state.json"
STATE_FILE = Path(__file__).resolve().parent / "state.json"
DATA_DIR = REPO_ROOT / "data"

# Dedicated deploy key for the VPS push — same restricted rrsync key
# community-boosts uses (see project memory / bots/CLAUDE.md).
VPS_KEY_FILE = Path.home() / ".ssh" / "relay_mynostr_ed25519"

PASSES = [
    {"name": "events",   "kinds": [31922, 31923],        "file": "community_events.json"},
    {"name": "market",   "kinds": [30402, 30405, 30406], "file": "community_market.json"},
    {"name": "articles", "kinds": [30023],               "file": "community_articles.json"},
]


# ── state / output I/O ────────────────────────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def load_output(fname):
    p = DATA_DIR / fname
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def save_output(fname, output):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / fname).write_text(
        json.dumps(output, indent=2, ensure_ascii=False, sort_keys=True))


# ── profiles ──────────────────────────────────────────────────────────────────
def fetch_profiles(relays, author_hexes, wall):
    """Newest verified kind-0 per author, as raw events keyed by pubkey. The
    frontend parses these exactly like a relay-sourced kind-0 (name / picture /
    lud16). Fetched once for every author across all feeds, not per-pass."""
    if not author_hexes:
        return {}
    raw = fetch_events_by_authors(relays, [KIND_PROFILE], sorted(author_hexes),
                                  max_wall_seconds=wall, label="profiles ")
    newest = {}
    for ev in raw:
        if ev.get("kind") != KIND_PROFILE or not verify_raw_event(ev):
            continue
        pk = ev.get("pubkey")
        prev = newest.get(pk)
        if prev is None or ev.get("created_at", 0) > prev.get("created_at", 0):
            newest[pk] = ev
    return newest


# ── scan-relay resolution (cached) ────────────────────────────────────────────
def get_scan_relays(members, state):
    """The relay set to scan, reused from state unless stale. Resolving the
    per-member outbox union costs ~5 min, so we cache it and only rebuild once
    a day — hourly runs reuse it and go straight to the (fast) scan."""
    cache = state.get("_scan_relays") or {}
    age = time.time() - cache.get("resolved_at", 0)
    if RESOLVE_OUTBOX and cache.get("relays") and age < RELAY_CACHE_TTL_SECONDS:
        print(f"Reusing cached scan-relay set: {len(cache['relays'])} relays "
              f"({int(age // 60)} min old)")
        return cache["relays"]
    print("Resolving scan relays"
          f"{' (base + per-member NIP-65 outbox)' if RESOLVE_OUTBOX else ' (base only)'}...")
    relays = resolve_scan_relays(members, NOSTR_RELAYS, resolve_outbox=RESOLVE_OUTBOX)
    state["_scan_relays"] = {"relays": relays, "resolved_at": int(time.time())}
    print(f"{len(relays)} relays to scan (cached for {RELAY_CACHE_TTL_SECONDS // 3600}h)")
    return relays


# ── main ──────────────────────────────────────────────────────────────────────
# One combined relay crawl feeds all three feeds. Every content kind + kind-5
# is fetched in a single (parallel) author-chunked scan, then split by kind —
# so the expensive relay work is paid once, not once per feed.
def main():
    members = load_community_npubs(FOLLOWPACKS_STATE)
    print(f"{len(members)} unique community members (all follow packs)")

    state = load_state()
    scan_relays = get_scan_relays(members, state)
    save_state(state)   # persist a freshly-resolved relay cache immediately

    # Incremental once every feed has a cursor; the shared `since` is the
    # oldest cursor (minus overlap) so no feed misses anything. But force a
    # full-history scan (since=None) when we've never done one, or the last
    # daily reconcile is stale — this re-sweeps everything so a replacement or
    # deletion that slipped the hourly propagation window still lands.
    cursors = [state.get(p["name"], {}).get("last_processed") for p in PASSES]
    reconcile_age = time.time() - (state.get("last_full_reconcile") or 0)
    full_scan = (not all(cursors)) or reconcile_age >= FULL_RECONCILE_TTL_SECONDS
    since = None if full_scan else (min(cursors) - OVERLAP_SECONDS)
    wall = BACKFILL_WALL_SECONDS if full_scan else INCREMENTAL_WALL_SECONDS
    content_kinds = sorted({k for p in PASSES for k in p["kinds"]})

    scan_mode = "FULL reconcile/backfill" if full_scan else f"incremental since {since}"
    print(f"\nScanning {len(scan_relays)} relays for kinds {content_kinds}+deletions "
          f"({scan_mode}, {wall}s/relay cap)...")
    raw = fetch_events_by_authors(scan_relays, content_kinds + [KIND_DELETION],
                                  members, since, max_wall_seconds=wall)
    print(f"{len(raw)} raw events fetched")

    # Verify signatures once, bucket by kind.
    deletions, by_kind, bad = [], {}, 0
    for ev in raw:
        if not verify_raw_event(ev):
            bad += 1
            continue
        if ev.get("kind") == KIND_DELETION:
            deletions.append(ev)
        else:
            by_kind.setdefault(ev.get("kind"), []).append(ev)
    if bad:
        print(f"[warn] dropped {bad} events failing signature verification")
    print(f"{sum(len(v) for v in by_kind.values())} content events "
          f"+ {len(deletions)} deletions (verified)")

    # Cursor advances to the newest thing seen across the whole scan (incl.
    # deletions) — we scanned everything up to now, so all feeds move together.
    newest_ts = max((e.get("created_at", 0) for e in raw), default=(since or 0))

    # Process each feed off the shared scan, collecting every surviving author
    # for a single profile fetch afterward.
    results, all_authors = {}, set()
    for cfg in PASSES:
        name = cfg["name"]
        pstate = state.get(name, {})
        content = [e for k in cfg["kinds"] for e in by_kind.get(k, [])]
        coordmap = newest_per_coord(load_output(cfg["file"]).get("events", []) + content)
        del_ids, del_coords = collect_deletions(
            deletions, set(pstate.get("deleted_ids", [])),
            dict(pstate.get("deleted_coords", {})))
        surviving = [e for e in coordmap.values() if not is_deleted(e, del_ids, del_coords)]
        surviving.sort(key=lambda e: e.get("created_at", 0), reverse=True)
        pstate["deleted_ids"] = sorted(del_ids)
        pstate["deleted_coords"] = del_coords
        results[name] = (surviving, pstate)
        all_authors |= {e.get("pubkey") for e in surviving if e.get("pubkey")}
        print(f"  {name}: {len(surviving)} live events "
              f"({len(coordmap) - len(surviving)} hidden by NIP-09)")

    # One profile fetch for everyone across all feeds.
    print(f"Fetching kind-0 profiles for {len(all_authors)} authors...")
    profiles = fetch_profiles(scan_relays, all_authors, wall)
    print(f"  {len(profiles)}/{len(all_authors)} profiles resolved")

    # Write (and optionally push) each feed.
    config = load_config(CREDENTIALS_FILE) if PUSH_TO_VPS else None
    for cfg in PASSES:
        name = cfg["name"]
        surviving, pstate = results[name]
        pf = {pk: profiles[pk]
              for pk in {e.get("pubkey") for e in surviving} if pk in profiles}
        save_output(cfg["file"], {
            "generated_at": datetime.now(tz=timezone.utc).isoformat(),
            "kinds": cfg["kinds"],
            "member_count": len(members),
            "relay_count": len(scan_relays),
            "events": surviving,
            "profiles": pf,
        })
        print(f"  wrote {len(surviving)} events + {len(pf)} profiles → data/{cfg['file']}")
        if PUSH_TO_VPS:
            push_file_to_vps(config, DATA_DIR / cfg["file"], cfg["file"], VPS_KEY_FILE)
        pstate["last_processed"] = max(pstate.get("last_processed") or 0, newest_ts, since or 0)
        state[name] = pstate

    if full_scan:
        state["last_full_reconcile"] = int(time.time())

    save_state(state)
    print("Done." + (" (full reconcile)" if full_scan else ""))


if __name__ == "__main__":
    main()
