/**
 * eventPublish — NIP-52 publish helper for kind 31922 / 31923.
 *
 * Ported from mynostr's eventPublish.js, slimmed: no RSVP, no
 * delete, no draft round-trip. Single function, one event kind family,
 * one happy path.
 *
 * Adapted to LB's publish primitives: ensureUserWriteRelays seeds
 * the pool with the user's NIP-65 outbox before publishing so future
 * edits/replacements land on the same set.
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import {
  getNDK,
  signWithTimeout,
  connectAndWait,
  ensureUserWriteRelays,
  FALLBACK_RELAYS,
} from './ndk.js'
import { isSafeUrl } from './utils.js'
import { publishSignedToRelays } from './boostagram.js'
import { KIND_DATE_EVENT, KIND_TIME_EVENT } from './eventTypes.js'

// The site's calendar relays: STATIC_RELAYS in assets/js/boosts-thread.js
// minus relay.fountain.fm, which is kind-1-only. Also what the snapshot bot
// (bots/community-feeds) scans before it resolves members' outboxes.
export const CALENDAR_EVENT_RELAYS = [...FALLBACK_RELAYS]

const FUTURE_CAP_SECONDS = 60
let _lastPublishedAt = 0

function nextPublishedAt() {
  const now = Math.floor(Date.now() / 1000)
  let ts = Math.max(now, _lastPublishedAt + 1)
  if (ts > now + FUTURE_CAP_SECONDS) ts = now
  _lastPublishedAt = ts
  return ts
}

function randomDTag() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0')
}

function buildCalendarEventTags(form) {
  const tags = []
  const dTag = form.dTag || randomDTag()
  tags.push(['d', dTag])
  tags.push(['title', String(form.title || '').trim()])
  tags.push(['start', String(form.start)])
  if (form.end) tags.push(['end', String(form.end)])

  if (form.kind === KIND_TIME_EVENT) {
    if (form.startTzid) tags.push(['start_tzid', form.startTzid])
    if (form.endTzid && form.endTzid !== form.startTzid) tags.push(['end_tzid', form.endTzid])
    // The `D` day-bucket tag (floor(start/86400)) is in the spec for
    // efficient relay-side bucketing. Cheap to add, harmless if ignored.
    const startSec = parseInt(form.start, 10)
    if (Number.isFinite(startSec)) {
      tags.push(['D', String(Math.floor(startSec / 86400))])
    }
  }

  if (form.summary) tags.push(['summary', String(form.summary).trim()])
  if (form.image && isSafeUrl(form.image)) tags.push(['image', form.image])
  if (form.location) tags.push(['location', String(form.location).trim()])

  for (const t of form.hashtags || []) {
    const h = String(t || '').replace(/^#/, '').trim().toLowerCase()
    if (h) tags.push(['t', h])
  }
  // Client-attribution tag — matches buildDonationBoostagramTemplate
  // and buildEpisodeBoostShareTemplate over in boostagram.js.
  tags.push(['client', 'localbitcoiners.com'])
  return { tags, dTag }
}

/**
 * Publish a calendar event (31922 or 31923).
 *
 * @returns {Promise<{ naddr, eventId, dTag, pubkey, kind, relays }>}
 */
export async function publishCalendarEvent(form) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (form.kind !== KIND_DATE_EVENT && form.kind !== KIND_TIME_EVENT) {
    throw new Error('Bad event kind — must be 31922 or 31923')
  }
  if (!form.title || !String(form.title).trim()) throw new Error('Title is required')
  if (!form.start) throw new Error('Start is required')

  const { tags, dTag } = buildCalendarEventTags(form)

  const event = new NDKEvent(ndk)
  event.kind = form.kind
  event.content = String(form.content || '')
  event.created_at = nextPublishedAt()
  event.tags = tags

  // Seed the pool with the user's NIP-65 write relays so the event
  // lands on the relays the user's followers actually read from.
  // Best-effort — a missing 10002 just means we publish to the
  // default fallback set.
  const me = ndk.activeUser?.pubkey
  if (me) await ensureUserWriteRelays(ndk, me).catch(() => {})
  await connectAndWait(ndk).catch(() => {})

  await signWithTimeout(event)
  // Two sides, in parallel: the user's outbox through NDK (their followers
  // read there), and the site's own relays through the plain pool. NDK's
  // relay set only includes our relays if they happen to be connected at
  // that instant, which right after sign-in they often are not, and the
  // Events feed (snapshot bot and live fallback alike) reads from ours; see
  // publishSignedToRelays. Neither side's failure hides the other's acks.
  const signed = event.toNostrEvent()
  const [outbox, site] = await Promise.all([
    event.publish().then(set => Array.from(set).map(r => r.url).filter(Boolean)).catch(() => []),
    publishSignedToRelays(signed, CALENDAR_EVENT_RELAYS),
  ])
  const confirmed = [...new Set([...site, ...outbox])]
  if (!confirmed.length) throw new Error('No relay accepted the event. Please try again.')
  const relays = confirmed

  let naddr = ''
  try {
    naddr = nip19.naddrEncode({
      kind: form.kind,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: relays.slice(0, 3),
    })
  } catch {}

  return {
    naddr,
    eventId: event.id,
    dTag,
    pubkey: event.pubkey,
    kind: form.kind,
    relays,
  }
}
