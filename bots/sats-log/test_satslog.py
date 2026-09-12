#!/usr/bin/env python3
"""Regression checks for the sats-log side of the feed gate and the value-split
bucket map.

Three things fail silently if missed, and this pins each:

  1. STREAMS ARE GATED. Keysend and Castamatic streams bypass the classifier,
     and until 2026-09-12 a stream on another feed was booked as a Local
     Bitcoiners show-level row — which put Chad and Reeds streamers on the LB
     supporters wall. Now it is dropped (and logged as unrouted), with the one
     deliberate exception of the Ep 009 livestream window.
  2. THE BUCKET MAP COVERS THE FEED. An address in a <podcast:value> block
     that BUCKET_BY_ADDRESS doesn't know is booked as a guest, silently. The
     channel block is all house addresses, so every one of them must be
     mapped. (Network: reads the live feed. Fails loudly if it can't.)
  3. THE WEBSITE REDIRECT MIRROR. WEBSITE_RECIPIENT_OVERRIDES restates the
     widget's LNADDRESS_OVERRIDES so a website row records where its sats
     actually went. The two are compared by reading the widget source; when
     one side has moved and the other hasn't, this is red on whichever side
     is behind. (Skipped with a note when the widget source isn't beside us.)

Run it from anywhere:

    python3 bots/sats-log/test_satslog.py
"""

import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))
sys.path.insert(0, str(HERE))
import local_bitcoiners_satslog as sl  # noqa: E402
import boost_formatter as bf  # noqa: E402
import feeds  # noqa: E402

FAILURES = []


def check(label, cond):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}")
    if not cond:
        FAILURES.append(label)


def _tx(ph, settled="2026-09-09T21:00:00Z", app_id=4):
    return {"paymentHash": ph, "settledAt": settled, "amount": 33000,
            "appId": app_id, "boostagram": {"action": "stream"}}


def _rec(feed_title, ph, **kw):
    rec = {
        "source": "keysend_stream", "app": "TestApp", "settled_at": "2026-09-09T21:00:00Z",
        "our_sats": 33, "total_sats": 100, "sender_npub": "", "sender_name": "Sir TJ",
        "feed_title": feed_title, "feed_guid": "", "ep_title": "", "item_guid": "",
        "_tx": _tx(ph),
    }
    rec.update(kw)
    return rec


# ── 1. stream gate ───────────────────────────────────────────────────────────
def test_stream_gate():
    print("stream gate")
    check("sats-log's feed constants are views onto the registry",
          sl.LB_FEED_GUID == feeds.LB.guid and sl.LB_FEED_TITLE == feeds.LB.title.lower())

    ep_meta = {"028": ("fid028", "Ep. 028 title")}
    cr  = _rec("Chad and Reeds Podcast", "a" * 64, ep_title="006. something")
    lb  = _rec("Local Bitcoiners", "b" * 64, ep_title="Velocity | Ep. 028")
    bab = _rec("Bowl After Bowl", "c" * 64, settled_at="2026-05-02T01:00:00Z")
    bab["_tx"] = _tx("c" * 64, settled="2026-05-02T01:00:00Z")
    absent = _rec("", "d" * 64)
    cm = _rec("Chad and Reeds Podcast", "e" * 64, source="castamatic_stream",
              feed_guid="7c6f7875-2b73-491e-b32c-e2c8d6e91d53")

    r = sl.resolve_stream_episode
    check("a Chad and Reeds keysend stream is dropped", r(cr, {}, ep_meta) is None)
    check("a Chad and Reeds Castamatic stream (by guid) is dropped", r(cm, {}, ep_meta) is None)
    check("an LB stream resolves to its episode",
          r(lb, {}, ep_meta) == ("fid028", "028", "Ep. 028 title", False))
    check("a Bowl After Bowl stream inside the Ep 009 window is Ep 009",
          (r(bab, {}, ep_meta) or ("", "", "", True))[1] == "009")
    check("a stream with no feed signal is dropped, not booked show-level",
          r(absent, {}, ep_meta) is None)
    check("stream_feed names the show a dropped stream belongs to",
          sl.stream_feed(cr) == "chad-and-reeds" and sl.stream_feed(lb) == "localbitcoiners"
          and sl.stream_feed(absent) is None)

    real_index = sl.build_rss_item_index
    sl.build_rss_item_index = lambda cache: {}   # offline
    try:
        rows, dropped = sl.build_node_stream_rows([cr, lb, bab, absent, cm], ep_meta)
    finally:
        sl.build_rss_item_index = real_index
    check("build_node_stream_rows keeps only our streams",
          len(rows) == 2 and {r_["episode_num"] for r_ in rows} == {"028", "009"})
    check("…and hands back every dropped record for the unrouted log",
          [d["_tx"]["paymentHash"][0] for d in dropped] == ["a", "d", "e"])
    check("no stream row is booked show-level for another feed any more",
          not any(r_["show_level"] == "true" for r_ in rows))


