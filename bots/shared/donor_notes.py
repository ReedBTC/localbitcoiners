#!/usr/bin/env python3
"""The booster's OWN kind-1 note for a boost — found, verified, attached.

Reed, 2026-10-17: the boost wall shows "each individual's kind-1 notes in the
feed if they exist, and the LB kind-1 note if there isn't one" — the
OnlyBoosts model. This module is the one place that decides whether a note
IS the donor's note for a given payment. Three ways in:

  receipt   the website receipt's `share_note`, author resolved on the relays
            and found to be the donor's key (live, in the publisher)
  session   the same note found later by the receipt's boost_session
            (backfill / reconcile — the note carries a `boost_session` tag,
            and the receipts are keyed by it)
  index     onlyboosts_coverage.find_match against the OnlyBoosts index
            (Fountain boosts above all), then the raw event off the relays
  relay     relay_note_for's veto note, the case where a donor note exists
            on Nostr but the index has not seen it

and four rules that make a wrong card impossible rather than unlikely:

  1. The signer must be a person. The show key and every publishing account
     OnlyBoosts knows (chadf-boostbot, boostmebitch, …) are excluded; such a
     note may name the donor in a `P` tag and that tag is never read —
     OnlyBoosts itself refuses to (its classify.py), because nothing verifies
     it.
  2. When the ledger knows the donor's npub, the note's pubkey must be that
     npub. A note by anyone else is not "their own note", however well the
     sats and message agree.
  3. A sats-only match is not enough to show a note under someone's name —
     it is enough to SUPPRESS our claim (the publisher's purpose, where the
     safe direction is silence) but not to ATTRIBUTE. Rejected, listed for
     hand review.
  4. An npub-only match with a second note from the same npub in the window
     cannot be told apart from their other boost by sats or text. Such a
     BURST is paired by episode instead (Reed, 2026-10-17, for the 19-boost
     BullishBoosts test run of 2026-07-21): the note's NIP-73 item guid
     against the record's episode (via the RSS index), else the note's own
     "for Ep. N" line, then time order within each episode, and plain time
     order only when no note names an episode. A note that contradicts
     itself or names an episode no record in the burst has stays
     unattached and is listed.

Signatures are verified before a pubkey is believed (collector_common).
"""

import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import onlyboosts_coverage as cov  # noqa: E402
from collector_common import query_relay, verify_raw_event  # noqa: E402
from nostr_utils import npub_to_hex, BOOST_SCAN_RELAYS, NOSTR_RELAYS  # noqa: E402
from boost_formatter import (  # noqa: E402
    fetch_event, fetch_kind_30078, fetch_all_kind_30078, _receipt_share_info,
    make_cache, record_donor_note, build_rss_item_index, _extract_episode_number,
)

_FOR_EP_RE = re.compile(r"\bfor Ep\.?\s*(\d{1,3})\b", re.IGNORECASE)

SHOW_PUBKEY_HEX = cov.SHOW_PUBKEY_HEX

# Publishing accounts: notes they sign are on behalf of someone and are never
# a donor's own note. Mirror of PUBLISHER_PUBKEYS in the OnlyBoosts repo
# (bots/global-boost-scan/clients.py) as of 2026-10-17, show key included.
PUBLISHER_PUBKEYS = {
    "f3bd42a91af5f3f1c40ca45ad2269464ab79996b32da78e8ed2ab91111b08e65": "chadf-boostbot",
    "d35ae076512c29b01a5b33aa764ed4db44a9d0bbd96009705f48101f6cfe76a2": "lnaddress-music",
    "c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592": "localbitcoiners",
    "3a87a19c801d57111b0905569225d2b20b39d154fc93bef5a8f2860c409b84d9": "onlyboosts",
    "3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408": "boostmebitch",
    "adab4ccd313996520304a5b1ec6c4076bc271bc6a3236702321c5811009d0649": "boostr-bot",
    "ffff6a7af32ea2239cb71548f476eec0dd9ae56673abda536bef5c241276fc3e": "msp-2-0",
}

# Where a donor note is fetched from: the boost-scan set (relay.fountain.fm
# holds most Fountain notes) plus the publish set plus the two relays that
# held the most of the mega-thread on 2026-08-13.
DONOR_RELAYS = list(dict.fromkeys(
    list(BOOST_SCAN_RELAYS) + list(NOSTR_RELAYS)
    + ["wss://relay.ditto.pub", "wss://relay.primal.net"]))

