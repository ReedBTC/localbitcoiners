#!/usr/bin/env python3
"""Offline regression test for the donor-note rules (shared/donor_notes.py)
and the wall fields they feed (boost-publisher/boost_wall.py).

Pins the rules that keep a note from being shown under the wrong name:
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

print("rule 5: a Fountain note says what the boost said")
TRAILER = ("https://fountain.fm/episode/My7odT0MuyDuyh3Y3fw8\\n\\nnostr:nevent1qvzqqqpxqupzpwrxeemtukuzv62esqjgxg4c"
           "maxrs9sgl7j6tdrufuaturv0wea9qqs0d5l4rgmnfczamq7k0wtxu3vgkx7uqav7f9w0pqpl232ks5h076spvtc3v")
check("ledger text: literal \\n folded, Fountain trailer dropped, casefolded",
      dn.donor_text("Gang  gang\\n\\n" + TRAILER) == "gang gang")
check("ledger placeholder is empty", dn.donor_text("*no comment with boost*") == "" and dn.donor_text(None) == "")
check("note text: real newlines + trailer", dn.donor_text("Gang gang\n\n" + TRAILER.replace("\\n", "\n")) == "gang gang")
check("both empty agree", dn.comment_agrees("*no comment with boost*", TRAILER.replace("\\n", "\n")))
check("a comment against an empty note disagrees (Lakesurfer 500)", not dn.comment_agrees("Ausome entropy", ""))
check("a different comment disagrees (Bullish / Voicemails)", not dn.comment_agrees("Bullish", "Voicemails sound fun"))
check("a wrapped comment agrees (BoostMeBitch note)", dn.comment_agrees("Test boost", "⚡ Boost ⚡\n\nTest boost\n\nBoosted 121 sats"))
check("an empty comment against a note with text disagrees", not dn.comment_agrees("", "hello there"))
# Lakesurfer: 500 sats with a comment at T0, 2000 sats without at T0+121; the
# donor's only note (empty) is the 2000's. The 500 must not take it first.
lake = [rec("e", ALICE, ALICE_NPUB, ts=T0 + 125, sats=2000, msg="")]
consumed = set()
m, how, why = dn.index_match(lake, info(ALICE_NPUB, sats=500, msg="Ausome entropy to my bitcoin content"), T0, consumed)
check("rule 5: the empty note is refused for the boost with a comment", m is None and "carries the comment" in why and not consumed)
m, how, why = dn.index_match(lake, info(ALICE_NPUB, sats=2000, msg="*no comment with boost*"), T0 + 121, consumed)
check("…and attaches to the boost without one, as npub", m and m["id"] == "e" and how == "npub")
# Ep 018: same sats, different text, four minutes apart.
voice = [rec("v", ALICE, ALICE_NPUB, ts=T0 + 277, sats=111, msg="Voicemails sound fun. Maybe someone can cook something up")]
m, how, why = dn.index_match(voice, info(ALICE_NPUB, sats=111, msg="Bullish"), T0, set())
check("rule 5: a same-size note with a different comment is refused", m is None)
m, how, how_ = dn.index_match(voice, info(ALICE_NPUB, sats=111, msg="Voicemails sound fun. Maybe someone can cook something up"), T0 + 274, set())
check("…and the note goes to the boost that said it", m and m["id"] == "v" and how == "npub+message")
# Two passing notes are still a burst (rule 4), not a coin flip.
two = [rec("p", ALICE, ALICE_NPUB, ts=T0 + 10, msg=""), rec("q", ALICE, ALICE_NPUB, ts=T0 + 400, msg="")]
m, how, why = dn.index_match(two, info(ALICE_NPUB, msg=None), T0, set())
check("two empty notes for an empty boost → ambiguous (burst)", m is None and why.startswith("ambiguous"))
# A website boost is exempt: its share note never carries the message.
m, how, why = dn.index_match([rec("w", ALICE, ALICE_NPUB, msg="Just boosted 1000 sats for Ep. 3")],
                             {**info(ALICE_NPUB, msg="great show"), "source": "website"}, T0, set())
check("website boosts are not held to rule 5", m and m["id"] == "w")
check("donor_from_index_record refuses a Fountain record whose msg disagrees, offline",
      dn.donor_from_index_record(rec("z", ALICE, ALICE_NPUB, msg="other"), info(ALICE_NPUB, msg="Bullish"), "npub", relays=[]) is None)

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

print("rule 4 bursts: pair_burst / note_episode")
R = [("r1", "001", "fid1", 100), ("r2", "002", "fid2", 160), ("r3", "003", "fid3", 220)]
N = [("n1", "001", "fid1", 90, None), ("n2", "002", None, 150, None), ("n3", "003", "fid3", 210, None)]
pairs, left = dn.pair_burst(R, N)
check("one note per episode pairs by fountain id or episode number", pairs == {"r1": "n1", "r2": "n2", "r3": "n3"} and not left)
pairs, left = dn.pair_burst(R, [("n1", "001", "fid1", 90, None), ("n9", "009", None, 95, None), ("nx", None, None, 99, "guid says Ep 002, text says Ep 003")])
check("a note naming an episode no record has, and a self-contradicting note, are left out and named",
      pairs == {"r1": "n1"} and {w for w, _, _ in left} == {"note", "record"} and len(left) == 4)
pairs, left = dn.pair_burst(R, [("a", None, None, 95, None), ("b", None, None, 155, None)])
check("no note names an episode → plain time order, leftover record listed", pairs == {"r1": "a", "r2": "b"} and left == [("record", "r3", "more records than notes (time order)")])
pairs, left = dn.pair_burst([("r1", "001", "f", 100), ("r1b", "001", "f", 200)], [("n1", "001", None, 190, None), ("n0", "001", None, 90, None)])
check("time order inside one episode", pairs == {"r1": "n0", "r1b": "n1"})
gi = {"g2": {"fountain_id": "fid2", "title": "002. Second"}}
ev = {"content": "Just boosted ⚡ 100 sats to nostr:x for Ep. 2", "tags": [["i", "podcast:item:guid:g2"]]}
check("note_episode: guid via the RSS index agrees with the text", dn.note_episode(ev, gi) == ("002", "fid2", None))
ev["content"] = "Just boosted ⚡ 100 sats for Ep. 3"
check("note_episode: guid vs text disagreement is a contradiction", dn.note_episode(ev, gi)[2] == "guid says Ep 002, text says Ep 003")
check("note_episode: text alone when the guid is unknown", dn.note_episode({"content": "for Ep. 7", "tags": []}, gi) == ("007", None, None))

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

print("rule 6: a keysend with no npub pairs on sats + app + episode")
REED = "32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a"
EP33 = "The Succession of Bitcoin Culture | Ep. 033"
BMB_NOTE = ("⚡ Boost ⚡\n\n#40hpw\n\nReed boosted 100 sats → Local Bitcoiners\n📻 " + EP33)


def krec(id_, pk=REED, ts=T0 + 8, sats=100, msg=BMB_NOTE, app="boostmebuddy", title=EP33):
    r = rec(id_, pk, None, ts, sats, msg)
    r["client_app"] = {"id": app, "via": None}
    r["episode"] = {"guid": "g", "title": title, "num": None}
    return r


def kinfo(msg="#40hpw", sats=100, app="BoostMeBuddy", ep="033", **kw):
    d = {"sender_npub": None, "total_sats": sats, "message": msg, "episode_number": ep,
         "settled_at": "2026-10-24T23:26:58Z", "source": "keysend", "app": app}
    d.update(kw)
    return d


# The 2026-10-24 case: "#40hpw" is under the 12-char floor, so find_match says sats.
m, how, why = dn.index_match([krec("k")], kinfo(), T0, set())
check("short message + app + episode attributes as sats+app", m and m["id"] == "k" and how == dn.APP_TIER)
m, how, why = dn.index_match([krec("k", app="fountain")], kinfo(), T0, set())
check("a different app does not", m is None and how == "sats")
m, how, why = dn.index_match([krec("k", title="Some Other Episode | Ep. 032")], kinfo(), T0, set())
check("a different episode does not", m is None)
m, how, why = dn.index_match([krec("k", title="Untitled")], kinfo(), T0, set())
check("a note naming no episode does not (equality, not absence of conflict)", m is None)
m, how, why = dn.index_match([krec("k")], kinfo(ep=None), T0, set())
check("a payment naming no episode does not", m is None)
m, how, why = dn.index_match([krec("k", sats=101)], kinfo(), T0, set())
check("sats are exact", m is None)
m, how, why = dn.index_match([krec("k")], kinfo(msg="#bitcoin"), T0, set())
check("a short message the note lacks does not", m is None)
m, how, why = dn.index_match([krec("k", ts=T0 + 2000)], kinfo(), T0, set())
check("outside the window does not", m is None)
m, how, why = dn.index_match([krec("k", pk=BOT)], kinfo(), T0, set())
check("a publisher's note never does", m is None)
m, how, why = dn.index_match([krec("k")], kinfo(show_level=True), T0, set())
check("a show-level payment does not", m is None)
m, how, why = dn.index_match([krec("k")], kinfo(sender_npub=ALICE_NPUB), T0, set())
check("a payment with an npub is rules 2–5's, not rule 6's", m is None or how != dn.APP_TIER)
m, how, why = dn.index_match([krec("k"), krec("j", pk=BOB, ts=T0 + 30)], kinfo(), T0, set())
check("two passing notes are ambiguous and go to review",
      m is None and how == dn.APP_TIER and why.startswith("ambiguous"))
m, how, why = dn.index_match([krec("k", msg="ChadF and 33 others boosted 100 sats → Local Bitcoiners\n📻 " + EP33)],
                             kinfo(msg=""), T0, set())
check("a payment with no message pairs on sats + app + episode alone", m and how == dn.APP_TIER)
consumed = {"k"}
m, how, why = dn.index_match([krec("k")], kinfo(), T0, consumed)
check("a consumed note is not reused", m is None)

print("rule 6: mentions")
NOTE = ("⚡ Boost ⚡\n\nYou already know nostr:npub1z9hy7a0n8zxnhgrcew2nnkr4sx6sum07exve99pqq30leujye3usgd858n "
        "from nostr:npub1kqrddzzl6xng2wn0n0eyyjnf6smwmtp8m5atetzjw7vqyngwrphs4ye5xu tune in to learn more "
        "about his Bitcoin meetup!\n\nReed boosted 100 sats → Local Bitcoiners")
LEDGER = "You already know @Business Cat from @Rock Paper Bitcoin tune in to learn more about his Bitcoin meetup!"
check("@Name in the ledger matches a nostr: mention in the note", dn.message_in_note(LEDGER, NOTE))
check("…but not when the words around it differ",
      not dn.message_in_note(LEDGER.replace("learn more", "hear more"), NOTE))
check("…and not without a mention in the note",
      not dn.message_in_note(LEDGER, NOTE.replace("nostr:npub1kqrddzzl6xng2wn0n0eyyjnf6smwmtp8m5atetzjw7vqyngwrphs4ye5xu", "Rock")))
check("plain containment still holds", dn.message_in_note("#40hpw", BMB_NOTE))
check("no payment message is no constraint", dn.message_in_note("", "anything"))

print("rule 6: the live path")
d = dn.donor_from_index_record(krec("k"), kinfo(), "sats", records=None)
check("without the index a sats match still does not attribute", d is None)
_fetch = dn.fetch_event
dn.fetch_event = lambda *a, **k: None
try:
    d = dn.donor_from_index_record(krec("k"), dict(kinfo(), settled_at="2026-10-24T23:26:58Z"),
                                   "sats", records=[dict(krec("k"), ts=dn._ts("2026-10-24T23:26:58Z") + 8)])
    check("with the index it attributes as sats+app", d and d["donor_match"] == dn.APP_TIER and d["donor_note_id"] == "k")
finally:
    dn.fetch_event = _fetch


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
