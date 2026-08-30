#!/usr/bin/env python3
"""Local Bitcoiners leaderboards — driven by data/sats.csv.

Runs the three leaderboard publishes in series. The canonical data source
is data/sats.csv (produced by bots/sats-log/), so any manual edits to that
file flow through to leaderboard output. No per-bot state files; no direct
Alby Hub access.

Order:
    1. episodesats     — top episodes by all-time sats
    2. boost-leaders   — listeners ranked by number of shows boosted
    3. top-boosts      — single largest boosts of the last 33 days
"""

import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pynostr.key import PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import (
    load_config, publish_to_nostr, hex_to_npub, npub_to_hex, get_lud16,
    build_zap_splits_for_note, write_dry_run_event, scrape_fountain_episode,
    event_id_to_nevent, record_published_leaderboard, with_header_image,
    TOPEPISODES_IMAGE, TOPBOOSTS_IMAGE, BOOSTLEADERS_IMAGE,
)
from boost_formatter import load_published_events, load_donation_events

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
SCRIPT_DIR       = Path(__file__).resolve().parent
SATS_CSV         = SCRIPT_DIR.parent.parent / "data" / "sats.csv"

# Default safe (dry-run). Override at runtime by setting
# LB_LEADERBOARDS_DRY_RUN=false in the environment — used by the scheduled
# one-shot systemd timer for tonight's live publish.
DRY_RUN = os.environ.get("LB_LEADERBOARDS_DRY_RUN", "true").lower() != "false"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def load_sats_rows():
    if not SATS_CSV.exists():
        raise FileNotFoundError(f"sats.csv not found at {SATS_CSV}")
    with open(SATS_CSV, newline='') as f:
        rows = list(csv.DictReader(f))
    if rows:
        oldest = min(r['settled_at'] for r in rows if r.get('settled_at'))
        newest = max(r['settled_at'] for r in rows if r.get('settled_at'))
        print(f"Loaded {len(rows)} rows from data/sats.csv ({oldest[:10]} → {newest[:10]})")
    else:
        print("Loaded 0 rows from data/sats.csv")
    return rows


def get_episode_number(title):
    if not title:
        return None
    if title.startswith("001."):
        return "001"
    m = re.search(r'Ep\.\s*(\d+)', title)
    if m:
        return m.group(1).zfill(3)
    return None


def is_show_level(row):
    return (row.get('show_level') or '').lower() == 'true'


def normalize_title(title):
    return re.sub(r'^Local Bitcoiners\s*[•·]\s*', '', title or '').strip()


def title_without_number(title):
    t = re.sub(r'\s*\|\s*Ep\.\s*\d+\s*$', '', title or '')
    t = re.sub(r'^\d{3}\.\s*', '', t)
    return t.strip()


_lud16_cache = {}
def cached_lud16(hex_pk):
    if hex_pk not in _lud16_cache:
        _lud16_cache[hex_pk] = get_lud16(hex_pk)
    return _lud16_cache[hex_pk]


