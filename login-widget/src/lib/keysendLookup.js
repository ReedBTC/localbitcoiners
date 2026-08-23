/**
 * Lightning address → keysend upgrade.
 *
 * Some providers publish `/.well-known/keysend/<name>` alongside the usual
 * `/.well-known/lnurlp/<name>`, naming the node pubkey plus the custom TLV
 * record that routes a payment to that account on a shared node. When an
 * address serves one, a `type: 'lnaddress'` recipient can be paid as a real
 * keysend carrying the boostagram inline in TLV 7629169.
 *
 * ⚠️ WHY THAT IS WORTH DOING, IN ONE SENTENCE: Helipad's
 * `parse_boost_from_invoice` reads the TLV in its FIRST branch, before any
 * memo or metadata handling, so a keysend needs nothing switched on at the
 * podcaster's end and puts no third party in the path. The BoostBox descriptor
 * (route two, shipped) reaches the same podcaster through Helipad's second
 * tier, but only where they have enabled `fetch_metadata`, which defaults off.
 *
 * Measured across the top-30 shows' value blocks on 2026-08-21: 48 of 111 legs
 * were already keysend, 34 more are upgradeable and worth upgrading, 25 are at
 * `fountain.fm` and deliberately excluded below, and 4 publish no usable
 * document. So the upgrade takes tier-one coverage from 48 legs to 82.
 *
 * ⚠️ EVERYTHING HERE IS BEST-EFFORT AND FAILS TOWARD LNURL. A miss, a timeout,
 * junk JSON, an SPA shell, a malformed pubkey and an unreachable edge all
 * resolve to null, and the leg pays exactly as it did before this file
 * existed. **Never make this throw.** LNURL works on every rail and keysend
 * does not, so the only safe direction of error is back to LNURL.
 */

import { getStatus, onChange as onWalletChange } from './wallet.js'
import * as nwc from './nwc.js'

/** @typedef {{ pubkey: string, customKey?: string, customValue?: string }} KeysendTarget */

// Tight because this runs INSIDE a boost someone is watching, and it is an
// optimisation with a working fallback: losing the upgrade on a slow network
// is much cheaper than stalling the payment. Slightly above the edge route's
// own 3.5s upstream budget so it can answer "no endpoint" rather than having
// us abort first and throw away a miss worth caching.
const LOOKUP_TIMEOUT_MS = 4_500
const HIT_TTL_MS = 6 * 60 * 60 * 1000
const MISS_TTL_MS = 15 * 60 * 1000

// Module scope, so a value block whose legs share an address probes it once.
const cache = new Map()

// Lightning node ids are compressed secp256k1 pubkeys: 33 bytes hex, always
// prefixed 02 or 03.
//
// ⚠️ VALIDATING STRICTLY HERE IS LOAD-BEARING, NOT TIDINESS. There is no
// second chance: once a leg has been handed to a wallet as a keysend it is
// never retried over LNURL (a payment that may be in flight must not be sent
// twice), so a malformed pubkey that slipped through fails the leg outright
// where the old path would have paid. `primal.net` answers this path HTTP 200
// with its SPA's HTML, so a status check alone reads three legs of the
// measured corpus as upgradeable when they are not.
const NODE_PUBKEY = /^0[23][0-9a-f]{64}$/i

/**
 * Providers we deliberately pay over LNURL even though they publish a keysend
 * document.
 *
 * ⚠️ FOUNTAIN IS THE REASON THIS LIST EXISTS AND THE REASON IS NOT THAT IT
 * LACKS KEYSEND. It has keysend, it publishes the well-known, the payment
 * arrives and the sats land — it just never surfaces the TLV boostagram to the
 * person who received it. So the upgrade fires, does exactly what it was
 * designed to do, and the metadata is discarded at the far end. The LUD-21
 * comment is the only channel Fountain shows, and that is the channel route
 * two already fills.
 *
 * ⚠️ DO NOT "CORRECT" THIS BY TESTING WHETHER THE HOST SERVES THE WELL-KNOWN.
 * It does, and that is the trap. Nothing observable from our side separates a
 * provider that renders the TLV from one that drops it — the payment succeeds
 * identically either way. Membership here is knowledge about the provider,
 * never a probe.
 *
 * It is also 25 of the 111 measured legs, so this is the largest single
 * decision in the file.
 */
const LNURL_ONLY_DOMAINS = ['fountain.fm']

/**
 * Whether this address's domain is one we always pay over LNURL.
 *
 * ⚠️ EXACT-OR-PARENT, NEVER `endsWith`. A bare suffix test also matches
 * `notfountain.fm`, which would hand any third party the ability to strip the
 * inline boostagram off other people's payments by registering a hostname. The
 * value block is attacker-authored text, so the domain is lowercased and a
 * trailing root dot stripped first: `USER@Fountain.FM.` is the same host to
 * DNS.
 */
