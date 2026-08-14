#!/usr/bin/env python3
"""profiles.json — every npub the website displays, resolved once, daily.

The site paints a name and an avatar next to almost every number it shows: the
boost wall, /supporters, /stats, the homepage. Until now each of those resolved
kind-0s live in the browser — a batched Primal `user_infos` call (1.3–1.7 s)
with a relay ladder behind it, duplicated across three implementations. Since
boost_wall.json cut the thread fetch to ~270 ms, that profile round trip IS the
page load. This file is the same corpus pre-resolved, shaped so the site can
paint from cache and keep the live ladder only for what's missing.

Shape: an OBJECT keyed by hex pubkey (the site's own caches are keyed by hex,
and a map spares the client indexing 150 records on every load):

    { "<hex>": { "npub": "npub1…", "name": "…", "picture": "https://…",
                 "nip05": "…", "created_at": 1786684271,
                 "event": { …the full signed kind-0… } } }

The parsed fields let the site paint immediately; the raw signed event is there
so the file is checkable rather than trusted, same as boost_wall.json. `name`
prefers display_name over name; `picture`/`nip05` are omitted when the profile
doesn't carry them, and a pubkey with no kind-0 anywhere is omitted ENTIRELY
rather than written as an empty record — the site falls back to a truncated
npub for those, and an empty record is indistinguishable from a profile whose
fields are genuinely blank.

Why both a relay pass and Primal: partial coverage buys the site nothing. The
browser call is one batched round trip, so trimming the pubkey set 60% cut it
only ~15% — any source below 100% leaves the live ladder in place and saves no
time. Measured 2026-08-14 over the 153-npub set, relays cap out at 145 (95%),
and 7 of the 8 stragglers are in Primal's cache. So this queries both, and the
one profile that remains has no kind-0 anywhere to find.

Read-only against relays, Primal, the RSS feed and every local data file.
Writes exactly one file, data/profiles.json, and pushes only with --push.
Signs nothing and publishes nothing.
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path

_BOTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BOTS_ROOT / "shared"))
sys.path.insert(0, str(_BOTS_ROOT / "follow-packs"))
from collector_common import (  # noqa: E402
    fetch_events_by_authors, fetch_primal_user_infos, push_file_to_vps,
    verify_raw_event,
)
from nostr_utils import hex_to_npub, load_config, npub_to_hex  # noqa: E402
# The two hand-maintained rosters that aren't derivable from any data file.
# Imported rather than re-listed so there is one copy on the bot side: this is
# where Reed already keeps them in sync with assets/js/supporters.js, and a
# second copy here would drift silently the first time a contributor is added.
from local_bitcoiners_followpacks import (  # noqa: E402
    CODING_CONTRIBUTORS, CO_HOSTS, RSS_FEED, compute_guests,
)

CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
REPO_ROOT        = _BOTS_ROOT.parent
DATA_DIR         = REPO_ROOT / "data"
PROFILES_FILE    = "profiles.json"
PROFILES_PATH    = DATA_DIR / PROFILES_FILE
SATS_CSV         = DATA_DIR / "sats.csv"
WALL_PATH        = DATA_DIR / "boost_wall.json"
VPS_KEY_FILE     = Path.home() / ".ssh" / "relay_mynostr_ed25519"

# Kind-0 coverage of the site's npub set, measured 2026-08-14:
#   nos.lol 145/153 (95%), nostr.mom 127, relay.damus.io 110,
#   relay.ditto.pub 97, relay.primal.net 41 — union of all five: 145.
# nos.lol alone accounts for the whole union today, so the other four are
# redundancy rather than coverage; they're kept because they cost one
# concurrent socket each and nos.lol being down would otherwise take the file
# from 95% to nothing. relay.fountain.fm is deliberately ABSENT from this list
# (it's in NOSTR_RELAYS and carries the boosts) — it serves no kind 0 at all,
# so querying it here is a guaranteed-empty socket.
PROFILE_RELAYS = [
    "wss://nos.lol",
    "wss://nostr.mom",
    "wss://relay.damus.io",
    "wss://relay.ditto.pub",
    "wss://relay.primal.net",
]

NPUB_RE = re.compile(r"npub1[02-9ac-hj-np-z]{58}")


# ── the npub set ─────────────────────────────────────────────────────────────
def collect_npubs():
    """Every npub the site displays anywhere, as {npub: [source, ...]}.

    Derived here rather than read from a list the website publishes, so a new
    supporter is covered by the next nightly run with nothing to redeploy on
    either side. The four sources are the four places the site gets an identity
    from; they overlap heavily (the wall's mentions are almost entirely
    supporters already), which is why the union is ~153 and not ~350."""
    found = {}

    def add(npub, source):
        found.setdefault(npub, []).append(source)

    # 1. Everyone who has ever sent sats. Zaps live here too (they were merged
    #    into sats.csv as source="zap" rows), so zaps.csv adds nothing.
    if SATS_CSV.exists():
        with SATS_CSV.open() as fh:
            for row in csv.DictReader(fh):
                n = (row.get("sender_npub") or "").strip()
                if NPUB_RE.fullmatch(n):
                    add(n, "sats.csv")
    else:
        print(f"  [warn] {SATS_CSV} missing — supporters will be under-covered")

    # 2. The boost wall: who sent each boost, plus everyone MENTIONED in the
    #    note text. The mentions matter — the wall renders `nostr:npub1…` inside
    #    a boost message as a name, so an unresolved one shows as raw bech32.
    if WALL_PATH.exists():
        try:
            wall = json.loads(WALL_PATH.read_text())
        except Exception as e:
            print(f"  [warn] {WALL_PATH.name} unreadable ({e})")
            wall = []
        for rec in wall if isinstance(wall, list) else []:
            n = (rec.get("sender_npub") or "").strip()
            if NPUB_RE.fullmatch(n):
                add(n, "wall_sender")
            for m in NPUB_RE.findall((rec.get("event") or {}).get("content") or ""):
                add(m, "wall_mention")
    else:
        print(f"  [warn] {WALL_PATH.name} missing — wall mentions will be under-covered")

    # 3. Show guests, from the [guests: …] marker in the RSS shownotes.
    for n in compute_guests():
        add(n, "rss_guest")

    # 4. The hand-maintained rosters (Reed appears in both).
    for n in CO_HOSTS:
        add(n, "co_host")
    for n in CODING_CONTRIBUTORS:
        add(n, "coder")

    return found


def source_summary(found):
    counts = {}
    for sources in found.values():
        for s in set(sources):
            counts[s] = counts.get(s, 0) + 1
    return counts


# ── resolution ───────────────────────────────────────────────────────────────
def newest_kind0(events, into=None):
    """Fold kind-0s into {hex: event}, newest created_at per pubkey. Relays
    disagree constantly — a stale copy of a profile is exactly what the live
    ladder currently papers over, and it must not be what gets cached."""
    out = dict(into or {})
    for ev in events:
        if ev.get("kind") != 0:
            continue
        pk = ev.get("pubkey")
        if not pk:
            continue
        prev = out.get(pk)
        if not prev or (ev.get("created_at") or 0) > (prev.get("created_at") or 0):
            out[pk] = ev
    return out


def resolve(hexes, relays=PROFILE_RELAYS, use_primal=True):
    """kind-0 per pubkey: relays first, Primal's cache for whatever's left."""
    print(f"  relay pass — {len(hexes)} pubkeys across {len(relays)} relays")
    raw = fetch_events_by_authors(relays, [0], hexes, max_wall_seconds=30,
                                  label="    profiles: ")
    verified = [ev for ev in raw if verify_raw_event(ev)]
    dropped = len(raw) - len(verified)
    if dropped:
        print(f"    [warn] dropped {dropped} event(s) with a bad signature")
    profiles = newest_kind0(verified)
    print(f"    {len(profiles)}/{len(hexes)} resolved from relays")

    missing = [h for h in hexes if h not in profiles]
    if missing and use_primal:
        print(f"  primal pass — {len(missing)} still missing")
        got = fetch_primal_user_infos(missing)
        profiles = newest_kind0(got.values(), into=profiles)
        print(f"    {len(got)} recovered ({len(profiles)}/{len(hexes)} total)")
    elif missing:
        print(f"  primal pass SKIPPED — {len(missing)} left unresolved")
    return profiles


def build_record(ev):
    """One profiles.json value. Parsed fields for painting, raw event for
    checking. A field the kind-0 doesn't carry is omitted, never emitted empty:
    the site's fallback keys off absence, and `"picture": ""` would read as a
    deliberate blank avatar rather than an unknown one."""
    try:
        content = json.loads(ev.get("content") or "{}")
    except Exception:
        content = {}
    if not isinstance(content, dict):
        content = {}
    rec = {"npub": hex_to_npub(ev["pubkey"])}
    name = (content.get("display_name") or content.get("name") or "").strip()
    if name:
        rec["name"] = name
    for src, dst in (("picture", "picture"), ("nip05", "nip05")):
        v = content.get(src)
        if isinstance(v, str) and v.strip():
            rec[dst] = v.strip()
    rec["created_at"] = ev.get("created_at")
    rec["event"] = ev
    return rec


def save(profiles, path=None):
    """Write keyed by hex, keys sorted, so the output is byte-stable across
    runs — an unstable key order would make every push a full-file diff."""
    p = Path(path or PROFILES_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    out = {pk: build_record(ev) for pk, ev in sorted(profiles.items())}
    p.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    return len(out), p.stat().st_size


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--push", action="store_true",
                    help="rsync the rebuilt file to the VPS (default: write locally only)")
    ap.add_argument("--dry-run", action="store_true",
                    help="resolve and report, write nothing")
    ap.add_argument("--no-primal", action="store_true",
                    help="relay pass only (caps at ~95%% coverage — see the docstring)")
    args = ap.parse_args()

    config = load_config(CREDENTIALS_FILE) if CREDENTIALS_FILE.exists() else {}

    print(f"Collecting the site's npub set (RSS guests from {RSS_FEED})\n")
    found = collect_npubs()
    for src, n in sorted(source_summary(found).items(), key=lambda kv: -kv[1]):
        print(f"    {src:<14} {n}")
    print(f"  union: {len(found)} npubs\n")
    if not found:
        print("[error] no npubs collected — refusing to overwrite profiles.json")
        return 1

    hex_by_npub = {n: npub_to_hex(n) for n in found}
    bad = [n for n, h in hex_by_npub.items() if not h]
    for n in bad:
        print(f"  [warn] undecodable npub skipped: {n}")
    hexes = list(dict.fromkeys(h for h in hex_by_npub.values() if h))

    profiles = resolve(hexes, use_primal=not args.no_primal)

    unresolved = [h for h in hexes if h not in profiles]
    pct = len(profiles) / len(hexes) * 100 if hexes else 0
    print(f"\n  {len(profiles)}/{len(hexes)} profiles ({pct:.1f}%), "
          f"{len(unresolved)} with no kind-0 anywhere")
    for h in unresolved:
        print(f"    unresolved: {hex_to_npub(h)}")

    # A relay sweep that comes back near-empty means the network failed, not
    # that 150 people deleted their profiles — don't let it flatten the file.
    if PROFILES_PATH.exists():
        try:
            prev = len(json.loads(PROFILES_PATH.read_text()))
        except Exception:
            prev = 0
        if prev and len(profiles) < prev * 0.5:
            print(f"\n[error] resolved {len(profiles)} vs {prev} already on file — "
                  f"looks like a failed sweep, refusing to overwrite")
            return 1

    if args.dry_run:
        print("\n[dry-run] nothing written")
        return 0

    count, size = save(profiles)
    print(f"\n  wrote {count} profiles ({size / 1024:.0f} KB) → data/{PROFILES_FILE}")
    if args.push:
        push_file_to_vps(config, PROFILES_PATH, PROFILES_FILE, VPS_KEY_FILE)
    else:
        print("  (not pushed — pass --push to send it to the VPS)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