def build_note_tags(note_text, nsec):
    """p-tags, t-tags, and zap-split tags for a mention-bearing note.
    LB account always gets a share; zappable mentioned npubs split equally."""
    pk         = PrivateKey.from_nsec(nsec)
    author_hex = pk.public_key.hex()
    tags       = []

    mentioned = re.findall(r'nostr:(npub1[a-z0-9]+)', note_text)
    mentioned_hexes = []
    for npub in mentioned:
        hex_pk = npub_to_hex(npub)
        if hex_pk is None:
            print(f"  [tags] skipping malformed npub: {npub[:24]}...")
            continue
        mentioned_hexes.append(hex_pk)

    seen_hex  = set()
    for hex_pk in mentioned_hexes:
        if hex_pk not in seen_hex:
            tags.append(["p", hex_pk])
            seen_hex.add(hex_pk)
    if author_hex not in seen_hex:
        tags.append(["p", author_hex])
        seen_hex.add(author_hex)

    for ht in re.findall(r'#(\w+)', note_text):
        tags.append(["t", ht.lower()])

    unique_hexes = list(dict.fromkeys(mentioned_hexes))
    unique_hexes = [h for h in unique_hexes if h != author_hex]

    zappable_guests = []
    for hex_pk in unique_hexes:
        if cached_lud16(hex_pk):
            zappable_guests.append(hex_pk)
        else:
            print(f"  [zap] skipping {hex_pk[:16]}... — no lud16 found")

    total_shares = len(zappable_guests) + 1
    per_guest    = 100 // total_shares
    lb_share     = 100 - (per_guest * len(zappable_guests))

    for hex_pk in zappable_guests:
        tags.append(["zap", hex_pk, "", str(per_guest)])
    tags.append(["zap", author_hex, "", str(lb_share)])

    return tags


# ===========================================================================
# 1/3  episodesats — top episodes by all-time sats
# ===========================================================================

EPS_TOP_N = 5
EPS_HOST_NPUBS = [
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",  # Reed
    "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",  # Rev
]


def eps_aggregate(rows):
    """Group rows by episode_id, sum total_sats across all kinds (boost +
    stream). Excludes show-level rows (those go to the show bucket, not on
    the per-episode leaderboard)."""
    eps = {}
    for r in rows:
        if is_show_level(r):
            continue
        eid = r.get('episode_id') or ''
        if not eid:
            continue
        try:
            sats = int(r.get('total_sats') or 0)
        except ValueError:
            continue
        if sats <= 0:
            continue
        title = normalize_title(r.get('episode_title') or '')
        bucket = eps.setdefault(eid, {'title': title or eid, 'total_sats': 0})
        # Prefer the longest title seen for this episode (most descriptive).
        if title and len(title) > len(bucket['title']):
            bucket['title'] = title
        bucket['total_sats'] += sats
    return eps


def eps_rank(eps):
    return sorted(eps.items(), key=lambda x: -x[1]['total_sats'])[:EPS_TOP_N]


def eps_resolve_guests(eps_to_scrape, guest_cache):
    """Scrape Fountain pages for guest npubs. Only called on the ranked
    top-N to keep scrape volume small."""
    for ep_id in eps_to_scrape:
        if ep_id in guest_cache:
            continue
        ep_url = f"https://fountain.fm/episode/{ep_id}"
        _, guests = scrape_fountain_episode(ep_url)
        guest_cache[ep_id] = guests
        print(f"  [guests] {ep_id}: {len(guests)} guest(s)")
        time.sleep(0.3)


def eps_format_note(ranked, guest_cache, default_npub):
    medals = ["🥇", "🥈", "🥉"]
    lines  = ["⚡ Local Bitcoiners Episode Boost Leaderboard!", ""]

    for i, (ep_id, ep) in enumerate(ranked):
        medal    = medals[i] if i < 3 else "▪️"
        ep_num   = get_episode_number(ep["title"])
        ep_label = f"Ep. {ep_num}" if ep_num else ep["title"]
        sats     = f"{ep['total_sats']:,}"
        guests   = guest_cache.get(ep_id, []) or [default_npub]
        guest_str = " & ".join(f"nostr:{n}" for n in guests)
        lines.append(f"{medal} {ep_label} with {guest_str} - {sats} sats")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)


def eps_format_episode_reply(rank, ep_id, ep, guests):
    medals   = ["🥇", "🥈", "🥉", "4th:", "5th:"]
    medal    = medals[rank] if rank < len(medals) else f"{rank + 1}th:"
    ep_num   = get_episode_number(ep["title"])
    ep_label = f"Ep. {ep_num}" if ep_num else ep["title"]
    sats     = f"{ep['total_sats']:,}"
    title    = title_without_number(ep["title"])
    ep_url   = f"https://fountain.fm/episode/{ep_id}"

    lines = [f"{medal} {ep_label} - {sats} sats", "", title, ""]
    lines.append("Hosted by " + " & ".join(f"nostr:{n}" for n in EPS_HOST_NPUBS))
    if guests:
        lines.append("Featuring " + " & ".join(f"nostr:{n}" for n in guests))
    lines.append("")
    lines.append(f"🎧 {ep_url}")
    return "\n".join(lines)


