import { nip19 } from 'nostr-tools'
import { getNDK } from './ndk.js'

/**
 * Per-host substitutions applied to RSS-derived split recipients before
 * any LNURL fetch, payment, or kind 30078 publish.
 *
 * Why this exists: the Local Bitcoiners show is self-hosting boost
 * infrastructure rather than depending on Fountain's tooling, so the
 * 2% leg the RSS feed attributes to Fountain's boostbot is rerouted to
 * aquafox30@primal.net before payment. The RSS feed itself stays
 * untouched (Fountain still generates it from the show config).
 *
 * Keyed by source lud16; values replace the matching recipient's
 * `name` and `address` while preserving the original split weight.
 *
 * Merge semantics:
 *   When the override target address is *already* a recipient in the
 *   current splits — e.g. the channel-level fallback splits include
 *   aquafox30@primal.net at 32% AND Fountain at 2%, both of which
 *   route to aquafox30 after the override — the two legs are merged
 *   into one with combined weight (34%). Avoids paying the same
 *   address twice in one boost (extra LN fees, two kind 30078 events
 *   for the same recipient).
 *
 * Audit note: any address listed here is a *redirect at the donor's
 * client*. The kind 30078 `recipient` tag will reflect the redirected
 * address, so a recipient bot watching the override target sees a
 * normal leg with no special signaling. The original RSS recipient
 * never sees the payment.
 */
export const LNADDRESS_OVERRIDES = {
  'boostbot@fountain.fm': {
    name: 'aquafox30@primal.net',
    address: 'aquafox30@primal.net',
  },
}

/**
 * Per-episode override maps, keyed by episode number. Each value has the
 * same shape as LNADDRESS_OVERRIDES and is shallow-merged OVER the global
 * map for that episode, so an episode entry replaces the global redirect
 * for the same source address and leaves every other source address alone.
 *
 * Episode 015 is donated in full to the Samourai Wallet developers' legal
 * defense: the RSS value block for that item splits 96% to
 * billandkeonne@getalby.com with 1% each to the two hosts and the usual 2%
 * to Fountain's boostbot. Sending that 2% to aquafox30 would carve a host
 * cut out of a donation episode, so for Ep015 the Fountain leg is
 * redirected to billandkeonne@getalby.com instead. It then merges with the
 * existing 96% leg (same post-override address) into a single 98% leg.
 *
 * This table is mirrored on the bot side; the two have to be changed in
 * the same window as the RSS split edit, or the site and the bot will
 * disagree about where a leg went.
 */
export const EPISODE_LNADDRESS_OVERRIDES = {
  15: {
    'boostbot@fountain.fm': {
      name: 'billandkeonne@getalby.com',
      address: 'billandkeonne@getalby.com',
    },
  },
}

/**
 * The override map in effect for one episode: the global map with that
 * episode's entries layered on top. Show-level boosts (no episode number)
 * and episodes without an entry get the global map unchanged.
 *
 * @param {number|string|null} [episodeNumber]
 * @returns {object} source lud16 → { name, address }
 */
export function getRecipientOverrides(episodeNumber) {
  const n = Number(episodeNumber)
  if (!Number.isFinite(n)) return LNADDRESS_OVERRIDES
  const perEpisode = EPISODE_LNADDRESS_OVERRIDES[n]
  if (!perEpisode) return LNADDRESS_OVERRIDES
  return { ...LNADDRESS_OVERRIDES, ...perEpisode }
}

/**
 * Lightning addresses whose recipients run the LB podcast boost bot
 * (i.e. care about kind 30078 metadata events). For every other
 * recipient — Fountain, Albyhub end users, guest personal addresses —
 * the kind 30078 publish is skipped: they don't subscribe to our
 * boost relays for it, so it would just be relay noise.
 *
 * Boosts to addresses in this set:
 *   - Always publish a kind 30078 (so the bot has a record).
 *   - When the donor is signed in and attributed, the event is signed
 *     with their real Nostr key for cryptographic provenance the bot
 *     can verify; if the signer rejects or times out, the modal falls
 *     back to a single-use burner key so the boost still goes through.
 *   - In anonymous mode, the event is burner-signed.
 *
 * Address comparison is case-insensitive — lud16 is technically
 * case-sensitive but in practice every Lightning wallet treats it as
 * insensitive, and a stray uppercase from RSS shouldn't cause us to
 * miss the metadata publish.
 */
export const META_PUBLISH_ALLOWLIST = new Set([
  'localbitcoiners@getalby.com',
  // Reed's host leg. Both addresses are allowlisted so the show's boost
  // splits can point at either one — they're never both live in a single
  // episode's splits; the second is a hot standby if the primary's LNURL
  // host is down, so the kind 30078 publish keeps working after a swap.
  'reed@getalby.com',
  'reed@localbitcoiners.com',
])

export function shouldPublishMetadata(address) {
  if (typeof address !== 'string' || !address) return false
  return META_PUBLISH_ALLOWLIST.has(address.toLowerCase())
}

/**
 * Apply the override map to a recipient list. Pure — returns a new
 * array; original is unmodified.
 *
 * Two passes implicit in one loop:
 *   1. Apply the address/name override (or pass through if none).
 *   2. If the post-override address is already in `out`, merge weights
 *      into the existing entry rather than appending a duplicate.
 *
 * @param {Array} recipients
 * @param {number|string|null} [episodeNumber]  selects the per-episode
 *   override layer; omit for show-level boosts.
 */