# find_match tiers that may attribute a note (rule 3). "message" is a ≥12-char
# containment of the donor's text with no npub on either side to contradict
# it — kept, it never fired on the 2026-10-17 backfill, so it stays harmless.
ATTRIBUTING_TIERS = {"npub+message", "npub", "sats+message", "message"}
DONOR_FIELDS = ("donor_note_id", "donor_match", "donor_event")


# ── identity ──────────────────────────────────────────────────────────────────

def is_donor_signer(pubkey):
    return bool(pubkey) and pubkey != SHOW_PUBKEY_HEX and pubkey not in PUBLISHER_PUBKEYS


def npub_hex(npub):
    if not npub:
        return None
    try:
        return npub_to_hex(npub)
    except Exception:
        return None


def donor_records(records):
    """Index records a person signed — the only ones that can be a donor note."""
    return [r for r in (records or [])
            if is_donor_signer((r.get("booster") or {}).get("pk"))]


def row_info(src):
    """find_match's `info` from a sats.csv row, a wall record or a BoostInfo
    (their field names overlap by design; the differences are normalised here)."""
    sats = src.get("total_sats") if src.get("total_sats") not in (None, "") else src.get("sats")
    try:
        sats = int(float(sats)) if sats not in (None, "") else None
    except (TypeError, ValueError):
        sats = None
    return {
        "sender_npub":    src.get("sender_npub") or None,
        "total_sats":     sats or None,
        "message":        src.get("message") or None,
        "episode_number": src.get("episode_number") or src.get("episode_num") or None,
        "settled_at":     src.get("settled_at"),
        "source":         src.get("source"),
        "payment_hash":   src.get("payment_hash"),
    }


# ── the guard every donor note passes ─────────────────────────────────────────

def verified_donor_event(event, info):
    """(event, None) when `event` can be shown as this boost's donor note, else
    (None, reason). Signature, kind, signer (rule 1) and ledger npub (rule 2)."""
    if not event or not isinstance(event, dict):
        return None, "no event"
    if not verify_raw_event(event):
        return None, "bad signature"
    if event.get("kind") != 1:
        return None, f"kind {event.get('kind')} is not a note"
    pk = event.get("pubkey")
    if not is_donor_signer(pk):
        return None, f"signed by {PUBLISHER_PUBKEYS.get(pk, 'the show')} — a publisher, not the donor"
    want = npub_hex((info or {}).get("sender_npub"))
    if want and pk != want:
        return None, "author is not the ledger's npub"
    return event, None


def donor_from_event(event, info, how):
    """A donor dict for the wall + published_events, or None when the event
    fails verified_donor_event."""
    ev, why = verified_donor_event(event, info)
    if not ev:
        return None
    return {"donor_event": ev, "donor_note_id": ev["id"], "donor_match": how,
            "donor_pubkey": ev["pubkey"]}


def donor_from_index_record(record, info, how, cache=None, relays=None):
    """A donor dict from an OnlyBoosts index record: the raw event fetched off
    the relays and verified; or, when no relay returns it yet, the id alone
    (rules 1–2 applied to what the index says about the signer) so the
    reconcile pass can fetch it later. None when it is not a donor note."""
    if how not in ATTRIBUTING_TIERS:
        return None
    booster = (record or {}).get("booster") or {}
    if not is_donor_signer(booster.get("pk")):
        return None
    npub = (info or {}).get("sender_npub")
    if npub and booster.get("npub") != npub:
        return None
    ev = fetch_event(record["id"], relays or DONOR_RELAYS, cache=cache)
    if ev:
        return donor_from_event(ev, info, how)
    return {"donor_note_id": record["id"], "donor_match": how,
            "donor_pubkey": booster.get("pk")}


