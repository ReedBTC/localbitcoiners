#!/usr/bin/env python3
"""Has somebody else's Nostr note for this boost already been indexed?

The boost-publisher publishes a standalone kind-1 note for every boost that
lands on the node, and those notes have always carried NIP-73 `i`/`k` podcast
tags — but no payment evidence (no `t=boost`, no `amount`), so a global NIP-73
indexer fetches them and drops them. The only LB boosts that ever reached
onlyboosts.social are the ones a donor published themselves (website widget) or
their app published for them (Fountain, BoostMeBitch). Everything else — every
Castamatic / PodcastGuru / CurioCaster keysend, every anonymous website boost,
every Fountain boost from a donor with no linked Nostr identity — is invisible.

The fix is to let our standalone note CLAIM the boost (carry the payment
evidence) when, and only when, nobody else's note did. This module answers that
question.

WHY THE OnlyBoosts API AND NOT A RELAY QUERY. The API is the surface we're
trying to keep whole, so it is the ground truth for "is this boost accounted
for". A relay query answers a weaker question — a note can exist on a relay and
still be rejected by the indexer's classifier — and acting on it would publish a
duplicate note for a boost that is already represented on Nostr. A note that
exists but never gets indexed is an indexer bug to fix, not a boost to
republish.

TIMING. The OnlyBoosts incremental timer runs every 5 min, each cycle takes
~70s and syncs its query layer (D1) in the same run, so a donor note is
queryable roughly 7 minutes after it reaches a scanned relay. boost-publisher
ticks every 10 min, so the first tick after settlement already sees most donor
notes and HOLD_WINDOW_SEC covers the rest.

FAIL-SAFE DIRECTION. Every uncertain path resolves toward "don't claim". A
missed claim costs one boost's visibility on onlyboosts.social — recoverable,
and visible in the daily audit. A wrong claim double-counts a donor's sats on a
public leaderboard, and cannot be unpublished.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API_URL = "https://onlyboosts.social/api/v1/boosts"

# Local Bitcoiners' <podcast:guid>. Same constant as boost_formatter.LB_FEED_GUID;
# duplicated rather than imported so this module stays a standalone client of a
# public API (it is useful from an audit script that has no formatter context).
LB_FEED_GUID = "56fbb1aa-da79-5e4b-bebc-3b934ab8914c"

# The show account. Our own claimed notes are indexed under this pubkey, so they
# have to be excluded from "did somebody ELSE publish this boost" — otherwise a
# re-fetch of an already-claimed boost would look like a donor note.
SHOW_PUBKEY_HEX = "c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592"

# How far a donor's note may sit from the node's settledAt and still be the same
# boost. Generous on purpose: the donor's client stamps created_at when it signs
# (which for the website widget is BEFORE payment, at pre-sign time), and
# Fountain publishes its note after its own indexing lag.
MATCH_WINDOW_SEC = 900          # ±15 min

# How long a boost with no match yet waits before we conclude nobody published
# one. Below this the note is held (not published at all) so it can still be
# published WITH claim tags on the next tick if the donor's note never shows.
#
# Two windows, because the risk isn't the same on both sides of the question.
# When we know the donor's npub, SOMEBODY could still publish — the donor's own
# client, or Fountain on their behalf — so we wait an hour before concluding
# nobody will. When we don't, no donor-side note is possible: an anonymous
# website boost had no signer, and Castamatic / PodcastGuru / CurioCaster speak
# no NIP-73 at all, so waiting past the index lag buys nothing but a late note.
HOLD_WINDOW_SEC = 1200          # 20 min — nobody could publish but us
HOLD_WINDOW_IDENTIFIED_SEC = 3600   # 60 min — a donor note is still possible

# Page back this far before the boost so a donor note that was signed early
# (website pre-sign) is inside the query window.
QUERY_PAD_SEC = 1800

PAGE_LIMIT = 100
MAX_PAGES = 5                   # LB volume is a handful per hour; this is a backstop


class CoverageUnavailable(Exception):
    """The API could not be reached or returned something unusable. Callers must
    treat this as 'unknown', never as 'nobody published one'."""


def _get(url, timeout):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        # Identify ourselves in the API's logs — this is the show's own bot
        # calling a public endpoint, and it should be legible as that.
        "User-Agent": "localbitcoiners-boost-publisher (+https://localbitcoiners.com)",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_indexed(since_ts, podcast_guid=LB_FEED_GUID, cache=None, timeout=20):
    """Every boost OnlyBoosts has indexed for this feed since `since_ts` (unix).

    One call per publisher run, not per boost: the caller passes the oldest
    settledAt in its batch and matches every boost against the same result set.
    Raises CoverageUnavailable on any network/parse failure.
    """
    key = ("onlyboosts_indexed", podcast_guid, since_ts)
    if cache is not None and key in cache:
        return cache[key]

    records = []
    cursor = None
    try:
        for _ in range(MAX_PAGES):
            params = {"podcast": podcast_guid, "since": str(int(since_ts)),
                      "limit": str(PAGE_LIMIT)}
            if cursor:
                params["cursor"] = cursor
            data = _get(f"{API_URL}?{urllib.parse.urlencode(params)}", timeout)
            batch = data.get("boosts") or []
            records.extend(batch)
            cursor = data.get("next_cursor")
            if not cursor or not batch:
                break
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            ValueError, OSError) as e:
        raise CoverageUnavailable(str(e)) from e

    if cache is not None:
        cache[key] = records
    return records


def _ts(settled_at):
    """ISO settledAt → unix seconds. None when unparseable."""
    if not settled_at:
        return None
    try:
        return int(datetime.fromisoformat(
            settled_at.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


_EP_NUM_RE = re.compile(r"\bEp\.?\s*(\d{1,3})\b", re.IGNORECASE)


def _episode_of(record):
    """(item_guid, episode_number) an indexed record names, either side None."""
    ep = record.get("episode") or {}
    guid = ep.get("guid") or None
    num = ep.get("num")
    if num is None:
        m = _EP_NUM_RE.search(ep.get("title") or "")
        num = m.group(1) if m else None
    return guid, (str(num).zfill(3) if num is not None else None)


def _episode_conflict(record, info):
    """True only when the note and the payment POSITIVELY name different
    episodes. Silence on either side is not a conflict — plenty of boosts know
    one identifier and not the other.

    This is what separates a same-size coincidence from a real match: on
    2026-08-15 one donor boosted 420 sats to Ep. 20 and 420 sats to Ep. 21
    three minutes apart. Same npub, same amount, same window — only the episode
    tells them apart.
    """
    r_guid, r_num = _episode_of(record)
    i_guid = info.get("item_guid")
    i_num = info.get("episode_number") or info.get("episode_num")
    if r_guid and i_guid and r_guid != i_guid:
        return True
    if r_num and i_num and str(r_num).zfill(3) != str(i_num).zfill(3):
        return True
    return False


def all_matches(records, info, settled_ts):
    """Every indexed boost that could be this payment, OUR OWN claimed notes
    included. find_match answers "did somebody else publish one"; this answers
    "how many notes now represent this boost", which is the question the daily
    audit asks — two is a double-count and the thing we most need to catch.
    """
    npub = info.get("sender_npub")
    total_sats = info.get("total_sats")
    out = []
    for r in records:
        try:
            if abs(int(r.get("ts") or 0) - settled_ts) > MATCH_WINDOW_SEC:
                continue
        except (TypeError, ValueError):
            continue
        if _episode_conflict(r, info):
            continue
        booster = r.get("booster") or {}
        if (npub and booster.get("npub") == npub) or (total_sats and r.get("sats") == total_sats):
            out.append(r)
    return out


def find_match(records, info, settled_ts, consumed=None):
    """The indexed boost that represents this payment, or None.

    Two signals, strongest first:

      npub  — we know the donor's Nostr identity (Fountain comment, website
              receipt) and a note from exactly that pubkey sits in the window.
              For Fountain this is airtight: the npub we read off the comment
              IS the identity Fountain publishes the note as.
      sats  — no identity to match on, so fall back to an exact sats match in
              the window. Amount collisions are possible (two 100-sat boosts
              20 minutes apart), and they resolve toward suppressing our claim
              rather than duplicating one — the safe direction.

    `consumed` is a set of already-matched event ids, so two boosts in one batch
    can't both claim the same indexed note.
    """
    consumed = consumed if consumed is not None else set()
    npub = info.get("sender_npub")
    total_sats = info.get("total_sats")

    def _candidates():
        for r in records:
            if r.get("id") in consumed:
                continue
            booster = r.get("booster") or {}
            # Our own claimed notes are not evidence that somebody else published.
            if booster.get("pk") == SHOW_PUBKEY_HEX:
                continue
            try:
                if abs(int(r.get("ts") or 0) - settled_ts) > MATCH_WINDOW_SEC:
                    continue
            except (TypeError, ValueError):
                continue
            if _episode_conflict(r, info):
                continue
            yield r, booster

    if npub:
        for r, booster in _candidates():
            if booster.get("npub") == npub:
                return r, "npub"

    if total_sats:
        for r, _ in _candidates():
            if r.get("sats") == total_sats:
                return r, "sats"

    return None, None



# ── the last check before an irreversible publish ─────────────────────────────
# A kind-1 note cannot be unpublished, so the decision that adds claim tags gets
# a second look that the decision to stay quiet does not. Two things can have
# changed since the batch query at the top of the run:
#
#   1. minutes have passed (a run does RSS parses, Fountain scrapes, lnbits
#      lookups), and the donor's note may have been indexed in that time;
#   2. the donor's note may exist on relays but not be indexed at all — the case
#      where publishing ours would put a second note on Nostr for a boost that is
#      already there. That is an indexer bug to fix, not a boost to republish.
#
# Both resolve toward not claiming. The cost of being wrong here is asymmetric:
# a missed claim is one boost absent from an index until someone notices, and is
# recoverable; a duplicate claim is a donor's sats counted twice, forever.

# Payment evidence a boost note can carry. Fountain's notes carry NONE of these
# (their evidence is a quoted kind-9735 receipt), so the relay veto below also
# accepts a note that merely matches on npub + episode — for Fountain, the
# donor's identity in the window IS the signal.
_EVIDENCE_TOPIC_TAGS = {"boost", "boostagram", "value4value"}


def _event_item_guid(ev):
    """The episode a raw kind-1 note names via NIP-73, or None."""
    for t in ev.get("tags", []):
        if len(t) >= 2 and t[0] == "i" and t[1].startswith("podcast:item:guid:"):
            return t[1][len("podcast:item:guid:"):]
    return None


def _note_sats(ev):
    """Sats a relay note claims, from its amount tag or its text. None if neither."""
    for t in ev.get("tags", []):
        if len(t) >= 2 and t[0] == "amount":
            try:
                v = int(t[1])
                if v > 0:
                    return round(v / 1000)
            except ValueError:
                pass
    m = re.search(r"([\d][\d,]{0,15})\s*sats\b", ev.get("content", "") or "", re.IGNORECASE)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return None


def relay_note_for(info, settled_ts, relays, query_relay, show_pubkey=SHOW_PUBKEY_HEX):
    """A boost note for this payment already on the relays, or None.

    `query_relay` is injected rather than imported so this module keeps no
    relay dependency of its own — the publisher passes collector_common's.
    Our own notes are ignored: they are what we are deciding whether to write.
    """
    filt = {"kinds": [1], "#i": [f"podcast:guid:{LB_FEED_GUID}"],
            "since": int(settled_ts - MATCH_WINDOW_SEC),
            "until": int(settled_ts + MATCH_WINDOW_SEC), "limit": 200}
    npub = info.get("sender_npub")
    npub_hex = None
    if npub:
        # Local bech32 decode would drag a dependency in for one field; the
        # publisher hands us the hex when it has it.
        npub_hex = info.get("sender_pubkey_hex")
    total_sats = info.get("total_sats")

    item_guid = info.get("item_guid")

    for relay in relays:
        try:
            events = query_relay(relay, filt) or []
        except Exception:
            continue                      # a dead relay is not evidence of absence
        for ev in events:
            if ev.get("pubkey") == show_pubkey:
                continue
            ev_sats = _note_sats(ev)
            ev_item = _event_item_guid(ev)
            # Positively different episodes → different boosts, whoever signed them.
            if ev_item and item_guid and ev_item != item_guid:
                continue
            if npub_hex and ev.get("pubkey") == npub_hex:
                # The donor's identity alone is not enough. On 2026-08-08 one
                # donor boosted 1,111 sats at 21:49 and 1,000 at 21:54; their
                # note for the first sits well inside the second's window, and
                # matching on npub alone vetoed a claim that was real. So a note
                # that states an amount has to state THIS one; a note with no
                # parseable amount still vetoes, since then we cannot tell them
                # apart and the safe direction is not to publish.
                if ev_sats is None or total_sats is None or ev_sats == total_sats:
                    return ev, f"{relay} has a note from the donor ({ev['id'][:12]}...)"
                continue
            has_evidence = (
                any(t[0] == "t" and len(t) >= 2 and t[1] in _EVIDENCE_TOPIC_TAGS
                    for t in ev.get("tags", []))
                or any(t[0] == "amount" for t in ev.get("tags", []) if t))
            if has_evidence and total_sats and ev_sats == total_sats:
                return ev, f"{relay} has a {total_sats}-sat boost note ({ev['id'][:12]}...)"
    return None, None


def verify_before_claim(info, now_ts, relays=None, query_relay=None):
    """Re-check, immediately before publishing, that nobody else covered this
    boost. Returns (True, why) to go ahead, or (False, why) to publish untagged.

    Only ever called on a "claim" verdict, so it runs a handful of times a day —
    cheap enough to be thorough where it counts.
    """
    settled_ts = _ts(info.get("settled_at"))
    if settled_ts is None:
        return False, "no parseable settledAt"

    try:
        fresh = fetch_indexed(settled_ts - QUERY_PAD_SEC)
    except CoverageUnavailable as e:
        return False, f"OnlyBoosts unreachable on re-check ({e}) — not claiming"
    match, how = find_match(fresh, info, settled_ts)
    if match:
        return False, f"indexed since the batch query (matched on {how}, {match['id'][:12]}...)"

    if relays and query_relay:
        ev, why = relay_note_for(info, settled_ts, relays, query_relay)
        if ev:
            return False, (f"a note for this boost is already on Nostr but NOT indexed — "
                           f"{why}. Not republishing; this is an indexer gap "
                           f"(coverage_audit reports it as INDEX GAP).")

    return True, "no note for this boost on the index or the relays"

# Receipt `share_status` values that mean the donor's own note exists. Anything
# else — declined, unavailable, anon, failed, or a receipt that predates the tag
# entirely — means no donor note is coming.
SHARE_PUBLISHED = "published"


def decide(info, records, now_ts, consumed=None):
    """Should our standalone note claim this boost?

    Returns (decision, reason) where decision is one of:
      "skip"  — somebody else's note covers it; publish our note untagged.
      "claim" — nobody did; publish our note WITH boost-evidence tags.
      "hold"  — too early to tell; publish nothing this tick and try again.

    `records` is the fetch_indexed() result, or None when the API was
    unreachable — in which case a boost is held until HOLD_WINDOW_SEC and then
    published untagged, so an OnlyBoosts outage can never manufacture a claim.
    """
    settled_ts = _ts(info.get("settled_at"))
    if settled_ts is None:
        return "skip", "no parseable settledAt"
    age = now_ts - settled_ts
    hold_window = (HOLD_WINDOW_IDENTIFIED_SEC if info.get("sender_npub")
                   else HOLD_WINDOW_SEC)

    # Website boosts carry their own answer. The widget pre-signs the donor's
    # share note before payment and stamps the outcome onto the kind-30078
    # boost_receipt, so there is nothing to look up and nothing to wait for.
    share_status = (info.get("share_status") or "").strip().lower()
    if share_status == SHARE_PUBLISHED:
        return "skip", f"receipt says donor published ({info.get('share_note_id', '')[:12] or 'no id'})"
    if share_status:
        return "claim", f"receipt says share_status={share_status}"

    if records is None:
        if age < hold_window:
            return "hold", "OnlyBoosts API unreachable — retrying next tick"
        return "skip", "OnlyBoosts API unreachable past the hold window"

    match, how = find_match(records, info, settled_ts, consumed)
    if match:
        if consumed is not None:
            consumed.add(match["id"])
        who = ((match.get("client_app") or {}).get("id")
               or match.get("client") or "unknown client")
        return "skip", f"already indexed via {who} (matched on {how}, {match['id'][:12]}...)"

    if age < hold_window:
        return "hold", (f"not indexed yet, {int(age / 60)} min old — waiting up to "
                        f"{int(hold_window / 60)} min for the donor's note")

    return "claim", f"no note indexed after {int(age // 60)} min"
