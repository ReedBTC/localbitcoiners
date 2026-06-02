#!/usr/bin/env python3

import sys
import requests
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import (
    load_config, publish_to_nostr, build_zap_splits_for_note,
    write_dry_run_event, follow_all,
)
from boost_formatter import (
    build_note_from_tx, load_published_events, save_published_events,
    record_published_event, make_cache, is_dry_run, persist_cache,
    build_podcast_guid_tags,
)

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
STATE_FILE       = Path(__file__).resolve().parent / "last_seen.txt"

DRY_RUN = False

def load_last_seen():
    if STATE_FILE.exists():
        return STATE_FILE.read_text().strip()
    return None

def save_last_seen(ts):
    STATE_FILE.write_text(ts)

def fetch_transactions(config):
    url     = config["ALBY_HUB_URL"]
    token   = config["ALBY_TOKEN"]
    headers = {"Authorization": f"Bearer {token}"}
    resp    = requests.get(f"{url}/api/transactions?limit=50", headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()

def main():
    config            = load_config(CREDENTIALS_FILE)
    last_seen         = load_last_seen()
    nsec              = config.get("NSEC_LOCAL_BITCOINERS")
    boost_board       = config.get("LOCAL_BITCOINERS_BOOST_BOARD")
    published_events  = load_published_events()
    cache             = make_cache()

    print(f"Polling Alby Hub... (last seen: {last_seen or 'none — processing all'})\n")

    try:
        data = fetch_transactions(config)
    except Exception as e:
        print(f"[error] Could not reach Alby Hub: {e}")
        return

    transactions = data if isinstance(data, list) else data.get("transactions", [])

    # Pre-filter by settledAt before classifying — keeps stale txs out of the
    # classifier's network lookups (kind 30078 / Fountain comments). Source
    # detection is now the classifier's job inside build_note_from_tx.
    candidates = []
    for tx in transactions:
        if tx.get("type") != "incoming" or tx.get("state") != "settled":
            continue
        if last_seen and tx.get("settledAt", "") <= last_seen:
            continue
        candidates.append(tx)

    if not candidates:
        print("No new transactions to consider.")
        return

    candidates.sort(key=lambda t: t.get("settledAt", ""))

    npubs_to_follow = []  # batched after the loop into a single kind-3 update

    newest_ts  = last_seen
    boost_count = 0

    for tx in candidates:
        result = build_note_from_tx(tx, cache=cache)
        if not result:
            # Not a boost (or it's a stream — streams belong to weekly-recap).
            # Don't advance newest_ts here; we want last_seen to track the most
            # recent *boost* we've processed, mirroring the prior behavior.
            continue

        info = result["info"]

        # Defer keysend boosts the classifier couldn't tie to a Fountain
        # episode — almost always livestream boosts (boostLink absent,
        # episode_guid → <podcast:liveItem>). Note would render with no 🔗 and
        # a "LIVE!" 🎙️ that buckets nowhere. last_seen stays behind so a
        # backfill script can re-fetch these post-show.
        if info["source"] == "keysend" and not info.get("episode_id"):
            ph = info.get("payment_hash", "")
            print(f"[skip] live keysend boost — {ph[:12]}... {info['total_sats']:,} sats — {info.get('episode_title') or '<no title>'}")
            continue

        # Defer a fresh fountain_boost whose donor comment isn't on Fountain
        # yet. The classifier sets fountain_comment_pending when the donor left
        # a BOLT11 memo but lookup_fountain_sender found no matching Fountain
        # comment this poll — almost always a propagation race: the comment was
        # posted seconds before our poll and Fountain's API hadn't indexed it.
        # Without the comment we have no sender npub and only the (often
        # truncated) BOLT11 memo.
        #
        # last_seen is a single high-water-mark, so we can't advance past a
        # newer boost while leaving this one behind for retry — and a deferred
        # boost re-published next run would duplicate (dedup is last_seen, not
        # published_events). So we BREAK: this boost and everything after it in
        # the batch wait for the next poll (~10 min), which re-runs them in
        # settledAt order once Fountain has had time to index.
        #
        # Bounded by tx age: once the boost is >10 min old the classifier's
        # condition still flags it, but we stop deferring and let it publish
        # with whatever we have, so a comment that never appears can't block
        # the queue forever.
        if info["source"] == "fountain_boost" and info.get("fountain_comment_pending"):
            settled_iso = tx.get("settledAt", "") or ""
            try:
                age_sec = (datetime.now(timezone.utc)
                           - datetime.fromisoformat(settled_iso.replace("Z", "+00:00"))
                          ).total_seconds()
            except Exception:
                age_sec = 99999  # unparseable → don't defer
            if age_sec < 600:
                ph = info.get("payment_hash", "")
                print(f"[defer] fountain_boost {ph[:12]}... — donor comment not on "
                      f"Fountain yet ({int(age_sec)}s old). Holding this boost and the "
                      f"rest of this batch for the next poll.")
                break

        boost_count += 1
        note             = result["note_text"]
        npub             = result["sender_npub"]
        payment_hash     = result["payment_hash"]
        settled_at       = tx.get("settledAt", "")
        sender_display   = f"nostr:{npub}" if npub else None
        effective_dryrun = is_dry_run(DRY_RUN, info["source"])

        if npub:
            # Auto-follow only Fountain senders historically; the website-boost
            # sender tag also resolves to a real npub the user has chosen to
            # attach, so it's reasonable to follow them too. Anonymous (no npub)
            # boosts have nothing to follow.
            npubs_to_follow.append(npub)

        print("─" * 50)
        print(note)
        print(f"  [source: {info['source']} | hash: {payment_hash[:16]}...]")
        print(f"  [sender: {sender_display or 'anonymous'}]")
        if effective_dryrun and not DRY_RUN:
            print("  [website-dry-run gate active — this note will not publish]")
        print()

        if nsec and not effective_dryrun:
            print("  Building zap splits...")
            zap_tags = build_zap_splits_for_note(note, nsec)
            if zap_tags:
                print(f"  Zap split: {len(zap_tags)} recipients")

            # NIP-73 podcast GUID tags (feed always, episode item GUID when known).
            all_tags = zap_tags + build_podcast_guid_tags(info)

            print("  Publishing standalone note...")
            standalone_id = publish_to_nostr(note, nsec, extra_tags=all_tags)
            if standalone_id:
                record_published_event(published_events, payment_hash, standalone_id, settled_at)

            if boost_board:
                print("  Publishing reply to boost board...")
                publish_to_nostr(note, nsec, reply_to_event_id=boost_board, extra_tags=all_tags)
        elif effective_dryrun and nsec:
            print("  Building zap splits...")
            zap_tags = build_zap_splits_for_note(note, nsec)
            all_tags = zap_tags + build_podcast_guid_tags(info)
            suffix   = payment_hash[:12] or None
            path, standalone_id = write_dry_run_event(
                note, nsec, prefix="boosts", extra_tags=all_tags, suffix=suffix,
            )
            print(f"  [dry-run] standalone → {path}")
            # Deliberately NOT recording standalone_id to published_events in
            # dry-run: the preview id wouldn't exist on real relays, and
            # persisting it would corrupt future production runs.
            if boost_board:
                path, _ = write_dry_run_event(
                    note, nsec, prefix="boosts-reply",
                    extra_tags=all_tags, reply_to_event_id=boost_board, suffix=suffix,
                )
                print(f"  [dry-run] boost-board reply → {path}")
        else:
            print("  [warn] No NSEC_LOCAL_BITCOINERS in config — skipping publish")

        newest_ts = tx.get("settledAt", newest_ts)

    if boost_count == 0:
        print("No new boosts found.")

    if newest_ts and newest_ts != last_seen:
        save_last_seen(newest_ts)
        print(f"\nState updated → {newest_ts}")

    if not DRY_RUN:
        save_published_events(published_events)

    persist_cache(cache)

    # Auto-follow any senders we identified this run who we're not already following.
    if nsec and npubs_to_follow:
        print(f"\n─── Follow-list update ───")
        print(f"  Senders this run: {len(npubs_to_follow)} ({len(set(npubs_to_follow))} unique)")
        follow_all(npubs_to_follow, nsec, dry_run=DRY_RUN)

if __name__ == "__main__":
    main()
