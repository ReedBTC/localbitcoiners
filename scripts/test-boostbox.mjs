/**
 * The BoostBox descriptor path: `functions/api/boostbox.js` and the comment
 * builder that consumes it.
 *
 * Run: node scripts/test-boostbox.mjs
 *
 * ⚠️ IT MAKES NO NETWORK CALLS. `globalThis.fetch` is replaced for the duration,
 * so nothing here writes a record to tardbox or spends the shared API key. A
 * test that POSTed for real would leave a public metadata record behind on
 * somebody else's service every time anyone ran it.
 *
 * What it is guarding, in order of how badly each one fails in the wild:
 *
 *   1. **The comment's whole-or-nothing rule.** A truncation cuts from the
 *      right and the descriptor is on the left, so the naive concatenation
 *      shortens the URL into a dead link while spending the whole allowance on
 *      it. The recipient then fetches a 404. This is the failure BMB pins in
 *      its own check script and the reason that function exists.
 *   2. **The body allowlist.** These records are written under our API key and
 *      read by podcasters as our attribution, so a caller must not be able to
 *      put arbitrary fields into one.
 *   3. **Failing closed.** No key, no KV, upstream refusing — every one of
 *      those must end as a boost that still pays with a bare message.
 */
import assert from 'node:assert/strict'
import { buildRecord, overRateLimit, onRequestPost, HELIPAD_READS } from '../functions/api/boostbox.js'
import { buildLnurlComment, MAX_MESSAGE_CHARS } from '../login-widget/src/lib/externalBoostagram.js'

