#!/usr/bin/env python3
"""Local Bitcoiners — unified community scan (quick / deep tiers).

Read-only research/data bot — never signs or publishes to Nostr. One scan
routine, two tiers, driven by `--tier`:

  • quick — the 6 fast base relays, run frequently (~5 min). Makes the common
    case (content that reaches the big relays, ~most of it) near-real-time for
    both the community podcast-boosts feed and the events/market/articles feeds.
  • deep  — the full outbox set (base + every member's NIP-65 write relays), run
    less often (~hourly). Backfills the outbox long tail (e.g. Stacker-News-
    bridged articles, outbox-only boosts) that the 6 relays can't see.

The two tiers are the SAME code — only the relay set (and cadence, via separate
timers) differ — so they can't drift. Each tier keeps its OWN cursor: the quick
pass must never advance the deep pass's cursor, or the deep pass would start its
window after content published to an outbox relay during a quick-only interval
and never look back far enough. Overlap + dedup handle the seams; both tiers
merge into the same output files (boosts by event id, feeds by coordinate).

New members (added upstream by the follow-packs bot) are detected by diffing the
current community against the set we've already backfilled — on WHICHEVER tier
notices first — and their whole back-catalog is fetched scoped to just them
(their outbox resolved on the spot), so a new supporter surfaces promptly rather
than waiting for a periodic full sweep. Deletes are kept robust by fetching
kind-5 over a wide window on the deep pass; a rare full-content sweep on the deep
pass is the backstop for late-propagated edits on existing members.

Two independent output pipelines (boost_pipeline / feed_pipeline) run off the one
shared fetch, each in its own try/except with its own output write + VPS push, so
a failure on one side can't corrupt or block the other.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from nostr_utils import load_config, NOSTR_RELAYS                       # noqa: E402
from collector_common import (                                          # noqa: E402
    fetch_events_multi, verify_raw_event, load_community_npubs,
    resolve_scan_relays, push_file_to_vps,
)
import boost_pipeline                                                   # noqa: E402
import feed_pipeline                                                    # noqa: E402

# ── paths / config ────────────────────────────────────────────────────────────
REPO_ROOT         = Path(__file__).resolve().parent.parent.parent
DATA_DIR          = REPO_ROOT / "data"
CREDENTIALS_FILE  = Path.home() / ".config/nostr-bots/credentials.env"
FOLLOWPACKS_STATE = Path(__file__).resolve().parent.parent / "follow-packs" / "state.json"
STATE_FILE        = Path(__file__).resolve().parent / "state.json"
VPS_KEY_FILE      = Path.home() / ".ssh" / "relay_mynostr_ed25519"

BOOST_OUTPUT_FILE = "community_boosts.json"

# Boost backfill floor — 10am EST Feb 2 2026 (show start), same as the standalone
# community-boosts bot. Feed content has no floor (can be arbitrarily old).
SINCE_CUTOFF = int(datetime(2026, 2, 2, 10, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp())

OVERLAP_SECONDS = 300           # re-query overlap; dedup makes it harmless

# Per-relay query wall caps. Incremental passes hit a small window, so a relay
# that hasn't EOSE'd in ~20s is effectively dead; full-history backfills get more.
INCREMENTAL_WALL = 20
BACKFILL_WALL    = 60

RELAY_CACHE_TTL      = 24 * 60 * 60       # re-resolve the deep outbox set at most daily
FULL_SWEEP_TTL       = 7 * 24 * 60 * 60   # deep full-content re-sweep (edit backstop)
PROFILE_REFRESH_TTL  = 12 * 60 * 60       # deep wholesale profile re-crawl

BOOST_KIND_FILTER = {"#k": ["podcast:guid", "podcast:item:guid"]}


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


def save_output(fname, obj):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / fname).write_text(
        json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True))


def boost_signature(o):
    """Fingerprint of the boost output's meaningful content (id list + cache
    keys), so an unchanged pass skips the write/push. Excludes generated_at."""
    return (
        tuple(b.get("event_id") for b in o.get("boosts", [])),
        tuple(sorted((o.get("episodes") or {}).keys())),
        tuple(sorted((o.get("shows") or {}).keys())),
    )


# ── relay resolution ──────────────────────────────────────────────────────────
def deep_relays(members, state, force):
    """The deep-tier scan set: base + every member's NIP-65 outbox, cached in
    state. Re-resolved when forced (membership changed / cache stale), else
    reused — resolving the outbox union costs minutes."""
    cache = state.get("scan_relays") or {}
    age = time.time() - cache.get("resolved_at", 0)
    if (not force) and cache.get("relays") and age < RELAY_CACHE_TTL:
        print(f"Reusing cached deep relay set: {len(cache['relays'])} relays "
              f"({int(age // 60)} min old)")
        return cache["relays"]
    print("Resolving deep relay set (base + per-member NIP-65 outbox)...")
    relays = resolve_scan_relays(members, NOSTR_RELAYS, resolve_outbox=True)
    state["scan_relays"] = {"relays": relays, "resolved_at": int(time.time()),
                            "member_hash": member_hash(members)}
    print(f"{len(relays)} deep relays (cached {RELAY_CACHE_TTL // 3600}h)")
    return relays


def member_hash(members):
    import hashlib
    return hashlib.sha1(",".join(sorted(members)).encode()).hexdigest()


# ── the shared fetch ──────────────────────────────────────────────────────────
def _filter_template(kinds, since, extra=None):
    tmpl = {"kinds": kinds}
    if since is not None:
        tmpl["since"] = since
    if extra:
        tmpl.update(extra)
    return tmpl


def fetch_bucket(relays, members, boost_since, feed_since, deletion_since, wall):
    """One tier's fetch: boost candidates (#k-narrowed kind-1), feed content, and
    deletions — all three in ONE multi-filter REQ per relay (single connection +
    EOSE wait), then deduped, verified (feeds/deletions), bucketed by kind.
    Returns (boost_raw, feed_by_kind, deletions, newest_ts)."""
    feed_kinds = feed_pipeline.ALL_FEED_KINDS
    del_kind = feed_pipeline.KIND_DELETION
    templates = [
        _filter_template([1], boost_since, BOOST_KIND_FILTER),
        _filter_template(feed_kinds, feed_since),
        _filter_template([del_kind], deletion_since),
    ]
    raw = fetch_events_multi(relays, templates, members,
                             max_wall_seconds=wall, label="scan ")

    boost_raw, feed_by_kind, deletions, bad = [], {}, [], 0
    feed_kind_set = set(feed_kinds)
    for ev in raw:
        k = ev.get("kind")
        if k == 1:
            boost_raw.append(ev)            # boost side verifies via classify, not sig
        elif k == del_kind:
            if verify_raw_event(ev):
                deletions.append(ev)
            else:
                bad += 1
        elif k in feed_kind_set:
            if verify_raw_event(ev):
                feed_by_kind.setdefault(k, []).append(ev)
            else:
                bad += 1
    if bad:
        print(f"  [warn] dropped {bad} feed/deletion events failing verification")

    newest_ts = max((e.get("created_at", 0) for e in raw), default=0)
    print(f"  fetched {len(boost_raw)} boost candidates, "
          f"{sum(len(v) for v in feed_by_kind.values())} feed events, "
          f"{len(deletions)} deletions")
    return boost_raw, feed_by_kind, deletions, newest_ts


def scoped_backfill(new_members, wall):
    """Full-history fetch scoped to just newly-added members, on base + THEIR
    outbox relays. Returns (boost_raw, feed_by_kind, deletions, newest_ts)."""
    print(f"New members ({len(new_members)}) — scoped full-history backfill...")
    nm_relays = resolve_scan_relays(new_members, NOSTR_RELAYS, resolve_outbox=True)
    print(f"  {len(nm_relays)} relays for the new-member backfill")
    return fetch_bucket(nm_relays, new_members,
                        boost_since=SINCE_CUTOFF, feed_since=None,
                        deletion_since=None, wall=wall)


def merge_events(*event_lists):
    seen = {}
    for lst in event_lists:
        for ev in lst:
            eid = ev.get("id")
            if eid:
                seen[eid] = ev
    return list(seen.values())


def merge_by_kind(*maps):
    out = {}
    for m in maps:
        for k, evs in m.items():
            out.setdefault(k, [])
            have = {e.get("id") for e in out[k]}
            out[k].extend(e for e in evs if e.get("id") not in have)
    return out


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=["quick", "deep"], required=True)
    ap.add_argument("--dry-run", action="store_true",
                    help="scan + classify but don't write outputs or push")
    ap.add_argument("--no-push", action="store_true",
                    help="write outputs locally but skip the VPS push")
    args = ap.parse_args()
    tier = args.tier

    config = load_config(CREDENTIALS_FILE)
    pi_key = config.get("LOCAL_BITCOINERS_INDEX_KEY")
    pi_secret = config.get("LOCAL_BITCOINERS_INDEX_SECRET")
    if not pi_key or not pi_secret:
        print("[warn] Podcast Index credentials missing — episode/show metadata skipped")

    members = load_community_npubs(FOLLOWPACKS_STATE)
    current = set(members)
    print(f"[{tier}] {len(members)} community members")

    state = load_state()
    cursors = state.get("cursors") or {}
    cursor = cursors.get(tier)
    first_run = cursor is None
    backfilled = set(state.get("backfilled_members") or [])
    new_members = sorted(current - backfilled)
    now = time.time()

    # ── tier setup: relay set + scan modes ──
    if tier == "quick":
        relays = list(NOSTR_RELAYS)
        full_content = first_run
        wide_deletions = first_run
        refresh_profiles = first_run
    else:
        cached = state.get("scan_relays") or {}
        force = (first_run or cached.get("member_hash") != member_hash(members)
                 or (now - cached.get("resolved_at", 0)) >= RELAY_CACHE_TTL)
        relays = deep_relays(members, state, force)
        save_state(state)                          # persist a fresh relay cache now
        stale_full = (now - state.get("last_full_reconcile", 0)) >= FULL_SWEEP_TTL
        full_content = first_run or stale_full
        wide_deletions = True                      # deep always sweeps deletions wide
        refresh_profiles = (full_content or
                            (now - state.get("last_profile_refresh", 0)) >= PROFILE_REFRESH_TTL)

    wall = BACKFILL_WALL if full_content else INCREMENTAL_WALL
    feed_since = None if full_content else (cursor - OVERLAP_SECONDS)
    boost_since = SINCE_CUTOFF if full_content else max(SINCE_CUTOFF, cursor - OVERLAP_SECONDS)
    deletion_since = None if wide_deletions else (cursor - OVERLAP_SECONDS)

    mode = ("full-content backfill" if full_content else "incremental")
    print(f"[{tier}] {len(relays)} relays, {mode}, {wall}s/relay cap "
          f"(feed_since={feed_since}, boost_since={boost_since}, wide_dels={wide_deletions})")

    # ── fetch: the tier scan + any scoped new-member backfill ──
    boost_raw, feed_by_kind, deletions, newest_ts = fetch_bucket(
        relays, members, boost_since, feed_since, deletion_since, wall)

    # New members need their full back-catalog. A deep full-content pass already
    # covers everyone's full history on the outbox set, so only backfill
    # separately otherwise (incremental passes, or the quick tier).
    if new_members and not (full_content and tier == "deep"):
        b2, f2, d2, ts2 = scoped_backfill(new_members, BACKFILL_WALL)
        boost_raw = merge_events(boost_raw, b2)
        feed_by_kind = merge_by_kind(feed_by_kind, f2)
        deletions = merge_events(deletions, d2)
        newest_ts = max(newest_ts, ts2)

    # ── boost pipeline (independent) ──
    try:
        existing_boost = load_output(BOOST_OUTPUT_FILE)
        boost_out, item_url_map = boost_pipeline.process_boosts(
            boost_raw, existing_boost,
            (state.get("boost") or {}).get("item_url_map") or {},
            pi_key, pi_secret, SINCE_CUTOFF)
        if boost_signature(boost_out) == boost_signature(existing_boost):
            print("  boosts: unchanged — skip write + push")
        elif args.dry_run:
            print(f"  boosts: [dry-run] would write {len(boost_out['boosts'])} boosts")
        else:
            save_output(BOOST_OUTPUT_FILE, boost_out)
            print(f"  wrote {len(boost_out['boosts'])} boosts → data/{BOOST_OUTPUT_FILE}")
            if not args.no_push:
                push_file_to_vps(config, DATA_DIR / BOOST_OUTPUT_FILE,
                                 BOOST_OUTPUT_FILE, VPS_KEY_FILE)
        state.setdefault("boost", {})["item_url_map"] = item_url_map
    except Exception as e:
        print(f"[error] boost pipeline failed: {e!r} — feeds + state still proceed")

    # ── feed pipeline (independent) ──
    try:
        existing_feeds = {p["name"]: load_output(p["file"]) for p in feed_pipeline.PASSES}
        results, profiles_cache = feed_pipeline.process_feeds(
            feed_by_kind, deletions, existing_feeds,
            state.get("feeds") or {}, state.get("profiles") or {},
            relays, members, refresh_profiles, wall)
        state["profiles"] = profiles_cache
        state.setdefault("feeds", {})
        for name, r in results.items():
            state["feeds"][name] = {"deleted_ids": r["deleted_ids"],
                                    "deleted_coords": r["deleted_coords"]}
            if not r["changed"]:
                print(f"  {name}: unchanged — skip write + push")
            elif args.dry_run:
                print(f"  {name}: [dry-run] would write {len(r['output']['events'])} events")
            else:
                save_output(r["file"], r["output"])
                print(f"  wrote {len(r['output']['events'])} events → data/{r['file']}")
                if not args.no_push:
                    push_file_to_vps(config, DATA_DIR / r["file"], r["file"], VPS_KEY_FILE)
        if refresh_profiles:
            state["last_profile_refresh"] = int(now)
    except Exception as e:
        print(f"[error] feed pipeline failed: {e!r} — boosts + state still proceed")

    # ── advance state ──
    if not args.dry_run:
        cursors[tier] = max(cursor or 0, newest_ts, feed_since or 0, boost_since)
        state["cursors"] = cursors
        state["backfilled_members"] = sorted(current)
        if full_content and tier == "deep":
            state["last_full_reconcile"] = int(now)
        save_state(state)
        print(f"[{tier}] cursor → {cursors[tier]} | "
              f"backfilled {len(current)} members | state saved")
    else:
        print("[dry-run] state not saved")


if __name__ == "__main__":
    main()
