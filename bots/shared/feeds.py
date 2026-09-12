"""The feed registry — which show a payment belongs to, and which of our
wallets feed which show's pipeline.

The node is a SHARED Lightning value-split recipient. Reed guests on other
shows, Chad and Reeds Podcast splits to the same address, and dozens of other
feeds keysend here through apps and playlists. A payment landing on this hub is
therefore never presumptively Local Bitcoiners: it has to positively identify a
feed, and only a feed these bots publish for gets a row or a note.

Until 2026-09 that identity lived in five places (an identity bundle, a page-
marker tuple, a bare Fountain show id, a title constant in sats-log, a website
comment regex), and each of the three misfiles this year was a path that had
forgotten one of them. This module is the one description of a show. Every
constant the classifier and sats-log expose (`LB_FEED_GUID`, `LB_SHOW_ID`,
`RSS_FEED`, …) is a view onto `LB` below.

Two ideas, kept separate on purpose:

  * WHICH SHOW a payment is for is read off the payment's own metadata — the
    boostagram's feedId / url / podcast title, a boost page's HTML, a Fountain
    show id in a URL. `feed_verdict` decides that per feed; `identify_feed`
    asks every registered feed and names the one that claims it.

  * WHICH WALLET a payment landed in is `tx["appId"]` on the Alby Hub
    transaction. The hub API is node-wide, so a sub-wallet's payments arrive
    in the same list as ours, and a single boost that pays two of our wallets
    settles TWICE, each leg with its own payment hash. `is_ingest_tx` is the
    allowlist: only the wallets in `Feed.ingest_app_ids` feed that show's
    pipeline, so a second leg is invisible to it — no second note, no doubled
    total. A payment's address is NOT on the transaction, so the wallet id is
    the only handle there is.

    The allowlist fails closed: a new wallet that isn't registered is dropped
    and logged as unrouted rather than absorbed. That is the right way round —
    a missed boost is recoverable, a note on the wrong profile is not.

Adding a show these bots should serve: one `Feed` with `ours=True`, its own
`ingest_app_ids` (a sub-wallet gets its own appId), its own
`website_comment_prefix` if its site sends boosts, and it must NOT share a
wallet with an existing show. Adding a show we merely recognise (so a dropped
payment is attributed in the unrouted log rather than anonymous): `ours=False`
and whatever identity has been observed on the node.
"""

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Feed:
    slug: str
    title: str                          # canonical display title
    guid: str = ""                      # primary <podcast:guid>
    feed_id: str = ""                   # primary Podcast Index feed id
    feed_url: str = ""                  # primary RSS URL
    titles: frozenset = frozenset()     # every spelling seen in the wild (lowercased)
    guids: frozenset = frozenset()      # every <podcast:guid> seen (lowercased)
    feed_ids: frozenset = frozenset()   # every Podcast Index feed id seen (strings)
    feed_urls: frozenset = frozenset()  # every feed URL seen (normalized)
    fountain_show_id: str = ""          # fountain.fm/show/<id>
    page_markers: tuple = ()            # strings that positively name the feed in a boost page
    website_comment_prefix: str = ""    # "<prefix>EpNNN" / "<prefix>Show" LNURL comments
    ingest_app_ids: frozenset = frozenset()  # Alby Hub appIds whose incoming txs feed this show
    ours: bool = False                  # a show these bots publish for

    def identity(self):
        """The signal bundle `feed_verdict` takes. Primary values are folded
        into the sets so a registry entry only has to state each once."""
        return {
            "feed_ids":  set(self.feed_ids) | ({self.feed_id} if self.feed_id else set()),
            "feed_urls": set(self.feed_urls) | ({self.feed_url} if self.feed_url else set()),
            "titles":    set(self.titles) | {self.title.lower()},
            "guids":     set(self.guids) | ({self.guid.lower()} if self.guid else set()),
        }

    @property
    def website_comment_re(self):
        """The LNURL comment the show's own website stamps on a boost leg:
        `<prefix>EpNNN` (episode number captured) or `<prefix>Show`. A second
        show's site must use its own prefix or this show's bot claims its
        boosts."""
        if not self.website_comment_prefix:
            return None
        return re.compile(rf"^{re.escape(self.website_comment_prefix)}(?:Ep(\d{{3}})|Show)$")


# ─────────────────────────────────────────────────────────────────────────────
# The registry. Order matters only for identify_feed's tie-break (first match
# wins); our own show goes first.
# ─────────────────────────────────────────────────────────────────────────────

LB = Feed(
    slug="localbitcoiners",
    title="Local Bitcoiners",
    guid="56fbb1aa-da79-5e4b-bebc-3b934ab8914c",
    feed_id="7683299",                     # Podcast Index byfeedid
    feed_url="https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU",
    fountain_show_id="Q48WBr6nT3mrbwMZ8ydY",
    # Any of these in a boost page's HTML positively names us. Deliberately
    # excludes the feed id — a bare 7-digit number matches by coincidence in a
    # page of ids and timestamps.
    page_markers=(
        "56fbb1aa-da79-5e4b-bebc-3b934ab8914c",
        "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU",
        "Q48WBr6nT3mrbwMZ8ydY",
        "Local Bitcoiners",
        "localbitcoiners.com",
    ),
    website_comment_prefix="LocalBitcoiners",
    # Alby Hub wallets whose incoming payments are Local Bitcoiners':
    #   4     the Alby account behind reed@getalby.com — every boost shape
    #         since 2026-04-20 (the live host leg of the value split)
    #   28    localbitcoiners@getalby.com, the era-2 address (Feb–Apr 2026);
    #         also LB_DONATION_APP_IDS in boost_formatter
    #   None  a keysend that reached the node directly, with no app attached
    #         (every direct keysend since 2026-05 arrives this way — the feed
    #         gate on its boostagram is the only thing that places it)
    # NOT here, on purpose: 57, the lb_v4v@getalby.com sub-wallet that took
    # over the show's V4V leg from aquafox30 in 2026-09. It receives the SAME
    # boost's second leg; ingesting it would double every row and note.
    ingest_app_ids=frozenset({4, 28, None}),
    ours=True,
)

