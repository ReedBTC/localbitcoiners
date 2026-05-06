#!/usr/bin/env python3

import sys
import json
import re
import time
import requests
from pathlib import Path
from pynostr.key import PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import (
    load_config, publish_to_nostr, hex_to_npub, npub_to_hex, get_lud16,
    write_dry_run_event, scrape_fountain_episode, record_published_leaderboard,
)
from boost_formatter import classify_lb_tx, make_cache, persist_cache

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
STATE_FILE       = Path(__file__).resolve().parent / "state.json"

DRY_RUN         = False
FETCH_START     = "2026-02-02T05:00:00Z"
SHOW_BUCKET     = "__show__"
SHOW_TITLE      = "Local Bitcoiners (Show Boosts)"
TOP_N           = 5

# Host npubs — always tagged in per-episode reply notes.
HOST_NPUBS = [
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",
    "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",
]

# In-process lud16 cache — we look up the same hosts/author across 6 notes per run.
_lud16_cache = {}
def _cached_lud16(hex_pk):
    if hex_pk not in _lud16_cache:
        _lud16_cache[hex_pk] = get_lud16(hex_pk)
    return _lud16_cache[hex_pk]

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_processed": None, "episodes": {}}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))

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

def normalize_title(title):
    return re.sub(r'^Local Bitcoiners\s*[•·]\s*', '', title or '').strip()

def episode_bucket(info):
    """Resolve an Alby tx's BoostInfo into the (episode_id, episode_title)
    bucket key used by per-episode aggregation. Preserves the exact pre-refactor
    keying so existing aggregated state keeps adding correctly:

      - fountain_stream show-level → SHOW_BUCKET / SHOW_TITLE
      - keysend → text-derived id (sanitized lowercase title, ≤40 chars), so
                  keysend boosts never merge with Fountain BOLT11 boosts on
                  the same episode (matches prior inline behavior)
      - fountain_boost / fountain_stream / website → Fountain internal ep_id
                  with normalized title; website boosts merge into the same
                  bucket as fountain boosts via the classifier's RSS guid map

    Returns (None, None) if the tx is unbucketable (e.g. fountain_stream with
    neither episode nor show URL — already filtered by the classifier, but
    defensive)."""
    if info["source"] == "fountain_stream" and info["show_level"]:
        return SHOW_BUCKET, SHOW_TITLE

    # Show-level Fountain BOLT11 boosts (URL `/show/...` instead of
    # `/episode/...`) — sats accumulate into SHOW_BUCKET so they're tracked,
    # but rank_episodes excludes SHOW_BUCKET so they stay off the per-episode
    # leaderboard.
    if info["source"] == "fountain_boost" and info.get("show_level"):
        return SHOW_BUCKET, SHOW_TITLE

    # Show-level website boosts (description `LocalBitcoinersShow`) follow
    # the same path — accumulate into SHOW_BUCKET, excluded from the
    # per-episode top-5.
    if info["source"] == "website" and info.get("show_level"):
        return SHOW_BUCKET, SHOW_TITLE

    # General LB donations aren't tied to any episode — handled by the
    # donations bot, which publishes its own real-time receipt note.
    if info["source"] == "lb_donation":
        return None, None

    if info["source"] == "keysend":
        # Defer livestream / unresolvable keysends. Without episode_id we'd
        # bucket by sanitized title (e.g. "live_____bowl_after_bowl_____")
        # which adds sats to a phantom episode that never matches a Fountain
        # one. Skip; backfill will re-process post-show.
        if not info.get("episode_id"):
            return None, None
        boostagram = info.get("boostagram") or {}
        ep_title   = normalize_title(boostagram.get("episode", "Unknown Episode"))
        ep_id      = re.sub(r'[^a-z0-9]', '_', ep_title.lower())[:40]
        return ep_id, ep_title

    ep_id    = info.get("episode_id")
    ep_title = normalize_title(info.get("episode_title") or "")
    if not ep_title:
        ep_title = ep_id
    return ep_id, ep_title

def get_episode_number(title):
    """Extract zero-padded episode number from title."""
    if not title:
        return None
    if title.startswith("001."):
        return "001"
    m = re.search(r'Ep\.\s*(\d+)', title)
    if m:
        return m.group(1).zfill(3)
    return None

def title_without_number(title):
    """Strip the episode-number marker from an episode title so the title
    reads cleanly when the number is already shown elsewhere."""
    # Trailing " | Ep. XXX"
    t = re.sub(r'\s*\|\s*Ep\.\s*\d+\s*$', '', title)
    # Leading "001. " (first-episode convention)
    t = re.sub(r'^\d{3}\.\s*', '', t)
    return t.strip()

