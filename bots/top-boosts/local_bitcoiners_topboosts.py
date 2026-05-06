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
    load_config, publish_to_nostr, hex_to_npub, build_zap_splits_for_note,
    write_dry_run_event, event_id_to_nevent, record_published_leaderboard,
)
from boost_formatter import (
    build_note_from_tx, load_published_events,
    save_published_events, record_published_event,
    load_donation_events,
    classify_lb_tx, make_cache, persist_cache,
)

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
STATE_FILE       = Path(__file__).resolve().parent / "state.json"

DRY_RUN     = False
FETCH_START = "2024-01-01T00:00:00Z"
TOP_N       = 5


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_processed": None, "boosts": [], "title_cache": {}}


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


def get_episode_number(title):
    if not title:
        return None
    if title.startswith("001."):
        return "001"
    m = re.search(r'Ep\.\s*(\d+)', title)
    if m:
        return m.group(1).zfill(3)
    return None


def episode_label(title):
    num = get_episode_number(title)
    return f"Ep. {num}" if num else (title or "unknown")


def episode_id_for_topboost(info):
    """Per-source episode-id key, preserving the prior inline behavior. Keysend
    boosts that arrive without a boostagram.episode title get a synthetic
    `keysend_<paymentHashPrefix>` id (so each one is its own bucket); changing
    that to None or the classifier-derived Fountain id would corrupt prior
    state's id shape."""
    if info["source"] == "keysend":
        # Defer livestream / unresolvable keysends — see boost-leaders'
        # episode_key_for_leader_count for the rationale. Returning None makes
        # the existing skip below catch it, leaving last_processed behind for
        # backfill.
        if not info.get("episode_id"):
            return None
        boostagram = info.get("boostagram") or {}
        ep_from_boostagram = boostagram.get("episode", "")
        if ep_from_boostagram:
            return ep_from_boostagram
        return f"keysend_{info['payment_hash'][:8]}"
    if info["source"] == "lb_donation":
        # Each general donation is its own bucket. The leaderboard ranks by
        # sats so two donations of equal sats from the same npub still show
        # up as separate entries (which is correct — they're separate boosts).
        return f"lb_donation_{info['payment_hash'][:8]}"
    return info.get("episode_id")


def episode_title_for_topboost(info, episode_id):
    """Match prior fallback chain: classifier title → cached title → episode_id."""
    if info["source"] == "keysend":
        boostagram = info.get("boostagram") or {}
        return boostagram.get("episode", "") or episode_id
    if info["source"] == "lb_donation":
        # Always render donations with a clean label — episode_id is the
        # synthetic `lb_donation_{ph}` which would look ugly on the leaderboard.
        return info.get("episode_title") or "localbitcoiners.com"
    return info.get("episode_title") or episode_id


def rank_boosts(boosts):
    """Return the top-N boosts sorted by sats descending."""
    return sorted(boosts, key=lambda b: -b["sats"])[:TOP_N]


# Manual senderName → npub overrides. Used when a booster has confirmed
# their npub out-of-band but the keysend payload didn't carry a senderPubkey
# TLV. Only consulted when the boost itself has no cryptographically-attested
# npub — an actual TLV pubkey from the booster always wins. The mapping
# itself lives outside the repo at ~/.config/nostr-bots/sender_overrides.json
# so individual booster identities aren't published; if the file is absent,
# the override system is a no-op.
SENDER_OVERRIDES_FILE = Path.home() / ".config/nostr-bots/sender_overrides.json"

def load_sender_name_overrides():
    if not SENDER_OVERRIDES_FILE.exists():
        return {}
    return json.loads(SENDER_OVERRIDES_FILE.read_text())

SENDER_NAME_OVERRIDES = load_sender_name_overrides()

def format_sender_display(b):
    """Display string for the sender column of a top-boosts entry. Prefers
    npub (full mention), then a manual senderName override, then bare
    senderName for keysend named-anon boosts (e.g. PodcastGuru — senderName
    set, no senderPubkey), and finally "Anon" for truly anonymous boosts."""
    if b.get("npub"):
        return f"nostr:{b['npub']}"
    name = b.get("sender_name")
    if name and name in SENDER_NAME_OVERRIDES:
        return f"nostr:{SENDER_NAME_OVERRIDES[name]}"
    if name:
        return name
    return "Anon"

def format_note(ranked):
    """Format the leaderboard note given a pre-ranked list of top-N boosts."""
    medals = ["🥇", "🥈", "🥉"]

    lines = ["⚡ Local Bitcoiners Top Boosts of All Time", ""]
    lines.append("The biggest single boosts ever sent to the show:")
    lines.append("")

    for i, b in enumerate(ranked):
        medal = medals[i] if i < 3 else "▪️"
        sats  = f"{b['sats']:,}"
        label = episode_label(b.get("episode_title"))
        sender = format_sender_display(b)
        lines.append(f"{medal} {sender} - {sats} sats on {label}")

    lines.append("")
    lines.append("#LocalBitcoiners #V4V #valuechain")
    lines.append("")
    lines.append("🎧 https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY")
    return "\n".join(lines)