def set_donor_note(rec, donor_event=None, donor_note_id=None, donor_match=None):
    """Attach the donor's own note to a wall record. Returns what was attached:
    "event" (id + raw event), "id" (id only — fetch it later), or None.

    Guards, each of which otherwise fails silently on the site:
      - a `donor_event` must carry an id, and `donor_note_id` is that id;
      - when the record names a `sender_npub`, the event's pubkey must be
        that npub's hex (rule 2) — refused rather than shown under the
        wrong name;
      - the show's key and the publisher accounts are never a donor (rule 1).
    Signature verification is verified_donor_event's job; the publisher and
    the rebuild tool both go through it before reaching here."""
    if donor_event:
        eid = donor_event.get("id")
        if not eid:
            return None
        if donor_note_id and donor_note_id != eid:
            return None
        donor_note_id = eid
        if not is_donor_signer(donor_event.get("pubkey")):
            return None
        want = npub_hex(rec.get("sender_npub"))
        if want and donor_event.get("pubkey") != want:
            return None
    if not donor_note_id:
        return None
    rec["donor_note_id"] = donor_note_id
    rec["donor_match"]   = donor_match or rec.get("donor_match") or "unknown"
    if donor_event:
        rec["donor_event"] = donor_event
        return "event"
    return "id"


# ── finding one ───────────────────────────────────────────────────────────────

def index_match(records, info, settled_ts, consumed=None):
    """(record, how, None) for an attributable index match, or (None, how, why).
    `records` may be the raw index — publisher signers are dropped here.
    Adds the match to `consumed` so two boosts cannot share one note."""
    recs = donor_records(records)
    m, how = cov.find_match(recs, info, settled_ts, consumed)
    if not m:
        return None, None, "no index match"
    if how not in ATTRIBUTING_TIERS:
        return None, how, f"{how}-only match rejected ({m['id'][:12]}…)"
    npub = info.get("sender_npub")
    booster = m.get("booster") or {}
    if npub and booster.get("npub") != npub:
        return None, how, f"matched note is signed by someone else ({m['id'][:12]}…)"
    if how == "npub":
        same = [r for r in recs
                if (r.get("booster") or {}).get("npub") == npub
                and r.get("id") not in (consumed or set())
                and abs(int(r.get("ts") or 0) - settled_ts) <= cov.MATCH_WINDOW_SEC]
        if len(same) > 1:
            return None, how, (f"ambiguous: {len(same)} notes from this npub in the window "
                               f"({', '.join(r['id'][:12] + '…' for r in same)})")
    if consumed is not None:
        consumed.add(m["id"])
    return m, how, None


def website_session_note(payment_hash, boost_session=None, cache=None, relays=None):
    """The website donor's share note for a payment, by the receipt chain:
    boostagram (#d=payment_hash) → boost_session → receipts (#d=session) →
    share_status/share_note → the note. Returns (event, None) or (None, why).
    The event still has to pass verified_donor_event; this only follows the
    chain and refuses the site-signed and mismatched cases."""
    cache = cache if cache is not None else make_cache()
    if not boost_session:
        ev30078 = fetch_kind_30078(payment_hash, cache=cache)
        tags = {t[0]: t[1] for t in (ev30078 or {}).get("tags", []) if len(t) > 1}
        boost_session = tags.get("boost_session")
    if not boost_session:
        return None, "no boost_session on the boostagram"
    receipts = fetch_all_kind_30078(boost_session, cache=cache)
    status, note_id, _ = _receipt_share_info(receipts)
    if status != cov.SHARE_PUBLISHED or not note_id:
        return None, f"share_status={status or 'none'}"
    ev = fetch_event(note_id, relays or DONOR_RELAYS, cache=cache)
    if not ev:
        return None, f"share note {note_id[:12]}… unfetchable"
    if ev.get("pubkey") == SHOW_PUBKEY_HEX:
        return None, "site-signed (the show's note)"
    tag_sess = next((t[1] for t in ev.get("tags", []) if len(t) > 1 and t[0] == "boost_session"), None)
    if tag_sess and tag_sess != boost_session:
        return None, "share note carries a different boost_session"
    return ev, None


def fetch_events_by_ids(ids, relays=None, max_wall_seconds=30, verify=True):
    """Batched id lookup across relays, stopping early once everything is
    found; signature-verified unless told otherwise."""
    out = {}
    ids = list(dict.fromkeys(i for i in ids if i))
    for relay in (relays or DONOR_RELAYS):
        want = [i for i in ids if i not in out]
        if not want:
            break
        for i in range(0, len(want), 100):
            try:
                got = query_relay(relay, {"ids": want[i:i + 100]},
                                  max_wall_seconds=max_wall_seconds) or []
            except Exception:
                continue
            for ev in got:
                if ev.get("id") in want and (not verify or verify_raw_event(ev)):
                    out[ev["id"]] = ev
    return out


