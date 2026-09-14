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

Since 2026-09-12 it also pins the feed REGISTRY (shared/feeds.py — one
description of a show, and the wallet allowlist that keeps a sub-wallet's
second leg of the same boost from becoming a second note), the UNROUTED log
every drop lands in, and the boost_session index the publisher dedupes legs by.

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


# ── 6. the registry: one description of a show ──────────────────────────────
def test_registry():
    print("feed registry")
    import feeds
    lb = feeds.LB
    check("the classifier's LB constants are views onto the registry",
          bf.LB_FEED_GUID == lb.guid and bf.LB_FEED_ID == lb.feed_id
          and bf.LB_SHOW_ID == lb.fountain_show_id and bf.RSS_FEED == lb.feed_url
          and bf.LB_SHOW_TITLE == lb.title and bf.LB_PAGE_MARKERS == lb.page_markers)
    m = bf.LB_WEBSITE_RE.match("LocalBitcoinersEp028")
    check("the website comment regex still captures the episode number",
          m is not None and m.group(1) == "028"
          and bf.LB_WEBSITE_RE.match("LocalBitcoinersShow") is not None)
    check("another site's comment prefix is not ours",
          bf.LB_WEBSITE_RE.match("SoloPodEp001") is None)
    ident = feeds.identify_feed
    check("an LB keysend identifies as localbitcoiners",
          ident({"title": "Local Bitcoiners", "feed_id": "7683299"}) == "localbitcoiners")
    check("Chad and Reeds by podhome url with feedId 0",
          ident({"title": "Chad and Reeds Podcast", "feed_id": "0",
                 "feed_url": "https://serve.podhome.fm/rss/7c6f7875-2b73-491e-b32c-e2c8d6e91d53"})
          == "chad-and-reeds")
    check("Chad and Reed's second guid + apostrophe title is the same show",
          ident({"guid": "6ec986d8-5b37-5237-b801-30b1efb5846c",
                 "title": "Chad and Reed's Podcast"}) == "chad-and-reeds")
    check("Bowl After Bowl by guid alone",
          ident({"guid": "2d418249-453a-5714-8abc-5b657570b641"}) == "bowl-after-bowl")
    check("a Fountain show id is decisive on its own",
          ident({"fountain_show_id": "IFLdE3GAAG8B4knvF48F"}) == "chad-and-reeds"
          and ident({"fountain_show_id": lb.fountain_show_id}) == "localbitcoiners"
          and ident({"fountain_show_id": "nope"}) is None)
    check("an unregistered show is nobody's", ident({"title": "Homegrown Hits"}) is None)
    check("no signal is nobody's", ident({}) is None and ident(None) is None)
    check("mixed signals are nobody's (LB guid, Chad and Reeds title)",
          ident({"guid": lb.guid, "title": "Chad and Reeds Podcast"}) is None)
    ours = [f for f in feeds.FEEDS.values() if f.ours]
    check("Local Bitcoiners is the only show these bots publish for",
          [f.slug for f in ours] == ["localbitcoiners"])
    check("no two of our shows share an ingest wallet",
          sum(len(f.ingest_app_ids) for f in ours)
          == len(set().union(*(f.ingest_app_ids for f in ours))))
    check("the host leg wallet (4) and direct keysends (None) are LB ingest wallets",
          {4, None} <= lb.ingest_app_ids)
    check("the lb_v4v sub-wallet (57) is NOT an ingest wallet",
          57 not in lb.ingest_app_ids)


# ── 7. the wallet gate: one boost, two legs, one row ────────────────────────
def _offline_cache():
    cache = bf.make_cache()
    cache["guid_to_fountain"] = {}
    cache["num_to_rss_item"] = {}
    cache["channel_value_all"] = []
    return cache


def _no_network(url, **kw):
    raise OSError(f"test tried to reach the network: {url}")


