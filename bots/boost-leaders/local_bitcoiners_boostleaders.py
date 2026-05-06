#!/usr/bin/env python3

import sys
import json
import time
import requests
from pathlib import Path

from pynostr.key import PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import (
    load_config, publish_to_nostr, build_zap_splits_for_note,
    write_dry_run_event, record_published_leaderboard,
)
from boost_formatter import classify_lb_tx, make_cache, persist_cache

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
STATE_FILE       = Path(__file__).resolve().parent / "state.json"

DRY_RUN         = False
FETCH_START     = "2024-01-01T00:00:00Z"
TOP_TIERS       = 3

# Hosts — excluded from the published leaderboard but still tracked in state
# (so toggling exclusion later doesn't require a backfill).
EXCLUDED_NPUBS = {
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",  # reed
    "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",  # rev
}


def load_state():
    if STATE_FILE.exists():
        raw = json.loads(STATE_FILE.read_text())
        # Convert lists back to sets for in-memory use
        raw["boosters"] = {npub: set(eps) for npub, eps in raw.get("boosters", {}).items()}
        return raw
    return {"last_processed": None, "boosters": {}}


def save_state(state):
    # Convert sets to sorted lists for JSON serialisation
    serialisable = {
        "last_processed": state["last_processed"],
        "boosters": {npub: sorted(eps) for npub, eps in state["boosters"].items()},
    }
    STATE_FILE.write_text(json.dumps(serialisable, indent=2))


def fetch_page(config, limit, offset):
    url     = config["ALBY_HUB_URL"]
    token   = config["ALBY_TOKEN"]
    headers = {"Authorization": f"Bearer {token}"}
    resp    = requests.get(
        f"{url}/api/transactions?limit={limit}&offset={offset}",
        headers=headers, timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("transactions", []), data.get("totalCount", 0)


def episode_key_for_leader_count(info):
    """Pick the episode-id used to count distinct-episode contributions per
    booster. We deliberately key keysend by its raw boostagram title (matching
    the original inline behavior pre-classifier refactor) rather than the
    Fountain id the classifier can sometimes derive from a Fountain URL —
    changing that key shape mid-flight would split historical state buckets
    against new ones and corrupt the leaderboard counts."""
    # Show-level Fountain boosts (URL `/show/...`) aren't tied to any specific
    # episode — skip so they don't inflate distinct-episode counts. Without
    # this, a show boost would add the show id (e.g. "Q48WBr6nT3mrbwMZ8ydY")
    # to the booster's set as if it were an episode.
    if info["source"] == "fountain_boost" and info.get("show_level"):
        return None

    # Show-level website boosts (description `LocalBitcoinersShow`) — same
    # rationale as fountain_boost show-level: not episode-tied, skip.
    if info["source"] == "website" and info.get("show_level"):
        return None

    # General LB donations aren't episodes — skip.
    if info["source"] == "lb_donation":
        return None

    if info["source"] == "keysend":
        # Defer livestream / unresolvable keysends — the classifier sets
        # episode_id when boostLink resolves to /episode/{id} or RSS title
        # match succeeds; absent both, it's almost certainly a livestream
        # boost (episode_guid → <podcast:liveItem>). Returning None makes the
        # existing skip below catch it without inflating distinct-episode
        # counts via a phantom "keysend_unknown" bucket.
        if not info.get("episode_id"):
            return None
        boostagram = info.get("boostagram") or {}
        return boostagram.get("episode", "") or "keysend_unknown"
    return info.get("episode_id")


def format_booster_display(key):
    """Display string for a boost-leaders booster key. Keys are either
    npubs (most common — npub-attributed boosts) or `name:<senderName>` for
    keysend named-anon boosts (PodcastGuru-style boostagrams that carry a
    senderName but no senderPubkey). Truly anonymous boosts never make it
    into `boosters` so don't need a display path here."""
    if key.startswith("name:"):
        return key[5:]
    return f"nostr:{key}"

def format_note(boosters):
    medals   = ["🥇", "🥈", "🥉"]
    filtered = {k: v for k, v in boosters.items() if k not in EXCLUDED_NPUBS}
    ranked   = sorted(filtered.items(), key=lambda x: -len(x[1]))

    # Find the top TOP_TIERS distinct episode-counts, then include every
    # booster whose count is in one of those tiers — a 10-way tie for 3rd
    # all gets listed.
    distinct_counts = []
    for _, episodes in ranked:
        c = len(episodes)
        if c not in distinct_counts:
            distinct_counts.append(c)
        if len(distinct_counts) >= TOP_TIERS:
            break
    top_counts = set(distinct_counts)
    top        = [(k, eps) for k, eps in ranked if len(eps) in top_counts]
    tier_medal = {c: medals[i] for i, c in enumerate(distinct_counts)}

    lines = ["⚡ Local Bitcoiners Boost Leaders", ""]
    lines.append("Listeners who have boosted the most episodes, all-time:")
    lines.append("")

    for booster_key, episodes in top:
        count = len(episodes)
        medal = tier_medal.get(count, "▪️")
        display = format_booster_display(booster_key)
        lines.append(f"{medal} {display} - {count} episode{'s' if count != 1 else ''}")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)