def run_episodesats(rows, nsec):
    print()
    print("==============================================================")
    print("  1/3  episodesats — top episodes by all-time sats")
    print("==============================================================")

    pk           = PrivateKey.from_nsec(nsec)
    author_hex   = pk.public_key.hex()
    default_npub = hex_to_npub(author_hex)

    eps = eps_aggregate(rows)
    print(f"Aggregated {len(eps)} episodes from sats.csv\n")

    ranked = eps_rank(eps)

    guest_cache = {}
    print("Resolving episode guests...")
    eps_resolve_guests([eid for eid, _ in ranked], guest_cache)
    print()

    note = eps_format_note(ranked, guest_cache, default_npub)
    print("=" * 50)
    print(note)
    print("=" * 50)

    replies = []
    for i, (ep_id, ep) in enumerate(ranked):
        reply_text = eps_format_episode_reply(i, ep_id, ep, guest_cache.get(ep_id, []))
        replies.append((i, ep_id, ep, reply_text))
        print(f"\n--- Reply {i + 1} of {len(ranked)} (rank {i + 1}) ---")
        print(reply_text)
        print("-" * 50)

    print("\nBuilding tags for main note...")
    extra_tags = build_note_tags(note, nsec)
    print(f"  {len(extra_tags)} tags built")

    if DRY_RUN:
        main_path, main_event_id = write_dry_run_event(
            with_header_image(note, TOPEPISODES_IMAGE), nsec, prefix="episodesats", extra_tags=extra_tags,
        )
        print(f"\n[dry-run] Main event → {main_path}")
        print(f"  Main event id: {main_event_id}")

        for i, ep_id, ep, reply_text in reversed(replies):
            reply_tags = build_note_tags(reply_text, nsec)
            ep_num = get_episode_number(ep["title"]) or "xxx"
            suffix = f"reply-rank{i + 1}-ep{ep_num}"
            reply_path, _ = write_dry_run_event(
                reply_text, nsec, prefix="episodesats",
                extra_tags=reply_tags, reply_to_event_id=main_event_id, suffix=suffix,
            )
            print(f"[dry-run] Rank {i + 1} reply → {reply_path}")
        return

    print("\nPublishing main leaderboard note...")
    main_event_id = publish_to_nostr(with_header_image(note, TOPEPISODES_IMAGE), nsec, extra_tags=extra_tags)
    if not main_event_id:
        print("[error] Main note publish failed; skipping reply chain.")
        return
    print(f"  Main event id: {main_event_id}")

    record_published_leaderboard(
        "local_bitcoiners_episodesats", main_event_id, author_hex,
    )

    for i, ep_id, ep, reply_text in reversed(replies):
        time.sleep(5)
        print(f"\nPublishing reply for rank {i + 1} ({ep_id})...")
        reply_tags = build_note_tags(reply_text, nsec)
        publish_to_nostr(reply_text, nsec, reply_to_event_id=main_event_id, extra_tags=reply_tags)


# ===========================================================================
# 2/3  boost-leaders — listeners ranked by number of shows boosted
# ===========================================================================

# Number of distinct episode-count TIERS to show — not the number of
# listeners. Everyone tied at a shown count is listed, so a note can carry
# more than BL_TOP_TIERS names (e.g. three listeners tied at 26 episodes all
# take the 🥇 line). Tiers past the three medals fall back to ▪️, matching
# the episodesats and top-boosts notes.
BL_TOP_TIERS = 5
BL_EXCLUDED_NPUBS = {
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",  # reed
    "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",  # rev
}