def _ts(s):
    return cov._ts(s)


# ── attaching, in bulk ────────────────────────────────────────────────────────

def attach_donor_notes(wall, published_events, rows_by_ph, index_records, *,
                       set_donor_note, since_ts=None, website=True, cache=None,
                       relays=None, fetch=True, log=print):
    """Find and attach donor notes for every wall record with a payment behind
    it and no `donor_event` yet. Mutates `wall` and `published_events` in
    memory; the caller writes (or doesn't — the backfill's dry run).

    `index_records` is the OnlyBoosts index for the span (None = unavailable:
    the session join and the fetch of already-known ids still run). Records
    settled before `since_ts` are left alone. Returns a stats dict whose
    `review` list is what a human should look at."""
    relays = relays or DONOR_RELAYS
    cache = cache if cache is not None else make_cache()
    stats = {"_wall": wall, "candidates": 0, "attached": Counter(), "by_source": Counter(),
             "id_only": 0, "unmatched": Counter(), "rejected": Counter(),
             "review": [], "already": 0, "message_filled": 0}
    consumed = {r.get("donor_note_id") for r in wall.values() if r.get("donor_note_id")}
    consumed |= {r.get("donor_note_id") for r in published_events.values() if r.get("donor_note_id")}
    donor_recs = donor_records(index_records) if index_records is not None else None
    pending = {}   # note id -> (event id, info, how)
    bursts = defaultdict(list)   # npub -> [(event id, info, settled ts)] (rule 4)

    def _apply(eid, info, d):
        rec = wall[eid]
        got = set_donor_note(rec, **{k: d.get(k) for k in DONOR_FIELDS})
        if not got:
            stats["rejected"]["refused by set_donor_note (npub mismatch)"] += 1
            return False
        record_donor_note(published_events, info.get("payment_hash"),
                          d["donor_note_id"], d["donor_match"], d.get("donor_pubkey"))
        stats["attached"][d["donor_match"]] += 1
        stats["by_source"][info.get("source") or "?"] += 1
        if got == "id":
            stats["id_only"] += 1
        return True

    ordered = sorted(wall.items(), key=lambda kv: _ts(kv[1].get("settled_at")) or 0)
    for eid, rec in ordered:
        ph = rec.get("payment_hash")
        if not ph:
            continue
        if rec.get("donor_event"):
            stats["already"] += 1
            continue
        row = rows_by_ph.get(ph) or {}
        merged = dict(rec)
        merged.update({k: v for k, v in row.items() if v not in ("", None)})
        info = row_info(merged)
        # The ledger's copy of the donor's text rides on the meta (build_record
        # does this for new records; existing ones get it here, verbatim).
        if not rec.get("message") and row.get("message"):
            rec["message"] = row["message"]
            stats["message_filled"] += 1
        ts = _ts(info.get("settled_at"))
        if ts is None or (since_ts and ts < since_ts):
            continue
        stats["candidates"] += 1

        pe = published_events.get(ph) or {}
        known = rec.get("donor_note_id") or pe.get("donor_note_id")
        if known:
            pending[known] = (eid, info, rec.get("donor_match") or pe.get("donor_match") or "unknown")
            continue

        if website and info.get("source") == "website":
            ev, why = website_session_note(ph, pe.get("boost_session"), cache=cache, relays=relays)
            if ev:
                d = donor_from_event(ev, info, "session")
                if d:
                    if d["donor_note_id"] in consumed:
                        stats["rejected"]["session note already attached elsewhere"] += 1
                    else:
                        consumed.add(d["donor_note_id"])
                        _apply(eid, info, d)
                    continue
                stats["rejected"]["session note failed the donor check"] += 1
            # No share note by the receipt chain: the index may still know one
            # (pre-2026-08 widget notes predate the share_status tag).

        if donor_recs is None:
            stats["unmatched"]["index unavailable"] += 1
            continue
        m, how, why = index_match(donor_recs, info, ts, consumed)
        if m:
            pending[m["id"]] = (eid, info, how)
        else:
            src = info.get("source") or "?"
            if how == "npub" and why.startswith("ambiguous"):
                bursts[info["sender_npub"]].append((eid, info, ts))
                continue
            if how:
                stats["rejected"][why.split(" (")[0]] += 1
                stats["review"].append({
                    "payment_hash": ph, "source": src, "settled_at": info.get("settled_at"),
                    "sats": info.get("total_sats"), "sender_npub": info.get("sender_npub"),
                    "tier": how, "why": why,
                })
            stats["unmatched"][f"{src}{' (npub)' if info.get('sender_npub') else ''}"] += 1

    if bursts:
        _pair_bursts(bursts, donor_recs, consumed, pending, stats, relays, cache, fetch, log)

    if pending:
        events = fetch_events_by_ids(list(pending), relays) if fetch else {}
        log(f"  donor notes: {len(pending)} to fetch, {len(events)} returned by the relays")
        for nid, (eid, info, how) in pending.items():
            ev = events.get(nid)
            if ev:
                d = donor_from_event(ev, info, how)
                if d:
                    _apply(eid, info, d)
                else:
                    stats["rejected"][f"fetched note failed the donor check ({verified_donor_event(ev, info)[1]})"] += 1
                    stats["unmatched"][info.get("source") or "?"] += 1
            else:
                _apply(eid, info, {"donor_note_id": nid, "donor_match": how})
    return stats


