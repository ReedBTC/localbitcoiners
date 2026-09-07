/**
 * Builders + defaults for the optional kind-1 announcement that fires
 * after a calendar event publishes successfully.
 *
 * Three surfaces:
 *   - DEFAULT_KIND1_TEMPLATE / DEFAULT_BOOST_TEMPLATE — prefilled
 *     editable text shown next to the share checkboxes
 *   - buildEventAnnouncementTemplate — produces the unsigned kind 1
 *     event template
 *   - publishEventAnnouncement — signs + publishes the template through
 *     the shared NDK instance (best-effort; failures stay quiet so a
 *     successful event publish isn't undone by a failed announcement)
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, connectAndWait } from './ndk.js'

const NADDR_PLACEHOLDER = '{naddr}'

// Both defaults are short editable prose — the naddr is appended at
// publish time by interpolateNaddr (when the user hasn't kept the
// {naddr} placeholder in their edit), so we don't need to embed
// `nostr:{naddr}` in the template itself.
// The feeds live on the homepage since feeds-homepage (lb-v80); the Events
// tab's own URL is what a note points at. Notes published before that still
// say /feeds, which 301s to the same place.
export const DEFAULT_KIND1_TEMPLATE =
  `I just posted a meetup on https://localbitcoiners.com/?feed=events#feeds`

export const DEFAULT_BOOST_TEMPLATE =
  `I just posted a meetup on https://localbitcoiners.com/?feed=events#feeds`

// Default for the "boost an existing meetup" flows (My Meetups + Search
// modals). Reads as "I have one already, here it comes" rather than the
// just-published framing of DEFAULT_BOOST_TEMPLATE.
export const BOOST_EXISTING_TEMPLATE =
  `Boosting my meetup from https://localbitcoiners.com/?feed=events#feeds`

/**
 * Replace {naddr} placeholders with the real naddr1… string. If the
 * user removed the placeholder we append a NIP-21 link at the end so
 * the announcement still references the event.
 */
export function interpolateNaddr(text, naddr) {
  if (!naddr) return String(text || '')
  const t = String(text || '')
  if (t.includes(NADDR_PLACEHOLDER)) {
    return t.replaceAll(NADDR_PLACEHOLDER, naddr)
  }
  if (t.includes(naddr)) return t
  return t.trim() + (t.trim() ? '\n\n' : '') + 'nostr:' + naddr
}

/**
 * Build an unsigned kind 1 event template that quotes a calendar event.
 *
 * Tags:
 *   - ['a', '<kind>:<authorpk>:<dtag>'] — addressable coordinate
 *   - ['k', '31922'|'31923']            — kind reference
 *   - ['client', 'localbitcoiners.com'] — attribution
 *
 * @param {object} args
 * @param {string} args.text   — the (editable, possibly placeholder-bearing) note body
 * @param {string} args.naddr  — naddr1… of the published event
 * @param {string} args.kind   — '31922' | '31923' (or the number)
 * @param {string} args.pubkey — author pubkey hex of the event
 * @param {string} args.dTag   — d-tag of the event
 */
export function buildEventAnnouncementTemplate({ text, naddr, kind, pubkey, dTag }) {
  const content = interpolateNaddr(text, naddr).trim()
  const k = String(kind)
  const tags = [
    ['a', `${k}:${pubkey}:${dTag}`],
    ['k', k],
    ['client', 'localbitcoiners.com'],
  ]
  return {
    kind: 1,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  }
}

/**
 * Sign + publish a kind 1 announcement template. Best-effort — caller
 * (the composer) treats this as a side-effect of the calendar publish
 * and never surfaces failures to the user, matching the silent boost
 * UX convention.
 */
export async function publishEventAnnouncement(template) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  const event = new NDKEvent(ndk)
  event.kind = template.kind
  event.content = template.content
  event.tags = template.tags
  event.created_at = template.created_at || Math.floor(Date.now() / 1000)
  await connectAndWait(ndk).catch(() => {})
  await signWithTimeout(event)
  return event.publish()
}
