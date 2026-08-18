#!/usr/bin/env python3
"""Is every Local Bitcoiners boost represented on Nostr exactly once?

Read-only. Signs nothing, publishes nothing, pays nothing — it compares three
views of the same boosts and reports where they disagree:

  the node      data/sats.csv — every boost that actually landed
  the relays    kind-1 notes carrying LB's NIP-73 feed tag
  the index     onlyboosts.social/api/v1 — what a global consumer can see

Three findings, in the order they matter:

  DOUBLE      one payment, two indexed notes. The failure mode this whole
              project has to avoid: a donor's sats counted twice on a public
              leaderboard. Nothing to fix after the fact except an exclusion,
              so it needs to be caught the day it happens.
  INDEX GAP   a boost note exists on a relay but OnlyBoosts hasn't indexed it
              a day later. Reed's call: we do NOT republish these — a second
              note for a boost already on Nostr is exactly the duplication
              we're avoiding. It's an indexer bug to fix, so it gets flagged.
  UNCOVERED   a boost on the node that reached Nostr not at all. Expected while
              CLAIM_BOOST_TAGS is off (that's the gap the flag closes); after
              it's on, each one is a claim that didn't happen.

Limitation, stated because it shapes the numbers: the relay sweep only counts a
note as a boost note if it carries a `t` topic tag or an `amount` tag. Fountain
notes carry neither (their evidence is a quoted kind-9735 zap receipt, which
resolving would mean a second round of relay fetches), so a Fountain note that
OnlyBoosts missed shows up as UNCOVERED rather than INDEX GAP. Both get
reported; only the bucket differs.

    python3 coverage_audit.py                      # last 3 days, report only
    python3 coverage_audit.py --days 14
    python3 coverage_audit.py --open-issue         # file findings on GitHub
"""

import argparse
import csv
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))

import onlyboosts_coverage as cov
from collector_common import query_relay
from nostr_utils import BOOST_SCAN_RELAYS

SATS_CSV = _BOTS_ROOT.parent / "data/sats.csv"

# Findings are filed where the fix lives, not where the audit runs.
#
#   INDEX GAP  the note exists on Nostr and OnlyBoosts hasn't indexed it — an
#              indexer problem, so it goes to the OnlyBoosts repo.
#   DOUBLE     two indexed notes for one payment. If one of them is ours this is
#              a publisher bug, and the publisher lives here.
#
# One open issue at a time per class, same convention as bots/bot-alert: a
# stable title means a still-unfixed finding doesn't file a new issue nightly.
# Close it and the next audit re-files with current numbers.
REPO_INDEX = "ReedBTC/onlyboosts"
REPO_BOTS = "ReedBTC/localbitcoiners"
ISSUE_TITLE_GAP = "[coverage] Local Bitcoiners boost notes on Nostr that OnlyBoosts hasn't indexed"
ISSUE_TITLE_DOUBLE = "[coverage] A Local Bitcoiners boost is represented twice on OnlyBoosts"
MARKER = "<!-- lb-coverage-audit -->"

BOOST_TOPIC_TAGS = {"boost", "boostagram", "value4value"}


def node_boosts(days):
    """Boosts that settled on the node in the window, newest last."""
    cutoff = time.time() - days * 86400
    out = []
    with SATS_CSV.open() as fh:
        for r in csv.DictReader(fh):
            if r.get("kind") != "boost":
                continue
            ts = cov._ts(r.get("settled_at"))
            if ts is None or ts < cutoff:
                continue
            out.append({
                "settled_at":   r["settled_at"],
                "settled_ts":   ts,
                "source":       r.get("source", ""),
                "app":          r.get("app", ""),
                "sender_npub":  r.get("sender_npub") or None,
                # Carried so the matcher can tell two same-size boosts apart by
                # the episode they're for — see _episode_conflict.
                "episode_number": r.get("episode_num") or None,
                # And by what the donor wrote — see message_agreement.
                "message":      r.get("message") or "",
                "total_sats":   int(float(r.get("total_sats") or 0)),
                "payment_hash": r.get("payment_hash", ""),
            })
    out.sort(key=lambda b: b["settled_ts"])
    return out