export function applyRecipientOverrides(recipients, episodeNumber) {
  if (!Array.isArray(recipients)) return recipients
  const overrides = getRecipientOverrides(episodeNumber)
  const out = []
  const indexByAddress = new Map()  // post-override address → index in `out`

  for (const r of recipients) {
    if (!r || !r.address) {
      out.push(r)
      continue
    }
    const override = overrides[r.address] || null
    const next = override ? { ...r, ...override } : r

    const existingIdx = indexByAddress.get(next.address)
    if (existingIdx !== undefined) {
      // Merge into the existing entry. Preserve its name/address so
      // display doesn't flip to whatever-came-second's name. Sum the
      // weights — total stays correct, recipient gets one combined leg.
      const existing = out[existingIdx]
      out[existingIdx] = {
        ...existing,
        splitWeight: existing.splitWeight + (next.splitWeight || 0),
      }
      continue
    }

    indexByAddress.set(next.address, out.length)
    out.push(next)
  }
  return out
}

// ── type=node recipient resolution ──────────────────────────────────────────
//
// Podcast 2.0 value blocks can list a recipient as `type="node"` (a Lightning
// node pubkey paid via keysend) instead of `type="lnaddress"` (paid via LNURL).
// The browser boost flow only speaks LNURL — it has no keysend path, and many
// donor wallets can't keysend anyway — so a node recipient can't be paid
// directly. Rather than silently DROP it (which used to renormalize its split
// onto the other legs, so the node guest got nothing and the donor overpaid the
// rest), we try to redirect it to a Lightning address and otherwise mark it
// unpayable so the leg fails honestly without sending or crediting those sats.
//
// On the Local Bitcoiners feed, every value recipient other than reed/rev/
// aquafox is a GUEST, and guests are identified by npub in the episode's
// `[guests: npub1...]` marker. A Lightning node pubkey is NOT a Nostr pubkey,
// so we can't derive the npub from the node pubkey — but we can either look it
// up in the curated map below or, when an episode has exactly one guest, assume
// that's who the node recipient is. From the npub we resolve the guest's
// current lud16 off their kind-0 profile (so a profile address change is picked
// up automatically), then pay it as an ordinary lnaddress leg.

// Curated Lightning-node-pubkey → npub map. Seeded from the `[guests:]` marker
// on the episodes where each guest appears (the npub is always in the feed).
// Add an entry whenever a new guest is listed as type=node and the episode has
// more than one guest (single-guest episodes resolve automatically below).
export const NODE_RECIPIENT_NPUBS = {
  // Sir Spencer — Wolf of KC (BowlAfterBowl). node pubkey → his npub.
  '03ecb3ee55ba6324d40bea174de096dc9134cb35d990235723b37ae9b5c49f4f53':
    'npub1yvscx9vrmpcmwcmydrm8lauqdpngum4ne8xmkgc2d4rcaxrx7tkswdwzdu',
}

export const UNPAYABLE_NODE_REASON =
  "Browser boosts can only pay Lightning addresses, and this recipient is " +
  "listed as a keysend node. This leg was skipped — those sats weren't sent."

/** Resolve an npub (or nprofile) to its kind-0 lud16, or null. Never throws. */
async function resolveLud16ForNpub(npub) {
  try {
    const decoded = nip19.decode(npub)
    const hex = decoded.type === 'npub' ? decoded.data
              : decoded.type === 'nprofile' ? decoded.data.pubkey
              : null
    if (!hex) return null
    const profile = await getNDK().getUser({ pubkey: hex }).fetchProfile()
    const addr = profile?.lud16 || profile?.lightningAddress || null
    return (typeof addr === 'string' && addr.includes('@')) ? addr.trim() : null
  } catch {
    return null
  }
}

/**
 * Resolve every `type:'node'` recipient to a payable lnaddress leg, or flag it
 * unpayable. Async (it may fetch kind-0 profiles). Pure w.r.t. the input array
 * — returns a new list; lnaddress recipients pass through untouched.
 *
 * @param {Array} recipients   split recipients ({ name, address, splitWeight, type })
 * @param {string[]} guestNpubs  episode `[guests:]` npubs (for sole-guest auto-match)
 * @returns {Promise<Array>} recipients with nodes rewritten to lnaddress or
 *   marked `{ unpayable: true, unpayableReason }`.
 */
export async function resolveNodeRecipients(recipients, guestNpubs = []) {
  if (!Array.isArray(recipients)) return recipients
  const guests = (Array.isArray(guestNpubs) ? guestNpubs : []).filter(Boolean)
  const out = []
  for (const r of recipients) {
    if (!r || r.type !== 'node') { out.push(r); continue }
    // Curated map first; else auto-match only when the episode has exactly
    // one guest (unambiguous). Multi-guest + unmapped → unpayable.
    const npub = NODE_RECIPIENT_NPUBS[r.address] || (guests.length === 1 ? guests[0] : null)
    const lud16 = npub ? await resolveLud16ForNpub(npub) : null
    if (lud16) {
      out.push({ ...r, type: 'lnaddress', address: lud16, name: r.name || lud16,
                 resolvedFromNode: r.address })
    } else {
      out.push({ ...r, unpayable: true, unpayableReason: UNPAYABLE_NODE_REASON })
    }
  }
  return out
}
