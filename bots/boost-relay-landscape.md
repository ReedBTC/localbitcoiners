# NIP-73 Podcast-Boost Relay Landscape

*Investigation date: 2026-07-24. Author: Claude Code (for Reed).*

Goal: figure out **which relays podcast-boost notes (Local Bitcoiners bot, Boost
Me Bitch, Fountain, and other NIP-73 clients) are actually published to**, so the
community-feed collector reads from the right set.

---

## TL;DR

- An `nevent` does **not** tell you where a note was published. Relays store no
  provenance, and the nevent we were given carried **no relay hints** at all.
  The only way to answer "where is this note?" is to REQ it by id from many
  relays and see who has it.
- **Fountain barely broadcasts.** ~90% of Fountain boost notes live **only on
  `relay.fountain.fm`**. Reading that relay is mandatory.
- The big general relays (`nos.lol`, `relay.damus.io`, `relay.mostr.pub`) hold
  the most boost notes in aggregate — these are mostly LB-bot, BMB, website, and
  other-client notes, which fan out normally.
- `purplepag.es`, `relay.getalby.com`, `relay.primal.net` carry **almost no**
  boost notes (they're profile / relay-list relays) — not worth scanning for
  boosts.

---

## Method

Probed relays directly with `websocket-client` (the same lib `collector_common`
uses). Three passes:

1. **Single-note probe** — REQ `{"ids":[<event id>]}` across ~40 relays for the
   specific note Reed gave.
2. **Aggregate scan** — REQ `{"kinds":[1],"#k":["podcast:guid"]}` and
   `["podcast:item:guid"]` (client-agnostic — any NIP-73 podcast boost) across the
   same relays; counted distinct notes + distinct authors each returned.
3. **Propagation test** — pulled 60 recent boost notes *from* `relay.fountain.fm`,
   then checked how many of those exact ids appeared on the big general relays.

Scripts live in the session scratchpad (`probe.py`, `scan.py`, `prop.py`).

Also checked the **BMB repo** (`github.com/ChadFarrow/boostmebitch`,
`lib/nostr/relays.ts`) and LB's own `bots/shared/nostr_utils.py` for publish
targets.

---

## The specific note

`nostr:nevent1qvzqqqqqqypz…qd0p9w4`

Decoded TLV (no relay hints present):

| field | value |
|---|---|
| kind | 1 |
| author (pubkey) | `91aeab23b5664edaa57dbe00b041ccb50544f89d7d956345bbd78b7dbaa48660` |
| event id | `e1d37f9f4dd83014877f0ee50166b286f21da81e6a699f0ab77837f1f6e5f568` |

It's a Fountain **No Agenda ep 1887** boost, tagged NIP-73:

```
k  podcast:item:guid
i  podcast:item:guid:http://1887.noagendanotes.com
k  podcast:guid
i  podcast:guid:856cd618-7f34-57ea-9b84-3600f1f65e7f
```

**Found on exactly one relay: `relay.fountain.fm`.** Absent from all ~39 others
probed (damus, nos.lol, primal, mostr, band, getalby, purplepag.es, snort,
podtards, chadf, noderunners, wavlake, …).

---

## Finding 1 — Fountain barely propagates

Sampled 60 recent boost notes **from** `relay.fountain.fm`, then checked how many
of those exact ids exist elsewhere:

| Relay | Fountain-sampled notes also present |
|---|---|
| relay.damus.io | 7 / 60 |
| nos.lol | 6 / 60 |
| relay.mostr.pub | 6 / 60 |
| relay.primal.net | 2 / 60 |
| relay.getalby.com/v1 | 0 / 60 |
| chadf.nostr1.com | 0 / 60 |

→ **~90% of Fountain boost notes are `relay.fountain.fm`-only.** If you don't read
that relay, you miss most Fountain boosts.

Fountain signs each boost with a **per-user Fountain-managed key** — the scan saw
**142 distinct authors** on their relay, not one shared account.

---

## Finding 2 — where boost notes live in aggregate

Client-agnostic scan (`#k = podcast:guid` / `podcast:item:guid`, kind 1),
distinct notes + distinct authors per relay:

| Relay | notes | authors | notes |
|---|---:|---:|---|
| nos.lol | 583 | 328 | best general catch-all |
| relay.mostr.pub | 537 | 270 | ActivityPub bridge, very wide |
| relay.damus.io | 412 | 75 | |
| **chadf.nostr1.com** | 384 | 8 | Chad Farrow's relay — BMB + his boosts |
| nostr.mom | 371 | 74 | |
| **relay.lexingtonbitcoin.org** | 364 | 80 | bitcoin PC2.0 relay, great diversity |
| nostr21.com | 337 | 67 | |
| relay.fountain.fm | 332 | 142 | unique Fountain content, mandatory |
| nostr.land | 181 | 15 | |
| podtards.com | 171 | 11 | podcasting-focused |
| relay.noderunners.network | 149 | 12 | |
| relay.wisp.talk | 110 | 61 | |
| relay.wavlake.com | 102 | 34 | music/podcast V4V |
| wot.utxo.one | 98 | 16 | |
| relay.nostrplebs.com | 97 | 19 | |
| offchain.pub | 81 | 24 | |
| relay.plebeian.market | 76 | 11 | |
| relay.coinos.io | 14 | 11 | |
| relay.westernbtc.com | 10 | 5 | |
| relay.bowlafterbowl.com | 9 | 4 | |
| relay.primal.net | 2 | 2 | ~none |
| purplepag.es | 0 | 0 | profile relay — no boosts |
| relay.getalby.com/v1 | 0 | 0 | ~none |

Unreachable during the scan (timeouts / bad status, not necessarily dead):
`nostr.wine`, `relay.nostr.band`, `nostr.oxtr.dev`, `relay.snort.social`,
`relayable.org`, `haven.permanerd.com`, `21ideas.nostr1.com`,
`nostr.bitcoiner.social`, `relay.stemstr.app`.

---

## Per-client publishing behavior

- **Fountain** — writes to `relay.fountain.fm` first; weak fanout. Per-user
  Fountain-managed signing keys. **Must read `relay.fountain.fm`.**
- **Boost Me Bitch** (`lib/nostr/relays.ts`) — default publish set
  `damus, primal, nos.lol, nostr.band, fountain.fm`; signed-in users add their
  NIP-65 write relays (union, cap 20). Manual override key `localStorage.bmb:relays`.
  NIP-73 tags: `i = podcast:guid:<feed-guid>` (`k = podcast:guid`) + optional
  `podcast:item:guid:<item-guid>`. Chad's `chadf.nostr1.com` carries the output.
- **LB bot** (`bots/shared/nostr_utils.py`) — publishes via the outbox model,
  with `NOSTR_RELAYS` as fallback (`damus, purplepag.es, nos.lol, getalby/v1,
  primal, fountain.fm`).

---

## What we changed (community-scan read set)

`NOSTR_RELAYS` is the **publish** set shared by boost-publisher, sats-log,
follow-packs, etc. `bots/CLAUDE.md` says *"Never modify NOSTR_RELAYS directly."*
So we added a **dedicated read-relay list** for the boost search/cache bot instead
of mutating the publish set.

New constant `BOOST_SCAN_RELAYS` in `bots/shared/nostr_utils.py`, used by
`bots/community-scan/` (`community_scan.py` base + `boost_pipeline.py` receipt
lookups):

**Removed** (near-zero boost yield): `purplepag.es`, `relay.getalby.com/v1`,
`relay.primal.net`.
**Added** (high boost yield): `nostr21.com`, `chadf.nostr1.com`, `podtards.com`,
`nostr.mom`, `relay.wavlake.com`.

Resulting read set: `relay.damus.io`, `nos.lol`, `relay.fountain.fm`,
`nostr21.com`, `chadf.nostr1.com`, `podtards.com`, `nostr.mom`,
`relay.wavlake.com`.

(Deep mode still unions each member's NIP-65 write relays on top of this base.)

---

## Open lever (not done)

community-scan is **author-scoped** — it only collects boosts from follow-pack
members. The 142 per-boost Fountain keys are almost all non-members, so adding
relays won't surface those. To catch *all* boosts to the LB show you'd switch to
**tag-scoped** collection: REQ `#k = podcast:guid` filtered to the LB show guid,
rather than filtering by author. Bigger change; flagged for later.

Good candidate relays not yet added but worth considering if you widen scope:
`relay.mostr.pub`, `relay.lexingtonbitcoin.org`, `relay.noderunners.network`,
`nostr.land`.
