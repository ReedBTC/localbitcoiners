/* The wallet-side settlement check (paymentLookup.js and
 * externalBoost.js#confirmLegSettled), the second source of truth a leg with
 * no NWC reply went without until 2026-09-04. Ported from OnlyBoosts
 * (18d0febb) with one section added for the call sites only this site has.
 *
 * What it pins:
 *   - classifyLookup: `state` first, then settled_at / preimage for wallets
 *     that predate it; nothing but an explicit `state: "failed"` is `failed`;
 *   - classifyLookupError: NOT_IMPLEMENTED and a validation failure are
 *     `unsupported`, NOT_FOUND and everything else `unknown` — a payment the
 *     wallet cannot find is not one it proved it never made;
 *   - keysendPaymentHash against a known SHA-256 vector, and its refusal of
 *     anything that is not 32 hex bytes;
 *   - confirmViaWallet's loop: a definite answer ends it, `unsupported` ends
 *     it at once, a throwing lookup is one `unknown` poll, the deadline and
 *     the abort signal both end it with `unknown`;
 *   - confirmLegSettled with the wallet injected and `fetch` STUBBED for
 *     LUD-21: the wallet's settled answer wins with no verify URL, LUD-21's
 *     wins when the wallet is unsupported, the wallet's `failed` is returned
 *     as such and LUD-21 can never produce it, WebLN (no lookup) with no
 *     verify URL is `unknown` without a single call;
 *   - a SOURCE scan: every ambiguous-payment site in the widget — the show's
 *     own leg runner, its retry guard, payInvoiceVerified and the external
 *     modal — goes through confirmLegSettled, and none of them calls the
 *     LUD-21-only confirmInvoiceSettled directly any more. The two boost
 *     paths are separate code (see payAllLegs.js's note on that), so nothing
 *     but this scan keeps the second path from quietly keeping the first
 *     source only.
 *
 * Confirmed red on three mutations upstream: `failed` inferred from a missing
 * settled_at, NOT_FOUND classified as `failed`, and the loop's deadline check
 * removed (the test then hangs, which is red enough).
 *
 *   node scripts/test-payment-lookup.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  classifyLookup, classifyLookupError, keysendPaymentHash, confirmViaWallet,
} from '../login-widget/src/lib/paymentLookup.js'
import { confirmLegSettled, legIsCheckable } from '../login-widget/src/lib/externalBoost.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
async function ok(label, fn) { await fn(); passed++; console.log(`  ✓ ${label}`) }

const HASH = 'c'.repeat(64)

console.log('\nclassifyLookup')
await ok('state wins', () => {
  assert.equal(classifyLookup({ state: 'settled' }), 'settled')
  assert.equal(classifyLookup({ state: 'SETTLED', settled_at: 0 }), 'settled')
  assert.equal(classifyLookup({ state: 'failed', settled_at: 1 }), 'failed', 'an explicit failed outranks a stray settled_at')
  assert.equal(classifyLookup({ state: 'pending' }), 'pending')
  assert.equal(classifyLookup({ state: 'accepted' }), 'pending')
})
await ok('a wallet without `state` settles on settled_at or a preimage', () => {
  assert.equal(classifyLookup({ settled_at: 1788527946 }), 'settled')
  assert.equal(classifyLookup({ preimage: 'a'.repeat(64) }), 'settled')
  assert.equal(classifyLookup({ preimage: '' }), 'pending')
  assert.equal(classifyLookup({ settled_at: 0, preimage: null }), 'pending')
})
await ok('⚠️ failed is never inferred', () => {
  assert.equal(classifyLookup({ settled_at: null }), 'pending')
  assert.equal(classifyLookup({ type: 'outgoing' }), 'pending')
  assert.equal(classifyLookup({ state: 'expired' }), 'pending', 'an unknown state keeps the leg where it is')
  assert.equal(classifyLookup(null), 'unknown')
  assert.equal(classifyLookup('settled'), 'unknown')
})

console.log('\nclassifyLookupError')
await ok('no such method is unsupported', () => {
  assert.equal(classifyLookupError({ code: 'NOT_IMPLEMENTED', message: 'x' }), 'unsupported')
  assert.equal(classifyLookupError({ name: 'Nip47ResponseValidationError', message: 'response from NWC failed validation: …' }), 'unsupported')
  assert.equal(classifyLookupError({ code: 'RESTRICTED' }), 'unsupported')
})
await ok('⚠️ NOT_FOUND is unknown, not failed', () => {
  assert.equal(classifyLookupError({ code: 'NOT_FOUND', message: 'transaction not found' }), 'unknown')
  assert.equal(classifyLookupError({ name: 'Nip47ReplyTimeoutError', message: 'reply timeout: event abc' }), 'unknown')
  assert.equal(classifyLookupError(new Error('boom')), 'unknown')
  assert.equal(classifyLookupError(null), 'unknown')
})

console.log('\nkeysendPaymentHash')
await ok('SHA-256 of the preimage bytes, hex', async () => {
  assert.equal(await keysendPaymentHash('00'.repeat(32)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925')
  assert.equal(await keysendPaymentHash('FF'.repeat(32)), await keysendPaymentHash('ff'.repeat(32)))
})
await ok('anything but 32 hex bytes is null', async () => {
  assert.equal(await keysendPaymentHash(''), null)
  assert.equal(await keysendPaymentHash('00'.repeat(31)), null)
  assert.equal(await keysendPaymentHash('zz'.repeat(32)), null)
})

console.log('\nconfirmViaWallet')
await ok('a definite answer ends the loop', async () => {
  const answers = ['pending', 'unknown', 'settled', 'settled']
  let calls = 0
  const lookup = async () => answers[calls++]
  assert.equal(await confirmViaWallet({ lookup, paymentHash: HASH, deadlineMs: 5000, intervalMs: 5 }), 'settled')
  assert.equal(calls, 3)
})
await ok('failed is returned as the wallet said it', async () => {
  assert.equal(await confirmViaWallet({ lookup: async () => 'failed', paymentHash: HASH, deadlineMs: 5000, intervalMs: 5 }), 'failed')
})
await ok('unsupported ends it at once', async () => {
  let calls = 0
  assert.equal(await confirmViaWallet({ lookup: async () => { calls++; return 'unsupported' }, paymentHash: HASH, deadlineMs: 5000, intervalMs: 5 }), 'unsupported')
  assert.equal(calls, 1)
})
await ok('a throwing lookup is one unknown poll, and the deadline ends it', async () => {
  let calls = 0
  const lookup = async () => { calls++; throw new Error('relay down') }
  const t0 = Date.now()
  assert.equal(await confirmViaWallet({ lookup, paymentHash: HASH, deadlineMs: 40, intervalMs: 10 }), 'unknown')
  assert.ok(calls >= 2 && calls <= 6, `polled ${calls} times`)
  assert.ok(Date.now() - t0 < 500)
})
await ok('deadline 0 asks exactly once', async () => {
  let calls = 0
  assert.equal(await confirmViaWallet({ lookup: async () => { calls++; return 'pending' }, paymentHash: HASH, deadlineMs: 0 }), 'unknown')
  assert.equal(calls, 1)
})
await ok('an abort ends it', async () => {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 15)
  const t0 = Date.now()
  assert.equal(await confirmViaWallet({ lookup: async () => 'pending', paymentHash: HASH, deadlineMs: 5000, intervalMs: 10, signal: ctrl.signal }), 'unknown')
  assert.ok(Date.now() - t0 < 1000)
})
await ok('no lookup or no hash is unknown without a call', async () => {
  assert.equal(await confirmViaWallet({ lookup: null, paymentHash: HASH }), 'unknown')
  assert.equal(await confirmViaWallet({ lookup: async () => 'settled', paymentHash: '' }), 'unknown')
})

console.log('\nconfirmLegSettled (fetch stubbed for LUD-21)')
const realFetch = globalThis.fetch
let verifyCalls = 0
let verifyAnswer = { settled: false }
globalThis.fetch = async (url) => {
  verifyCalls++
  assert.ok(String(url).startsWith('https://verify.example/'), `only the verify URL is fetched, got ${url}`)
  return new Response(JSON.stringify(verifyAnswer), { status: 200, headers: { 'content-type': 'application/json' } })
}
try {
  await ok('the wallet settles a keysend leg with no verify URL', async () => {
    verifyCalls = 0
    const res = await confirmLegSettled({ paymentHash: HASH }, { deadlineMs: 500, intervalMs: 5, lookup: async () => 'settled' })
    assert.equal(res, 'settled')
    assert.equal(verifyCalls, 0)
  })
  await ok('LUD-21 settles the leg when the wallet cannot look up', async () => {
    verifyCalls = 0
    verifyAnswer = { settled: true }
    const res = await confirmLegSettled({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }, { deadlineMs: 500, intervalMs: 5, lookup: async () => 'unsupported' })
    assert.equal(res, 'settled')
    assert.ok(verifyCalls >= 1)
  })
  await ok('⚠️ the wallet\'s failed is returned, and LUD-21 cannot produce one', async () => {
    verifyAnswer = { settled: false }
    assert.equal(await confirmLegSettled({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }, { deadlineMs: 300, intervalMs: 5, lookup: async () => 'failed' }), 'failed')
    assert.equal(await confirmLegSettled({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }, { deadlineMs: 60, intervalMs: 5, lookup: async () => 'pending' }), 'unknown')
    assert.equal(await confirmLegSettled({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }, { deadlineMs: 60, intervalMs: 5, lookup: null }), 'unknown')
  })
  await ok('WebLN (no lookup) with no verify URL is unknown without a call', async () => {
    verifyCalls = 0
    assert.equal(await confirmLegSettled({ paymentHash: HASH }, { deadlineMs: 500, lookup: null }), 'unknown')
    assert.equal(verifyCalls, 0)
  })
  await ok('a leg with no payment hash is unknown', async () => {
    assert.equal(await confirmLegSettled({ verifyUrl: 'https://verify.example/x' }, { lookup: async () => 'settled' }), 'unknown')
  })
  await ok('the caller\'s abort ends both sides', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 15)
    const t0 = Date.now()
    assert.equal(await confirmLegSettled({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }, { deadlineMs: 5000, intervalMs: 10, signal: ctrl.signal, lookup: async () => 'pending' }), 'unknown')
    assert.ok(Date.now() - t0 < 1000)
  })
  await ok('legIsCheckable: a verify URL suffices; otherwise it is the wallet\'s call (none in Node)', () => {
    assert.equal(legIsCheckable({ paymentHash: HASH, verifyUrl: 'https://verify.example/x' }), true)
    assert.equal(legIsCheckable({ paymentHash: HASH, verifyUrl: 'http://verify.example/x' }), false)
    assert.equal(legIsCheckable({ verifyUrl: 'https://verify.example/x' }), false)
    assert.equal(legIsCheckable({ paymentHash: HASH }), false)
  })
} finally {
  globalThis.fetch = realFetch
}

console.log('\nevery ambiguous-payment site asks the wallet (source scan)')
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const count = (text, needle) => text.split(needle).length - 1
await ok('the show\'s leg runner, its retry guard, payInvoiceVerified and the external modal call confirmLegSettled', () => {
  for (const rel of [
    'login-widget/src/lib/payAllLegs.js',
    'login-widget/src/components/MultiLegBoostForm.jsx',
    'login-widget/src/index.jsx',
    'login-widget/src/components/ExternalBoostModal.jsx',
  ]) {
    const text = src(rel)
    assert.ok(count(text, 'confirmLegSettled(') >= 1, `${rel} does not call confirmLegSettled`)
    assert.equal(count(text, 'confirmInvoiceSettled('), 0, `${rel} still calls the LUD-21-only confirmInvoiceSettled directly`)
  }
})
await ok('confirmInvoiceSettled is reached only through confirmLegSettled', () => {
  assert.equal(count(src('login-widget/src/lib/externalBoost.js'), 'confirmInvoiceSettled('), 1)
})
await ok('the show\'s keysend leg stamps the hash before the pay call and hands the wallet a bare pubkey', () => {
  const text = src('login-widget/src/lib/payAllLegs.js')
  assert.ok(text.indexOf('keysendPaymentHash(preimage)') < text.indexOf('client.payKeysend('), 'hash is computed before payKeysend')
  assert.ok(text.includes('nodePubkeyOf(leg.recipient.address)'))
})
await ok('the wallet adapter carries lookupPayment on NWC and null on WebLN', () => {
  const text = src('login-widget/src/lib/wallet.js')
  assert.ok(text.includes('lookupPayment: (hash) => nwc.lookupPayment(hash)'))
  assert.ok(text.includes('lookupPayment: null'))
})
await ok('nwc.js#lookupPayment bypasses the SDK\'s lookupInvoice (which rejects a keysend\'s empty invoice)', () => {
  const text = src('login-widget/src/lib/nwc.js')
  assert.ok(text.includes("executeNip47Request(\n      'lookup_invoice'"))
  assert.equal(count(text, 'client.lookupInvoice('), 0)
})

console.log(`\ntest-payment-lookup: ${passed} passed`)