def find_txs_by_payment_hash(config, target_hashes, page_limit_safety=200):
    """Paginate Alby Hub transactions oldest-first until each target payment
    hash is found (or we exceed page_limit_safety). Returns a dict of
    payment_hash -> tx for each hit."""
    target = set(target_hashes)
    found  = {}
    offset = 0
    limit  = 50
    while target and offset < page_limit_safety * limit:
        txs, total = fetch_page(config, limit, offset)
        if not txs:
            break
        for tx in txs:
            ph = tx.get("paymentHash", "")
            if ph in target:
                found[ph] = tx
                target.discard(ph)
                if not target:
                    return found
        offset += limit
        if offset >= total:
            break
        time.sleep(0.2)
    return found


def ensure_top_boost_event_ids(ranked, published_events, config, nsec, dry_run):
    """Guarantee a standalone kind-1 event_id exists (or has been published
    in this run) for each ranked boost. Returns payment_hash -> event_id.

    Boosts already tracked in published_events reuse their saved id. Missing
    ones trigger a regen: re-fetch the Alby tx, rebuild the note via the
    shared boost formatter, publish (or dry-run), and record the new id. A
    boost that can't be resolved is simply omitted from the result (its reply
    is skipped)."""
    # Donations are published by the donations bot, which records its event
    # ids in a separate JSON file (avoids concurrent-writer races with
    # boost-publisher on the same file). Check both before falling back to
    # regen.
    donation_events = load_donation_events()

    event_ids = {}
    missing   = []
    for b in ranked:
        ph = b.get("payment_hash", "")
        if not ph:
            continue
        if ph in published_events:
            event_ids[ph] = published_events[ph]["event_id"]
        elif ph in donation_events:
            event_ids[ph] = donation_events[ph]["event_id"]
        else:
            missing.append(b)

    if not missing:
        print(f"  All {len(event_ids)} top boosts already have saved event ids.")
        return event_ids

    print(f"  {len(missing)} of {len(ranked)} top boosts missing event ids; regenerating...\n")

    hashes_needed = [b["payment_hash"] for b in missing]
    found_txs     = find_txs_by_payment_hash(config, hashes_needed)

    regen_cache = make_cache()
    for b in missing:
        ph = b["payment_hash"]
        tx = found_txs.get(ph)
        if not tx:
            print(f"  [warn] Could not locate tx for {ph[:12]}... in Alby; reply will be skipped")
            continue

        result = build_note_from_tx(tx, cache=regen_cache)
        if not result:
            print(f"  [warn] Could not build note for {ph[:12]}...; reply will be skipped")
            continue

        note = result["note_text"]
        print(f"\n  ── Regenerated note for {ph[:12]} ({result['sats']:,} sats) ──")
        print(note)
        print(f"  ──────")

        zap_tags = build_zap_splits_for_note(note, nsec)
        if zap_tags:
            print(f"  Zap split: {len(zap_tags)} recipients")

        if dry_run:
            path, ev_id = write_dry_run_event(
                note, nsec, prefix="regen-boost", extra_tags=zap_tags, suffix=ph[:12],
            )
            print(f"  [dry-run] regen → {path}")
            event_ids[ph] = ev_id
        else:
            time.sleep(2)  # gentle rate-limit across multiple regens
            ev_id = publish_to_nostr(note, nsec, extra_tags=zap_tags)
            if ev_id:
                event_ids[ph] = ev_id
                record_published_event(published_events, ph, ev_id, tx.get("settledAt", ""))
                print(f"  Saved event id: {ev_id[:16]}...")
            else:
                print(f"  [warn] Regen publish failed for {ph[:12]}; reply will be skipped")

    return event_ids


