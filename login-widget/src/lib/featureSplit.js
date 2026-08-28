/**
 * Feature splits — who gets the show's reassignable leg when a boost is a
 * "Feature this" boost from /feeds.
 *
 * A Feature boost is an ordinary show boost whose message carries a reference
 * to the thing being featured (an naddr, or the OnlyBoosts episode URL). The
 * sats-log bot scans the message and the item lands in the tab's gold box.
 * What this module adds is the money side: the show's third split leg (34%,
 * normally aquafox30) is pointed at whoever made the thing, so the sats follow
 * what is being promoted. The two host legs are untouched, which is what keeps
 * the bots' LB-feed-identity classifier seeing the boost as ours.
 *
 * Four kinds, one shape:
 *
 *   kind       thing                      the leg goes to
 *   article    a NIP-23 long-form post    the author's kind-0 lud16
 *   event      a NIP-52 calendar event    the organizer's kind-0 lud16
 *   listing    a NIP-99 listing           the seller's kind-0 lud16
 *   episode    another podcast's episode  the podcast's own value block,
 *                                         split proportionally (lnaddress and
 *                                         keysend legs alike, paid as the
 *                                         external-boost flow pays them)
 *
 * The site callers pass what they already know (the Articles and Market tabs
 * hold the profile with its lud16; the Podcast Boosts tab holds the value
 * block). Anything with a pubkey and no address is resolved HERE, from the
 * kind-0 on the relays, time-boxed, so the widget's own meetup flows (search,
 * my meetups, paste) get the split without knowing how to look it up.
 *
 * ⚠️ ONLY THE REASSIGNABLE LEG IS EVER TOUCHED. Nothing here can name a host
 * leg; BoostModal owns which leg is reassignable and this module only says who
 * should receive it.
 */
import { nip19 } from 'nostr-tools'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'

// A miss costs the maker their share of one boost, never the boost itself, so
// the lookup is short: the Feature button is already disabled while it runs.
export const FEATURE_LOOKUP_TIMEOUT_MS = 2500

export const FEATURE_KINDS = {
  article: { thing: 'article', role: 'author' },
  event:   { thing: 'event',   role: 'organizer' },
  listing: { thing: 'listing', role: 'seller' },
  episode: { thing: 'episode', role: 'podcast' },
}

export function isLightningAddress(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

const HEX64 = /^[0-9a-f]{64}$/i

function str(v) { return typeof v === 'string' ? v.trim() : '' }

/**
 * Coerce whatever a caller passed into the one feature shape, or null. Accepts
 * the legacy `authorSplit` ({ name, address }) as an article feature. A naddr
 * fills in the pubkey (and the kind, when the caller gave none) so the widget's
 * meetup flows can pass just the address they already hold.
 *
 * @returns {null | {
 *   kind: 'article'|'event'|'listing'|'episode',
 *   name: string, pubkey: string, address: string,
 *   recipients: Array<{name,address,type,splitWeight,customKey?,customValue?}>|null,
 *   naddr: string,
 * }}
 */
export function normalizeFeature(opts = {}) {
  const feature = opts?.feature && typeof opts.feature === 'object' ? opts.feature : null
  const legacy = opts?.authorSplit && typeof opts.authorSplit === 'object' ? opts.authorSplit : null
  if (!feature && !legacy) return null
  const src = feature || { kind: 'article', name: legacy.name, address: legacy.address }

  let kind = str(src.kind)
  let pubkey = str(src.pubkey).toLowerCase()
  const naddr = str(src.naddr).replace(/^nostr:/i, '')
  if (naddr) {
    try {
      const d = nip19.decode(naddr)
      if (d.type === 'naddr') {
        if (!pubkey && HEX64.test(d.data.pubkey || '')) pubkey = d.data.pubkey.toLowerCase()
        if (!kind) kind = kindFromNostrKind(d.data.kind)
      }
    } catch {}
  }
  if (!FEATURE_KINDS[kind]) return null
  if (!HEX64.test(pubkey)) pubkey = ''

  const recipients = Array.isArray(src.recipients)
    ? src.recipients
        .filter((r) => r && (r.type === 'node' || r.type === 'lnaddress') && str(r.address) && Number(r.splitWeight) > 0)
        .map((r) => ({
          name: str(r.name),
          address: str(r.address),
          type: r.type,
          splitWeight: Number(r.splitWeight),
          ...(r.customKey && r.customValue ? { customKey: String(r.customKey), customValue: String(r.customValue) } : {}),
        }))
    : null

  const address = isLightningAddress(src.address) ? str(src.address).toLowerCase() : ''
  return {
    kind,
    name: str(src.name),
    pubkey,
    address,
    recipients: recipients && recipients.length ? recipients : null,
    naddr,
  }
}

function kindFromNostrKind(k) {
  if (k === 30023) return 'article'
  if (k === 31922 || k === 31923) return 'event'
  if (k === 30402) return 'listing'
  return ''
}

/**
 * Fill in `address` (and a display name) from the maker's kind-0 when the
 * caller gave a pubkey and nothing payable. Never throws; on any miss the
 * feature comes back as it went in, and BoostModal falls back to the standard
 * splits with a line saying why.
 */
export async function resolveFeatureAddress(feature, timeoutMs = FEATURE_LOOKUP_TIMEOUT_MS) {
  if (!feature || feature.address || feature.recipients || !feature.pubkey) return feature
  try {
    const user = getNDK().getUser({ pubkey: feature.pubkey })
    await withTimeout(user.fetchProfile(), timeoutMs, 'feature profile lookup')
    const p = user.profile || null
    const addr = p?.lud16 || p?.lightningAddress || ''
    return {
      ...feature,
      name: feature.name || str(p?.displayName) || str(p?.name) || '',
      address: isLightningAddress(addr) ? str(addr).toLowerCase() : '',
    }
  } catch {
    return feature
  }
}

/** Prose for the modal: what the thing is and who is paid for it. */
export function describeFeature(feature) {
  const meta = FEATURE_KINDS[feature?.kind] || FEATURE_KINDS.article
  return { thing: meta.thing, role: meta.role }
}