def rank_episodes(episodes):
    """Return top-N (ep_id, ep_dict) tuples by sats, excluding show boosts."""
    return sorted(
        [(eid, ep) for eid, ep in episodes.items() if eid != SHOW_BUCKET],
        key=lambda x: -x[1]["total_sats"]
    )[:TOP_N]

def format_note(ranked, guest_cache, default_npub):
    """Format the leaderboard note with guest npub tags."""
    medals = ["🥇", "🥈", "🥉"]
    lines  = ["⚡ Local Bitcoiners Episode Boost Leaderboard!", ""]

    for i, (ep_id, ep) in enumerate(ranked):
        medal  = medals[i] if i < 3 else "▪️"
        ep_num = get_episode_number(ep["title"])
        ep_label = f"Ep. {ep_num}" if ep_num else ep["title"]
        sats   = f"{ep['total_sats']:,}"

        guests = guest_cache.get(ep_id, [])
        if not guests:
            guests = [default_npub]

        guest_str = " & ".join(f"nostr:{npub}" for npub in guests)
        lines.append(f"{medal} {ep_label} with {guest_str} - {sats} sats")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)

def format_episode_reply(rank, ep_id, ep, guests):
    """Build a mini-advertisement reply note for a ranked episode.
    Unlike the main leaderboard note, no default-guest fallback — we simply
    omit the 'Featuring' line when an episode has no guests."""
    medals = ["🥇", "🥈", "🥉", "4th:", "5th:"]
    medal  = medals[rank] if rank < len(medals) else f"{rank + 1}th:"
    ep_num = get_episode_number(ep["title"])
    ep_label = f"Ep. {ep_num}" if ep_num else ep["title"]
    sats   = f"{ep['total_sats']:,}"
    title  = title_without_number(ep["title"])
    ep_url = f"https://fountain.fm/episode/{ep_id}"

    lines = [f"{medal} {ep_label} - {sats} sats", "", title, ""]
    lines.append("Hosted by " + " & ".join(f"nostr:{n}" for n in HOST_NPUBS))
    if guests:
        lines.append("Featuring " + " & ".join(f"nostr:{n}" for n in guests))
    lines.append("")
    lines.append(f"🎧 {ep_url}")
    return "\n".join(lines)

def resolve_guests(episodes, guest_cache):
    """Scrape guest npubs for episodes not already in guest_cache. Skips the
    show bucket and synthetic non-Fountain episode ids (keysend_*, lb_website_*)
    since those don't map to a Fountain episode page."""
    for ep_id in episodes:
        if ep_id == SHOW_BUCKET or ep_id in guest_cache:
            continue
        if ep_id.startswith("keysend_") or ep_id.startswith("lb_website_"):
            guest_cache[ep_id] = []
            continue
        ep_url = f"https://fountain.fm/episode/{ep_id}"
        _, guests = scrape_fountain_episode(ep_url)
        if guests:
            # match the LB-specific normalization the boost classifier doesn't apply
            pass
        guest_cache[ep_id] = guests
        print(f"  [guests] {ep_id}: {len(guests)} guest(s)")
        time.sleep(0.3)

def build_note_tags(note_text, nsec):
    """Build p-tags, t-tags, and zap split tags for the note.
    LB account always gets a zap split share. Guests get equal shares,
    LB gets the remainder so splits total 100."""
    pk         = PrivateKey.from_nsec(nsec)
    author_hex = pk.public_key.hex()
    tags       = []

    # p-tags for all mentioned npubs
    mentioned = re.findall(r'nostr:(npub1[a-z0-9]+)', note_text)
    seen_hex  = set()
    for npub in mentioned:
        hex_pk = npub_to_hex(npub)
        if hex_pk not in seen_hex:
            tags.append(["p", hex_pk])
            seen_hex.add(hex_pk)
    # ensure author is in p-tags
    if author_hex not in seen_hex:
        tags.append(["p", author_hex])
        seen_hex.add(author_hex)

    # t-tags for hashtags
    for ht in re.findall(r'#(\w+)', note_text):
        tags.append(["t", ht.lower()])

    # zap splits — unique npubs that have a lud16, always including author
    guest_hexes = [npub_to_hex(n) for n in mentioned]
    unique_hexes = list(dict.fromkeys(guest_hexes))  # dedupe, preserve order
    # remove author from guest list (added separately with remainder)
    unique_hexes = [h for h in unique_hexes if h != author_hex]

    # filter to those with lud16
    zappable_guests = []
    for hex_pk in unique_hexes:
        lud16 = _cached_lud16(hex_pk)
        if lud16:
            zappable_guests.append(hex_pk)
        else:
            print(f"  [zap] skipping {hex_pk[:16]}... — no lud16 found")

    total_shares   = len(zappable_guests) + 1  # +1 for LB account
    per_guest      = 100 // total_shares
    lb_share       = 100 - (per_guest * len(zappable_guests))

    for hex_pk in zappable_guests:
        tags.append(["zap", hex_pk, "", str(per_guest)])
    tags.append(["zap", author_hex, "", str(lb_share)])

    return tags

