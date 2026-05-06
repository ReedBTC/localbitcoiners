#!/usr/bin/env python3

import sys
import json
import requests
import websocket
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import load_config, publish_to_nostr, write_dry_run_event, build_zap_splits_for_v4v
from boost_formatter import (
    nostrify_mentions, V4V_RELAYS,
    load_donation_events, save_donation_events, record_published_event,
)

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
STATE_FILE       = Path(__file__).resolve().parent / "last_seen.txt"

DRY_RUN              = False
LOCALBITCOINERS_APP_ID = 28
QUERY_RELAYS = V4V_RELAYS

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

def fetch_nostr_event(payment_hash):
    filter_ = {"kinds": [30078], "#d": [payment_hash]}
    for relay in QUERY_RELAYS:
        try:
            ws = websocket.create_connection(relay, timeout=10)
            ws.send(json.dumps(["REQ", "boost", filter_]))
            while True:
                msg = json.loads(ws.recv())
                if msg[0] == "EVENT":
                    ws.close()
                    return msg[2]
                elif msg[0] == "EOSE":
                    ws.close()
                    break
        except Exception as e:
            print(f"  [warn] relay query failed {relay}: {e}")
    return None

def parse_boostagram(event):
    tags = {t[0]: t[1] for t in event.get("tags", []) if len(t) >= 2}
    return {
        "message":   event.get("content", ""),
        "sender":    tags.get("sender"),
        "recipient": tags.get("recipient"),
        "amount":    int(tags.get("amount", 0)),
        "url":       tags.get("url"),
    }

def format_note(boostagram, sats):
    lines = ["⚡ New Donation on localbitcoiners.com"]
    lines.append(f"💰 {sats:,} sats")

    if boostagram["sender"]:
        lines.append(f"👤 nostr:{boostagram['sender']}")
    else:
        lines.append("👤 Anon")

    if boostagram["message"]:
        lines.append(f'💬 "{nostrify_mentions(boostagram["message"])}"')

    if boostagram["url"] and "localhost" not in boostagram["url"]:
        lines.append(f"🔗 {boostagram['url']}")

    lines.append("")
    lines.append("#LocalBitcoiners #Bitcoin #V4V #V4V2")
    return "\n".join(lines)

def main():
    config           = load_config(CREDENTIALS_FILE)
    last_seen        = load_last_seen()
    nsec             = config.get("NSEC_LOCAL_BITCOINERS")
    boost_board      = config.get("LOCAL_BITCOINERS_BOOST_BOARD")
    donation_events  = load_donation_events()

    print(f"Polling Alby Hub... (last seen: {last_seen or 'none'})\n")

    try:
        data = fetch_transactions(config)
    except Exception as e:
        print(f"[error] Could not reach Alby Hub: {e}")
        return

    transactions = data if isinstance(data, list) else data.get("transactions", [])

    donations = []
    for tx in transactions:
        if tx.get("type") != "incoming":
            continue
        if tx.get("state") != "settled":
            continue
        if not tx.get("descriptionHash"):
            continue
        if tx.get("appId") != LOCALBITCOINERS_APP_ID:
            continue
        if last_seen and tx.get("settledAt", "") <= last_seen:
            continue
        donations.append(tx)

    if not donations:
        print("No new localbitcoiners.com donations found.")
        return

    donations.sort(key=lambda t: t.get("settledAt", ""))

    newest_ts = last_seen
    for tx in donations:
        payment_hash = tx.get("paymentHash")
        settled_at   = tx.get("settledAt", "")
        sats         = tx["amount"] // 1000

        print(f"  Found candidate: {sats} sats [{payment_hash[:16]}...]")
        print(f"  Querying Nostr for kind 30078 event...")

        event = fetch_nostr_event(payment_hash)
        if not event:
            print(f"  [skip] No kind 30078 event for {payment_hash[:16]}... (not a V4V 2.0 boost)")
            newest_ts = settled_at
            continue

        boostagram = parse_boostagram(event)
        note       = format_note(boostagram, sats)
        zap_tags   = build_zap_splits_for_v4v(boostagram["sender"], nsec) if nsec else []

        print("─" * 50)
        print(note)
        print()

        if nsec and not DRY_RUN:
            print("  Publishing standalone note...")
            event_id = publish_to_nostr(note, nsec, extra_tags=zap_tags)
            # Recorded so top-boosts can reference donation notes in its weekly
            # reply chain when a donation lands in the all-time top 5.
            if event_id:
                record_published_event(donation_events, payment_hash, event_id, settled_at)

            # Mirror the boost-publisher pattern: also reply to the LB boost
            # board so donation receipts surface in the megathread alongside
            # episode boost notes — donors who tipped from the website are
            # otherwise confused why their boosts don't appear there.
            if boost_board:
                print("  Publishing reply to boost board...")
                publish_to_nostr(note, nsec, reply_to_event_id=boost_board, extra_tags=zap_tags)
        elif DRY_RUN and nsec:
            path, _ = write_dry_run_event(note, nsec, prefix="localbitcoiners-donation", suffix=payment_hash[:12], extra_tags=zap_tags)
            print(f"  [dry-run] standalone → {path}")
            if boost_board:
                path, _ = write_dry_run_event(
                    note, nsec, prefix="localbitcoiners-donation-reply",
                    extra_tags=zap_tags, reply_to_event_id=boost_board, suffix=payment_hash[:12],
                )
                print(f"  [dry-run] boost-board reply → {path}")
        else:
            print("  [warn] No NSEC_LOCAL_BITCOINERS in config — skipping publish")

        newest_ts = settled_at

    if newest_ts and newest_ts != last_seen:
        save_last_seen(newest_ts)
        print(f"\nState updated → {newest_ts}")

    if not DRY_RUN:
        save_donation_events(donation_events)

if __name__ == "__main__":
    main()