# ── rule 4: bursts, paired by episode ─────────────────────────────────────────

def note_episode(event, guid_index):
    """(episode_num, fountain_id, contradiction) for a donor note: the NIP-73
    item guid resolved through the RSS index first, the note's own
    "for Ep. N" line second. `contradiction` is set when the two disagree."""
    ep_guid = fid = None
    for t in event.get("tags") or []:
        if len(t) > 1 and t[0] == "i" and str(t[1]).startswith("podcast:item:guid:"):
            entry = (guid_index or {}).get(t[1][len("podcast:item:guid:"):])
            if entry:
                fid = entry.get("fountain_id") or None
                title = entry.get("title") or ""
                lead = re.match(r"\s*(\d{3})\.", title)      # "002. Title" — the feed's shape
                ep_guid = (lead.group(1) if lead else _extract_episode_number(title)) or None
            break
    m = _FOR_EP_RE.search(event.get("content") or "")
    ep_text = m.group(1).zfill(3) if m else None
    if ep_guid and ep_text and ep_guid != ep_text:
        return None, fid, f"guid says Ep {ep_guid}, text says Ep {ep_text}"
    return ep_guid or ep_text, fid, None


def pair_burst(records, notes):
    """Pair one donor's burst. `records`: [(key, episode_num, episode_id,
    settled_ts)]; `notes`: [(note_id, episode_num, fountain_id, created_at,
    contradiction)]. Returns (pairs {key: note_id}, leftovers [(what, id, why)]).

    By episode first (fountain id or episode number), time order inside an
    episode; plain time order over everything only when NO note names an
    episode. A note that names an episode no record has, or contradicts
    itself, is left out and said so."""
    pairs, left = {}, []
    usable = [n for n in notes if not n[4]]
    left += [("note", n[0], n[4]) for n in notes if n[4]]
    if usable and not any(n[1] or n[2] for n in usable):
        rs = sorted(records, key=lambda r: r[3]); ns = sorted(usable, key=lambda n: n[3])
        for r, n in zip(rs, ns):
            pairs[r[0]] = n[0]
        left += [("record", r[0], "more records than notes (time order)") for r in rs[len(ns):]]
        left += [("note", n[0], "more notes than records (time order)") for n in ns[len(rs):]]
        return pairs, left
    by_ep = defaultdict(lambda: ([], []))
    for r in records:
        by_ep[r[2] or r[1] or "?"][0].append(r)
    for n in usable:
        key = n[2] if n[2] and n[2] in by_ep else (n[1] or n[2] or "?")
        # a note naming only an episode number joins the record keyed by fountain id
        if key not in by_ep:
            for k, (rs, _) in by_ep.items():
                if any(r[1] == n[1] for r in rs) and n[1]:
                    key = k
                    break
        by_ep[key][1].append(n)
    for key, (rs, ns) in by_ep.items():
        rs = sorted(rs, key=lambda r: r[3]); ns = sorted(ns, key=lambda n: n[3])
        for r, n in zip(rs, ns):
            pairs[r[0]] = n[0]
        left += [("record", r[0], f"no note for its episode ({key})") for r in rs[len(ns):]]
        left += [("note", n[0], f"names episode {key}, which no record in the burst has") for n in ns[len(rs):]]
    return pairs, left