def bl_aggregate(rows):
    """Bucket boosters by npub (preferred) or name:<sender_name> (keysend
    named-anon fallback). Collect each booster's set of distinct episode_ids.
    Excludes streams and show-level rows."""
    boosters = {}
    for r in rows:
        if r.get('kind') != 'boost':
            continue
        if is_show_level(r):
            continue
        eid = r.get('episode_id') or ''
        if not eid:
            continue
        npub = r.get('sender_npub') or ''
        name = r.get('sender_name') or ''
        if npub:
            key = npub
        elif name:
            key = f"name:{name}"
        else:
            continue
        boosters.setdefault(key, set()).add(eid)
    return boosters


def bl_format_booster_display(key):
    if key.startswith("name:"):
        return key[5:]
    return f"nostr:{key}"


def bl_format_note(boosters):
    medals   = ["🥇", "🥈", "🥉"]
    filtered = {k: v for k, v in boosters.items() if k not in BL_EXCLUDED_NPUBS}
    ranked   = sorted(filtered.items(), key=lambda x: -len(x[1]))

    distinct_counts = []
    for _, episodes in ranked:
        c = len(episodes)
        if c not in distinct_counts:
            distinct_counts.append(c)
        if len(distinct_counts) >= BL_TOP_TIERS:
            break
    top_counts = set(distinct_counts)
    top        = [(k, eps) for k, eps in ranked if len(eps) in top_counts]
    tier_medal = {c: (medals[i] if i < len(medals) else "▪️")
                  for i, c in enumerate(distinct_counts)}

    lines = ["⚡ Local Bitcoiners Boost Leaders", ""]
    lines.append("Listeners who have boosted the most episodes, all-time:")
    lines.append("")

    for booster_key, episodes in top:
        count   = len(episodes)
        medal   = tier_medal.get(count, "▪️")
        display = bl_format_booster_display(booster_key)
        lines.append(f"{medal} {display} - {count} episode{'s' if count != 1 else ''}")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)


def run_boostleaders(rows, nsec):
    print()
    print("==============================================================")
    print("  2/3  boost-leaders — most shows boosted")
    print("==============================================================")

    boosters = bl_aggregate(rows)
    print(f"Aggregated {len(boosters)} boosters from sats.csv\n")

    if not boosters:
        print("[warn] No boosters found; nothing to publish.")
        return

    note = bl_format_note(boosters)
    print("=" * 50)
    print(note)
    print("=" * 50)

    author_hex = PrivateKey.from_nsec(nsec).public_key.hex()

    print("\nBuilding zap splits...")
    zap_tags = build_zap_splits_for_note(note, nsec)
    if zap_tags:
        print(f"Zap split: {len(zap_tags)} recipients")

    if DRY_RUN:
        path, _ = write_dry_run_event(
            with_header_image(note, BOOSTLEADERS_IMAGE), nsec, prefix="boostleaders", extra_tags=zap_tags,
        )
        print(f"\n[dry-run] standalone → {path}")
        return

    print("\nPublishing standalone note...")
    standalone_id = publish_to_nostr(with_header_image(note, BOOSTLEADERS_IMAGE), nsec, extra_tags=zap_tags)
    if standalone_id:
        record_published_leaderboard(
            "local_bitcoiners_boostleaders", standalone_id, author_hex,
        )


# ===========================================================================
# 3/3  top-boosts — single largest boosts of a trailing window
# ===========================================================================

TB_TOP_N = 5
# Trailing window, in days, measured back from the moment the bot fires.
# Matches the site's 33-day feature TTL.
TB_WINDOW_DAYS = 33
TB_SENDER_OVERRIDES_FILE = Path.home() / ".config/nostr-bots/sender_overrides.json"


