/**
 * The one-card rule on the boost wall: `assets/js/boost-record.js`.
 *
 * Run: node scripts/test-boost-record.mjs
 *
 * No network. Feeds the module wall records shaped like /api/boost-wall
 * since lb-v86 and checks the calls documented in it:
 *
 *   1. A record with donor_event shows the donor's note; without one, the
 *      show's note. The show note stays the key.
 *   2. Sats, time and episode come from the record, never from the shown
 *      note's text; the text regexes only serve events without a record.
 *   3. Fountain's trailer is stripped at render only when its nevent is a
 *      kind-9735 zap receipt; a quoted kind-1 is left alone.
 *   4. A donor_event that is not kind 1, or whose signer is not the sender
 *      the record names, is refused.
 *   5. The meta strip prints sats · app · episode, and nothing on a record
 *      without sats.
 */
import assert from 'node:assert/strict'
import {
  parseWallRecord, displayEventOf, isDonorCard, boostSatsOf, boostTimeOf,
  episodeNumMatches, metaStripParts, stripFountainTrailer, neventKind,
  displayContentOf, donorEventProblem,
} from '../assets/js/boost-record.js'

let passed = 0
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`) }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const SENDER_HEX = '0a6863dfcf6534171557d9cac249ef47e0c5d6caa5c311a853149f535ef48681'
const SENDER_NPUB = 'npub1pf5x8h70v56pw92hm89vyj00glsvt4k25hp3r2znzj04xhh5s6qs0jthwf'
const SHOW_HEX = 'c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592'
const ROOT = 'e36cb32dad0e08cfc6f1e2519f4c955a67c2a6bbc2797922626b3078eaaf3fd4'

// A real Fountain trailer: the nevent is the zap receipt (kind 9735).
const ZAP_NEVENT = 'nevent1qvzqqqpxqupzpwrxeemtukuzv62esqjgxg4cmaxrs9sgl7j6tdrufuaturv0wea9qqsf0cgz8fjjem0au90rvkmvnymvgjj95vem3fz5f9vwc7vw09n4arskmzmmk'
// A kind-1 nevent (kind TLV = 1), for the quoted-note case.
const NOTE_NEVENT = 'nevent1qqsrg23qx5kjhw3zgs4fmtg9dx3szr6z7tmvjf4svrvsr08nlv7w7q3qzyqqqqqqmyfyn5'

const showEvent = (over = {}) => ({
  id: 'a'.repeat(64), kind: 1, pubkey: SHOW_HEX, created_at: 1792143900, sig: 'x',
  tags: [['e', ROOT, '', 'root']],
  content: '⚡ New boost on Local Bitcoiners!\n💰 100 sats 📱 via Fountain\n👤 nostr:' + SENDER_NPUB
    + '\n💬 Toxic Maximalism has its place.\n🎙️ Local Bitcoiners • The Death Throes w/Johnny | Ep. 032\n🔗 https://fountain.fm/episode/VR6Q',
  ...over,
})
const donorEvent = (over = {}) => ({
  id: 'b'.repeat(64), kind: 1, pubkey: SENDER_HEX, created_at: 1792143773, sig: 'y', tags: [],
  content: 'Toxic Maximalism has its place.\n\nhttps://fountain.fm/episode/VR6Q4kwdypJ8yF51X66y\n\nnostr:' + ZAP_NEVENT,
  ...over,
})
const record = (over = {}) => ({
  event: showEvent(), payment_hash: 'ph1', sats: 100, sender_npub: SENDER_NPUB,
  episode_id: 'VR6Q', episode_num: '032', episode_title: 't', show_level: false,
  app: 'Fountain', source: 'fountain_boost', settled_at: '2026-10-16T09:42:51Z',
  standalone_id: 'c'.repeat(64), ...over,
})

console.log('parseWallRecord')
ok('reads the donor fields and keeps the old ones', () => {
  const m = parseWallRecord(record({ donor_event: donorEvent(), donor_note_id: 'b'.repeat(64), donor_match: 'npub+message', message: 'Toxic Maximalism has its place.' }))
  assert.equal(m.donorEvent.id, 'b'.repeat(64))
  assert.equal(m.donorNoteId, 'b'.repeat(64))
  assert.equal(m.donorMatch, 'npub+message')
  assert.equal(m.message, 'Toxic Maximalism has its place.')
  assert.equal(m.sats, 100); assert.equal(m.episodeNum, '032'); assert.equal(m.paymentHash, 'ph1')
})
ok('absent donor fields are null, not undefined', () => {
  const m = parseWallRecord(record())
  assert.equal(m.donorEvent, null); assert.equal(m.donorNoteId, null); assert.equal(m.message, null)
})
ok('a donor_event that is not a kind 1 is dropped at parse', () => {
  assert.equal(parseWallRecord(record({ donor_event: donorEvent({ kind: 9735 }) })).donorEvent, null)
})

console.log('displayEventOf / isDonorCard')
ok('the donor note is shown when the record has one', () => {
  const ev = showEvent(); const m = parseWallRecord(record({ donor_event: donorEvent() }))
  assert.equal(displayEventOf(ev, m).id, 'b'.repeat(64)); assert.equal(isDonorCard(m), true)
})
ok('the show note is shown otherwise, and with no meta at all', () => {
  const ev = showEvent()
  assert.equal(displayEventOf(ev, parseWallRecord(record())).id, ev.id)
  assert.equal(displayEventOf(ev, null).id, ev.id)
  assert.equal(isDonorCard(null), false)
})
ok('a known-but-unfetched donor note (id only) still shows the show note', () => {
  const m = parseWallRecord(record({ donor_note_id: 'b'.repeat(64) }))
  assert.equal(displayEventOf(showEvent(), m).pubkey, SHOW_HEX); assert.equal(isDonorCard(m), false)
})

console.log('sats / time / episode come from the record')
ok('sats: record first', () => {
  assert.equal(boostSatsOf(showEvent(), parseWallRecord(record({ sats: 2100 }))), 2100)
})
ok('sats: 💰 line of the SHOW note when there is no record', () => {
  assert.equal(boostSatsOf(showEvent(), null), 100)
  assert.equal(boostSatsOf(showEvent({ content: 'hi' }), null), 0)
})
ok('time: settled_at, not the donor note or the show note', () => {
  const m = parseWallRecord(record({ donor_event: donorEvent() }))
  assert.equal(boostTimeOf(showEvent(), m), Math.floor(Date.parse('2026-10-16T09:42:51Z') / 1000))
})
ok('time: show note created_at without a record or with a bad settled_at', () => {
  assert.equal(boostTimeOf(showEvent(), null), 1792143900)
  assert.equal(boostTimeOf(showEvent(), parseWallRecord(record({ settled_at: 'garbage' }))), 1792143900)
})
ok('episode: zero-padded string against an int', () => {
  const m = parseWallRecord(record({ episode_num: '032' }))
  assert.equal(episodeNumMatches(showEvent({ content: 'no marker' }), m, 32), true)
  assert.equal(episodeNumMatches(showEvent(), m, 3), false)
  assert.equal(episodeNumMatches(showEvent(), parseWallRecord(record({ episode_num: '001' })), 1), true)
})
ok('episode: a record without episode_num never matches, whatever the text says', () => {
  const rec = record(); delete rec.episode_num
  assert.equal(episodeNumMatches(showEvent(), parseWallRecord(rec), 32), false)
})
ok('episode: the 🎙️ regex only for events without a record', () => {
  assert.equal(episodeNumMatches(showEvent(), null, 32), true)
  assert.equal(episodeNumMatches(showEvent(), null, 3), false)
  assert.equal(episodeNumMatches(showEvent({ content: '🎙️ Local Bitcoiners • 001. Starting' }), null, 1), true)
  assert.equal(episodeNumMatches(showEvent({ content: '• 1. not the show' }), null, 1), false)
  assert.equal(episodeNumMatches(showEvent(), null, 0), false)
})

console.log('Fountain trailer')
ok('neventKind decodes the kind TLV', () => {
  assert.equal(neventKind(ZAP_NEVENT), 9735)
  assert.equal(neventKind('npub1xyz'), null)
  assert.equal(neventKind(''), null)
})
ok('a zap-receipt trailer is stripped', () => {
  assert.equal(stripFountainTrailer(donorEvent().content), 'Toxic Maximalism has its place.')
})
ok('a quoted kind-1 at the end is kept', () => {
  const text = 'look at this\n\nhttps://fountain.fm/episode/VR6Q\n\nnostr:' + NOTE_NEVENT
  assert.equal(stripFountainTrailer(text), text)
})
ok('no trailer, no change; empty stays empty', () => {
  assert.equal(stripFountainTrailer('plain'), 'plain'); assert.equal(stripFountainTrailer(''), '')
})
ok('displayContentOf strips on donor cards only', () => {
  const m = parseWallRecord(record({ donor_event: donorEvent() }))
  assert.equal(displayContentOf(showEvent(), m), 'Toxic Maximalism has its place.')
  const showWithTrailer = showEvent({ content: 'x https://fountain.fm/episode/a nostr:' + ZAP_NEVENT })
  assert.equal(displayContentOf(showWithTrailer, null), showWithTrailer.content)
})

console.log('donorEventProblem')
ok('a donor note signed by the named sender passes', () => {
  assert.equal(donorEventProblem(parseWallRecord(record({ donor_event: donorEvent() })), SENDER_HEX), null)
})
ok('a donor note signed by someone else is refused', () => {
  const m = parseWallRecord(record({ donor_event: donorEvent({ pubkey: SHOW_HEX }) }))
  assert.equal(donorEventProblem(m, SENDER_HEX), 'pubkey-mismatch')
})
ok('an anonymous record (no sender) accepts any well-formed signer', () => {
  assert.equal(donorEventProblem(parseWallRecord(record({ donor_event: donorEvent() })), null), null)
})
ok('a malformed pubkey is refused; no donor note is no problem', () => {
  assert.equal(donorEventProblem(parseWallRecord(record({ donor_event: donorEvent({ pubkey: 'nope' }) })), null), 'bad-pubkey')
  assert.equal(donorEventProblem(parseWallRecord(record()), SENDER_HEX), null)
})

console.log('metaStripParts')
ok('sats · app · episode', () => {
  assert.deepEqual(metaStripParts(parseWallRecord(record({ sats: 2100 }))), ['⚡ 2,100 sats', 'via Fountain', 'Ep. 32'])
})
ok('show-level boost says so; no app is skipped', () => {
  const rec = record({ show_level: true, app: '' }); delete rec.episode_num
  assert.deepEqual(metaStripParts(parseWallRecord(rec)), ['⚡ 100 sats', 'Show boost'])
})
ok('no sats, no strip', () => {
  const rec = record(); delete rec.sats
  assert.deepEqual(metaStripParts(parseWallRecord(rec)), []); assert.deepEqual(metaStripParts(null), [])
})

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`)
