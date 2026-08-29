#!/usr/bin/env python3
"""Local Bitcoiners — supporter follow packs (following.space kind 39089).

Publishes/refreshes one follow pack (kind 39089) per Supporters-page
category, owned by the show's Nostr account. Mirrors the membership logic in
`assets/js/supporters.js` so the packs match what the page shows. Each pack is
a parameterized-replaceable event keyed by a stable `d` slug — a daily refresh
just republishes with a newer `created_at`. The website's /supporters "Follow
Pack" buttons link to following.space/d/<slug>?p=<show hex> for one-click
follow.

Designed to run once per day, AFTER the sats-log update regenerates
data/sats.json (a separate, later systemd timer — kept out of sats-log itself
so manual/off-cycle stats runs don't publish). Skips republishing a pack whose
member set is unchanged since last run.

This job ONLY publishes the show's own kind-39089 events. It never reads or
writes any user's kind-3 follow list. See bots/follow-packs-spec.md.

Starts DRY_RUN = True — never flip to False without explicit instruction; this
signs and publishes from the show account.
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import (
    load_config, publish_to_nostr, write_dry_run_event, npub_to_hex,
    get_outbox_relays, NOSTR_RELAYS,
)
from pynostr.key import PrivateKey

DRY_RUN = False   # LIVE — publishes kind-39089 packs from the show account

CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
REPO_ROOT        = Path(__file__).resolve().parent.parent.parent
SATS_JSON        = REPO_ROOT / "data" / "sats.json"
STATE_FILE       = Path(__file__).resolve().parent / "state.json"
RSS_FEED         = "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU"

# The show account that owns the packs. Same key the boost-publisher signs with
# (NSEC_LOCAL_BITCOINERS → this hex); the website's ?p= link uses the hex, so
# the pack owner and the link MUST match. Asserted against the signing key at
# runtime before anything publishes.
SHOW_NPUB  = "npub1cvcgs83gw6pcrhvtmlf8gdqaegx93qkznwry96jteqhh2cexgkfq45rtya"
SHOW_HEX   = "c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592"
PACK_IMAGE = "https://localbitcoiners.com/assets/LocalBitcoiners.png"

# Hosts (Reed + Rev) are NO LONGER excluded from the booster tiers — they rank
# by what they've boosted, same as any supporter (mirrors supporters.js, which
# dropped the host exclusion 2026-06-11; Reed asked to be included in the packs).

# Coding contributors — hardcoded, mirrors CODING_CONTRIBUTORS in supporters.js.
# Reed maintains this by hand; keep in sync with the website list.
CODING_CONTRIBUTORS = [
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",  # Reed
    "npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7",  # Chad Farrow
]

# Co-hosts (Reed + Rev). They host every episode, so they're never episode
# "[guests: …]" in the RSS — but they belong in the Show Guests pack. Added via
# this hand-maintained list, unioned with the RSS-derived guests (co-hosts
# first). Mirror any co-host handling the website adds to its guests display so
# the /supporters page and this pack stay in sync.
CO_HOSTS = [
    "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",  # Reed
    "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",  # Rev
]

# Minimum lifetime sats to enter the bottom tier — and therefore to appear in
# any pack on boost/stream/zap history alone. Raised from 1 to 100 so a single
# token sat doesn't earn a place in the packs the website reads for supporter
# status. Nobody already published is dropped by this: see the grandfathering
# in compute_tier_members(). The website's own TIERS in supporters.js keeps its
# floor of 1 on purpose — /supporters displays everyone who has ever boosted;
# this is only about pack membership.
ENTRY_TIER_MIN_SATS = 100

# Booster tier floors (inclusive), highest first — a supporter lands in the
# first tier they clear, by lifetime total_sats (boosts + streams).
#
# RETIRED AS PUBLISHED PACKS 2026-08: /supporters became one ranked wall and
# dropped the 100k/69k/21k tiers, so the site now reads only lb-supporters-all
# and lb-supporters-guests (assets/js/supporter-set.js). These floors are still
# evaluated because ALL_PACK is the union of every category — the tiers are how
# "everyone at or above ENTRY_TIER_MIN_SATS" gets enumerated. Don't delete them
# thinking they're dead: doing so empties the all-supporters pack, which gates
# /feeds and community-status.js. supporters.js no longer mirrors these floors,
# so there is nothing left to keep in sync with it.
TIER_PACKS = [
    (100000,              "lb-supporters-100k",  "Local Bitcoiners — 100k+ Boosters & Streamers"),
    (69000,               "lb-supporters-69k",   "Local Bitcoiners — 69k+ Boosters & Streamers"),
    (21000,               "lb-supporters-21k",   "Local Bitcoiners — 21k+ Boosters & Streamers"),
    (ENTRY_TIER_MIN_SATS, "lb-supporters-other", "Local Bitcoiners — All Other Boosters & Streamers"),
]

GUESTS_PACK = ("lb-supporters-guests", "Local Bitcoiners — Show Guests")
# Also retired 2026-08 as a published pack. CODING_CONTRIBUTORS still feeds
# ALL_PACK, so Reed and Chad stay in the supporter set even though no coder
# pack ships any more.
CODERS_PACK = ("lb-supporters-coders", "Local Bitcoiners — Coding Contributors")
# Combined pack: the union of every category above — one-click "follow every
# Local Bitcoiners supporter". Built from the same sources, deduped by hex, so
# it always mirrors whatever the per-category packs contain.
ALL_PACK    = ("lb-supporters-all", "Local Bitcoiners — All Supporters")

# State key holding the entry-floor grandfather roster — see compute_tier_members.
GRANDFATHER_KEY = "entry_grandfathered"

# Refresh a pack this many days after its last publish even when its membership
# hasn't moved. kind-39089 is addressable, so a pack only needs one event on a
# relay — but relays prune, and a pack that only republishes on change can sit
# untouched for weeks and quietly decay off one (lb-supporters-guests went
# missing from relay.primal.net exactly this way while healthy on four others).
# Until the set comparison in process_pack was fixed, the all-supporters pack's
# member order churned daily and republished it as an accidental keepalive;
# this is that keepalive made deliberate and cheap.
REPUBLISH_AFTER_DAYS = 14

# Slugs retired 2026-08 whose kind-39089 events are still standing on the
# relays advertising stale membership. Each is republished ONCE with no p-tags
# to clear it; after that its state entry is [], process_pack sees no change and
# skips it forever. Keep the list — it costs one no-op comparison a day and
# re-clears the pack if a relay ever misses the empty event.
RETIRED_PACKS = [
    (TIER_PACKS[0][1], TIER_PACKS[0][2]),
    (TIER_PACKS[1][1], TIER_PACKS[1][2]),
    (TIER_PACKS[2][1], TIER_PACKS[2][2]),
    (TIER_PACKS[3][1], TIER_PACKS[3][2]),
    CODERS_PACK,
]

NPUB_RE   = re.compile(r"^npub1[02-9ac-hj-np-z]{58}$")
GUESTS_RE = re.compile(r"\[guests:\s*([^\]]+)\]", re.IGNORECASE)


# ── state ────────────────────────────────────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── membership ───────────────────────────────────────────────────────────────
def load_sats_rows():
    data = json.loads(SATS_JSON.read_text())
    return data["rows"] if isinstance(data, dict) else data


ZAP_MIN_SATS = 100  # min lifetime zap total for an npub to earn tier credit from zaps

def compute_tier_members(rows, state=None):
    """{tier_slug: [npub, ...]} — lifetime total_sats per sender_npub (boosts +
    streams + zaps); name-only (no npub) supporters omitted. Hosts (Reed/Rev)
    are included by what they've boosted, mirroring supporters.js. Each npub
    lands in the first tier it clears.

    Zap rows (source == 'zap') are accumulated separately and only added to an
    npub's total when their aggregate zap sats reach ZAP_MIN_SATS — prevents
    single tiny zaps from qualifying someone for the entry-level tier.

    `state` (optional) is the published-pack state, used to grandfather the
    ENTRY_TIER_MIN_SATS raise: the floor applies going forward, but nobody who
    was already published into the entry pack is removed for falling under it.
    Graduation still wins — a grandfathered member who later clears a higher
    tier moves up rather than being held in both."""
    totals = {}
    zap_totals = {}
    for r in rows:
        npub = (r.get("sender_npub") or "").strip()
        if not npub:
            continue
        try:
            sats = int(r.get("total_sats") or 0)
            if r.get("source") == "zap":
                zap_totals[npub] = zap_totals.get(npub, 0) + sats
            else:
                totals[npub] = totals.get(npub, 0) + sats
        except (TypeError, ValueError):
            continue

    for npub, zap_sats in zap_totals.items():
        if zap_sats >= ZAP_MIN_SATS:
            totals[npub] = totals.get(npub, 0) + zap_sats

    packs = {slug: [] for _, slug, _ in TIER_PACKS}
    for npub, total in totals.items():
        for floor, slug, _ in TIER_PACKS:   # highest first
            if total >= floor:
                packs[slug].append(npub)
                break

    # Grandfather the entry-floor raise. Anyone the entry pack had already
    # published stays in it even if their lifetime total is now under
    # ENTRY_TIER_MIN_SATS — the floor governs who gets in from here on, not who
    # gets removed. Members already placed in a tier this run are skipped, so a
    # grandfathered supporter who has since climbed to a higher tier graduates
    # normally instead of appearing twice.
    #
    # The roster lives in its own state key. It used to be read straight off
    # state["lb-supporters-other"]["members"], but that pack was retired in
    # 2026-08 and then CLEARED (published empty), which would have zeroed the
    # roster as a side effect of an unrelated publish. GRANDFATHER_KEY is seeded
    # once from that pack's last-published members and is never written by
    # process_pack.
    if state:
        entry_slug = TIER_PACKS[-1][1]
        if GRANDFATHER_KEY not in state:
            state[GRANDFATHER_KEY] = list(
                (state.get(entry_slug) or {}).get("members") or []
            )
            print(f"  [{GRANDFATHER_KEY}] seeded with "
                  f"{len(state[GRANDFATHER_KEY])} hex(es) from {entry_slug}")
        prev_hexes = set(state.get(GRANDFATHER_KEY) or [])
        if prev_hexes:
            placed = set()
            for members in packs.values():
                for npub in members:
                    h = npub_to_hex(npub)
                    if h:
                        placed.add(h)
            kept = 0
            for npub in totals:
                h = npub_to_hex(npub)
                if h and h in prev_hexes and h not in placed:
                    packs[entry_slug].append(npub)
                    kept += 1
            if kept:
                print(f"  [{entry_slug}] grandfathered {kept} member(s) below the "
                      f"{ENTRY_TIER_MIN_SATS}-sat floor (already published)")
    return packs


def compute_guests():
    """Union of [guests: npub…] across all RSS items. Same parse as
    functions/api/guests.js / _middleware.js parseGuests."""
    out = []
    try:
        rss = requests.get(RSS_FEED, timeout=15).text
    except Exception as e:
        print(f"  [warn] RSS fetch for guests failed: {e}")
        return out
    for blob in GUESTS_RE.findall(rss):
        for tok in blob.split(","):
            tok = tok.strip()
            if NPUB_RE.match(tok):
                out.append(tok)
    return out


# ── event build ──────────────────────────────────────────────────────────────
def pack_tags(slug, title, member_npubs):
    """Build the kind-39089 tag list. p-tags are hex, deduped, order-stable;
    npubs that fail to decode are dropped. Returns (tags, member_hexes)."""
    tags = [
        ["d", slug],
        ["title", title],
        ["image", PACK_IMAGE],
    ]
    seen, hexes = set(), []
    for npub in member_npubs:
        h = npub_to_hex(npub)
        if h is None:
            print(f"    [warn] dropping undecodable npub: {npub[:16]}…")
            continue
        if h in seen:
            continue
        seen.add(h)
        hexes.append(h)
    for h in hexes:
        tags.append(["p", h])
    return tags, hexes


# ── publish ──────────────────────────────────────────────────────────────────
def _days_since(stamp):
    """Whole days since an ISO-8601 published_at, or None if absent/unparseable
    (treated as stale so the pack gets one refresh and a fresh timestamp)."""
    if not stamp:
        return None
    try:
        when = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    return max(0, (datetime.now(timezone.utc) - when).days)


def process_pack(slug, title, member_npubs, nsec, relays, state):
    """Publish/refresh one pack unless its member set is unchanged. Returns True
    if it published (or would have, in dry-run).

    Empty handling: a pack that computes to no members is skipped ONLY if it was
    never published. If it previously HAD members and is now empty — e.g. a tier
    that emptied when its last member graduated to a higher tier — it's
    republished with no p-tags to CLEAR the now-stale members; otherwise the old
    event keeps advertising people who no longer belong to that tier. (A tier
    that still has members after a graduation already self-corrects: its set
    changed, so it republishes without the graduate. Only the emptied case
    slipped through.) The website hides an empty-pack section on its own."""
    tags, hexes = pack_tags(slug, title, member_npubs)
    prev = (state.get(slug) or {}).get("members") or []

    # Compare as SETS. hexes is ordered by however the union was assembled,
    # which churns with sats.json row order, so an ordered compare republished
    # the all-supporters pack daily on an identical member set.
    if set(hexes) == set(prev):
        # An empty pack is never refreshed — there is nothing to keep alive, and
        # a cleared retired pack must stay a no-op forever.
        age = _days_since((state.get(slug) or {}).get("published_at"))
        if not hexes:
            print(f"  [{slug}] unchanged (empty) — skipping republish")
            return False
        if age is not None and age < REPUBLISH_AFTER_DAYS:
            print(f"  [{slug}] unchanged ({len(hexes)} members, published "
                  f"{age}d ago) — skipping republish")
            return False
        stale = "never dated" if age is None else f"{age}d ago"
        print(f"  [{slug}] unchanged ({len(hexes)} members) but last published "
              f"{stale} — refreshing to keep it on the relays")

    if not hexes:
        print(f"  [{slug}] now empty — republishing with no members to clear "
              f"{len(prev)} stale member(s)")
    else:
        print(f"  [{slug}] {title}")
        print(f"           {len(hexes)} members"
              + (f"  (+{len(hexes) - len(prev)})" if prev else "  (new pack)"))

    if DRY_RUN:
        path, event_id = write_dry_run_event(
            "", nsec, prefix="followpack", extra_tags=tags, suffix=slug, kind=39089,
        )
        print(f"           [dry-run] → {path}")
    else:
        event_id = publish_to_nostr("", nsec, relays=relays, extra_tags=tags, kind=39089)
        if not event_id:
            print(f"           [error] publish failed — leaving state unchanged")
            return False
        state[slug] = {
            "members":      hexes,
            "event_id":     event_id,
            "title":        title,
            "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    return True


def main():
    config = load_config(CREDENTIALS_FILE)
    nsec   = config.get("NSEC_LOCAL_BITCOINERS")
    if not nsec:
        print("[error] NSEC_LOCAL_BITCOINERS missing from config — aborting")
        return

    # Refuse to publish from the wrong key: the website's ?p= link is hardcoded
    # to SHOW_HEX, so a pack signed by any other key would be unreachable.
    signing_hex = PrivateKey.from_nsec(nsec).public_key.hex()
    if signing_hex != SHOW_HEX:
        print(f"[error] signing key {signing_hex[:12]}… != show account "
              f"{SHOW_HEX[:12]}… — aborting so packs aren't published under the "
              f"wrong pubkey (would break the website ?p= link)")
        return

    if DRY_RUN:
        print("[dry-run] building pack previews — will NOT publish or save state\n")

    rows  = load_sats_rows()
    state = load_state()

    # Publish target: the show's own outbox (NIP-65) unioned with NOSTR_RELAYS,
    # so packs land on the show's relays plus the broad defaults. Measured
    # 2026-08-12: nos.lol, relay.ditto.pub and nostr.mom each hold all 7 of our
    # packs; relay.damus.io, purplepag.es and relay.nostr.band hold none — the
    # first three only reach us through NOSTR_RELAYS, not through the outbox.
    # publish_to_nostr drops the kind-1-only relays (fountain) for kind 39089.
    outbox = get_outbox_relays(SHOW_HEX) or []
    relays = list(dict.fromkeys(outbox + NOSTR_RELAYS))

    tier_members = compute_tier_members(rows, state)
    # Co-hosts first, then the RSS-derived episode guests (deduped by npub).
    guests       = list(dict.fromkeys(CO_HOSTS + compute_guests()))
    coders       = list(CODING_CONTRIBUTORS)

    print(f"Source: {len(rows)} sats.json rows | {len(guests)} guest npubs | "
          f"{len(coders)} coders | relays: {len(relays)}\n")

    # Everyone across every category, deduped by hex in pack_tags — mirrors the
    # union feeds.js already computes from the per-category packs.
    all_members = list(guests) + list(coders)
    for _, slug, _ in TIER_PACKS:
        all_members += tier_members.get(slug, [])

    published = 0
    # Two packs ship: Show Guests, then the combined "everyone" pack. The four
    # tier packs and the coder pack were RETIRED 2026-08 when /supporters became
    # one ranked wall — see the note on TIER_PACKS. Their membership is still
    # computed above because all_members unions it; only the publish is gone.
    published += process_pack(GUESTS_PACK[0], GUESTS_PACK[1], guests, nsec, relays, state)
    published += process_pack(ALL_PACK[0], ALL_PACK[1], all_members, nsec, relays, state)
    # Clear the retired packs (no-op once each has been emptied).
    for slug, title in RETIRED_PACKS:
        published += process_pack(slug, title, [], nsec, relays, state)

    print(f"\n{published} pack(s) {'previewed' if DRY_RUN else 'published'}.")

    if not DRY_RUN:
        save_state(state)
        print(f"State saved → {STATE_FILE}")


if __name__ == "__main__":
    main()