def tb_load_sender_overrides():
    if not TB_SENDER_OVERRIDES_FILE.exists():
        return {}
    return json.loads(TB_SENDER_OVERRIDES_FILE.read_text())

TB_SENDER_OVERRIDES = tb_load_sender_overrides()


def tb_window_start():
    """UTC cutoff for the trailing window, as an ISO-Z string that sorts
    against sats.csv's settled_at column."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=TB_WINDOW_DAYS)
    return cutoff.strftime('%Y-%m-%dT%H:%M:%SZ')


def tb_aggregate(rows, since):
    """Return boost rows settled on/after `since`, sorted by total_sats desc.
    Includes show-level boosts (matches old-bot behavior + the website's
    biggest-boosts view); excludes streams. Rows with no settled_at can't be
    placed in the window, so they're dropped."""
    boosts = []
    for r in rows:
        if r.get('kind') != 'boost':
            continue
        settled = r.get('settled_at') or ''
        if not settled or settled < since:
            continue
        try:
            sats = int(r.get('total_sats') or 0)
        except ValueError:
            continue
        if sats <= 0:
            continue
        boosts.append({
            'payment_hash':  r.get('payment_hash') or '',
            'npub':          r.get('sender_npub') or '',
            'sender_name':   r.get('sender_name') or '',
            'sats':          sats,
            'episode_id':    r.get('episode_id') or '',
            'episode_num':   r.get('episode_num') or '',
            'episode_title': r.get('episode_title') or '',
            'show_level':    is_show_level(r),
            'settled_at':    settled,
        })
    boosts.sort(key=lambda b: -b['sats'])
    return boosts


def tb_format_sender_display(b):
    """Display fallback chain: npub → manual senderName override → bare
    senderName (keysend named-anon) → "Anon"."""
    if b.get('npub'):
        return f"nostr:{b['npub']}"
    name = b.get('sender_name')
    if name and name in TB_SENDER_OVERRIDES:
        return f"nostr:{TB_SENDER_OVERRIDES[name]}"
    if name:
        return name
    return "Anon"


def tb_episode_label(b):
    if b.get('show_level'):
        return "Local Bitcoiners (show)"
    num = b.get('episode_num') or get_episode_number(b.get('episode_title') or '')
    if num:
        return f"Ep. {num}"
    return b.get('episode_title') or "unknown"


def tb_format_note(ranked):
    medals = ["🥇", "🥈", "🥉"]
    lines  = [f"⚡ Local Bitcoiners Top Boosts — Last {TB_WINDOW_DAYS} Days", ""]
    lines.append(f"The biggest single boosts sent to the show in the past {TB_WINDOW_DAYS} days:")
    lines.append("")

    for i, b in enumerate(ranked):
        medal  = medals[i] if i < 3 else "▪️"
        sats   = f"{b['sats']:,}"
        label  = tb_episode_label(b)
        sender = tb_format_sender_display(b)
        lines.append(f"{medal} {sender} - {sats} sats on {label}")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)


def tb_resolve_event_ids(ranked, published_events, donation_events):
    """For each top-N boost look up its event_id from boost-publisher's
    published_events / donation_events cache. Returns payment_hash → event_id
    for hits; logs a coverage warning for misses (their reply notes are
    skipped — we no longer regen via Alby in this bot)."""
    event_ids = {}
    missing   = []
    for b in ranked:
        ph = b.get('payment_hash')
        if not ph:
            continue
        if ph in published_events:
            event_ids[ph] = published_events[ph]['event_id']
        elif ph in donation_events:
            event_ids[ph] = donation_events[ph]['event_id']
        else:
            missing.append(b)

    if missing:
        print(f"\n  [warn] {len(missing)} top-{TB_TOP_N} boost(s) missing from event cache — reply will be skipped:")
        for b in missing:
            ident = b.get('npub') or b.get('sender_name') or 'Anon'
            print(f"    {b['sats']:,} sats, ph={b['payment_hash'][:12]}..., sender={ident}")
    else:
        print(f"  All top-{TB_TOP_N} boosts found in event cache.")

    return event_ids


