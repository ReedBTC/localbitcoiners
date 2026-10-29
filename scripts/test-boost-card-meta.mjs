/**
 * The boost card's meta row: `assets/js/boost-card-meta.js`.
 *
 * Run: node scripts/test-boost-card-meta.mjs
 *
 * No network. Feeds the module parsed wall records (boost-record.js's
 * parseWallRecord, the same shapes test-boost-record.mjs uses) and checks:
 *
 *   1. The row is sats, "via <app>", and the episode by TITLE with a link to
 *      /ep### (zero-padded), the show-name prefix cut from the feed's title.
 *   2. A record with a number but no title falls back to "Ep. N"; a
 *      show-level boost says "Show boost"; no sats, no row.
 *   3. `withEpisode: false` (the episode's own page) drops the episode part
 *      and keeps the rest.
 */
import assert from 'node:assert/strict'
import { parseWallRecord } from '../assets/js/boost-record.js'
import { metaRowOf, episodeDisplayTitle, episodeHrefOf } from '../assets/js/boost-card-meta.js'

let passed = 0
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`) }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const record = (over = {}) => ({
  event: { id: 'a'.repeat(64), kind: 1, pubkey: 'b'.repeat(64), created_at: 1, tags: [], content: '' },
  payment_hash: 'ph1', sats: 2100, sender_npub: null,
  episode_id: 'JXHZ', episode_num: '034',
  episode_title: 'Local Bitcoiners • VanCity Inflation Mints Meetups w/Kurtis and Fustler: Vancouver, BC | Ep. 034',
  show_level: false, app: 'Fountain', source: 'fountain_boost', settled_at: '2026-10-29T13:20:02Z',
  ...over,
})

console.log('episodeDisplayTitle')
ok('cuts the show-name prefix and keeps the rest verbatim', () => {
  assert.equal(episodeDisplayTitle('Local Bitcoiners • Making Meetups Fun & Sustainable: Bitcoin Bay | Ep. 008'),
    'Making Meetups Fun & Sustainable: Bitcoin Bay | Ep. 008')
  assert.equal(episodeDisplayTitle('Local Bitcoiners • 001. The First One'), '001. The First One')
  assert.equal(episodeDisplayTitle('local bitcoiners - Lowercase Dash'), 'Lowercase Dash')
})
ok('a title without the prefix is untouched; a non-string is empty', () => {
  assert.equal(episodeDisplayTitle('Some Other Title'), 'Some Other Title')
  assert.equal(episodeDisplayTitle(null), '')
  assert.equal(episodeDisplayTitle(undefined), '')
})
ok('the bare show name (what show-level records carry) is empty', () => {
  assert.equal(episodeDisplayTitle('Local Bitcoiners'), '')
})

console.log('episodeHrefOf')
ok('/ep### from the zero-padded episode_num string', () => {
  assert.equal(episodeHrefOf(parseWallRecord(record())), '/ep034')
  assert.equal(episodeHrefOf(parseWallRecord(record({ episode_num: '7' }))), '/ep007')
  assert.equal(episodeHrefOf(parseWallRecord(record({ episode_num: '1234' }))), '/ep1234')
})
ok('null without a usable number', () => {
  const rec = record(); delete rec.episode_num
  assert.equal(episodeHrefOf(parseWallRecord(rec)), null)
  assert.equal(episodeHrefOf(parseWallRecord(record({ episode_num: 'abc' }))), null)
  assert.equal(episodeHrefOf(null), null)
})

console.log('metaRowOf')
ok('sats · via app · episode title linking to the episode page', () => {
  assert.deepEqual(metaRowOf(parseWallRecord(record())), {
    sats: '2,100 sats', via: 'via Fountain',
    episode: { label: 'VanCity Inflation Mints Meetups w/Kurtis and Fustler: Vancouver, BC | Ep. 034', href: '/ep034', num: 34 },
    showBoost: false,
  })
})
ok('no app, no via', () => {
  assert.equal(metaRowOf(parseWallRecord(record({ app: '' }))).via, null)
})
ok('a number without a title falls back to "Ep. N"', () => {
  const rec = record(); delete rec.episode_title
  assert.deepEqual(metaRowOf(parseWallRecord(rec)).episode, { label: 'Ep. 34', href: '/ep034', num: 34 })
})
ok('a title that is only the show name falls back to "Ep. N" too', () => {
  assert.equal(metaRowOf(parseWallRecord(record({ episode_title: 'Local Bitcoiners' }))).episode.label, 'Ep. 34')
})
ok('a show-level boost says so and names no episode', () => {
  const rec = record({ show_level: true, episode_title: 'Local Bitcoiners' }); delete rec.episode_num
  const row = metaRowOf(parseWallRecord(rec))
  assert.equal(row.episode, null); assert.equal(row.showBoost, true); assert.equal(row.sats, '2,100 sats')
})
ok('withEpisode: false keeps sats and app and drops the episode', () => {
  const row = metaRowOf(parseWallRecord(record()), { withEpisode: false })
  assert.equal(row.episode, null); assert.equal(row.showBoost, false)
  assert.equal(row.sats, '2,100 sats'); assert.equal(row.via, 'via Fountain')
})
ok('no sats, no row; no meta, no row', () => {
  const rec = record(); delete rec.sats
  assert.equal(metaRowOf(parseWallRecord(rec)), null)
  assert.equal(metaRowOf(null), null)
})

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`)