def main():
    config      = load_config(CREDENTIALS_FILE)
    state       = load_state()
    nsec        = config.get("NSEC_LOCAL_BITCOINERS")
    boosts      = state.get("boosts", [])
    title_cache = state.get("title_cache", {})
    seen_hashes = {b["payment_hash"] for b in boosts if b.get("payment_hash")}

    cutoff = state["last_processed"] or FETCH_START
    print(f"Fetching boosts since: {cutoff}\n")

    cache         = make_cache()
    new_count     = 0
    skipped_anon  = 0
    offset        = 0
    limit         = 50
    newest_ts     = state["last_processed"]

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

            payment_hash = tx.get("paymentHash", "")
            if payment_hash and payment_hash in seen_hashes:
                continue

            info = classify_lb_tx(tx, cache=cache)
            if not info or info["source"] == "fountain_stream":
                continue

            episode_id    = episode_id_for_topboost(info)
            episode_title = episode_title_for_topboost(info, episode_id)
            npub          = info["sender_npub"]
            sender_name   = info.get("sender_name")
            sats          = info["total_sats"]

            # All non-stream boosts that resolve to an episode are eligible —
            # named-anon (senderName but no npub) and truly-anon (neither)
            # both count toward the all-time top-N. Display falls back through
            # nostr:npub → senderName → "Anon" via format_sender_display.
            if not episode_id or sats <= 0:
                skipped_anon += 1
                continue

            # Persist any newly-discovered titles for next run (skip the
            # synthetic keysend_<hash> / lb_donation_<hash> ids — those
            # titles are just the synthetic id or a generic label).
            if episode_title and episode_id and not (
                episode_id.startswith("keysend_") or episode_id.startswith("lb_donation_")
            ):
                title_cache[episode_id] = episode_title

            boosts.append({
                "payment_hash":  payment_hash,
                "npub":          npub,
                "sender_name":   sender_name,
                "sats":          sats,
                "episode_id":    episode_id,
                "episode_title": episode_title,
                "settled_at":    settled_at,
            })
            seen_hashes.add(payment_hash)
            new_count += 1

            if newest_ts is None or settled_at > newest_ts:
                newest_ts = settled_at

        offset += limit
        if last_page or offset >= total:
            break

        time.sleep(0.5)

    print(f"\nProcessed {new_count} new identified boosts ({skipped_anon} skipped — no npub).\n")

    state["boosts"]         = boosts
    state["title_cache"]    = title_cache
    state["last_processed"] = newest_ts
    save_state(state)
    print(f"State saved → {STATE_FILE}\n")

    persist_cache(cache)

    if not boosts:
        print("[warn] No identified boosts found yet — nothing to publish.")
        return

    if not nsec:
        print("[warn] No NSEC_LOCAL_BITCOINERS in config — skipping publish")
        return

    ranked = rank_boosts(boosts)
    note   = format_note(ranked)
    print("=" * 50)
    print(note)
    print("=" * 50)

    # Resolve an event_id for every top-N boost before touching the leaderboard
    # publish — that way the reply chain can be built confidently.
    print("\n─── Resolving event ids for top boosts ───")
    published_events = load_published_events()
    event_ids_by_hash = ensure_top_boost_event_ids(
        ranked, published_events, config, nsec, dry_run=DRY_RUN,
    )
    if not DRY_RUN:
        save_published_events(published_events)

    # Main leaderboard publish
    print("\n─── Leaderboard ───")
    if not DRY_RUN:
        print("Building zap splits...")
        zap_tags = build_zap_splits_for_note(note, nsec)
        if zap_tags:
            print(f"  Zap split: {len(zap_tags)} recipients")
        print("Publishing main leaderboard note...")
        main_event_id = publish_to_nostr(note, nsec, extra_tags=zap_tags)
    else:
        zap_tags = build_zap_splits_for_note(note, nsec)
        path, main_event_id = write_dry_run_event(
            note, nsec, prefix="topboosts", extra_tags=zap_tags,
        )
        print(f"[dry-run] Main event → {path}")

    if not main_event_id:
        print("[error] Main note publish failed; skipping reply chain.")
        return
    print(f"  Main event id: {main_event_id}")

    lb_author_hex = PrivateKey.from_nsec(nsec).public_key.hex()
    if not DRY_RUN:
        record_published_leaderboard(
            "local_bitcoiners_topboosts", main_event_id, lb_author_hex,
        )

    # Reply chain — iterate top-N in reverse so rank 1 is the latest reply.
    print("\n─── Reply chain ───")
    for i in reversed(range(len(ranked))):
        b  = ranked[i]
        ph = b.get("payment_hash", "")
        ev_id = event_ids_by_hash.get(ph)
        if not ev_id:
            print(f"[skip] Rank {i + 1} ({ph[:12]}...) has no event id — no reply")
            continue
        nevent     = event_id_to_nevent(ev_id, author_hex=lb_author_hex)
        reply_text = f"nostr:{nevent}"

        if not DRY_RUN:
            time.sleep(5)  # let the prior publish propagate across relays
            print(f"Publishing reply for rank {i + 1} → nostr:{nevent[:32]}...")
            publish_to_nostr(reply_text, nsec, reply_to_event_id=main_event_id)
        else:
            suffix = f"reply-rank{i + 1}"
            path, _ = write_dry_run_event(
                reply_text, nsec, prefix="topboosts",
                reply_to_event_id=main_event_id, suffix=suffix,
            )
            print(f"[dry-run] Rank {i + 1} reply → {path}")


if __name__ == "__main__":
    main()
