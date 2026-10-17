#!/usr/bin/env python3
"""Rebuild data/boost_wall.json from a relay scan of the boost mega-thread.

Two jobs, same code path:

  BACKFILL — the ~400 boost-board replies that predate the publisher recording
  its reply ids. Their events are on the relays; their payment context is
  recoverable through a two-hop join described below.

  RECONCILE — the ongoing correctness pass. local_bitcoiners_boosts.py can only
  append notes IT publishes, but the website renders every kind-1 in the thread:
  the root, the corrections Reed publishes by hand through mynostr, and replies
  from other people (there are already two). An append-only file would silently
  drop all of those, so this needs to run on a timer, not just once.

The legacy join, for a reply with no recorded reply_id:

  reply ──content+time──> standalone note ──published_events──> payment_hash
       ──data/sats.csv──> sats / episode / app / sender

The content hop works because the reply and the standalone note are the same
text from the same key, published seconds apart; the standalone differs only by
a banner-image line prepended at publish time, which normalization strips. Where
several boosts share identical text (23 of them — a bare "1000 sats" on the same
episode), created_at proximity picks the right pair and each standalone is
consumed once.

Since 2026-10-17 a third job rides along: the DONOR-NOTE pass. For every
record with a payment behind it and no donor note yet, settled within the
last --donor-days (7), it looks for the booster's own kind-1 (the website
receipt chain, then the OnlyBoosts index) and attaches it — the late cases
the publisher cannot see at publish time (a Fountain note indexed after our
reply went out; a share note that was unfetchable for an hour). Ids it finds
are recorded in published_events.json, the durable join the wall is rebuilt
from, so this is the one place besides the publisher that writes that file.

Read-only against relays and every other local data file. Writes
data/boost_wall.json and (donor ids only) published_events.json, and pushes
only with --push.
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
from collector_common import query_relay, verify_raw_event  # noqa: E402
from nostr_utils import NOSTR_RELAYS, load_config  # noqa: E402
from boost_formatter import load_published_events, save_published_events  # noqa: E402
import donor_notes  # noqa: E402
import onlyboosts_coverage as cov  # noqa: E402

CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
SATS_CSV         = boost_wall.REPO_ROOT / "data" / "sats.csv"

# The publish set plus the relays that actually hold this thread. Measured
# 2026-08-13: fountain 372, ditto 358, nos.lol 204, nostr.mom 156 of 405 unique
# — no single relay has it all, and damus.io currently 503s on connect. Union of
# everything, deduped by event id, is the only way to get a complete wall.
SCAN_RELAYS = list(dict.fromkeys(list(NOSTR_RELAYS) + [
    "wss://relay.fountain.fm",
    "wss://relay.ditto.pub",
    "wss://nos.lol",
    "wss://nostr.mom",
]))

BANNER_PREFIX = "https://i.nostr.build/"


def scan_thread(root_id, relays):
    """Every kind-1 in the thread: the root, plus anything #e-tagging it (which
    includes replies-to-boosts, exactly as the website's own relay path collects
    them). Signature-verified — these come off untrusted relays and the file is
    served to browsers as if we vouched for it."""
    events = {}
    for relay in relays:
        got = query_relay(relay, [
            {"kinds": [1], "#e": [root_id], "limit": 1000},
            {"ids": [root_id]},
        ], max_wall_seconds=45)
        added = 0
        for ev in got:
            eid = ev.get("id")
            if not eid or eid in events:
                continue
            if not verify_raw_event(ev):
                print(f"    [warn] {relay}: dropped {eid[:12]}… — bad signature")
                continue
            events[eid] = ev
            added += 1
        print(f"    {relay.split('/')[2]}: {len(got)} events, {added} new")
    return events


def fetch_events_by_id(ids, relays):
    """Batched, signature-verified id lookup (shared with the donor pass)."""
    return donor_notes.fetch_events_by_ids(ids, relays)


def normalize(content):
    """Reply text vs standalone text: identical but for the banner image line
    the publisher prepends to standalones only (nostr_utils.with_header_image)."""
    c = (content or "").strip()
    if c.startswith(BANNER_PREFIX) and "\n" in c:
        c = c.split("\n", 1)[1]
    return c.strip()


def load_sats_rows():
    if not SATS_CSV.exists():
        print(f"  [warn] {SATS_CSV} missing — records will carry no payment fields")
        return {}
    with SATS_CSV.open() as fh:
        return {r["payment_hash"]: r for r in csv.DictReader(fh) if r.get("payment_hash")}


def join_legacy(thread, published_events, relays):
    """reply_id → payment_hash for replies the publisher never recorded.

    Returns (mapping, standalone_by_ph) — the second so callers can record which
    standalone note each reply pairs with."""
    # Standalone ids whose reply we don't already know.
    known_replies = {rec["reply_id"] for rec in published_events.values()
                     if rec.get("reply_id")}
    pending = {rec["event_id"]: ph for ph, rec in published_events.items()
               if rec.get("event_id") and not rec.get("reply_id")}
    if not pending:
        return {}, {}

    print(f"  fetching {len(pending)} standalone notes for the content join...")
    standalones = fetch_events_by_id(list(pending), relays)
    print(f"    got {len(standalones)}/{len(pending)}")

    # Candidate replies, bucketed by normalized text.
    buckets = {}
    for ev in thread.values():
        if ev["id"] in known_replies:
            continue
        buckets.setdefault(normalize(ev.get("content")), []).append(ev)

    mapping, paired = {}, {}
    used = set()
    # Nearest-in-time wins, so process in an order where the closest pairs are
    # unambiguous first: sort candidates per standalone by |Δcreated_at|.
    for sid, ev in sorted(standalones.items(), key=lambda kv: kv[1].get("created_at", 0)):
        ph = pending[sid]
        cands = [c for c in buckets.get(normalize(ev.get("content")), [])
                 if c["id"] not in used]
        if not cands:
            continue
        best = min(cands, key=lambda c: abs((c.get("created_at") or 0)
                                            - (ev.get("created_at") or 0)))
        used.add(best["id"])
        mapping[best["id"]] = ph
        paired[best["id"]] = sid
    return mapping, paired


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--push", action="store_true",
                    help="rsync the rebuilt file to the VPS (default: write locally only)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change, write nothing")
    ap.add_argument("--no-legacy-join", action="store_true",
                    help="skip the content join; unrecorded replies get their event only")
    ap.add_argument("--root", default=None, help="thread root id (default: the boost board)")
    ap.add_argument("--donor-days", type=int, default=7,
                    help="look for donor notes on boosts settled this many days back (0 = skip)")
    args = ap.parse_args()

    config = load_config(CREDENTIALS_FILE) if CREDENTIALS_FILE.exists() else {}
    root_id = args.root or config.get("LOCAL_BITCOINERS_BOOST_BOARD") or boost_wall.BOOST_BOARD_ROOT

    print(f"Scanning boost thread {root_id[:12]}… across {len(SCAN_RELAYS)} relays\n")
    thread = scan_thread(root_id, SCAN_RELAYS)
    print(f"\n  {len(thread)} unique signature-verified events\n")
    if not thread:
        print("[error] relay scan returned nothing — refusing to overwrite the wall")
        return 1

    published_events = load_published_events()
    sats_rows        = load_sats_rows()

    ph_by_reply = {rec["reply_id"]: ph for ph, rec in published_events.items()
                   if rec.get("reply_id")}
    std_by_reply = {rec["reply_id"]: rec["event_id"] for ph, rec in published_events.items()
                    if rec.get("reply_id") and rec.get("event_id")}
    print(f"  {len(ph_by_reply)} replies already recorded by the publisher")

    if not args.no_legacy_join:
        legacy, paired = join_legacy(thread, published_events, SCAN_RELAYS)
        print(f"  {len(legacy)} more joined by content+time\n")
        ph_by_reply.update(legacy)
        std_by_reply.update(paired)

    wall = boost_wall.load_wall()
    before = len(wall)
    enriched = 0
    for eid, ev in thread.items():
        ph  = ph_by_reply.get(eid)
        row = sats_rows.get(ph) if ph else None
        if row:
            enriched += 1
        elif ph:
            # Known payment, no sats.csv row (a boost newer than the last
            # sats-log run). Keep the hash so a later rebuild can fill it in.
            row = {"payment_hash": ph}
        boost_wall.upsert(wall, boost_wall.build_record(
            ev, info=row, standalone_id=std_by_reply.get(eid)))

    bare = len(thread) - enriched
    print(f"  {enriched} records with payment context, {bare} event-only "
          f"(root, manual corrections, third-party replies)")
    print(f"  wall: {before} → {len(wall)} records")

    pe_dirty = False
    if args.donor_days > 0:
        print(f"\nDonor notes — boosts settled in the last {args.donor_days} days")
        since_ts = int(time.time()) - args.donor_days * 86400
        try:
            index = cov.fetch_indexed(since_ts - cov.QUERY_PAD_SEC)
            print(f"  OnlyBoosts has {len(index)} LB boosts indexed in the window")
        except cov.CoverageUnavailable as e:
            index = None
            print(f"  [warn] OnlyBoosts unreachable ({e}) — index matching skipped this run")
        stats = donor_notes.attach_donor_notes(
            wall, published_events, sats_rows, index,
            set_donor_note=boost_wall.set_donor_note, since_ts=since_ts)
        donor_notes.print_stats(stats)
        pe_dirty = sum(stats["attached"].values()) > 0

    if args.dry_run:
        print("\n[dry-run] nothing written")
        return 0

    count, size = boost_wall.save_wall(wall)
    print(f"\n  wrote {count} records ({size / 1024:.0f} KB) → data/{boost_wall.WALL_FILE}")
    if pe_dirty:
        save_published_events(published_events)
        print("  recorded the new donor note ids in published_events.json")
    if args.push:
        boost_wall.push_wall(config)
    else:
        print("  (not pushed — pass --push to send it to the VPS)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