def _pair_bursts(bursts, donor_recs, consumed, pending, stats, relays, cache, fetch, log):
    guid_index = None
    if fetch:
        try:
            guid_index = build_rss_item_index(cache)
        except Exception as e:
            log(f"  [warn] RSS index unavailable for burst pairing ({e}); using the notes' text only")
    for npub, group in bursts.items():
        lo = min(ts for _, _, ts in group) - cov.MATCH_WINDOW_SEC
        hi = max(ts for _, _, ts in group) + cov.MATCH_WINDOW_SEC
        cands = [r for r in donor_recs
                 if (r.get("booster") or {}).get("npub") == npub
                 and r.get("id") not in consumed and lo <= int(r.get("ts") or 0) <= hi]
        events = fetch_events_by_ids([r["id"] for r in cands], relays) if fetch else {}
        notes = []
        for r in cands:
            ev = events.get(r["id"])
            if not ev:
                continue
            ep, fid, contra = note_episode(ev, guid_index)
            notes.append((r["id"], ep, fid, ev.get("created_at") or r["ts"], contra))
        records = [(eid, info.get("episode_number"), None, ts) for eid, info, ts in group]
        # the record's fountain id lives on the wall record, not the info
        records = [(eid, ep, (stats.get("_wall") or {}).get(eid, {}).get("episode_id"), ts)
                   for eid, ep, _, ts in records]
        pairs, left = pair_burst(records, notes)
        log(f"  burst {npub[:16]}…: {len(group)} boosts, {len(notes)} notes fetched, "
            f"{len(pairs)} paired by episode, {len(left)} left")
        infos = {eid: info for eid, info, _ in group}
        for eid, nid in pairs.items():
            consumed.add(nid)
            pending[nid] = (eid, infos[eid], "npub+episode")
        for what, ident, why in left:
            stats["rejected"][f"burst: {what} left unpaired"] += 1
            if what == "record":
                info = infos[ident]
                stats["unmatched"][f"{info.get('source') or '?'} (npub)"] += 1
                stats["review"].append({
                    "payment_hash": info.get("payment_hash"), "source": info.get("source"),
                    "settled_at": info.get("settled_at"), "sats": info.get("total_sats"),
                    "sender_npub": npub, "tier": "npub", "why": f"burst: {why}"})
            else:
                stats["review"].append({"payment_hash": None, "source": "note", "settled_at": None,
                                        "sats": None, "sender_npub": npub, "tier": "npub",
                                        "why": f"burst: note {ident[:12]}… {why}"})


def print_stats(stats, log=print):
    log(f"  candidates {stats['candidates']}, already had a donor note {stats['already']}, "
        f"message filled from the ledger on {stats['message_filled']}")
    log(f"  attached {sum(stats['attached'].values())} "
        f"(id only, event not yet fetched: {stats['id_only']})")
    for k, v in sorted(stats["attached"].items(), key=lambda kv: -kv[1]):
        log(f"    {v:5d}  {k}")
    log("  by source: " + ", ".join(f"{k} {v}" for k, v in sorted(stats["by_source"].items())))
    if stats["rejected"]:
        log("  rejected:")
        for k, v in sorted(stats["rejected"].items(), key=lambda kv: -kv[1]):
            log(f"    {v:5d}  {k}")
    log("  unmatched: " + ", ".join(f"{k} {v}" for k, v in sorted(stats["unmatched"].items())))
    if stats["review"]:
        log(f"\n  FOR REVIEW ({len(stats['review'])}) — not attached:")
        for r in stats["review"]:
            log(f"    {r['settled_at'] or '-':<20}  {r['source']:<14} {str(r['sats']):>7} sats  "
                f"{(r['sender_npub'] or '-')[:16]}  ph={(r['payment_hash'] or '-')[:12]}…  {r['why']}")