def main():
    config   = load_config(CREDENTIALS_FILE)
    state    = load_state()
    nsec     = config.get("NSEC_LOCAL_BITCOINERS")
    boosters = state.get("boosters", {})

    cutoff = state["last_processed"] or FETCH_START
    print(f"Fetching boosts since: {cutoff}\n")

    cache        = make_cache()
    new_tx_count = 0
    skipped_anon = 0
    offset       = 0
    limit        = 50
    newest_ts    = state["last_processed"]

    while True:
        txs, total = fetch_page(config, limit, offset)
        if not txs:
            break

        print(f"  Fetched offset {offset} ({len(txs)} txs, total={total})")

        settled_times  = [t.get("settledAt") for t in txs if t.get("settledAt")]
        oldest_on_page = min(settled_times) if settled_times else ""
        last_page      = bool(oldest_on_page) and oldest_on_page <= cutoff

        for tx in txs:
            settled_at = tx.get("settledAt", "")
            if not settled_at or settled_at <= cutoff:
                continue

            info = classify_lb_tx(tx, cache=cache)
            if not info:
                continue
            # Leaders is "who boosted" — streams don't count.
            if info["source"] == "fountain_stream":
                continue

            npub        = info["sender_npub"]
            sender_name = info.get("sender_name")
            episode_id  = episode_key_for_leader_count(info)

            # Pick a booster identity. Prefer npub (cryptographic identity);
            # fall back to senderName for keysend named-anon boosts (e.g.
            # PodcastGuru sends a senderName but no senderPubkey). Truly
            # anonymous boosts (no npub, no name) get skipped — without an
            # identifier we can't track distinct-episode contributions.
            if npub:
                booster_key = npub
            elif sender_name:
                booster_key = f"name:{sender_name}"
            else:
                booster_key = None

            if not booster_key or not episode_id:
                skipped_anon += 1
                # Don't advance newest_ts on anon skips — preserves prior
                # behavior. A boost without an identifier or episode can't
                # gain one retroactively, but the cost of leaving last_processed
                # behind is low.
                continue

            if booster_key not in boosters:
                boosters[booster_key] = set()
            boosters[booster_key].add(episode_id)
            new_tx_count += 1

            if newest_ts is None or settled_at > newest_ts:
                newest_ts = settled_at

        offset += limit
        if last_page or offset >= total:
            break

        time.sleep(0.5)

    print(f"\nProcessed {new_tx_count} new identified boosts ({skipped_anon} skipped — anonymous or no npub).\n")

    state["boosters"]       = boosters
    state["last_processed"] = newest_ts
    save_state(state)
    print(f"State saved → {STATE_FILE}\n")

    persist_cache(cache)

    if not boosters:
        print("[warn] No boosters with known npubs found yet — nothing to publish.")
        return

    note = format_note(boosters)
    print("=" * 50)
    print(note)
    print("=" * 50)

    if not nsec:
        print("\n[warn] No NSEC_LOCAL_BITCOINERS in config — skipping publish")
        return

    author_hex = PrivateKey.from_nsec(nsec).public_key.hex()

    print("\nBuilding zap splits...")
    zap_tags = build_zap_splits_for_note(note, nsec)
    if zap_tags:
        print(f"Zap split: {len(zap_tags)} recipients")

    if not DRY_RUN:
        print("\nPublishing standalone note...")
        standalone_id = publish_to_nostr(note, nsec, extra_tags=zap_tags)
        if standalone_id:
            record_published_leaderboard(
                "local_bitcoiners_boostleaders", standalone_id, author_hex,
            )
    else:
        path, _ = write_dry_run_event(
            note, nsec, prefix="boostleaders", extra_tags=zap_tags,
        )
        print(f"[dry-run] standalone → {path}")


if __name__ == "__main__":
    main()
