/**
 * The New Member rule on the boost wall: `assets/js/new-member.js`.
 *
 * Run: node scripts/test-new-member.mjs
 *
 * No network. The rule is pure over ledger rows; this feeds it synthetic
 * rows shaped like /api/sats and checks the calls documented in the module:
 *
 *   1. One badge per identity, on the earliest boost by settled_at.
 *   2. Streams and zaps neither earn nor block the badge.
 *   3. Placeholder and group names are no identity, so never a badge.
 *   4. The hosts are never new, by npub or by name.
 *   5. loadFirstBoosts fails quiet (null) on a bad response or body.
 */
import assert from 'node:assert/strict'
import { identityOf, firstBoostHashes, loadFirstBoosts } from '../assets/js/new-member.js'

let passed = 0
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`) }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const row = (o) => ({ kind: 'boost', payment_hash: null, sender_npub: null, sender_name: null, settled_at: '2026-05-01T00:00:00Z', total_sats: 100, ...o })
const ALICE = 'npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REED  = 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s'

console.log('identityOf')
ok('npub wins over a name', () => assert.equal(identityOf({ sender_npub: ALICE, sender_name: 'Alice' }), ALICE))
ok('name-only is case-folded and trimmed', () => assert.equal(identityOf({ sender_name: '  Logues ' }), 'name:logues'))
ok('placeholder names are no identity', () => {
  for (const n of ['A Local Bitcoiner', 'anon', 'Anonymous', 'onlyboosts.social user', 'boostmebitch.com user']) assert.equal(identityOf({ sender_name: n }), null, n)
})
ok('group boosts are no identity', () => assert.equal(identityOf({ sender_name: 'ChadF and 33 others' }), null))
ok('hosts are no identity, by npub and by name', () => {
  assert.equal(identityOf({ sender_npub: REED }), null)
  assert.equal(identityOf({ sender_name: 'Reed' }), null)
  assert.equal(identityOf({ sender_name: 'rev.hodl' }), null)
})
ok('blank is no identity', () => assert.equal(identityOf({ sender_name: '' }), null) || assert.equal(identityOf(null), null))

console.log('firstBoostHashes')
ok('earliest boost per identity, later ones not', () => {
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
ok('name-only and npub identities are separate', () => {
  const set = firstBoostHashes([
    row({ payment_hash: 'n', sender_name: 'Logues', settled_at: '2026-05-01T00:00:00Z' }),
    row({ payment_hash: 'p', sender_npub: ALICE, settled_at: '2026-05-02T00:00:00Z' }),
  ])
  assert.deepEqual([...set].sort(), ['n', 'p'])
})
ok('placeholder, host, hashless and undated rows are skipped', () => {
  const set = firstBoostHashes([
    row({ payment_hash: 'a', sender_name: 'A Local Bitcoiner' }),
    row({ payment_hash: 'r', sender_npub: REED }),
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
const json = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body })
await (async () => {
  const good = await withFetch(json({ rows: [row({ payment_hash: 'h1', sender_npub: ALICE })] }), () => loadFirstBoosts())
  ok('wrapped rows resolve to a checker', () => { assert.equal(good.count, 1); assert.equal(good.isFirstBoost('h1'), true); assert.equal(good.isFirstBoost('nope'), false); assert.equal(good.isFirstBoost(null), false) })
  const bare = await withFetch(json([row({ payment_hash: 'h1', sender_npub: ALICE })]), () => loadFirstBoosts())
  ok('a bare array works too', () => assert.equal(bare.isFirstBoost('h1'), true))
  const bad = await withFetch(json('Please use a Nostr client to connect.'), () => loadFirstBoosts())
  ok('a non-array body is null', () => assert.equal(bad, null))
  const err = await withFetch(json({}, 502), () => loadFirstBoosts())
  ok('an upstream error is null', () => assert.equal(err, null))
  const thrown = await withFetch(async () => { throw new Error('offline') }, () => loadFirstBoosts())
  ok('a thrown fetch is null', () => assert.equal(thrown, null))
})()

console.log(process.exitCode ? `\n${passed} passed, with failures` : `\nall ${passed} passed`)
