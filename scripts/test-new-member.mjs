/**
 * The New Member rule on the boost wall: `assets/js/new-member.js`.
 *
 * Run: node scripts/test-new-member.mjs
 *
 * No network. The rule is pure over ledger rows; this feeds it synthetic
 * rows shaped like /api/sats and checks the calls documented in the module:
 *
 *   1. One badge per npub, on the earliest boost by settled_at.
 *   2. A typed name is no identity: name-only boosts never get the badge.
 *   3. Hosts and past guests never get the badge.
 *   4. Streams and zaps neither earn nor block the badge.
 *   5. loadFirstBoosts fails quiet (null) on a bad ledger OR a bad guest
 *      list, so a guest is never welcomed because the list was missing.
 */
import assert from 'node:assert/strict'
import { identityOf, firstBoostHashes, loadFirstBoosts, HOST_NPUBS } from '../assets/js/new-member.js'

let passed = 0
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`) }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const row = (o) => ({ kind: 'boost', payment_hash: null, sender_npub: null, sender_name: null, settled_at: '2026-05-01T00:00:00Z', total_sats: 100, ...o })
const ALICE = 'npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const GUEST = 'npub1gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg'
const REED  = 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s'

console.log('identityOf')
ok('the npub is the identity', () => assert.equal(identityOf({ sender_npub: ALICE, sender_name: 'Alice' }), ALICE))
ok('a typed name alone is no identity', () => {
  for (const n of ['Logues', 'ChadF', 'A Local Bitcoiner', 'anon', 'ChadF and 33 others']) assert.equal(identityOf({ sender_name: n }), null, n)
})
ok('blank or missing is no identity', () => { assert.equal(identityOf({ sender_npub: ' ' }), null); assert.equal(identityOf(null), null) })

console.log('firstBoostHashes')
ok('earliest boost per npub, later ones not', () => {
  const set = firstBoostHashes([
    row({ payment_hash: 'h2', sender_npub: ALICE, settled_at: '2026-05-02T00:00:00Z' }),
    row({ payment_hash: 'h1', sender_npub: ALICE, settled_at: '2026-05-01T00:00:00Z' }),
    row({ payment_hash: 'h3', sender_npub: ALICE, settled_at: '2026-05-03T00:00:00Z' }),
  ])
  assert.deepEqual([...set], ['h1'])
})
ok('ledger order breaks a timestamp tie', () => {
  const set = firstBoostHashes([
    row({ payment_hash: 'first', sender_npub: ALICE }),
    row({ payment_hash: 'second', sender_npub: ALICE }),
  ])
  assert.deepEqual([...set], ['first'])
})
ok('an earlier stream or zap does not block the first boost', () => {
  const set = firstBoostHashes([
    row({ kind: 'stream', payment_hash: null, sender_npub: ALICE, settled_at: '2026-01-01T00:00:00Z' }),
    row({ kind: 'zap', payment_hash: 'z', sender_npub: ALICE, settled_at: '2026-02-01T00:00:00Z', total_sats: 5000 }),
    row({ payment_hash: 'b', sender_npub: ALICE, settled_at: '2026-05-01T00:00:00Z' }),
  ])
  assert.deepEqual([...set], ['b'])
})
ok('zaps and streams never get the badge themselves', () => {
  const set = firstBoostHashes([
    row({ kind: 'zap', payment_hash: 'z', sender_npub: ALICE }),
    row({ kind: 'stream', payment_hash: 's', sender_npub: ALICE }),
  ])
  assert.equal(set.size, 0)
})
ok('a name-only first boost earns nothing, and does not spend the npub\'s badge', () => {
  const set = firstBoostHashes([
    row({ payment_hash: 'n', sender_name: 'Alice', settled_at: '2026-05-01T00:00:00Z' }),
    row({ payment_hash: 'p', sender_npub: ALICE, settled_at: '2026-05-02T00:00:00Z' }),
  ])
  assert.deepEqual([...set], ['p'])
})
ok('hosts are excluded by default, guests when passed', () => {
  const rows = [
    row({ payment_hash: 'r', sender_npub: REED }),
    row({ payment_hash: 'g', sender_npub: GUEST }),
    row({ payment_hash: 'a', sender_npub: ALICE }),
  ]
  assert.deepEqual([...firstBoostHashes(rows)].sort(), ['a', 'g'])
  assert.deepEqual([...firstBoostHashes(rows, { exclude: new Set([...HOST_NPUBS, GUEST]) })], ['a'])
})
ok('a guest is excluded even when the boost predates the episode', () => {
  const set = firstBoostHashes([row({ payment_hash: 'g', sender_npub: GUEST, settled_at: '2025-01-01T00:00:00Z' })], { exclude: new Set([GUEST]) })
  assert.equal(set.size, 0)
})
ok('hashless and undated rows are skipped', () => {
  const set = firstBoostHashes([
    row({ payment_hash: null, sender_npub: ALICE }),
    row({ payment_hash: 'u', sender_npub: ALICE, settled_at: 'not a date' }),
  ])
  assert.equal(set.size, 0)
})
ok('garbage input is an empty set', () => {
  assert.equal(firstBoostHashes(null).size, 0)
  assert.equal(firstBoostHashes([null, 1, 'x', {}]).size, 0)
})

console.log('loadFirstBoosts')
const realFetch = globalThis.fetch
async function withFetch(impl, fn) { globalThis.fetch = impl; try { return await fn() } finally { globalThis.fetch = realFetch } }
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
// Route by URL: sats and guests are fetched in one Promise.all.
const routes = (sats, guests) => async (url) => url.includes('guests') ? guests : sats
const LEDGER = { rows: [row({ payment_hash: 'h1', sender_npub: ALICE }), row({ payment_hash: 'g1', sender_npub: GUEST })] }
await (async () => {
  const good = await withFetch(routes(reply(LEDGER), reply({ guests: [GUEST] })), () => loadFirstBoosts())
  ok('ledger + guests resolve to a checker that skips the guest', () => { assert.equal(good.count, 1); assert.equal(good.isFirstBoost('h1'), true); assert.equal(good.isFirstBoost('g1'), false); assert.equal(good.isFirstBoost(null), false) })
  const bare = await withFetch(routes(reply(LEDGER.rows), reply({ guests: [] })), () => loadFirstBoosts())
  ok('a bare ledger array works too', () => assert.equal(bare.isFirstBoost('g1'), true))
  const badSats = await withFetch(routes(reply('Please use a Nostr client to connect.'), reply({ guests: [] })), () => loadFirstBoosts())
  ok('a non-array ledger is null', () => assert.equal(badSats, null))
  const satsErr = await withFetch(routes(reply({}, 502), reply({ guests: [] })), () => loadFirstBoosts())
  ok('a ledger upstream error is null', () => assert.equal(satsErr, null))
  const guestsErr = await withFetch(routes(reply(LEDGER), reply({ guests: [], error: 'feed_error' }, 502)), () => loadFirstBoosts())
  ok('a guest-list upstream error is null (fails closed)', () => assert.equal(guestsErr, null))
  const guestsShape = await withFetch(routes(reply(LEDGER), reply({ nope: true })), () => loadFirstBoosts())
  ok('a guest list without an array is null (fails closed)', () => assert.equal(guestsShape, null))
  const thrown = await withFetch(async () => { throw new Error('offline') }, () => loadFirstBoosts())
  ok('a thrown fetch is null', () => assert.equal(thrown, null))
})()

console.log(process.exitCode ? `\n${passed} passed, with failures` : `\nall ${passed} passed`)