CHAD_AND_REEDS = Feed(
    slug="chad-and-reeds",
    title="Chad and Reeds Podcast",
    guid="7c6f7875-2b73-491e-b32c-e2c8d6e91d53",
    feed_id="7968805",
    feed_url="https://serve.podhome.fm/rss/7c6f7875-2b73-491e-b32c-e2c8d6e91d53",
    # Both spellings arrive in boostagrams, and a second guid exists: the
    # LNURL test feed Chad hosts on GitHub publishes under its own guid with
    # the apostrophe title. All of it is the same show for our purposes.
    titles=frozenset({"chad and reeds podcast", "chad and reed's podcast"}),
    guids=frozenset({"6ec986d8-5b37-5237-b801-30b1efb5846c"}),
    ours=False,
)

BOWL_AFTER_BOWL = Feed(
    slug="bowl-after-bowl",
    title="Bowl After Bowl",
    guid="2d418249-453a-5714-8abc-5b657570b641",
    feed_id="946122",
    feed_url="https://feed.bowlafterbowl.com/feed.xml",
    ours=False,
)

FEEDS = {f.slug: f for f in (LB, CHAD_AND_REEDS, BOWL_AFTER_BOWL)}


# ─────────────────────────────────────────────────────────────────────────────
# Verdicts
# ─────────────────────────────────────────────────────────────────────────────
# Real-world finding (surveyed off the live node): keysend boostagrams carry NO
# podcast:guid. The signals that DO appear are `feedId`, feed `url`, and the
# `podcast` title — and none is populated by every app (LB boosts show
# feedId=7683299 from some apps but 0 from others; url present from some, empty
# from others; only the title is near-universal). So identity is a multi-signal
# bundle and the verdict treats a missing/placeholder signal as ABSENT, never as
# a mismatch. `guid` is kept for forward-compat even though few apps send it.

FEED_MATCH  = "match"    # a present signal positively names the target feed
FEED_OTHER  = "other"    # a present signal positively names a DIFFERENT feed
FEED_ABSENT = "absent"   # no usable feed signal present


def _norm_feed_url(u):
    return (u or "").strip().lower().rstrip("/")


def _norm_feed_id(v):
    """feedId of 0 / '' / None means 'not provided' — treat as absent, not a
    mismatch. (Fountain and PodcastGuru send 0 even for real LB boosts.)"""
    s = str(v or "").strip()
    return "" if s in ("", "0") else s


def feed_verdict(meta, identity):
    """Decide whether a boost's feed-identity `meta` belongs to `identity`.

    `meta` — loosely-typed signals pulled off a boostagram / fetched boost page:
    any of `feed_id`, `feed_url`, `title`, `guid` (missing keys are fine).
    `identity` — bundle of `feed_ids` / `feed_urls` / `titles` / `guids` sets
    (titles + guids compared lowercased; urls normalized), i.e. `Feed.identity()`.

    Each PRESENT signal votes match (names the target feed) or other (names a
    different feed); missing / placeholder signals abstain. A single `other`
    vote is decisive even if another signal matches — mixed signals are treated
    as untrustworthy and rejected. If nothing names the target and nothing
    contradicts it, the verdict is ABSENT and the caller decides what to do."""
    saw_match = saw_other = False

    def _vote(present, is_match):
        nonlocal saw_match, saw_other
        if not present:
            return
        if is_match:
            saw_match = True
        else:
            saw_other = True

    fid = _norm_feed_id(meta.get("feed_id"))
    _vote(fid, fid in {str(x) for x in identity["feed_ids"]})

    url = _norm_feed_url(meta.get("feed_url"))
    _vote(url, url in {_norm_feed_url(u) for u in identity["feed_urls"]})

    title = (meta.get("title") or "").strip().lower()
    _vote(title, title in {t.lower() for t in identity["titles"]})

    guid = (meta.get("guid") or "").strip().lower()
    _vote(guid, guid in {g.lower() for g in identity["guids"]})

    if saw_other:
        return FEED_OTHER
    if saw_match:
        return FEED_MATCH
    return FEED_ABSENT


def identify_feed(meta):
    """The slug of the registered feed `meta` positively names, or None when
    no registered feed claims it (an unregistered show, or no usable signal).
    Asks each feed with `feed_verdict`, so a payment whose signals disagree
    with EVERY registry entry is nobody's."""
    if not meta:
        return None
    for feed in FEEDS.values():
        if feed_verdict(meta, feed.identity()) == FEED_MATCH:
            return feed.slug
    return None


def is_ingest_tx(tx, feed):
    """True when the Alby Hub transaction landed in one of `feed`'s ingest
    wallets. `appId` is None for a keysend that reached the node with no app
    attached; a registry entry lists None explicitly when it wants those."""
    return tx.get("appId") in feed.ingest_app_ids