def relay_boost_notes(since_ts):
    """kind-1 notes on the boost-dense relays carrying LB's feed tag AND payment
    evidence, unioned by event id across relays."""
    filt = {"kinds": [1], "#i": [f"podcast:guid:{cov.LB_FEED_GUID}"],
            "since": int(since_ts), "limit": 500}
    seen = {}
    for relay in BOOST_SCAN_RELAYS:
        try:
            for ev in query_relay(relay, filt) or []:
                tags = ev.get("tags", [])
                has_topic = any(t[0] == "t" and len(t) >= 2 and t[1] in BOOST_TOPIC_TAGS
                                for t in tags)
                has_amount = any(t[0] == "amount" and len(t) >= 2 for t in tags)
                if has_topic or has_amount:
                    seen[ev["id"]] = ev
        except Exception as e:
            print(f"  [warn] {relay}: {e}")
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    # A boost younger than this is still in flight: the donor's client may not
    # have published yet, and OnlyBoosts indexes on a 5-minute cycle.
    ap.add_argument("--min-age-hours", type=float, default=24)
    ap.add_argument("--open-issue", action="store_true")
    ap.add_argument("--dry-issue", action="store_true",
                    help="print what would be filed, file nothing")
    ap.add_argument("--repo-index", default=REPO_INDEX,
                    help="repo for notes OnlyBoosts hasn't indexed")
    ap.add_argument("--repo-bots", default=REPO_BOTS,
                    help="repo for a boost represented twice")
    args = ap.parse_args()

    boosts = node_boosts(args.days)
    if not boosts:
        print("No boosts in window.")
        return 0
    since = boosts[0]["settled_ts"] - cov.QUERY_PAD_SEC

    try:
        indexed = cov.fetch_indexed(since)
    except cov.CoverageUnavailable as e:
        print(f"[error] OnlyBoosts API unreachable: {e}")
        return 1
    notes = relay_boost_notes(since)
    indexed_ids = {r["id"] for r in indexed}

    now = time.time()
    old_enough = [b for b in boosts if now - b["settled_ts"] > args.min_age_hours * 3600]

    # Assign notes to payments one-for-one before judging either side. Counting
    # "how many indexed notes could be this boost" independently per boost reads
    # two same-size boosts minutes apart (537 sats at 10:50 and 10:53, each with
    # its own note) as two doubles, because each boost sees both notes. A greedy
    # assignment — strongest signal first, each note consumed once — leaves
    # exactly the real leftovers on both sides:
    #   unmatched payment → UNCOVERED, no note represents it
    #   unmatched note    → DOUBLE, a second note for a payment already covered
    consumed = set()
    uncovered = []
    for b in old_enough:
        match, _ = cov.find_match(indexed, b, b["settled_ts"], consumed)
        if match:
            consumed.add(match["id"])
        else:
            uncovered.append(b)

    doubles = []
    for r in indexed:
        if r["id"] in consumed:
            continue
        # A leftover note only doubles a payment if it looks like one we already
        # covered. Leftovers that match nothing are boosts whose Lightning legs
        # never reached our node — someone else's split, not our problem.
        for b in old_enough:
            if r in cov.all_matches(indexed, b, b["settled_ts"]):
                doubles.append((b, r))
                break

    index_gaps = [ev for ev in notes.values()
                  if ev["id"] not in indexed_ids
                  and now - ev.get("created_at", 0) > args.min_age_hours * 3600]

    def fmt_boost(b):
        return (f"{b['settled_at'][:16]}  {b['source']:<15} {b['app']:<20} "
                f"{b['total_sats']:>8,} sats  {'npub' if b['sender_npub'] else 'anon'}")

    lines = [
        f"Window: last {args.days} day(s), boosts older than {args.min_age_hours}h",
        f"Node boosts: {len(boosts)} ({len(old_enough)} settled long enough to judge)",
        f"Indexed by OnlyBoosts: {len(indexed)}   Boost notes seen on relays: {len(notes)}",
        "",
    ]
    if doubles:
        lines.append(f"DOUBLE — {len(doubles)} extra indexed note(s) for a payment already covered:")
        for b, m in doubles:
            who = (m.get("client_app") or {}).get("id") or m.get("client") or "?"
            when = datetime.fromtimestamp(m["ts"], timezone.utc).strftime("%F %H:%M")
            lines.append(f"  {fmt_boost(b)}")
            lines.append(f"      extra: {m['id'][:16]}  {m.get('sats')} sats  via {who}  at {when}")
        lines.append("")
    if index_gaps:
        lines.append(f"INDEX GAP — {len(index_gaps)} boost note(s) on relays that OnlyBoosts hasn't indexed:")
        for ev in sorted(index_gaps, key=lambda e: e.get("created_at", 0)):
            when = datetime.fromtimestamp(ev["created_at"], timezone.utc).strftime("%F %H:%M")
            lines.append(f"  {when}  {ev['id'][:16]}  by {ev['pubkey'][:12]}...")
        lines.append("")
    if uncovered:
        lines.append(f"UNCOVERED — {len(uncovered)} boost(s) that never reached Nostr:")
        for b in uncovered:
            lines.append(f"  {fmt_boost(b)}")
        lines.append("")
    if not (doubles or index_gaps or uncovered):
        lines.append("Every boost in the window is represented exactly once. ✅")

    report = "\n".join(lines)
    print(report)

    # Only DOUBLE and INDEX GAP are anomalies worth waking someone for.
    # UNCOVERED is the known, expected gap until CLAIM_BOOST_TAGS is on, so it
    # rides along in each body as context rather than filing an issue of its own.
    if args.open_issue or args.dry_issue:
        if index_gaps:
            file_issue(args.repo_index, ISSUE_TITLE_GAP, report, args.dry_issue)
        if doubles:
            file_issue(args.repo_bots, ISSUE_TITLE_DOUBLE, report, args.dry_issue)
    return 0


def _run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def file_issue(repo, title, report, dry=False):
    body = (f"{MARKER}\nOpened automatically by `bots/boost-publisher/coverage_audit.py`\n"
            f"on the Local Bitcoiners bot box. Close it once the finding is resolved —\n"
            f"a still-open issue with this title suppresses the next report.\n\n"
            f"Full audit output, including findings that belong to the other repo:\n\n"
            f"```\n{report}\n```\n")
    if dry:
        print(f"\n[audit] DRY — would file in {repo}:\n  title: {title}\n{body}")
        return

    rc, out, _ = _run(["gh", "issue", "list", "--repo", repo, "--state", "open",
                       "--search", title, "--json", "number,title"])
    if rc == 0:
        try:
            for it in json.loads(out or "[]"):
                if it.get("title") == title:
                    print(f"[audit] {repo} issue #{it['number']} is already open — not filing another")
                    return
        except ValueError:
            pass
    rc, out, err = _run(["gh", "issue", "create", "--repo", repo,
                         "--title", title, "--body", body])
    print(f"[audit] opened {out.strip()}" if rc == 0
          else f"[audit] gh issue create failed for {repo}: {(err or out).strip()}")


if __name__ == "__main__":
    sys.exit(main())