def main():
    config   = load_config(CREDENTIALS_FILE)
    state    = load_state()
    nsec     = config.get("NSEC_LOCAL_BITCOINERS")
    episodes = state.get("episodes", {})

    # Derive the LB account npub for use as default guest
    pk = PrivateKey.from_nsec(nsec)
    default_npub = hex_to_npub(pk.public_key.hex())

    cutoff = state["last_processed"] or FETCH_START
    print(f"Fetching transactions since: {cutoff}\n")

    cache        = make_cache()
    guest_cache  = {}
    new_tx_count = 0
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

            ep_id, ep_title = episode_bucket(info)
            if not ep_id:
                continue

            sats = info["total_sats"]

            if ep_id not in episodes:
                episodes[ep_id] = {"title": ep_title, "total_sats": 0, "boost_count": 0}

            episodes[ep_id]["total_sats"] += sats
            # boost_count counts only actual boosts (fountain_boost, keysend,
            # website) — streams are passive per-minute drips, not boosts.
            if info["source"] in ("fountain_boost", "keysend", "website"):
                episodes[ep_id]["boost_count"] += 1

            new_tx_count += 1

            if newest_ts is None or settled_at > newest_ts:
                newest_ts = settled_at

        offset += limit

        if last_page or offset >= total:
            break

        time.sleep(0.5)

    print(f"\nProcessed {new_tx_count} new transactions.\n")

    state["episodes"]       = episodes
    state["last_processed"] = newest_ts
    save_state(state)
    print(f"State saved → {STATE_FILE}\n")

    persist_cache(cache)

    # Resolve guests for any episodes not yet scraped
    print("Resolving episode guests...")
    resolve_guests(episodes, guest_cache)
    print()

    ranked = rank_episodes(episodes)

    note = format_note(ranked, guest_cache, default_npub)
    print("=" * 50)
    print(note)
    print("=" * 50)

    # Build per-episode reply notes (rank 1 first for printing; we publish in reverse).
    replies = []
    for i, (ep_id, ep) in enumerate(ranked):
        reply_text = format_episode_reply(i, ep_id, ep, guest_cache.get(ep_id, []))
        replies.append((i, ep_id, ep, reply_text))
        print(f"\n--- Reply {i + 1} of {len(ranked)} (rank {i + 1}) ---")
        print(reply_text)
        print("-" * 50)

    if not nsec:
        print("\n[warn] No NSEC_LOCAL_BITCOINERS in config — skipping publish")
        return

    author_hex = PrivateKey.from_nsec(nsec).public_key.hex()

    if not DRY_RUN:
        print("\nBuilding tags for main note...")
        extra_tags = build_note_tags(note, nsec)
        print(f"  {len(extra_tags)} tags built")
        print("\nPublishing main leaderboard note...")
        main_event_id = publish_to_nostr(note, nsec, extra_tags=extra_tags)
        if not main_event_id:
            print("[error] Main note publish failed; skipping reply chain.")
            return
        print(f"  Main event id: {main_event_id}")

        record_published_leaderboard(
            "local_bitcoiners_episodesats", main_event_id, author_hex,
        )

        # Post replies in reverse rank order so rank 1 is the latest reply.
        # Sleep between publishes so the prior event has time to propagate —
        # otherwise a reply can land on a relay that hasn't yet seen its root.
        for i, ep_id, ep, reply_text in reversed(replies):
            time.sleep(5)
            print(f"\nPublishing reply for rank {i + 1} ({ep_id})...")
            reply_tags = build_note_tags(reply_text, nsec)
            publish_to_nostr(reply_text, nsec, reply_to_event_id=main_event_id, extra_tags=reply_tags)
    else:
        extra_tags = build_note_tags(note, nsec)
        main_path, main_event_id = write_dry_run_event(
            note, nsec, prefix="episodesats", extra_tags=extra_tags,
        )
        print(f"\n[dry-run] Main event → {main_path}")
        print(f"  Main event id: {main_event_id}")

        # Mirror publish order: reverse rank, so file mtimes match post order.
        for i, ep_id, ep, reply_text in reversed(replies):
            reply_tags = build_note_tags(reply_text, nsec)
            ep_num = get_episode_number(ep["title"]) or "xxx"
            suffix = f"reply-rank{i + 1}-ep{ep_num}"
            reply_path, _ = write_dry_run_event(
                reply_text, nsec, prefix="episodesats",
                extra_tags=reply_tags, reply_to_event_id=main_event_id, suffix=suffix,
            )
            print(f"[dry-run] Rank {i + 1} reply → {reply_path}")

if __name__ == "__main__":
    main()
