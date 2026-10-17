#!/usr/bin/env python3
"""Offline regression test for the donor-note rules (shared/donor_notes.py)
and the wall fields they feed (boost-publisher/boost_wall.py).

Pins the four rules that keep a note from being shown under the wrong name:
publisher signers excluded, the ledger npub wins, sats-only never attributes,
an ambiguous npub-only match goes to review — plus the record shape the site
parses (`event` always present, `"donor_event" in rec` as the presence test,
`message` on the meta), upsert preserving donor fields, the settled_at sort,
decide()'s match_out hook, and topboosts preferring the donor's note.

No network. Run it from anywhere:

    python3 bots/shared/test_donor_notes.py
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "boost-publisher"))
import donor_notes as dn  # noqa: E402
import boost_wall  # noqa: E402
import onlyboosts_coverage as cov  # noqa: E402

FAILURES = []


def check(label, cond):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}")
    if not cond:
        FAILURES.append(label)


SHOW = dn.SHOW_PUBKEY_HEX
BOT = "f3bd42a91af5f3f1c40ca45ad2269464ab79996b32da78e8ed2ab91111b08e65"   # chadf-boostbot
ALICE_NPUB = "npub1a3zuwhttqgxw340qgupl24jmydnssmht05v48ecm5tvx762d358sexf24q"
ALICE = dn.npub_hex(ALICE_NPUB)
BOB = "ab" * 32
T0 = 1_792_000_000


def rec(id_, pk, npub=None, ts=T0, sats=1000, msg=""):
    return {"id": id_, "ts": ts, "sats": sats, "msg": msg,
            "booster": {"pk": pk, "npub": npub}}


def info(npub=None, sats=1000, msg=None):
    return {"sender_npub": npub, "total_sats": sats, "message": msg,
            "settled_at": "2026-10-14T17:46:40Z", "source": "fountain_boost"}


print("identity")
check("show key is not a donor signer", not dn.is_donor_signer(SHOW))
check("chadf-boostbot is not a donor signer", not dn.is_donor_signer(BOT))
check("a person is", dn.is_donor_signer(ALICE))
check("donor_records drops publisher-signed rows",
      [r["id"] for r in dn.donor_records([rec("a", SHOW), rec("b", BOT), rec("c", ALICE)])] == ["c"])

print("index_match — the four rules")
m, how, why = dn.index_match([rec("x", ALICE, ALICE_NPUB, msg="thanks for the great show")],
                             info(ALICE_NPUB, msg="thanks for the great show"), T0)
check("npub+message attributes", m and m["id"] == "x" and how == "npub+message")
m, how, why = dn.index_match([rec("x", BOT, None, msg="thanks for the great show")],
                             info(None, msg="thanks for the great show"), T0)
check("rule 1: a publisher's note never attributes, even on message", m is None and why == "no index match")
m, how, why = dn.index_match([rec("x", BOB, "npub1bob", msg="thanks for the great show")],
                             info(ALICE_NPUB, msg="thanks for the great show"), T0)
check("rule 2: a note by someone else is refused even with sats+message",
      m is None and how in ("sats+message", "message") and "someone else" in why)
m, how, why = dn.index_match([rec("x", BOB, "npub1bob")], info(None, sats=1000), T0)
check("rule 3: sats-only is rejected and named for review", m is None and how == "sats" and "rejected" in why)
m, how, why = dn.index_match([rec("x", ALICE, ALICE_NPUB, ts=T0 + 60, sats=500),
                              rec("y", ALICE, ALICE_NPUB, ts=T0 - 60, sats=700)],
                             info(ALICE_NPUB, sats=1000), T0)
check("rule 4: npub-only with two of the donor's notes in the window → review",
      m is None and how == "npub" and why.startswith("ambiguous"))
consumed = set()
m, how, why = dn.index_match([rec("x", ALICE, ALICE_NPUB, sats=1000)], info(ALICE_NPUB), T0, consumed)
check("npub-only with a single candidate attributes and is consumed", m and "x" in consumed)
m, how, why = dn.index_match([rec("x", ALICE, ALICE_NPUB, sats=1000)], info(ALICE_NPUB), T0, consumed)
check("a consumed note cannot be matched twice", m is None)

print("verified_donor_event")
fake = {"id": "e" * 64, "pubkey": ALICE, "kind": 1, "created_at": T0, "tags": [], "content": "x", "sig": "0" * 128}
ev, why = dn.verified_donor_event(fake, info(ALICE_NPUB))
check("an unverifiable signature is refused", ev is None and why == "bad signature")
check("donor_from_event returns None for it", dn.donor_from_event(fake, info(ALICE_NPUB), "receipt") is None)
check("donor_from_index_record refuses a non-attributing tier without touching the network",
      dn.donor_from_index_record(rec("x", ALICE, ALICE_NPUB), info(ALICE_NPUB), "sats") is None)
check("…and a record signed by a publisher",
      dn.donor_from_index_record(rec("x", BOT, None), info(None), "sats+message") is None)
check("…and a record whose npub is not the ledger's",
      dn.donor_from_index_record(rec("x", BOB, "npub1bob"), info(ALICE_NPUB), "npub") is None)

print("set_donor_note")
alice_ev = {"id": "a1" * 32, "pubkey": ALICE, "kind": 1, "created_at": T0, "tags": [], "content": "hi"}
r = {"event": {"id": "r"}, "sender_npub": ALICE_NPUB}
check("event by the ledger npub attaches", dn.set_donor_note(r, donor_event=alice_ev, donor_match="receipt") == "event"
      and r["donor_note_id"] == alice_ev["id"] and r["donor_match"] == "receipt" and "donor_event" in r)
r = {"event": {"id": "r"}, "sender_npub": ALICE_NPUB}
check("event by someone else is refused", dn.set_donor_note(r, donor_event={**alice_ev, "pubkey": BOB}) is None
      and "donor_event" not in r and "donor_note_id" not in r)
r = {"event": {"id": "r"}}
check("event by the show is refused even with no npub on the record",
      dn.set_donor_note(r, donor_event={**alice_ev, "pubkey": SHOW}) is None)
r = {"event": {"id": "r"}, "sender_npub": ALICE_NPUB}
check("id only attaches as 'id' without donor_event",
      dn.set_donor_note(r, donor_note_id="z" * 64, donor_match="npub") == "id" and "donor_event" not in r
      and r["donor_note_id"] == "z" * 64)
r = {"event": {"id": "r"}}
check("mismatched id + event is refused", dn.set_donor_note(r, donor_event=alice_ev, donor_note_id="q" * 64) is None)

print("boost_wall record shape")
row = {"payment_hash": "p" * 64, "total_sats": "1000.0", "sender_npub": ALICE_NPUB, "episode_num": "019",
       "source": "fountain_boost", "settled_at": "2026-10-14T13:46:40Z", "message": "thanks\\nfor the show",
       "show_level": "False", "app": "Fountain"}
show_ev = {"id": "s" * 64, "pubkey": SHOW, "kind": 1, "created_at": T0 + 300, "tags": [], "content": "🎙️"}
w = boost_wall.build_record(show_ev, info=row, standalone_id="t" * 64,
                            donor={"donor_event": alice_ev, "donor_note_id": alice_ev["id"], "donor_match": "npub+message"})
check("event is always present and is the show note", w["event"] is show_ev)
check("sats accepts a float string", w["sats"] == 1000)
check("message rides on the meta, verbatim", w["message"] == "thanks\\nfor the show")
check("donor fields present", w["donor_event"] is alice_ev and w["donor_note_id"] == alice_ev["id"] and w["donor_match"] == "npub+message")
w2 = boost_wall.build_record(show_ev, info=row, standalone_id="t" * 64)
check("no donor → no donor fields at all", not any(k in w2 for k in boost_wall.DONOR_FIELDS))
wall = {}
boost_wall.upsert(wall, w)
boost_wall.upsert(wall, w2)
check("upsert from a writer that knows no donor preserves the donor fields",
      wall[show_ev["id"]]["donor_event"] is alice_ev)
boost_wall.upsert(wall, boost_wall.build_record(show_ev))
check("…and an event-only upsert preserves the meta too", wall[show_ev["id"]]["sats"] == 1000)

print("sort")
a = {"event": {"id": "a", "created_at": 100}, "settled_at": "2026-10-14T13:46:40Z"}   # T0
b = {"event": {"id": "b", "created_at": 999}}                                        # bare, created_at 999
c = {"event": {"id": "c", "created_at": 50}, "settled_at": "2026-10-14T13:50:00Z"}    # later settle
order = [r["event"]["id"] for r in sorted([a, b, c], key=boost_wall.sort_key)]
check("settled_at ranks a payment record, created_at only the bare ones", order == ["c", "a", "b"])

print("attach_donor_notes (offline: no index, no fetch)")
wall = {"s1": {"event": {"id": "s1", "pubkey": SHOW, "created_at": T0}, "payment_hash": "ph1",
               "sender_npub": ALICE_NPUB, "settled_at": "2026-10-14T17:46:40Z", "source": "fountain_boost"}}
pe = {"ph1": {"event_id": "ours", "donor_note_id": "k" * 64, "donor_match": "npub"}}
rows = {"ph1": {"payment_hash": "ph1", "message": "great episode", "total_sats": "1000"}}
st = dn.attach_donor_notes(wall, pe, rows, None, set_donor_note=dn.set_donor_note, fetch=False, log=lambda *a: None)
check("ledger message is copied onto a record that lacks it", wall["s1"]["message"] == "great episode" and st["message_filled"] == 1)
check("a known id with no fetch attaches as id only", wall["s1"]["donor_note_id"] == "k" * 64 and "donor_event" not in wall["s1"] and st["id_only"] == 1)
check("index unavailable is counted, not treated as no match",
      dn.attach_donor_notes({"s2": {"event": {"id": "s2"}, "payment_hash": "ph2", "settled_at": "2026-10-14T17:46:40Z"}},
                            {}, {}, None, set_donor_note=dn.set_donor_note, fetch=False, log=lambda *a: None)["unmatched"]["index unavailable"] == 1)

print("decide match_out")
out = {}
d, why = cov.decide(info(ALICE_NPUB, msg="thanks for the great show"),
                    [rec("x", ALICE, ALICE_NPUB, msg="thanks for the great show")], T0 + 100, set(), match_out=out)
check("skip on an index match hands the record back", d == "skip" and out.get("record", {}).get("id") == "x" and out["how"] == "npub+message")
out = {}
d, why = cov.decide({**info(ALICE_NPUB), "share_status": "published", "share_note_id": "n" * 64}, [], T0 + 100, match_out=out)
check("a receipt skip leaves match_out empty (the share note is handled by the caller)", d == "skip" and not out)
d, why = cov.decide(info(ALICE_NPUB), [], T0 + 100)
check("return shape unchanged without match_out", d == "hold")

print("topboosts prefers the donor's note")
spec = importlib.util.spec_from_file_location(
    "lb_leaderboards", HERE.parent / "leaderboards" / "local_bitcoiners_leaderboards.py")
lb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lb)
pe = {"p1": {"event_id": "ours1", "donor_note_id": "theirs1", "donor_pubkey": ALICE},
      "p2": {"event_id": "ours2"}}
got = lb.tb_resolve_event_ids([{"payment_hash": "p1", "sats": 1}, {"payment_hash": "p2", "sats": 1}, {"payment_hash": "p3", "sats": 1}], pe, {})
check("donor note + donor author when recorded", got["p1"] == ("theirs1", ALICE))
check("falls back to our standalone with no author (→ the show)", got["p2"] == ("ours2", None))
check("unknown hash is still skipped", "p3" not in got)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all ok")
