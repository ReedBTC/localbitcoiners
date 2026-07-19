#!/usr/bin/env python3
"""DRY RUN — lnbits enrichment preview. Publishes/pays nothing.

Fetches recent Alby Hub txs, builds the lnbits comment map, enriches, and runs
the real classifier over each recent incoming tx — printing what it resolves to
before/after enrichment. Use this to confirm website + Fountain + keysend all
classify correctly with reed@localbitcoiners.com receiving, prior to wiring the
enrichment into run_sats().
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))

from nostr_utils import load_config
from boost_formatter import classify_lb_tx, make_cache
import lnbits_source

CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
ALBY_PAGE = 30  # recent window is enough to show the test boosts


def fetch_alby(config, limit):
    import requests
    url, tok = config["ALBY_HUB_URL"], config["ALBY_TOKEN"]
    r = requests.get(f"{url}/api/transactions?limit={limit}&offset=0",
                     headers={"Authorization": f"Bearer {tok}"}, timeout=30)
    r.raise_for_status()
    return r.json().get("transactions", [])


def short(s, n):
    s = (s or "")
    return (s[: n - 1] + "…") if len(s) > n else s.ljust(n)


def main():
    config = load_config(CREDENTIALS_FILE)

    print("Fetching Alby Hub transactions…")
    txs = fetch_alby(config, ALBY_PAGE)
    incoming = [t for t in txs if t.get("type") == "incoming" and t.get("state") == "settled"]
    print(f"  {len(incoming)} recent incoming settled txs\n")

    print("Building lnbits comment map…")
    comment_map = lnbits_source.build_comment_map(config)
    patched = lnbits_source.enrich_txs(incoming, comment_map)
    print(f"  enriched {patched} tx description(s) from lnbits\n")

    cache = make_cache()
    print(f"{'settledAt':20}  {'payhash':12}  enr  {'description (post)':26}  "
          f"{'source':15}  {'ep':3}  {'sats':>5}  sender")
    print("-" * 120)
    for tx in incoming:
        ph = (tx.get("paymentHash") or "")[:10]
        enr = "Y" if "_lnbits_original_description" in tx else " "
        desc = tx.get("description", "")
        try:
            info = classify_lb_tx(tx, cache=cache)
        except Exception as e:
            info = None
            err = f"[classify error: {e}]"
        if info:
            sender = info.get("sender_npub") or info.get("sender_name") or "—"
            row = (f"{short(tx.get('settledAt',''),20)}  {ph:12}  {enr:^3}  "
                   f"{short(desc,26)}  {short(info['source'],15)}  "
                   f"{short(info.get('episode_number') or '',3)}  "
                   f"{info.get('total_sats',0):5}  {short(sender,24)}")
        else:
            reason = "unclassified" if 'err' not in dir() else err
            row = (f"{short(tx.get('settledAt',''),20)}  {ph:12}  {enr:^3}  "
                   f"{short(desc,26)}  {'(none)':15}  {'':3}  {'':>5}  —")
        print(row)

    print("\nLegend: enr=Y means description was replaced with the lnbits comment.")
    print("This was a DRY RUN — nothing was published or paid.")


if __name__ == "__main__":
    main()