let passed = 0
async function ok(label, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${label}`)
}

function fakeKV() {
  const store = new Map()
  return {
    store,
    async get(k) { const v = store.get(k); return v === undefined ? null : v },
    async put(k, v) { store.set(k, v) },
  }
}

/** A stand-in for tardbox. Records what it was sent so the assertions can read
 *  the outbound body rather than guessing at it. */
function stubUpstream({ status = 200, body = null, headers = {} } = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return new Response(
      body === null ? JSON.stringify({ id: 'ID1', url: 'https://tardbox.com/boost/ID1', desc: 'ignored' }) : body,
      { status, headers: { 'content-type': 'application/json', ...headers } },
    )
  }
  return calls
}

const realFetch = globalThis.fetch

function post(body, env) {
  const request = new Request('https://localbitcoiners.com/api/boostbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.4' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return onRequestPost({ request, env })
}

const envOk = () => ({ BOOSTBOX_API_KEY: 'test-key', SIGN_RATELIMIT: fakeKV() })
const LEG = { value_msat: 33_000, value_msat_total: 100_000 }

console.log('\nThe comment, and the rule the naive version breaks:\n')

const URL_ = 'https://tardbox.com/boost/01K9R9E2JNE1CR0ME6CFM45T8E'
const DESC = `rss::payment::boost ${URL_}`

await ok('a descriptor that fits is followed by as much message as is left', () => {
  const c = buildLnurlComment({ descriptorUrl: URL_, message: 'x'.repeat(300), commentAllowed: 255 })
  assert.equal(c.length, 255)
  assert.equal(c.startsWith(`${DESC} `), true)
})

await ok('⚠️ a descriptor that does not fit is DROPPED, never truncated', () => {
  // The whole point. A shortened URL is not a degraded descriptor, it is a link
  // the recipient's tooling will try to fetch and fail on, and it has spent the
  // entire comment allowance to do it.
  const c = buildLnurlComment({ descriptorUrl: URL_, message: 'hello', commentAllowed: DESC.length - 1 })
  assert.equal(c, 'hello')
  assert.equal(c.includes('rss::payment'), false)
})

await ok('the URL is never cut, at any allowance that admits it at all', () => {
  for (let allowed = DESC.length; allowed <= DESC.length + 40; allowed++) {
    const c = buildLnurlComment({ descriptorUrl: URL_, message: 'y'.repeat(80), commentAllowed: allowed })
    assert.equal(c.length <= allowed, true, `overflowed at ${allowed}`)
    assert.equal(c.includes(URL_), true, `URL lost at ${allowed}`)
  }
})

await ok('no descriptor is the bare message, which is what shipped before', () => {
  assert.equal(buildLnurlComment({ descriptorUrl: '', message: 'hello', commentAllowed: 255 }), 'hello')
})

await ok('a recipient taking no comment gets none', () => {
  assert.equal(buildLnurlComment({ descriptorUrl: URL_, message: 'hello', commentAllowed: 0 }), '')
})

await ok('the message cap still applies inside the comment', () => {
  const c = buildLnurlComment({ descriptorUrl: '', message: 'z'.repeat(MAX_MESSAGE_CHARS + 50), commentAllowed: 5000 })
  assert.equal(c.length, MAX_MESSAGE_CHARS)
})

console.log('\nThe record, and what a caller may not put in it:\n')

await ok('⚠️ the DECLARED split wins over the realised one', () => {
  // The live test that caught this: a 33% leg of a 111-sat boost is floored to
  // 36 sats, which reads back as 32.4%. Deriving published 32 where the show's
  // own value block declares 33, and every other app reports the declared one.
  const r = buildRecord({ value_msat: 36_000, value_msat_total: 111_000, split: 33 })
  assert.equal(r.split, 33)
  assert.equal(Math.round((36_000 / 111_000) * 100), 32)
})

await ok('an absent or unusable split still falls back to the derivation', () => {
  assert.equal(buildRecord(LEG).split, 33)
  assert.equal(buildRecord({ ...LEG, split: 0 }).split, 33)
  assert.equal(buildRecord({ ...LEG, split: 101 }).split, 33)
  assert.equal(buildRecord({ ...LEG, split: 'lots' }).split, 33)
  assert.equal(buildRecord({ ...LEG, value_msat: 33_000, value_msat_total: 100_000 }).value_msat, 33_000)
})

await ok('⚠️ value_msat_total rides every record, since its absence is the bug', () => {
  // Helipad computes the split against this. Without it every boost renders as
  // "(100% split)" and the podcaster sees one leg as the whole payment.
  assert.equal(Object.hasOwn(buildRecord(LEG), 'value_msat_total'), true)
})

await ok('⚠️ the four strings Helipad reads survive, under ITS names', () => {
  // Helipad deserializes an `RssPayment` of nine fields and drops the rest, so a
  // field it does not name is a field that does not exist. `podcast` and
  // `episode` are the BOOSTAGRAM TLV's names for two of these, and sending
  // those instead is what produced a live row with a sender, a total and no
  // show at all. Measured 2026-08-22 against a real Helipad.
  const r = buildRecord({
    ...LEG,
    feed_title: 'Chad and Reeds Podcast',
    item_title: '003. Dimly LIT',
    message: 'hi',
    sender_name: 'Reed',
  })
  for (const f of HELIPAD_READS) assert.equal(Object.hasOwn(r, f), true, `${f} was dropped`)
  assert.equal(r.feed_title, 'Chad and Reeds Podcast')
  assert.equal(r.item_title, '003. Dimly LIT')
})

await ok('the TLV names are refused, so they cannot come back by habit', () => {
  const r = buildRecord({ ...LEG, podcast: 'Show', episode: 'Ep' })
  assert.equal(Object.hasOwn(r, 'podcast'), false)
  assert.equal(Object.hasOwn(r, 'episode'), false)
})

await ok('the guids ride twice, because only the remote pair reaches Helipad', () => {
  const r = buildRecord({
    ...LEG,
    feed_guid: 'F', item_guid: 'I', remote_feed_guid: 'F', remote_item_guid: 'I',
  })
  assert.equal(r.remote_feed_guid, 'F')
  assert.equal(r.remote_item_guid, 'I')
  assert.equal(r.feed_guid, 'F')
})

await ok('app_name is ours and is not caller-settable', () => {
  assert.equal(buildRecord({ ...LEG, app_name: 'Not Us' }).app_name, 'Local Bitcoiners')
})

await ok('action is pinned to boost', () => {
  assert.equal(buildRecord({ ...LEG, action: 'stream' }).action, 'boost')
})

await ok('unknown fields are dropped rather than forwarded', () => {
  const r = buildRecord({ ...LEG, evil: 'x', proxy_for_pubkey: 'deadbeef' })
  assert.equal(Object.hasOwn(r, 'evil'), false)
  assert.equal(Object.hasOwn(r, 'proxy_for_pubkey'), false)
})

await ok('a leg may not claim more than the boost it belongs to', () => {
  assert.throws(() => buildRecord({ value_msat: 200_000, value_msat_total: 100_000 }), /invalid amount/)
})

await ok('amounts are bounded at both ends', () => {
  assert.throws(() => buildRecord({ value_msat: 0, value_msat_total: 1 }), /invalid amount/)
  assert.throws(() => buildRecord({ value_msat: 1, value_msat_total: 5_000_000_001 }), /invalid amount/)
  assert.throws(() => buildRecord({ value_msat: 1.5, value_msat_total: 10 }), /invalid amount/)
})

await ok('control characters are stripped from forwarded strings', () => {
  const r = buildRecord({ ...LEG, message: 'a\u0000b\u001fc' })
  assert.equal(/[\u0000-\u001f]/.test(r.message), false)
})

console.log('\nThe handler, and every way it is allowed to fail:\n')

await ok('no API key answers 503 and calls nothing', async () => {
  const calls = stubUpstream()
  const res = await post(LEG, { SIGN_RATELIMIT: fakeKV() })
  assert.equal(res.status, 503)
  assert.equal(calls.length, 0)
})

await ok('no rate-limit namespace answers 503 and calls nothing', async () => {
  const calls = stubUpstream()
  const res = await post(LEG, { BOOSTBOX_API_KEY: 'k' })
  assert.equal(res.status, 503)
  assert.equal(calls.length, 0)
})

await ok('a good request forwards the key and returns id and url', async () => {
  const calls = stubUpstream()
  const res = await post({ ...LEG, message: 'hi', sender_name: 'Reed' }, envOk())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: 'ID1', url: 'https://tardbox.com/boost/ID1' })
  assert.equal(calls[0].init.headers['X-Api-Key'], 'test-key')
  assert.equal(calls[0].url, 'https://tardbox.com/boost')
})

await ok('⚠️ the upstream desc is NOT returned, so nobody can use it', async () => {
  // It is built with no knowledge of `commentAllowed`; a caller reaching for it
  // is a caller about to send a truncated URL.
  stubUpstream()
  const body = await (await post(LEG, envOk())).json()
  assert.equal(Object.hasOwn(body, 'desc'), false)
})

await ok('the response is never cached', async () => {
  stubUpstream()
  const res = await post(LEG, envOk())
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
})

await ok('an upstream refusal reports the status and not its body', async () => {
  stubUpstream({ status: 401, body: JSON.stringify({ error: 'unauthorized', secret: 'leaky' }) })
  const res = await post(LEG, envOk())
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.status, 401)
  assert.equal(JSON.stringify(body).includes('leaky'), false)
})

await ok('an upstream answer with no url is refused rather than passed on', async () => {
  stubUpstream({ body: JSON.stringify({ id: 'x' }) })
  assert.equal((await post(LEG, envOk())).status, 502)
})

await ok('a non-https url from upstream is refused', async () => {
  stubUpstream({ body: JSON.stringify({ id: 'x', url: 'http://tardbox.com/boost/x' }) })
  assert.equal((await post(LEG, envOk())).status, 502)
})

await ok('a network fault answers 502 rather than throwing', async () => {
  globalThis.fetch = async () => { throw new Error('econnreset') }
  assert.equal((await post(LEG, envOk())).status, 502)
})

await ok('malformed JSON answers 400, not 500', async () => {
  stubUpstream()
  assert.equal((await post('{not json', envOk())).status, 400)
})

await ok('over the limit it answers 429 and calls nothing', async () => {
  const kv = fakeKV()
  for (let i = 0; i < 60; i++) await overRateLimit(kv, '203.0.113.4')
  const calls = stubUpstream()
  const res = await post(LEG, { BOOSTBOX_API_KEY: 'k', SIGN_RATELIMIT: kv })
  assert.equal(res.status, 429)
  assert.equal(calls.length, 0)
})

await ok('⚠️ the limit is per LEG, so an ordinary many-leg boost is not refused', async () => {
  // A value block with ten lnaddress recipients is ten POSTs from one press.
  // The signing oracle's 5/min would refuse the sixth leg of a normal boost.
  const kv = fakeKV()
  for (let i = 0; i < 10; i++) {
    assert.equal(await overRateLimit(kv, '203.0.113.9'), false, `refused leg ${i + 1}`)
  }
})

await ok('the counter is windowed, so the next minute starts clean', async () => {
  const kv = fakeKV()
  const t0 = Date.now()
  for (let i = 0; i < 60; i++) await overRateLimit(kv, '198.51.100.1', t0)
  assert.equal(await overRateLimit(kv, '198.51.100.1', t0), true)
  assert.equal(await overRateLimit(kv, '198.51.100.1', t0 + 61_000), false)
})

globalThis.fetch = realFetch
console.log(`\n${passed} assertions passed.\n`)
