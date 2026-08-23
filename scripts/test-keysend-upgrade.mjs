/**
 * The keysend upgrade: `functions/api/keysend.js` and `keysendLookup.js`.
 *
 * Run: node scripts/test-keysend-upgrade.mjs
 *
 * ⚠️ IT MAKES NO NETWORK CALLS. `globalThis.fetch` is replaced for the
 * duration, so nothing here probes a third party's well-known.
 *
 * This one guards a money path in a way the other seven do not: every rule
 * below decides **where sats are addressed**, and the leg it decides for has
 * already stopped being retryable by the time anything goes wrong. Once a
 * wallet has been handed a keysend there is no observation proving it did not
 * go out, so there is no falling back to LNURL afterwards. Everything that
 * could disqualify a leg has to be caught here, before the payment.
 *
 * In order of how badly each fails in the wild:
 *
 *   1. **`notfountain.fm` must not match `fountain.fm`.** The exclusion list
 *      is matched exact-or-parent; a bare `endsWith` hands anyone who can
 *      register a hostname the ability to strip the inline boostagram off
 *      other people's payments.
 *   2. **A routing pair is never assembled from two objects.** `customKey` and
 *      `customValue` address a sub-account on a shared node, so a key from one
 *      entry paired with a value from another pays a stranger.
 *   3. **The strict pubkey check.** `primal.net` answers the probe HTTP 200
 *      with its SPA's HTML — three legs of the measured top-30 corpus — so a
 *      status check alone reads them as upgradeable.
 *   4. **The wallet gate.** An lnaddress leg pays over BOLT11, which every
 *      rail speaks; a keysend leg does not. Upgrading a leg a wallet cannot
 *      pay trades a payment for metadata, which is the wrong way round.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { onRequestGet, parseAddress } from '../functions/api/keysend.js'
/* ⚠️ STATICALLY, AND BEFORE THE WALLET-GATE SECTION STUBS `globalThis.window`.
 * externalBoost.js registers a `beforeunload` guard at module scope, so a
 * lazy import lands after the stub and calls addEventListener on a bare
 * object. Node runs static imports first, which is the whole fix. */