def run_topboosts(rows, nsec):
    print()
    print("==============================================================")
    print(f"  3/3  top-boosts — largest boosts of the last {TB_WINDOW_DAYS} days")
    print("==============================================================")

    since  = tb_window_start()
    boosts = tb_aggregate(rows, since)
    print(f"Window: {since} → now ({TB_WINDOW_DAYS} days)")
    print(f"Aggregated {len(boosts)} boosts from sats.csv\n")

    if not boosts:
        print(f"[warn] No boosts in the last {TB_WINDOW_DAYS} days; nothing to publish.")
        return

    ranked = boosts[:TB_TOP_N]
    note   = tb_format_note(ranked)
    print("=" * 50)
    print(note)
    print("=" * 50)

    print("\n─── Resolving event ids for top boosts ───")
    published_events  = load_published_events()
    donation_events   = load_donation_events()
    event_ids_by_hash = tb_resolve_event_ids(ranked, published_events, donation_events)

    lb_author_hex = PrivateKey.from_nsec(nsec).public_key.hex()

    print("\n─── Leaderboard ───")
    zap_tags = build_zap_splits_for_note(note, nsec)
    if zap_tags:
        print(f"  Zap split: {len(zap_tags)} recipients")

    if DRY_RUN:
        path, main_event_id = write_dry_run_event(
            with_header_image(note, TOPBOOSTS_IMAGE), nsec, prefix="topboosts", extra_tags=zap_tags,
        )
        print(f"[dry-run] Main event → {path}")
    else:
        print("Publishing main leaderboard note...")
        main_event_id = publish_to_nostr(with_header_image(note, TOPBOOSTS_IMAGE), nsec, extra_tags=zap_tags)

    if not main_event_id:
        print("[error] Main note publish failed; skipping reply chain.")
        return
    print(f"  Main event id: {main_event_id}")

    if not DRY_RUN:
        record_published_leaderboard(
            "local_bitcoiners_topboosts", main_event_id, lb_author_hex,
        )

    print("\n─── Reply chain ───")
    for i in reversed(range(len(ranked))):
        b  = ranked[i]
        ph = b.get('payment_hash', '')
        ev_id = event_ids_by_hash.get(ph)
        if not ev_id:
            print(f"[skip] Rank {i + 1} ({ph[:12]}...) has no event id — no reply")
            continue
        nevent     = event_id_to_nevent(ev_id, author_hex=lb_author_hex)
        reply_text = f"nostr:{nevent}"

        if DRY_RUN:
            suffix = f"reply-rank{i + 1}"
            path, _ = write_dry_run_event(
                reply_text, nsec, prefix="topboosts",
                reply_to_event_id=main_event_id, suffix=suffix,
            )
            print(f"[dry-run] Rank {i + 1} reply → {path}")
        else:
            time.sleep(5)
            print(f"Publishing reply for rank {i + 1} → nostr:{nevent[:32]}...")
            publish_to_nostr(reply_text, nsec, reply_to_event_id=main_event_id)


# ===========================================================================
# Entry point
# ===========================================================================

def main():
    print(f"Local Bitcoiners leaderboards — sats.csv driven")
    print(f"DRY_RUN = {DRY_RUN}\n")

    config = load_config(CREDENTIALS_FILE)
    nsec   = config.get("NSEC_LOCAL_BITCOINERS")
    if not nsec:
        print("[fatal] No NSEC_LOCAL_BITCOINERS in credentials.env")
        sys.exit(1)

    rows = load_sats_rows()

    run_episodesats(rows, nsec)
    run_boostleaders(rows, nsec)
    run_topboosts(rows, nsec)

    print()
    print("All three leaderboards complete.")


if __name__ == "__main__":
    main()
