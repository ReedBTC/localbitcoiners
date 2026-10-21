#!/usr/bin/env python3
"""Attach the booster's own kind-1 note to every historical wall record.

One-off companion to build_boost_wall.py's rolling 7-day donor pass: this one
walks the WHOLE wall. Reads the OnlyBoosts index for the feed (every page),
the website receipt chain for website boosts, and the relays for the raw
events; applies donor_notes' four rules; prints the match report and the
hand-review list.

Default is a DRY RUN that writes the resulting wall to --out (a separate file,
so the site can be built against real records before anything ships) and
touches nothing else. --apply writes the wall in place and records the donor
note ids in published_events.json. Nothing here publishes or pushes.

    python3 backfill_donor_notes.py --out ../../data/boost_wall.donor.json
    python3 backfill_donor_notes.py --apply
    python3 backfill_donor_notes.py --redo --apply   # re-pair the whole wall

--redo forgets every donor note first (wall and published_events alike) and
pairs the whole wall again under the current rules; the normal run only
fills records that have none. Use it after a rule change.

Paths default to this checkout's files; pass them explicitly when running
from a worktree against the live data (the state files are gitignored and
live only in the production checkout).
"""

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import boost_wall

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))
import donor_notes  # noqa: E402
import onlyboosts_coverage as cov  # noqa: E402
from boost_formatter import PUBLISHED_EVENTS_FILE  # noqa: E402

SATS_CSV = boost_wall.REPO_ROOT / "data" / "sats.csv"


def load_rows(path):
    with Path(path).open() as fh:
        return {r["payment_hash"]: r for r in csv.DictReader(fh)
                if r.get("payment_hash") and r.get("kind") == "boost"}


def fetch_whole_index(since_ts):
    """Every LB record OnlyBoosts has, oldest boost onward. fetch_indexed caps
    pages as a backstop for the publisher's hourly window; the backfill needs
    the lot, so the cap is lifted for this process only."""
    cov.MAX_PAGES = 100
    return cov.fetch_indexed(since_ts - cov.QUERY_PAD_SEC)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wall", default=str(boost_wall.WALL_PATH), help="input wall file")
    ap.add_argument("--sats-csv", default=str(SATS_CSV))
    ap.add_argument("--published-events", default=str(PUBLISHED_EVENTS_FILE))
    ap.add_argument("--out", default=None,
                    help="write the resulting wall HERE (dry run; default: <wall>.donor.json)")
    ap.add_argument("--apply", action="store_true",
                    help="write the wall in place and record donor ids in published_events.json")
    ap.add_argument("--days", type=int, default=0, help="only boosts settled this many days back (0 = all)")
    ap.add_argument("--no-website", action="store_true", help="skip the receipt-chain join")
    ap.add_argument("--no-fetch", action="store_true", help="match only; do not fetch raw events (ids only)")
    ap.add_argument("--review-json", default=None, help="also write the review list here")
    ap.add_argument("--redo", action="store_true",
                    help="drop every donor note first and pair the whole wall again")
    args = ap.parse_args()

    wall = boost_wall.load_wall(args.wall)
    pe_path = Path(args.published_events)
    published_events = json.loads(pe_path.read_text()) if pe_path.exists() else {}
    rows = load_rows(args.sats_csv)
    print(f"wall {len(wall)} records, ledger {len(rows)} boost rows, "
          f"published_events {len(published_events)}")
    if args.redo:
        dropped = 0
        for r in wall.values():
            for k in donor_notes.DONOR_FIELDS:
                dropped += r.pop(k, None) is not None
        for pe in published_events.values():
            for k in ("donor_note_id", "donor_match", "donor_pubkey"):
                pe.pop(k, None)
        print(f"--redo: forgot {dropped} donor fields; pairing the whole wall again")

    settled = [cov._ts(r.get("settled_at")) for r in wall.values() if r.get("settled_at")]
    since_ts = (int(time.time()) - args.days * 86400) if args.days else min(t for t in settled if t)
    try:
        index = fetch_whole_index(since_ts)
        signers = sum(1 for r in index if donor_notes.is_donor_signer((r.get("booster") or {}).get("pk")))
        print(f"OnlyBoosts index: {len(index)} LB records, {signers} signed by a person")
    except cov.CoverageUnavailable as e:
        print(f"[warn] OnlyBoosts unreachable ({e}) — index matching skipped")
        index = None

    stats = donor_notes.attach_donor_notes(
        wall, published_events, rows, index,
        set_donor_note=boost_wall.set_donor_note,
        since_ts=since_ts if args.days else None,
        website=not args.no_website, fetch=not args.no_fetch)
    print()
    donor_notes.print_stats(stats)

    with_event = sum(1 for r in wall.values() if r.get("donor_event"))
    with_id = sum(1 for r in wall.values() if r.get("donor_note_id"))
    with_ph = sum(1 for r in wall.values() if r.get("payment_hash"))
    print(f"\nwall now: {with_event} records with donor_event, {with_id} with donor_note_id, "
          f"of {with_ph} with a payment ({len(wall)} total)")

    if args.review_json and stats["review"]:
        Path(args.review_json).write_text(json.dumps(stats["review"], indent=2))
        print(f"review list → {args.review_json}")

    if args.apply:
        count, size = boost_wall.save_wall(wall, path=args.wall)
        pe_path.write_text(json.dumps(published_events, indent=2))
        print(f"\nwrote {count} records ({size / 1024:.0f} KB) → {args.wall}; "
              f"donor ids recorded in {pe_path.name}. Not pushed.")
    else:
        out = args.out or str(Path(args.wall).with_suffix(".donor.json"))
        count, size = boost_wall.save_wall(wall, path=out)
        print(f"\n[dry run] wrote {count} records ({size / 1024:.0f} KB) → {out}; "
              f"published_events.json untouched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
