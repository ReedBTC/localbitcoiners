#!/usr/bin/env python3
"""Offline regression test for the feed gate — the check that keeps another
show's boost off the Local Bitcoiners profile.

The node is a shared Lightning value-split recipient, so every incoming-payment
path has to positively identify our feed. That has failed three times, each
time in a different path (see "The feed gate" in bots/CLAUDE.md). This test
pins the two things that fail silently:

  1. the VERDICT SEMANTICS of feed_verdict — one OTHER vote is decisive, a
     missing or placeholder signal abstains rather than mismatching;
  2. the DISPATCH SHAPE of _classify_fountain_boost — every BOLT11 boost-page
     host either has a dedicated reader with its own gate, or goes through the
     generic unknown-host check. A host that reaches neither is the 2026-09-10
     bug (two Chad and Reeds boosts paged at truefans.fm, published as LB).

No network: requests.get is stubbed with canned pages. Run it from anywhere:

    python3 bots/shared/test_feed_gate.py
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boost_formatter as bf  # noqa: E402

FAILURES = []


def check(label, cond):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}")
    if not cond:
        FAILURES.append(label)


# ── 1. feed_verdict semantics ────────────────────────────────────────────────
def test_feed_verdict():
    print("feed_verdict")
    v = bf.lb_feed_verdict
    check("feed guid names LB -> match",
          v({"guid": bf.LB_FEED_GUID}) == bf.FEED_MATCH)
    check("feed id names LB -> match",
          v({"feed_id": bf.LB_FEED_ID}) == bf.FEED_MATCH)
    check("another show's title -> other",
          v({"title": "Chad and Reeds Podcast"}) == bf.FEED_OTHER)
    check("no signal at all -> absent",
          v({}) == bf.FEED_ABSENT)
    check("feedId '0' is absent, not a mismatch",
          v({"feed_id": "0"}) == bf.FEED_ABSENT)
    check("empty title abstains rather than voting other",
          v({"title": ""}) == bf.FEED_ABSENT)
    # Mixed signals are untrustworthy: one OTHER outvotes a MATCH.
    check("LB guid + another show's title -> other",
          v({"guid": bf.LB_FEED_GUID, "title": "Chad and Reeds Podcast"})
          == bf.FEED_OTHER)


# ── 2. host parsing ──────────────────────────────────────────────────────────
def test_host_matching():
    print("boost-page host matching")
    known = bf._is_known_boost_page_host
    check("fountain.fm is known", known("https://fountain.fm/episode/abc"))
    check("castamatic.com is known", known("https://castamatic.com/boost/abc"))
    check("a subdomain of a known host is known",
          known("https://www.castamatic.com/boost/abc"))
    check("truefans.fm is not known", not known("https://truefans.fm/x/y"))
    # A substring test on the URL — which is what the dispatch used to do —
    # lets an arbitrary host borrow a known host's reader AND its gate.
    check("a known host in the PATH does not count as that host",
          not known("https://evil.example/castamatic.com/boost/abc"))
    check("a known host in the QUERY does not count as that host",
          not known("https://evil.example/x?u=fountain.fm"))


# ── 3. the generic unknown-host page check ───────────────────────────────────
class _Resp:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


def test_unknown_host_feed():
    print("unknown-host page check")
    pages = {
        # The real shape of the 2026-09-10 misfile: an app page for another
        # show. Names us nowhere.
        "https://truefans.fm/chad-and-reeds-podcast/6aa20397":
            '<title>TrueFans | Shows | 006.</title>'
            '<script>{"title":"Chad and Reeds Podcast"}</script>',
        # A hypothetical new app paging a genuine LB boost: the show name is
        # on the page, so the boost is ours.
        "https://newapp.example/boost/1":
            '<title>NewApp | Boost</title><h1>Local Bitcoiners</h1>',
        # Identity by feed guid rather than by name.
        "https://newapp.example/boost/2":
            f'<meta name="podcast-guid" content="{bf.LB_FEED_GUID}">',
    }
    real_get = bf.requests.get

    def fake_get(url, **kw):
        if url in pages:
            return _Resp(pages[url])
        raise OSError("unreachable")

    bf.requests.get = fake_get
    try:
        cache = {}
        f = bf._unknown_host_feed
        check("page for another show -> other",
              f("https://truefans.fm/chad-and-reeds-podcast/6aa20397", cache) == "other")
        check("page naming Local Bitcoiners -> lb",
              f("https://newapp.example/boost/1", cache) == "lb")
        check("page carrying the LB feed guid -> lb",
              f("https://newapp.example/boost/2", cache) == "lb")
        check("unreachable page -> unknown (never silently 'other')",
              f("https://newapp.example/boost/404", cache) == "unknown")
        # One fetch per URL per run: a batch of boosts from one app is cheap.
        calls = []
        bf.requests.get = lambda url, **kw: (calls.append(url), fake_get(url, **kw))[1]
        f("https://newapp.example/boost/1", cache)
        check("a verdict already in the cache is not re-fetched", not calls)
    finally:
        bf.requests.get = real_get


# ── 4. end-to-end: the two misfiled boosts, and a real LB one ────────────────
def test_classify_dispatch():
    print("classify_lb_tx dispatch")
    real_get = bf.requests.get

    def fake_get(url, **kw):
        if url.startswith("https://truefans.fm/"):
            return _Resp('<title>TrueFans | Shows | 006.</title>'
                         '<script>{"title":"Chad and Reeds Podcast"}</script>')
        raise OSError("unreachable")

    bf.requests.get = fake_get
    try:
        # A cache whose RSS index is already built (empty) so nothing reaches
        # the network but the boost page itself.
        cache = bf.make_cache()
        cache["guid_to_fountain"] = {}
        cache["num_to_rss_item"] = {}

        def classify(desc, ph):
            return bf.classify_lb_tx({
                "type": "incoming", "state": "settled", "description": desc,
                "paymentHash": ph, "settledAt": "2026-09-10T03:21:52Z",
                "amount": 527000,
            }, cache)

        tf = ("rss::payment::boost https://truefans.fm/chad-and-reeds-podcast/"
              "6aa20397a90daa0ed6b235cd?payment=50e507b4 Liberty Boost!")
        check("a boost paged on an unrecognized host for another show is dropped",
              classify(tf, "88ed6060" * 8) is None)

        # The stream path is fail-closed by construction — it matches only a
        # fountain.fm URL. Pin that, since it is why the truefans.fm STREAMS on
        # the node were never filed.
        ts = ("rss::payment::stream https://truefans.fm/chad-and-reeds-podcast/"
              "6aa20397a90daa0ed6b235cd")
        check("a stream on an unrecognized host is dropped",
              classify(ts, "ce362322" * 8) is None)
    finally:
        bf.requests.get = real_get


# ── 5. source scan: no BOLT11 host may be dispatched by substring ────────────
def test_no_substring_host_dispatch():
    print("source scan: host dispatch is parsed, not substring")
    src = (Path(bf.__file__).with_suffix(".py")).read_text(encoding="utf-8")
    body = src.split("def _classify_fountain_boost", 1)[1] \
              .split("\ndef _classify_castamatic_boost", 1)[0]
    for host in bf.KNOWN_BOOST_PAGE_HOSTS:
        # `"fountain.fm" in episode_url` matches any URL merely CONTAINING the
        # host, which both mis-routes the reader and skips that reader's gate.
        bad = re.search(rf'["\'][^"\']*{re.escape(host)}[^"\']*["\']\s+in\s+\w*episode_url',
                        body)
        check(f"{host} is not dispatched by a substring test on the URL", not bad)
    check("the unknown-host gate is wired into the BOLT11 boost path",
          "_is_known_boost_page_host" in body and "_unknown_host_feed" in body)
    check("an unreachable unknown host defers rather than publishing",
          "feed_unverified = True" in body)


def main():
    for t in (test_feed_verdict, test_host_matching, test_unknown_host_feed,
              test_classify_dispatch, test_no_substring_host_dispatch):
        t()
        print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("all feed-gate checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
