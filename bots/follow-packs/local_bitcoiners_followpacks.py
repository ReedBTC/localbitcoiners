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

# Booster tier floors (inclusive), highest first — a supporter lands in the
# first tier they clear, by lifetime total_sats (boosts + streams). Mirrors
# TIERS in supporters.js.
TIER_PACKS = [
    (100000, "lb-supporters-100k",  "Local Bitcoiners — 100k+ Boosters & Streamers"),
    (69000,  "lb-supporters-69k",   "Local Bitcoiners — 69k+ Boosters & Streamers"),
    (21000,  "lb-supporters-21k",   "Local Bitcoiners — 21k+ Boosters & Streamers"),
    (1,      "lb-supporters-other", "Local Bitcoiners — All Other Boosters & Streamers"),
]

GUESTS_PACK = ("lb-supporters-guests", "Local Bitcoiners — Show Guests")
CODERS_PACK = ("lb-supporters-coders", "Local Bitcoiners — Coding Contributors")

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

def compute_tier_members(rows):
    """{tier_slug: [npub, ...]} — lifetime total_sats per sender_npub (boosts +
    streams + zaps); name-only (no npub) supporters omitted. Hosts (Reed/Rev)
    are included by what they've boosted, mirroring supporters.js. Each npub
    lands in the first tier it clears.

    Zap rows (source == 'zap') are accumulated separately and only added to an
    npub's total when their aggregate zap sats reach ZAP_MIN_SATS — prevents
    single tiny zaps from qualifying someone for the entry-level tier."""
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
        try:
            h = npub_to_hex(npub)
        except Exception:
            print(f"    [warn] dropping undecodable npub: {npub[:16]}…")
            continue
        if not re.fullmatch(r"[0-9a-f]{64}", h or "") or h in seen:
            continue
        seen.add(h)
        hexes.append(h)
    for h in hexes:
        tags.append(["p", h])
    return tags, hexes


# ── publish ──────────────────────────────────────────────────────────────────
def process_pack(slug, title, member_npubs, nsec, relays, state):
    """Publish/refresh one pack unless its member set is unchanged. Empty packs
    are skipped (the website hides an empty-pack button). Returns True if it
    published (or would have, in dry-run)."""
    tags, hexes = pack_tags(slug, title, member_npubs)
    if not hexes:
        print(f"  [{slug}] empty — skipping")
        return False

    prev = (state.get(slug) or {}).get("members") or []
    if hexes == prev:
        print(f"  [{slug}] unchanged ({len(hexes)} members) — skipping republish")
        return False

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

    # Publish target: the show's own outbox (NIP-65) unioned with the fallback
    # set, so packs land on the show's relays plus the broad defaults.
    outbox = get_outbox_relays(SHOW_HEX) or []
    relays = list(dict.fromkeys(outbox + NOSTR_RELAYS))

    tier_members = compute_tier_members(rows)
    # Co-hosts first, then the RSS-derived episode guests (deduped by npub).
    guests       = list(dict.fromkeys(CO_HOSTS + compute_guests()))
    coders       = list(CODING_CONTRIBUTORS)

    print(f"Source: {len(rows)} sats.json rows | {len(guests)} guest npubs | "
          f"{len(coders)} coders | relays: {len(relays)}\n")

    published = 0
    # Guests, coders, then tiers high→low.
    published += process_pack(GUESTS_PACK[0], GUESTS_PACK[1], guests, nsec, relays, state)
    published += process_pack(CODERS_PACK[0], CODERS_PACK[1], coders, nsec, relays, state)
    for floor, slug, title in TIER_PACKS:
        published += process_pack(slug, title, tier_members.get(slug, []), nsec, relays, state)

    print(f"\n{published} pack(s) {'previewed' if DRY_RUN else 'published'}.")

    if not DRY_RUN:
        save_state(state)
        print(f"State saved → {STATE_FILE}")


if __name__ == "__main__":
    main()