# ── 2. the unrouted writer ───────────────────────────────────────────────────
def test_write_unrouted():
    print("unrouted.csv writer")
    real_path = sl.UNROUTED_CSV
    with tempfile.TemporaryDirectory() as d:
        sl.UNROUTED_CSV = Path(d) / "unrouted.csv"
        try:
            a = bf.record_unrouted({}, _tx("a" * 64, app_id=57), "wallet", "not an ingest wallet")
            b = bf.record_unrouted({}, _tx("b" * 64, settled="2026-09-10T00:00:00Z"), "keysend",
                                   "feed verdict other",
                                   feed_meta={"title": "Chad and Reeds Podcast"})
            check("first write records both", sl.write_unrouted([a, b]) == (2, 2))
            check("a second run with the same records adds nothing",
                  sl.write_unrouted([a, b]) == (0, 2))
            c = bf.record_unrouted({}, _tx("c" * 64), "bolt11", "no page URL")
            check("a new hash is appended", sl.write_unrouted([c, a]) == (1, 3))
            text = sl.UNROUTED_CSV.read_text(encoding="utf-8")
            lines = text.splitlines()
            check("header is the documented column set",
                  lines[0] == ",".join(bf.UNROUTED_COLUMNS))
            check("newest first", lines[1].startswith("2026-09-10T00:00:00Z," + "b" * 64))
            check("the record names the feed it belongs to",
                  ",chad-and-reeds,Chad and Reeds Podcast," in lines[1])
            check("a record with no hash is ignored, not written",
                  sl.write_unrouted([dict(a, payment_hash="")]) == (0, 3))
        finally:
            sl.UNROUTED_CSV = real_path


# ── 3. bucket map covers the channel block (network) ─────────────────────────
def test_channel_block_bucket_map():
    print("bucket map vs the live channel value block")
    blocks = sl.load_rss_value_blocks()
    chan = (blocks or {}).get("__channel__") or []
    check("the feed's channel value block was read", bool(chan))
    missing = [r["address"] for r in chan
               if r["address"].lower() not in sl.BUCKET_BY_ADDRESS]
    check(f"every channel-block address is in BUCKET_BY_ADDRESS "
          f"(block: {[r['address'] for r in chan]})", chan and not missing)
    check("the show's V4V wallet is mapped to the V4V column",
          sl.BUCKET_BY_ADDRESS.get("lb_v4v@getalby.com") == "aquafox_sats"
          and sl.BUCKET_BY_ADDRESS.get("aquafox30@primal.net") == "aquafox_sats")
    check("the V4V wallet is NOT one of our divisor addresses "
          "(it is the second leg of a boost we already ingest)",
          "lb_v4v@getalby.com" not in bf.OUR_VALUE_ADDRESSES)


# ── 4. the website redirect mirror ───────────────────────────────────────────
def _js_override_sources(js, const):
    """Source addresses (the keys) of one `export const <const> = { … }` map in
    recipientOverrides.js, or None when the map isn't there."""
    m = re.search(rf"export const {const} = \{{(.*?)\n\}}", js, re.S)
    if not m:
        return None
    return set(re.findall(r"^\s{2}'([^']+@[^']+)':", m.group(1), re.M))


def test_website_override_mirror():
    print("website redirect mirror (widget ↔ sats-log)")
    js_path = HERE.parent.parent / "login-widget" / "src" / "lib" / "recipientOverrides.js"
    if not js_path.exists():
        print(f"  skip  widget source not found at {js_path}")
        return
    js = js_path.read_text(encoding="utf-8")
    site_global = _js_override_sources(js, "LNADDRESS_OVERRIDES")
    check("the widget's global LNADDRESS_OVERRIDES map was read", site_global is not None)
    bot_global = set(sl.WEBSITE_RECIPIENT_OVERRIDES)
    check(f"global redirect sources agree (site {sorted(site_global or [])}, "
          f"bot {sorted(bot_global)})", site_global == bot_global)
    for ep, per_ep in sl.EPISODE_RECIPIENT_OVERRIDES.items():
        block = re.search(rf"^\s{{2}}{int(ep)}: \{{(.*?)^\s{{2}}\}}", js, re.S | re.M)
        check(f"Ep{ep} per-episode redirect exists on the site", block is not None)
        for src_addr, dst_addr in per_ep.items():
            check(f"Ep{ep}: {src_addr} -> {dst_addr} on both sides",
                  block is not None and src_addr in block.group(1) and dst_addr in block.group(1))


def main():
    for t in (test_stream_gate, test_write_unrouted, test_channel_block_bucket_map,
              test_website_override_mirror):
        t()
        print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("all sats-log checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