export function isLnurlOnlyAddress(address) {
  const domain = String(address || '').split('@')[1]?.trim().toLowerCase().replace(/\.$/, '')
  if (!domain) return false
  return LNURL_ONLY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/**
 * The routing pair, taken from the documented `customData: [{...}]` shape or
 * from the top level, which some providers use instead.
 *
 * ⚠️ KEY AND VALUE ARE ONLY EVER TAKEN TOGETHER FROM THE SAME OBJECT. Pairing
 * a key from one source with a value from another misroutes the payment to
 * the wrong sub-account on a shared node, which is a stranger being paid.
 */
function firstCustomPair(data) {
  const entries = Array.isArray(data?.customData) ? data.customData : []
  for (const entry of [...entries, data]) {
    const k = entry?.customKey
    const v = entry?.customValue
    if (k == null || v == null) continue
    const customKey = String(k).trim()
    const customValue = String(v).trim()
    // The key is a TLV record number; a non-numeric one cannot go on the wire.
    if (!customKey || !customValue || !/^\d+$/.test(customKey)) continue
    return { customKey, customValue }
  }
  return {}
}

/**
 * A keysend document → a target, or null.
 *
 * `pubkey` is the documented field; `destination` and `nodeId` appear in the
 * wild. `tag: "keysend"` is deliberately not required — the strict pubkey
 * check is the real gate, and self-hosted endpoints are looser about the
 * envelope than the custodial ones.
 */
export function parseKeysendResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (typeof data.status === 'string' && data.status.toUpperCase() === 'ERROR') return null
  const raw = data.pubkey ?? data.destination ?? data.nodeId
  const pubkey = typeof raw === 'string' ? raw.trim() : ''
  if (!NODE_PUBKEY.test(pubkey)) return null
  return { pubkey: pubkey.toLowerCase(), ...firstCustomPair(data) }
}

/**
 * Resolve `name@domain` to a keysend target, or null when the address does not
 * publish a usable one — which is the common case.
 *
 * @returns {Promise<KeysendTarget|null>}
 */
export async function lookupKeysendTarget(address) {
  const [name, domain] = String(address || '').split('@')
  if (!name || !domain) return null

  // ⚠️ AHEAD OF THE CACHE, NOT JUST THE FETCH. These domains DO answer the
  // probe, so a cached hit would be a real target we then have to remember to
  // ignore at every read. Refusing to look is the version with one place to
  // get it wrong.
  if (isLnurlOnlyAddress(address)) return null

  const key = address.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  let value = null
  try {
    const res = await fetch(`/api/keysend?addr=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (res.ok) value = parseKeysendResponse(await res.json())
  } catch {
    value = null
  }
  // Misses are cached too, on a shorter TTL: an LNURL-only address must not
  // cost a failed round trip on every leg of every boost.
  cache.set(key, { value, expires: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) })
  return value
}

/* ------------------------------------------------------------------ *
 * Can this wallet keysend at all?
 * ------------------------------------------------------------------ */

/**
 * ⚠️ THE GATE THAT KEEPS THE UPGRADE NON-REGRESSIVE, AND IT IS THE PART BMB
 * DOES NOT HAVE.
 *
 * An lnaddress leg pays over BOLT11, which every rail speaks. A keysend leg
 * does not: most WebLN extensions have no `keysend` method at all, and an NWC
 * connection is only as capable as the wallet behind it. So upgrading blindly
 * converts a leg that WOULD have paid into one that cannot — on the measured
 * corpus, 34 of 111 legs — in exchange for metadata. **The metadata is a
 * courtesy to the recipient; the payment is the point.**
 *
 * Both answers fail toward false, because false is the direction that still
 * pays.
 */
let keysendUnsupported = false
let nwcCapable = null   // null = not yet asked this session

/**
 * ⚠️ WHAT THE WALLET ITSELF TOLD US OUTRANKS WHAT IT ADVERTISED. A capability
 * error out of a real keysend attempt is the one measurement that cannot be
 * wrong, so it is latched for the session and no later leg is upgraded.
 * Called only for a decline that provably sent nothing; see `isCleanDecline`.
 */
export function noteKeysendUnsupported() {
  keysendUnsupported = true
}

/**
 * @returns {Promise<boolean>} whether an upgraded leg can actually be paid.
 *
 * WebLN answers synchronously off the provider object. NWC costs one lookup of
 * the wallet service's own info event, which is cached for the session and
 * bounded — an unreachable or silent wallet service answers "no", so the legs
 * stay on the path that works.
 */
export async function walletCanKeysend() {
  if (keysendUnsupported) return false
  const kind = getStatus().kind
  if (kind === 'webln') {
    return typeof window !== 'undefined' && typeof window.webln?.keysend === 'function'
  }
  if (kind !== 'nwc') return false
  if (nwcCapable !== null) return nwcCapable
  try {
    const client = nwc.getClient()
    const info = await Promise.race([
      client.getWalletServiceInfo(),
      new Promise((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)),
    ])
    const caps = Array.isArray(info?.capabilities) ? info.capabilities : []
    nwcCapable = caps.includes('pay_keysend')
  } catch {
    // ⚠️ A wallet that does not implement `get_info` is not a wallet that
    // cannot keysend, and this answers "no" for it anyway. That is the
    // deliberate trade: a missed upgrade costs metadata on one leg, where a
    // wrong "yes" costs the payment. `noteKeysendUnsupported` is the other
    // direction of the same caution.
    nwcCapable = false
  }
  return nwcCapable
}

/** Test seam, and the reset a wallet change needs: drops both memos. */
export function clearKeysendLookupCache() {
  cache.clear()
  keysendUnsupported = false
  nwcCapable = null
}

/**
 * ⚠️ BOTH CAPABILITY MEMOS ARE ABOUT THE WALLET, SO THEY DIE WITH IT. The
 * asymmetry is what makes this necessary rather than tidy: going from a
 * keysend-capable wallet to one without it and keeping the old `true` upgrades
 * legs the new wallet cannot pay. The other direction only costs metadata.
 *
 * The address cache is deliberately NOT cleared — a keysend document is a fact
 * about the recipient and has nothing to do with who is paying.
 */
// Subscribed unconditionally rather than behind a `typeof window` guard.
// `wallet.onChange` is documented safe to call before any wallet has been
// touched, and a guard here would make the reset the one rule in this file
// that cannot be tested — which is the rule protecting the payment.
onWalletChange(() => {
  keysendUnsupported = false
  nwcCapable = null
})