import { _isCleanDeclineForTests as isCleanDecline } from '../login-widget/src/lib/externalBoost.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
async function ok(label, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${label}`)
}

/* keysendLookup.js reads the live wallet to answer "can this rail keysend".
 * Its two dependencies are rewritten to stubs the test can drive; everything
 * else in the file is the shipped source. Same arrangement as
 * test-feed-lang.mjs. */
const dir = mkdtempSync(join(tmpdir(), 'ob-keysend-'))
writeFileSync(join(dir, 'wallet.js'), `
export function getStatus() { return { kind: globalThis.__kind ?? null } }
export function onChange(fn) { globalThis.__walletListener = fn; return () => {} }
`)
writeFileSync(join(dir, 'nwc.js'), `
export function getClient() {
  if (globalThis.__nwcThrows) throw new Error('no client')
  return {
    async getWalletServiceInfo() {
      globalThis.__infoCalls = (globalThis.__infoCalls || 0) + 1
      if (globalThis.__infoThrows) throw new Error('relay unreachable')
      return { capabilities: globalThis.__caps || [] }
    },
  }
}
`)
writeFileSync(
  join(dir, 'keysendLookup.js'),
  readFileSync(join(ROOT, 'login-widget/src/lib/keysendLookup.js'), 'utf8'),
)
const {
  isLnurlOnlyAddress, parseKeysendResponse, lookupKeysendTarget,
  walletCanKeysend, noteKeysendUnsupported, clearKeysendLookupCache,
} = await import(pathToFileURL(join(dir, 'keysendLookup.js')).href)

const realFetch = globalThis.fetch
const PUBKEY = '02' + 'a'.repeat(64)
const PUBKEY2 = '03' + 'b'.repeat(64)

/** Records every outbound request so the assertions can read what was asked
 *  for rather than guessing at it. */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return handler(String(url), init, calls.length)
  }
  return calls
}
const jsonResp = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const req = (addr) =>
  onRequestGet({ request: new Request(`https://onlyboosts.social/api/keysend?addr=${addr}`) })

try {
  console.log('\nThe exclusion list — exact-or-parent, never endsWith')

  await ok('fountain.fm is excluded', () => {
    assert.equal(isLnurlOnlyAddress('bob@fountain.fm'), true)
  })
  await ok('a subdomain of it is excluded', () => {
    assert.equal(isLnurlOnlyAddress('bob@wallet.fountain.fm'), true)
  })
  await ok('⚠️ notfountain.fm is NOT excluded', () => {
    // The whole point. `endsWith('fountain.fm')` matches this, which would let
    // anyone who registers a hostname opt other people's recipients out of the
    // inline boostagram.
    assert.equal(isLnurlOnlyAddress('bob@notfountain.fm'), false)
    assert.equal(isLnurlOnlyAddress('bob@myfountain.fm'), false)
  })
  await ok('case and a trailing root dot are the same host', () => {
    assert.equal(isLnurlOnlyAddress('BOB@Fountain.FM.'), true)
  })
  await ok('an ordinary provider is not excluded', () => {
    assert.equal(isLnurlOnlyAddress('bob@getalby.com'), false)
  })
  await ok('junk answers false rather than throwing', () => {
    assert.equal(isLnurlOnlyAddress(''), false)
    assert.equal(isLnurlOnlyAddress('nodomain'), false)
    assert.equal(isLnurlOnlyAddress(null), false)
  })

  console.log('\nThe document parser — the pubkey is the real gate')

  await ok('a documented pubkey resolves, lowercased', () => {
    assert.deepEqual(parseKeysendResponse({ pubkey: PUBKEY.toUpperCase() }), { pubkey: PUBKEY })
  })
  await ok('destination and nodeId are accepted as aliases', () => {
    assert.equal(parseKeysendResponse({ destination: PUBKEY }).pubkey, PUBKEY)
    assert.equal(parseKeysendResponse({ nodeId: PUBKEY2 }).pubkey, PUBKEY2)
  })
  await ok('tag: "keysend" is deliberately not required', () => {
    assert.equal(parseKeysendResponse({ pubkey: PUBKEY }).pubkey, PUBKEY)
  })
  await ok('⚠️ a pubkey that is not a compressed node id is refused', () => {
    assert.equal(parseKeysendResponse({ pubkey: '04' + 'a'.repeat(64) }), null, 'wrong prefix')
    assert.equal(parseKeysendResponse({ pubkey: '02' + 'a'.repeat(62) }), null, 'too short')
    assert.equal(parseKeysendResponse({ pubkey: '02' + 'a'.repeat(66) }), null, 'too long')
    assert.equal(parseKeysendResponse({ pubkey: '02' + 'z'.repeat(64) }), null, 'not hex')
    assert.equal(parseKeysendResponse({ pubkey: '' }), null)
    assert.equal(parseKeysendResponse({ pubkey: 12345 }), null, 'not a string')
  })
  await ok('an LNURL-style error document is refused', () => {
    assert.equal(parseKeysendResponse({ status: 'ERROR', reason: 'nope', pubkey: PUBKEY }), null)
    assert.equal(parseKeysendResponse({ status: 'error', pubkey: PUBKEY }), null)
  })
  await ok('a non-object is refused', () => {
    assert.equal(parseKeysendResponse(null), null)
    assert.equal(parseKeysendResponse('<!doctype html>'), null)
    assert.equal(parseKeysendResponse([{ pubkey: PUBKEY }]), null)
  })

  console.log('\nThe routing pair — taken whole or not at all')

  await ok('the documented customData shape is read', () => {
    assert.deepEqual(
      parseKeysendResponse({ pubkey: PUBKEY, customData: [{ customKey: '696969', customValue: 'acct1' }] }),
      { pubkey: PUBKEY, customKey: '696969', customValue: 'acct1' },
    )
  })
  await ok('a top-level pair is read too', () => {
    assert.deepEqual(
      parseKeysendResponse({ pubkey: PUBKEY, customKey: '818818', customValue: 'acct2' }),
      { pubkey: PUBKEY, customKey: '818818', customValue: 'acct2' },
    )
  })
  await ok('⚠️ a key and a value from DIFFERENT objects are never paired', () => {
    // Pairing across entries addresses a different sub-account on the shared
    // node — a stranger gets the sats and the payment still succeeds.
    const out = parseKeysendResponse({
      pubkey: PUBKEY,
      customData: [{ customKey: '696969' }, { customValue: 'someone-elses-account' }],
    })
    assert.deepEqual(out, { pubkey: PUBKEY })
  })
  await ok('a non-numeric customKey cannot go on the wire', () => {
    const out = parseKeysendResponse({ pubkey: PUBKEY, customData: [{ customKey: 'abc', customValue: 'v' }] })
    assert.deepEqual(out, { pubkey: PUBKEY })
  })
  await ok('the first complete pair wins over a later one', () => {
    const out = parseKeysendResponse({
      pubkey: PUBKEY,
      customData: [{ customKey: '1', customValue: 'first' }, { customKey: '2', customValue: 'second' }],
    })
    assert.equal(out.customValue, 'first')
  })

  console.log('\nThe edge route — an address, never a URL')

  await ok('a good address parses to a name and a host', () => {
    assert.deepEqual(parseAddress('Bob@GetAlby.com'), { name: 'bob', host: 'getalby.com' })
  })
  await ok('⚠️ a port, a path or credentials are refused', () => {
    // Each of these would make the URL we build name a different host than the
    // address claims, and the address comes out of a third party's value block.
    assert.equal(parseAddress('bob@host.com:8080'), null)
    assert.equal(parseAddress('bob@host.com/evil'), null)
    assert.equal(parseAddress('bob@user:pw@host.com'), null)
    assert.equal(parseAddress('bob@127.0.0.1'), null)
    assert.equal(parseAddress('bob@localhost'), null)
  })
  await ok('two @ signs are refused', () => {
    assert.equal(parseAddress('a@b@host.com'), null)
  })
  await ok('an over-long value is refused before anything parses it', () => {
    assert.equal(parseAddress('a'.repeat(300) + '@host.com'), null)
  })
  await ok('a missing or empty address is refused', () => {
    assert.equal(parseAddress(''), null)
    assert.equal(parseAddress(null), null)
    assert.equal(parseAddress('nodomain'), null)
  })

  await ok('the outbound URL is the well-known path and nothing else', async () => {
    const calls = stubFetch(() => jsonResp({ pubkey: PUBKEY }))
    await req('bob.smith%2Bv4v@getalby.com')
    assert.deepEqual(calls, ['https://getalby.com/.well-known/keysend/bob.smith%2Bv4v'])
  })
  await ok('a good document comes back verbatim, uncacheable', async () => {
    stubFetch(() => jsonResp({ pubkey: PUBKEY, customData: [{ customKey: '696969', customValue: 'x' }], extra: 'kept' }))
    const res = await req('bob@getalby.com')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    // Verbatim: the client parser is the single source of truth on shape, so
    // the route must not filter fields it does not recognise.
    assert.equal(body.extra, 'kept')
    assert.equal(parseKeysendResponse(body).customValue, 'x')
  })
  await ok('a bad address never reaches the network', async () => {
    const calls = stubFetch(() => jsonResp({ pubkey: PUBKEY }))
    const res = await req('not-an-address')
    assert.equal(res.status, 400)
    assert.deepEqual(calls, [])
  })
  await ok('an upstream 404 is the ordinary case, answered as 404', async () => {
    stubFetch(() => jsonResp({ error: 'nope' }, 404))
    const res = await req('bob@getalby.com')
    assert.equal(res.status, 404)
    assert.equal((await res.json()).reason, 'no keysend endpoint')
  })
  await ok('⚠️ an SPA shell served with HTTP 200 is the same absent endpoint', async () => {
    // primal.net does exactly this, and it is three legs of the measured corpus.
    stubFetch(() => new Response('<!doctype html><html><body>app</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    const res = await req('bob@primal.net')
    assert.equal(res.status, 404)
  })
  await ok('a JSON array or a bare string is not a document', async () => {
    stubFetch(() => jsonResp([{ pubkey: PUBKEY }]))
    assert.equal((await req('bob@getalby.com')).status, 404)
    stubFetch(() => jsonResp('"just a string"'))
    assert.equal((await req('bob@getalby.com')).status, 404)
  })
  await ok('a declared over-large body is refused without reading it', async () => {
    stubFetch(() => jsonResp({ pubkey: PUBKEY }, 200, { 'content-length': String(200 * 1024) }))
    assert.equal((await req('bob@getalby.com')).status, 404)
  })
  await ok('an undeclared over-large body is refused while streaming', async () => {
    stubFetch(() => new Response('x'.repeat(100 * 1024), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    assert.equal((await req('bob@getalby.com')).status, 404)
  })
  await ok('an aborted or unreachable fetch is a 404, never a throw', async () => {
    stubFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e })
    assert.equal((await req('bob@getalby.com')).status, 404)
    stubFetch(() => { throw new TypeError('network') })
    assert.equal((await req('bob@getalby.com')).status, 404)
  })

  console.log('\nThe wallet gate — the upgrade may never cost a payment')

  await ok('no wallet cannot keysend', async () => {
    clearKeysendLookupCache(); globalThis.__kind = null
    assert.equal(await walletCanKeysend(), false)
  })
  await ok('a WebLN provider is asked for the method itself', async () => {
    clearKeysendLookupCache(); globalThis.__kind = 'webln'
    globalThis.window = { webln: { keysend: () => {} } }
    assert.equal(await walletCanKeysend(), true)
    globalThis.window = { webln: { payInvoice: () => {} } }
    assert.equal(await walletCanKeysend(), false, 'an extension with no keysend method')
    globalThis.window = {}
    assert.equal(await walletCanKeysend(), false, 'no provider at all')
  })
  await ok('NWC is asked for its declared capabilities', async () => {
    clearKeysendLookupCache(); globalThis.__kind = 'nwc'
    globalThis.__caps = ['pay_invoice', 'pay_keysend', 'get_balance']
    assert.equal(await walletCanKeysend(), true)
    clearKeysendLookupCache()
    globalThis.__caps = ['pay_invoice', 'get_balance']
    assert.equal(await walletCanKeysend(), false)
  })
  await ok('the capability answer is asked for once per session', async () => {
    clearKeysendLookupCache(); globalThis.__kind = 'nwc'
    globalThis.__caps = ['pay_keysend']; globalThis.__infoCalls = 0
    await walletCanKeysend(); await walletCanKeysend(); await walletCanKeysend()
    assert.equal(globalThis.__infoCalls, 1)
  })
  await ok('⚠️ a wallet service that will not answer is treated as incapable', async () => {
    // The deliberate trade: a missed upgrade costs metadata on one leg, where a
    // wrong yes costs the payment.
    clearKeysendLookupCache(); globalThis.__kind = 'nwc'
    globalThis.__infoThrows = true
    assert.equal(await walletCanKeysend(), false)
    globalThis.__infoThrows = false
    clearKeysendLookupCache(); globalThis.__nwcThrows = true
    assert.equal(await walletCanKeysend(), false)
    globalThis.__nwcThrows = false
  })
  await ok('⚠️ what the wallet SAID outranks what it advertised', async () => {
    clearKeysendLookupCache(); globalThis.__kind = 'nwc'
    globalThis.__caps = ['pay_keysend']
    assert.equal(await walletCanKeysend(), true)
    noteKeysendUnsupported()
    assert.equal(await walletCanKeysend(), false, 'latched for the session')
  })
  await ok('⚠️ changing wallet drops both capability memos', async () => {
    // Going from a keysend-capable wallet to one without it and keeping the old
    // yes upgrades legs the new wallet cannot pay. The address cache is a fact
    // about recipients and deliberately survives.
    clearKeysendLookupCache(); globalThis.__kind = 'nwc'
    globalThis.__caps = ['pay_keysend']
    assert.equal(await walletCanKeysend(), true)
    noteKeysendUnsupported()
    assert.equal(await walletCanKeysend(), false)
    assert.equal(typeof globalThis.__walletListener, 'function', 'the module subscribed on load')
    globalThis.__walletListener()
    assert.equal(await walletCanKeysend(), true, 'the latch cleared with the wallet')
  })

  console.log('\nThe lookup — cached, and never throwing')

  await ok('⚠️ an excluded domain is never probed at all', async () => {
    // Ahead of the cache, not just the fetch: fountain.fm DOES answer, so a
    // cached hit would be a real target to remember to ignore at every read.
    clearKeysendLookupCache()
    const calls = stubFetch(() => jsonResp({ pubkey: PUBKEY }))
    assert.equal(await lookupKeysendTarget('bob@fountain.fm'), null)
    assert.deepEqual(calls, [])
  })
  await ok('a hit resolves and is cached', async () => {
    clearKeysendLookupCache()
    const calls = stubFetch(() => jsonResp({ pubkey: PUBKEY, customKey: '696969', customValue: 'v' }))
    const a = await lookupKeysendTarget('bob@getalby.com')
    const b = await lookupKeysendTarget('BOB@getalby.com')
    assert.deepEqual(a, { pubkey: PUBKEY, customKey: '696969', customValue: 'v' })
    assert.deepEqual(b, a)
    assert.equal(calls.length, 1, 'the second read came from the cache')
  })
  await ok('a miss is cached too, so it costs one round trip per boost', async () => {
    clearKeysendLookupCache()
    const calls = stubFetch(() => jsonResp({ reason: 'no keysend endpoint' }, 404))
    assert.equal(await lookupKeysendTarget('bob@getalby.com'), null)
    assert.equal(await lookupKeysendTarget('bob@getalby.com'), null)
    assert.equal(calls.length, 1)
  })
  await ok('a 200 carrying an unusable document resolves to null', async () => {
    clearKeysendLookupCache()
    stubFetch(() => jsonResp({ pubkey: 'not-a-node-id' }))
    assert.equal(await lookupKeysendTarget('bob@getalby.com'), null)
  })
  await ok('⚠️ nothing here throws, whatever the edge does', async () => {
    clearKeysendLookupCache()
    stubFetch(() => { throw new Error('offline') })
    assert.equal(await lookupKeysendTarget('bob@getalby.com'), null)
    clearKeysendLookupCache()
    stubFetch(() => new Response('not json', { status: 200 }))
    assert.equal(await lookupKeysendTarget('bob@getalby.com'), null)
    assert.equal(await lookupKeysendTarget('nodomain'), null)
  })

  console.log('\nThe shipped routing — read as text, and here is why')

  /* ⚠️ A TEXT CHECK, NOT A RUN, AND DELIBERATELY SO. Exercising the leg loop
   * means a connected wallet, a live NWC client and a real invoice; the module
   * imports cleanly under node but every path through it ends at a wallet.
   * What is worth guarding here is not the arithmetic — it is that nobody
   * later adds the one line that reopens the double-pay door. */
  const boost = readFileSync(join(ROOT, 'login-widget/src/lib/externalBoost.js'), 'utf8')

  await ok('⚠️ the invoice fallback fires on FAILED and on nothing else', () => {
    // The whole safety argument in one line. FAILED can only have come from
    // `isCleanDecline`, which is this file's definition of "the payment never
    // left the wallet" — the same test that already puts a re-paying Retry in
    // front of the donor. UNCERTAIN reaching this branch would be the
    // 2026-08-19 double payment: an attempt was made, nothing observable came
    // back, and it gets paid a second time.
    assert.match(boost, /if \(upgraded && result\.status === STATUS\.FAILED\)/)
    const branch = boost.slice(boost.indexOf('if (upgraded && result.status'))
    const body = branch.slice(0, branch.indexOf('\n        }') + 10)
    assert.doesNotMatch(body, /UNCERTAIN/, 'no uncertain leg is re-paid here')
    assert.match(body, /result = await payLnaddressLeg\(/)
  })
  await ok('⚠️ the fallback is the ONLY second call site for the LNURL leg', () => {
    // Two calls: the ordinary route, and the clean-decline fallback. A third
    // is a path nobody has argued for, and every unargued path on this file is
    // a way to pay a recipient twice.
    const calls = boost.match(/payLnaddressLeg\(/g) || []
    assert.equal(calls.length, 3, 'one definition, two calls')
  })
  await ok('a genuine node recipient has no invoice to fall back to', () => {
    // `upgraded` gates the fallback, so a leg the value block declared as
    // type:'node' cannot reach it — there is no lightning address to pay.
    assert.match(boost, /if \(upgraded && /)
  })
  await ok('the LNURL leg is reached only when no upgrade was resolved', () => {
    assert.match(boost, /leg\.recipient\.type === 'lnaddress' && !upgraded/)
  })
  await ok('⚠️ the upgraded destination is built field by field', () => {
    // A spread would carry the value block's own customKey/customValue onto a
    // node it was never meant for, addressing a stranger's sub-account.
    const from = boost.indexOf('async function resolveKeysendUpgrade')
    assert.ok(from > 0, 'the resolver is still named that')
    const fn = boost.slice(from, boost.indexOf('\n}\n', from) + 3)
    assert.doesNotMatch(fn, /\.\.\.leg\.recipient/)
    assert.match(fn, /address: target\.pubkey/)
  })
  await ok('the wallet is asked before the address', () => {
    // Cheap ordering claim with a real payoff: on a wallet that cannot keysend
    // this costs one lookup for the whole boost rather than one per leg.
    const i = boost.indexOf('walletCanKeysend()')
    const j = boost.indexOf('lookupKeysendTarget(')
    assert.ok(i > 0 && j > i, 'walletCanKeysend gates lookupKeysendTarget')
  })
  await ok('a capability decline latches for the rest of the boost', () => {
    assert.match(boost, /if \(KEYSEND_UNSUPPORTED_RE\.test\(msg\)\) noteKeysendUnsupported\(\)/)
  })

  console.log('\nThe wallet failure codes — the string that got a leg stuck')

  await ok('⚠️ the production FAILURE_REASON_NO_ROUTE string is a clean decline', () => {
    // Pinned verbatim from Reed's console, 2026-08-22. The shared classifier
    // looks for `no route`; NIP-47 says `NO_ROUTE`, and that underscore left an
    // upgraded leg UNCERTAIN — the one status with no way out, since the
    // fallback and Retry are both gated on FAILED and a keysend has no verify
    // URL for "Check again". The donor had no action available at all.
    assert.equal(
      isCleanDecline('Failed to request pay_keysend Nip47WalletError: FAILURE_REASON_NO_ROUTE'),
      true,
    )
    assert.equal(isCleanDecline('FAILURE_REASON_NO_ROUTE'), true)
    assert.equal(isCleanDecline('FAILURE_REASON_INSUFFICIENT_BALANCE'), true)
    assert.equal(isCleanDecline('FAILURE_REASON_INCORRECT_PAYMENT_DETAILS'), true)
  })
  await ok('⚠️ TIMEOUT and ERROR stay ambiguous, and that is the safety', () => {
    // An HTLC in flight when the clock expired can still settle. Calling that a
    // clean decline offers a re-pay on a payment that may land, which is the
    // 2026-08-19 double payment arriving through the classifier instead of
    // through the button.
    assert.equal(isCleanDecline('FAILURE_REASON_TIMEOUT'), false)
    assert.equal(isCleanDecline('FAILURE_REASON_ERROR'), false)
    assert.equal(isCleanDecline('FAILURE_REASON_NONE'), false)
    assert.equal(isCleanDecline('some unrelated wallet noise'), false)
  })
  await ok('the classifier still recognises what it always did', () => {
    assert.equal(isCleanDecline('Payment rejected by user'), true)
    assert.equal(isCleanDecline('no route'), true)
    assert.equal(isCleanDecline('method not found'), true, 'keysend capability')
  })

  console.log(`\n${passed} assertions passed.`)
} finally {
  globalThis.fetch = realFetch
}
