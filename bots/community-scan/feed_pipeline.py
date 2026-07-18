#!/usr/bin/env python3
"""Feeds side of the unified community scan.

Pure processing: takes the addressable content + deletions the orchestrator
fetched, and produces the three feed outputs (events / market / articles) with
coordinate dedup, NIP-09 deletion filtering, pruned deletion state, cached
profiles, and an unchanged-payload signature so idle passes skip the write/push.
Owns NO relay-scan or tier/cursor logic.

Addressable-event mechanics (vs the boost side's immutable kind-1 notes) are the
same as the standalone community-feeds bot this replaces: dedup by COORDINATE
kind:pubkey:d-tag (newest wins), NIP-09 (kind-5) deletions honoured against the
accumulated store, every cached event signature-verified before we serve it.
"""

from datetime import datetime, timezone

from collector_common import (
    fetch_events_by_authors, verify_raw_event, newest_per_coord,
    collect_deletions, is_deleted,
)

KIND_DELETION = 5
KIND_PROFILE = 0

PASSES = [
    {"name": "events",   "kinds": [31922, 31923],        "file": "community_events.json"},
    {"name": "market",   "kinds": [30402, 30405, 30406], "file": "community_market.json"},
    {"name": "articles", "kinds": [30023],               "file": "community_articles.json"},
]

ALL_FEED_KINDS = sorted({k for p in PASSES for k in p["kinds"]})


# ── profiles (cached across passes) ───────────────────────────────────────────
def fetch_profiles(relays, author_hexes, wall):
    """Newest verified kind-0 per author, as raw events keyed by pubkey."""
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


def resolve_profiles(relays, all_authors, cache, refresh_all, wall):
    """Newest kind-0 per author, reusing `cache` (a {pubkey: raw-kind0} dict).

    `refresh_all` — do the full crawl and replace the cache wholesale (the deep
    pass's periodic profile refresh). Otherwise fetch only authors missing from
    the cache (new members / newly-surfaced authors) and merge. Returns
    (subset_for_these_authors, updated_cache)."""
    cache = dict(cache or {})
    if refresh_all:
        cache = fetch_profiles(relays, all_authors, wall)      # wholesale refresh
    else:
        missing = [a for a in all_authors if a not in cache]
        if missing:
            print(f"  fetching kind-0 for {len(missing)} new author(s) "
                  f"({len(all_authors) - len(missing)} cached)")
            cache.update(fetch_profiles(relays, missing, wall))
    subset = {pk: cache[pk] for pk in all_authors if pk in cache}
    return subset, cache


def payload_signature(events, profiles):
    """Stable fingerprint of a feed's meaningful output — the event id list
    (always newest-first) + each profile's pubkey and created_at. Excludes
    generated_at so an otherwise-identical pass doesn't churn a rewrite/push."""
    return (
        tuple(e.get("id") for e in events),
        tuple(sorted((pk, ev.get("created_at")) for pk, ev in profiles.items())),
    )


# ── the pipeline entrypoint ───────────────────────────────────────────────────
def process_feeds(by_kind, deletions, existing_outputs, feed_states,
                  profiles_cache, scan_relays, members, refresh_profiles, wall):
    """Produce per-feed outputs off the shared scan.

    `by_kind`         — {kind: [events]} content the orchestrator fetched.
    `deletions`       — verified kind-5 events (fetched wide by the orchestrator).
    `existing_outputs`— {name: current output dict} for merge + unchanged check.
    `feed_states`     — {name: {deleted_ids, deleted_coords}} from state.
    `profiles_cache`  — {pubkey: raw-kind0} from state.
    `refresh_profiles`— force a full profile re-crawl (deep/periodic).

    Returns (results, updated_profiles_cache) where
    results[name] = {output, changed, deleted_ids, deleted_coords}."""
    interim, all_authors = {}, set()
    for cfg in PASSES:
        name = cfg["name"]
        fstate = feed_states.get(name, {})
        prev_out = existing_outputs.get(name, {})
        content = [e for k in cfg["kinds"] for e in by_kind.get(k, [])]
        coordmap = newest_per_coord(prev_out.get("events", []) + content)
        del_ids, del_coords = collect_deletions(
            deletions, set(fstate.get("deleted_ids", [])),
            dict(fstate.get("deleted_coords", {})))
        surviving = [e for e in coordmap.values() if not is_deleted(e, del_ids, del_coords)]
        surviving.sort(key=lambda e: e.get("created_at", 0), reverse=True)

        # Prune persisted deletion state to only what can suppress content we
        # store: coord deletions for kinds this feed tracks, id deletions for
        # ids currently in the store. Keeps it from growing without bound.
        tracked = set(cfg["kinds"])
        stored_ids = {e.get("id") for e in coordmap.values()}
        del_coords = {c: at for c, at in del_coords.items()
                      if c.split(":", 1)[0].isdigit() and int(c.split(":", 1)[0]) in tracked}
        del_ids = {i for i in del_ids if i in stored_ids}

        interim[name] = (surviving, sorted(del_ids), del_coords)
        all_authors |= {e.get("pubkey") for e in surviving if e.get("pubkey")}
        print(f"  {name}: {len(surviving)} live events "
              f"({len(coordmap) - len(surviving)} hidden by NIP-09); "
              f"retained {len(del_ids)} id + {len(del_coords)} coord deletions")

    print(f"Resolving kind-0 profiles for {len(all_authors)} authors...")
    profiles, profiles_cache = resolve_profiles(
        scan_relays, all_authors, profiles_cache, refresh_profiles, wall)
    print(f"  {len(profiles)}/{len(all_authors)} profiles available")

    results = {}
    for cfg in PASSES:
        name = cfg["name"]
        surviving, del_ids, del_coords = interim[name]
        prev_out = existing_outputs.get(name, {})
        pf = {pk: profiles[pk]
              for pk in {e.get("pubkey") for e in surviving} if pk in profiles}
        changed = (payload_signature(surviving, pf) !=
                   payload_signature(prev_out.get("events", []),
                                     prev_out.get("profiles", {})))
        output = {
            "generated_at": datetime.now(tz=timezone.utc).isoformat(),
            "kinds": cfg["kinds"],
            "member_count": len(members),
            "relay_count": len(scan_relays),
            "events": surviving,
            "profiles": pf,
        }
        results[name] = {
            "output": output, "changed": changed,
            "deleted_ids": del_ids, "deleted_coords": del_coords,
            "file": cfg["file"],
        }
    return results, profiles_cache
