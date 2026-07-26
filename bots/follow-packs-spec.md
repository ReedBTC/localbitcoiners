# Spec — Supporter follow packs (following.space, kind 39089)

Status: **proposed / not yet implemented.** Hand-off spec for the bots
workstream. The website side (the "Follow Pack" buttons on /supporters)
depends on these packs existing, and is held until they're published.

## Goal

Publish one **NIP-51 follow pack (kind 39089)** per Supporters-page
category, owned by the show's Nostr account, and keep them current.
The /supporters page links each category to its pack on
[following.space](https://following.space) so a logged-in user can
one-click-follow everyone in that category in their own client.

Nothing here touches anyone's kind-3 follow list. A follow pack is a
parameterized-replaceable event the **show** owns; republishing with the
same `d` tag and a newer `created_at` just refreshes it.

## Owning account

Publish from the show's public account:

- npub: `npub1cvcgs83gw6pcrhvtmlf8gdqaegx93qkznwry96jteqhh2cexgkfq45rtya`
- hex:  `c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592`

⚠️ **Confirm the bots can sign as this account.** If the boost-publisher
signs with a different key, either publish the packs from that key
instead — and tell the website which hex pubkey to use in the `?p=` link
param — or provision the show key for this job. The pack owner and the
website link's `?p=` MUST be the same pubkey.

## Event shape (kind 39089)

```
{
  "kind": 39089,
  "created_at": <now>,
  "tags": [
    ["d", "<slug>"],                       // stable per pack — see table
    ["title", "<title>"],
    ["description", "<optional>"],
    ["image", "https://localbitcoiners.com/assets/LocalBitcoiners.png"],  // optional
    ["p", "<member hex pubkey>"],          // one per member
    ["p", "<member hex pubkey>"],
    ...
  ],
  "content": ""
}
```

- `p` tag values are **hex** pubkeys (decode npub → hex).
- Dedupe `p` tags. Drop any that fail to decode.
- Keep the `d` slugs **stable and exactly as below** — the website URLs
  are hardcoded to them.

## The six packs

| d slug (`d` tag)        | title                                          | members |
|-------------------------|------------------------------------------------|---------|
| `lb-supporters-guests`  | Local Bitcoiners — Show Guests                  | guest npubs |
| `lb-supporters-coders`  | Local Bitcoiners — Coding Contributors          | coder npubs (hardcoded) |
| `lb-supporters-100k`    | Local Bitcoiners — 100k+ Boosters & Streamers   | tier ≥ 100,000 |
| `lb-supporters-69k`     | Local Bitcoiners — 69k+ Boosters & Streamers    | tier 69,000–99,999 |
| `lb-supporters-21k`     | Local Bitcoiners — 21k+ Boosters & Streamers    | tier 21,000–68,999 |
| `lb-supporters-other`   | Local Bitcoiners — All Other Boosters & Streamers | tier 100–20,999 (grandfathered: members published under the old 1-sat floor are never removed) |

## Membership — must match the /supporters page exactly

The website derives the same sets in `assets/js/supporters.js`; mirror
that logic so the packs match what the page shows.

**Booster tiers** — from `data/sats.json` rows:
- Group by `sender_npub`; sum `total_sats` (boosts **and** streams).
- Exclude hosts (same two npubs the page/stats use):
  - Reed: `npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s`
  - Rev Hodl: `npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z`
- Each supporter lands in exactly one tier by lifetime total (≥100k, ≥69k,
  ≥21k, else ≥1).
- **Only supporters with an `sender_npub`** go in packs. Name-only
  supporters (no npub) appear on the page with a blank avatar but can't be
  followed, so they're omitted here.

**Show Guests** — the union of `[guests: npub1…, …]` npubs across all
episodes' RSS shownotes. Same parse as `functions/api/guests.js` /
`functions/_middleware.js` `parseGuests` (regex `\[guests:\s*([^\]]+)\]`,
comma-split, validate `^npub1[02-9ac-hj-np-z]{58}$`).

**Coding Contributors** — hardcoded, must match `CODING_CONTRIBUTORS` in
`assets/js/supporters.js`:
- Reed: `npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s`
- Chad Farrow: `npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7`

## Cadence

Simplest: publish/refresh **all six** packs once per day at the end of the
existing `sats-log` run (after `data/sats.json` is regenerated). Tier
membership shifts daily; guests/coders rarely change but republishing them
daily is harmless (same `d`, newer `created_at`). Skip the publish for a
pack only if its member set is byte-identical to the last published one
(optional optimization — avoids needless events).

Publish to the show's write relays + the usual fallback set
(`relay.damus.io`, `nos.lol`, `relay.primal.net`, `purplepag.es`).

## Website link format (for reference — built once packs are live)

Each category's "Follow Pack" button links to:

```
https://following.space/d/<slug>?p=c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592
```

e.g. Show Guests → `https://following.space/d/lb-supporters-guests?p=c330881e…2645 92`
(no spaces — full 64-char hex). following.space resolves the pack by
`#d` + author and renders a one-click follow UI.

## Out of scope / notes

- No deletion handling needed; replaceable events supersede by `d` tag.
- If a tier is empty on a given day, publishing an empty pack is fine (or
  skip it); the website button can be hidden when its pack is empty.
- This job only ever publishes the show's own kind-39089 events — it must
  never read or write any user's kind-3 follow list.