LB_KEYSEND = {
    "type": "incoming", "state": "settled", "amount": 10_000_000,
    "paymentHash": "ab" * 32, "settledAt": "2026-09-11T21:00:00Z",
    "boostagram": {
        "action": "boost", "podcast": "Local Bitcoiners", "feedId": "7683299",
        "url": "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU",
        "episode": "Reducing Friction and Increasing Velocity builds Culture | Ep. 028",
        "message": "great show", "appName": "TestApp", "senderName": "tester",
        "valueMsatTotal": 10_000_000,
    },
}


def test_wallet_gate():
    print("wallet gate (feeds.LB.ingest_app_ids)")
    real_get = bf.requests.get
    bf.requests.get = _no_network
    try:
        cache = _offline_cache()
        on_sub = dict(LB_KEYSEND, appId=57)
        check("an LB boost that settled in the sub-wallet is not classified",
              bf.classify_lb_tx(on_sub, cache) is None)
        rec = cache["unrouted"][-1] if cache["unrouted"] else {}
        check("…and is logged as unrouted on the wallet path, attributed to LB",
              rec.get("path") == "wallet" and rec.get("app_id") == "57"
              and rec.get("feed") == "localbitcoiners" and rec.get("our_sats") == 10_000)
        check("the unrouted record has exactly the documented columns",
              set(rec) == set(bf.UNROUTED_COLUMNS))
        info = bf.classify_lb_tx(dict(LB_KEYSEND, appId=4), cache)
        check("the same boost in the host wallet is classified",
              info is not None and info["source"] == "keysend" and info["total_sats"] == 10_000)
        check("a direct keysend (no appId at all) is classified",
              bf.classify_lb_tx(dict(LB_KEYSEND), cache) is not None)
        n = len(cache["unrouted"])
        bf.classify_lb_tx({"type": "incoming", "state": "settled", "appId": 57,
                           "description": "", "amount": 21000, "paymentHash": "cd" * 32,
                           "settledAt": "2026-09-11T21:00:00Z"}, cache)
        check("a plain payment to the sub-wallet (a zap, a transfer) is not logged",
              len(cache["unrouted"]) == n)
        # The live 2026-09-14 test boost: the website's second leg, 32 sats
        # into the sub-wallet with the LNURL comment and nothing else.
        bf.classify_lb_tx({"type": "incoming", "state": "settled", "appId": 57,
                           "description": "LocalBitcoinersEp028", "amount": 32000,
                           "paymentHash": "ef" * 32, "settledAt": "2026-09-14T12:12:48Z"}, cache)
        rec = cache["unrouted"][-1]
        check("a website leg in the sub-wallet is logged as OUR show's second leg",
              rec["path"] == "wallet" and rec["feed"] == "localbitcoiners" and rec["our_sats"] == 32)
    finally:
        bf.requests.get = real_get


# ── 8. every drop is a record, and a URL-less BOLT11 boost is a drop ────────
def test_unrouted_records():
    print("unrouted records")
    real_get = bf.requests.get
    bf.requests.get = _no_network
    try:
        cache = _offline_cache()
        cr = dict(LB_KEYSEND, appId=4, paymentHash="ef" * 32)
        cr["boostagram"] = dict(LB_KEYSEND["boostagram"], podcast="Chad and Reeds Podcast",
                                feedId="0", url="https://serve.podhome.fm/rss/7c6f7875-2b73-491e-b32c-e2c8d6e91d53")
        check("a Chad and Reeds keysend in our wallet is still dropped by the feed gate",
              bf.classify_lb_tx(cr, cache) is None)
        rec = cache["unrouted"][-1] if cache["unrouted"] else {}
        check("…and the unrouted record names the show it belongs to",
              rec.get("path") == "keysend" and rec.get("feed") == "chad-and-reeds"
              and rec.get("feed_title") == "Chad and Reeds Podcast")

        bare = {"type": "incoming", "state": "settled", "appId": 4, "amount": 5_000_000,
                "description": "rss::payment::boost", "paymentHash": "01" * 32,
                "settledAt": "2026-09-11T21:00:00Z"}
        check("a BOLT11 boost with no boost page URL is dropped, not published empty",
              bf.classify_lb_tx(bare, cache) is None)
        rec = cache["unrouted"][-1] if cache["unrouted"] else {}
        check("…and is logged on the bolt11 path", rec.get("path") == "bolt11"
              and rec.get("payment_hash") == "01" * 32)
        check("record_unrouted with no cache is a harmless no-op",
              bf.record_unrouted(None, bare, "bolt11", "x") is None)

        # The recurring live case: a Chad and Reeds boost that arrives through
        # Fountain. The page gate refuses it; the record should name the show.
        def fountain_page(url, **kw):
            if url.startswith("https://fountain.fm/episode/"):
                return _Resp('<a href="https://fountain.fm/show/IFLdE3GAAG8B4knvF48F">show</a>')
            raise OSError("unreachable")
        bf.requests.get = fountain_page
        cr_fountain = {"type": "incoming", "state": "settled", "appId": 4, "amount": 33000,
                       "description": "rss::payment::boost https://fountain.fm/episode/G8YZMq5ImH5H98L3BMuy hi",
                       "paymentHash": "45" * 32, "settledAt": "2026-09-13T23:12:58Z"}
        check("a Chad and Reeds boost arriving through Fountain is dropped",
              bf.classify_lb_tx(cr_fountain, cache) is None)
        rec = cache["unrouted"][-1] if cache["unrouted"] else {}
        check("…and the record names Chad and Reeds from the page's show id",
              rec.get("path") == "bolt11" and rec.get("feed") == "chad-and-reeds")
        cr_stream = dict(cr_fountain, paymentHash="67" * 32,
                         description="rss::payment::stream https://fountain.fm/episode/G8YZMq5ImH5H98L3BMuy")
        check("the same show's Fountain stream is dropped and named too",
              bf.classify_lb_tx(cr_stream, cache) is None
              and cache["unrouted"][-1].get("feed") == "chad-and-reeds")
    finally:
        bf.requests.get = real_get


# ── 9. a website leg carries its boost_session; sessions index legs ─────────
def test_boost_session():
    print("boost_session on website legs")
    real_get = bf.requests.get
    bf.requests.get = _no_network
    try:
        cache = _offline_cache()
        ph = "23" * 32
        cache["kind_30078"][ph] = {
            "content": "hello from the site",
            "tags": [["d", ph], ["sender", ""], ["amount", "330000"], ["amount_total", "1000000"],
                     ["recipient", "reed@getalby.com"], ["boost_session", "sess-1"],
                     ["item_guid", "guid-028"], ["episode_title", "Ep. 028"]],
        }
        cache["kind_30078_by_d"]["sess-1"] = []
        tx = {"type": "incoming", "state": "settled", "appId": 4, "amount": 330000,
              "description": "LocalBitcoinersEp028", "paymentHash": ph,
              "settledAt": "2026-09-11T21:00:00Z"}
        info = bf.classify_lb_tx(tx, cache)
        check("a website leg is classified and carries its boost_session",
              info is not None and info["source"] == "website"
              and info.get("boost_session") == "sess-1")

        ev = {}
        bf.record_published_event(ev, "h1", "e1", "2026-09-11T21:00:00Z", boost_session="sess-1")
        bf.record_published_event(ev, "h2", "e1", "2026-09-11T21:00:01Z",
                                  boost_session="sess-1", sibling_of="h1")
        bf.record_published_event(ev, "h3", "e3", "2026-09-11T21:00:02Z")
        check("published_sessions maps a session to the leg whose note was published",
              bf.published_sessions(ev) == {"sess-1": "h1"})
        check("a sibling record keeps the parent's event id",
              ev["h2"]["event_id"] == "e1" and ev["h2"]["sibling_of"] == "h1")
        check("records without a session are unchanged in shape",
              set(ev["h3"]) == {"event_id", "settled_at", "published_at"})
    finally:
        bf.requests.get = real_get


def main():
    for t in (test_feed_verdict, test_host_matching, test_unknown_host_feed,
              test_classify_dispatch, test_no_substring_host_dispatch,
              test_registry, test_wallet_gate, test_unrouted_records,
              test_boost_session):
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
