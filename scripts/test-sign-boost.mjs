#!/usr/bin/env node
/**
 * The signing oracle's validator, exercised against the real note template.
 *
 * ⚠️ THE INPUT IS THE SHIPPED BUILDER, NOT A FIXTURE. `buildExternalNoteTemplate`
 * lives in the widget source and this test imports it, so a tag added there
 * without being added to the endpoint's allowlist fails HERE rather than in
 * production, where the symptom is every site-signed note silently refused.
 * That coupling is the whole point of the test.
 *
 * Run: node scripts/test-sign-boost.mjs
 */
import assert from 'node:assert/strict'
import { validateBoostTemplate, validateDonationTemplate, validateShowBoostTemplate, validateTemplate, secretKeyFrom, overRateLimit, onRequestPost } from '../functions/api/sign-boost.js'
import { verifyEvent, getPublicKey, nip19 } from '../functions/_shared/nostr-sign.js'
import { buildExternalNoteTemplate, buildDonationNoteTemplate, donationHeadline, sanitizeSenderName, MAX_SENDER_NAME_CHARS } from '../login-widget/src/lib/externalBoostagram.js'
import { SITE_SIGN_MAX_SATS } from '../login-widget/src/lib/siteSign.js'
import { buildShowSiteNoteTemplate, SHOW_NOTE_HEADLINE, sanitizeShowSender, SHOW_SENDER_NAME_CHARS } from '../login-widget/src/lib/boostagram.js'
import { BOOST_BANNER_URL, DONATION_BANNER_URL, DONATION_URL } from '../login-widget/src/lib/externalBoostagram.js'

let passed = 0
// ⚠️ AWAITS. It used to call fn() bare, so an async assertion that failed became
// an unhandled rejection AFTER the ✓ had already printed — a test that reports
// success and then crashes, which is worse than one that fails.
async function ok(label, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${label}`)
}
function rejects(label, template, expected) {
  let message = null
  try { validateBoostTemplate(template) } catch (e) { message = e.message }
  assert.notEqual(message, null, `${label}: expected a rejection, got none`)
  if (expected) assert.match(message, expected, `${label}: wrong reason (${message})`)
  passed++
  console.log(`  ✓ ${label} — ${message}`)
}

// A real template, exactly as the modal builds one.
function realTemplate(over = {}) {
  return buildExternalNoteTemplate({
    paidSats: 1000,
    legsPaid: 2,
    legsTotal: 3,
    message: 'great episode',
    showTitle: 'Chad and Reeds Podcast',
    episodeTitle: '002. Idea Economy',
    podcastGuid: '7c6f7875-2b73-491e-b32c-e2c8d6e91d53',
    itemGuid: 'a1b2c3',
    bmbUrl: 'https://localbitcoiners.com/episode/a1b2c3',
    ...over,
  })
}

console.log('\nThe real template passes:')
await ok('the shipped builder’s output validates unchanged', () => {
  const t = validateBoostTemplate(realTemplate())
  assert.equal(t.kind, 1)
  assert.equal(t.content, realTemplate().content)
})
await ok('every tag it emits is in the allowlist', () => {
  // The assertion above already proves it; this one names the failure so a
  // rejected new tag reads as "add it to ALLOWED_TAGS" rather than as a puzzle.
  const names = [...new Set(realTemplate().tags.map((t) => t[0]))].sort()
  assert.deepEqual(names, ['amount', 'client', 'i', 'k', 'r', 't'])
})
await ok('a boost with no message and no episode still validates', () => {
  validateBoostTemplate(realTemplate({ message: '', episodeTitle: '', itemGuid: '', bmbUrl: '' }))
})

// ─── The typed "From" name (boost-login.md D15) ────────────────────────────
// The bot path is the ONLY one that carries a name, and the name is the one
// piece of donor-typed text that becomes a line of the bot's own prose. So it
// gets its own block: the validator has to keep accepting the note, and the
// line has to stay a line.
console.log('\nThe typed sender name rides in the body and nowhere else:')
await ok('a note carrying a From line still validates', () => {
  const t = validateBoostTemplate(realTemplate({ senderName: 'Reed' }))
  assert.match(t.content, /^👤 From Reed$/m)
})
await ok('it adds NO tag, so ALLOWED_TAGS is unaffected', () => {
  const withName = realTemplate({ senderName: 'Reed' }).tags
  const without = realTemplate({ senderName: '' }).tags
  assert.deepEqual(withName, without)
})
await ok('⚠️ it is never a p tag, an author claim or a proxy field', () => {
  // D2/D15: nothing can verify that the person named authorised a note signed
  // by a key they do not hold, so the name may not reach anything the index
  // credits. A `p` tag would also be refused by the oracle's allowlist, which
  // is the second line of defence rather than the first.
  const tags = realTemplate({ senderName: 'Reed' }).tags
  assert.equal(tags.some((t) => t[0] === 'p'), false)
  assert.equal(tags.some((t) => t.includes('Reed')), false)
})
await ok('⚠️ a newline in the name cannot add a line to the note', () => {
  // The body is read line by line by consumers including our own collector,
  // so a name carrying a newline could otherwise post a whole line of its own
  // under the bot's identity.
  const t = realTemplate({ senderName: 'Reed\n🎙️ Some Other Show\nhttps://evil.example' })
  const lines = t.content.split('\n').filter((l) => l.startsWith('👤 From '))
  assert.equal(lines.length, 1)
  // Flattened onto the one line it was given, and then cut by the cap — which
  // is why the URL cannot survive whole either.
  assert.equal(lines[0], '👤 From Reed 🎙️ Some Other Show https://evil.ex')
  validateBoostTemplate(t)
})
await ok('⚠️ a 📱 in the name cannot forge the attribution line', () => {
  // `clients.py#_VIA_RE` fills `client_via` from `📱 via <App>`. It `.search`es,
  // so line 1 wins today whatever the name says; stripping the emoji is what
  // keeps that true if the lines are ever reordered.
  const t = realTemplate({ senderName: '📱 via Fountain' })
  assert.equal(t.content.split('\n').filter((l) => l.includes('📱')).length, 1)
  // Line TWO since the banner landed; `_VIA_RE.search` still finds it first
  // because nothing above it carries the emoji.
  assert.match(t.content.split('\n')[1], /📱 via localbitcoiners\.com$/)
})
await ok('the name is capped, and the cap is applied in the builder', () => {
  const long = 'x'.repeat(200)
  const t = realTemplate({ senderName: long })
  const line = t.content.split('\n').find((l) => l.startsWith('👤 From '))
  assert.equal(line.length, '👤 From '.length + MAX_SENDER_NAME_CHARS)
  validateBoostTemplate(t)
})
await ok('a blank or whitespace name emits no line at all', () => {
  for (const name of ['', '   ', '\n\n', undefined, null]) {
    assert.equal(realTemplate({ senderName: name }).content.includes('👤'), false)
  }
  assert.equal(sanitizeSenderName('  \n  '), '')
})

// ─── The banner, and the opening it is allowed to be ──────────────────────
// ⚠️ THE ORACLE HARDCODES THIS URL because a Function cannot import it. These
// three assertions are the whole of what keeps the two copies honest: change
// the banner in the builder alone and the first one fails here rather than
// every site-signed note failing in production.
console.log('\nThe banner leads the note, and the oracle knows exactly which one:')
await ok('the note opens with the banner on its own line', () => {
  const lines = realTemplate().content.split('\n')
  assert.equal(lines[0], BOOST_BANNER_URL)
  assert.match(lines[1], /^⚡Just boosted /)
})
await ok('⚠️ the oracle accepts the banner the shipped builder actually emits', () => {
  validateBoostTemplate(realTemplate())
})
rejects('⚠️ any OTHER text before the boost line', {
  ...realTemplate(),
  content: 'vote for me\n' + realTemplate().content,
}, /not a boost note/)
rejects('a lookalike banner from another host', {
  ...realTemplate(),
  content: realTemplate().content.replace(BOOST_BANNER_URL, 'https://evil.example/x.png'),
}, /not a boost note/)
await ok('a bare boost line with no banner still validates', () => {
  // The un-bannered opening stays legal so a note built before this shipped,
  // or by anything that omits it, is not refused.
  validateBoostTemplate({
    ...realTemplate(),
    content: realTemplate().content.split('\n').slice(1).join('\n'),
  })
})

console.log('\nThe oracle refuses to be a general-purpose signer:')
rejects('kind 0 (profile hijack)', { ...realTemplate(), kind: 0 }, /kind 1/)
rejects('kind 4 (a DM)', { ...realTemplate(), kind: 4 }, /kind 1/)
rejects('free text that is not a boost', { ...realTemplate(), content: 'vote for me' }, /not a boost note/)
rejects('the topic markers stripped', {
  ...realTemplate(),
  tags: realTemplate().tags.filter((t) => t[1] !== 'boostagram'),
}, /not a boost note/)

console.log('\nThe two tags that make it worth attacking:')
rejects('an e tag, which would make this REPLY to any note', {
  ...realTemplate(),
  tags: [...realTemplate().tags, ['e', 'f'.repeat(64)]],
}, /unsupported tag/)
rejects('a p tag, which would make this a mention blast', {
  ...realTemplate(),
  tags: [...realTemplate().tags, ['p', 'f'.repeat(64)]],
}, /unsupported tag/)

console.log('\nThe figure this index will read off the note:')
rejects('two amount tags', {
  ...realTemplate(),
  tags: [...realTemplate().tags, ['amount', '1']],
}, /invalid amount/)
rejects('an amount above the cap', {
  ...realTemplate(),
  tags: realTemplate().tags.map((t) => (t[0] === 'amount' ? ['amount', String(SITE_SIGN_MAX_SATS * 1000 + 1)] : t)),
}, /invalid amount/)
// ⚠️ THE ONE THING PINNING THE TWO COPIES OF THE CAP TOGETHER. The endpoint's
// `MAX_AMOUNT_MSAT` and the widget's `SITE_SIGN_MAX_SATS` live in files that
// cannot import each other, so this pair of assertions is the enforcement. If
// it fails, the modal is either promising a note it cannot get signed or
// refusing one it could.
await ok('the widget\u2019s declared cap is exactly the endpoint\u2019s', () => {
  validateBoostTemplate({
    ...realTemplate(),
    tags: realTemplate().tags.map((t) => (t[0] === 'amount' ? ['amount', String(SITE_SIGN_MAX_SATS * 1000)] : t)),
  })
})

rejects('a non-integer amount', {
  ...realTemplate(),
  tags: realTemplate().tags.map((t) => (t[0] === 'amount' ? ['amount', '1.5e6'] : t)),
}, /invalid amount/)
rejects('a negative amount', {
  ...realTemplate(),
  tags: realTemplate().tags.map((t) => (t[0] === 'amount' ? ['amount', '-1000'] : t)),
}, /invalid amount/)

console.log('\nWhat gets published under our own name:')
rejects('a javascript: url in an r tag', {
  ...realTemplate(),
  tags: realTemplate().tags.map((t) => (t[0] === 'r' ? ['r', 'javascript:alert(1)'] : t)),
}, /unsupported url/)
rejects('someone else’s client attribution', {
  ...realTemplate(),
  tags: realTemplate().tags.map((t) => (t[0] === 'client' ? ['client', 'evil.example'] : t)),
}, /unsupported client/)

console.log('\nSize and time:')
rejects('content past the cap', { ...realTemplate(), content: '⚡Just boosted ' + 'x'.repeat(3000) }, /invalid content/)
rejects('a tag item past the cap', {
  ...realTemplate(),
  tags: [...realTemplate().tags, ['t', 'x'.repeat(600)]],
}, /invalid tags/)
rejects('a back-dated note', { ...realTemplate(), created_at: Math.floor(Date.now() / 1000) - 4000 }, /created_at/)
rejects('a post-dated note', { ...realTemplate(), created_at: Math.floor(Date.now() / 1000) + 4000 }, /created_at/)

console.log('\nThe key:')
await ok('an nsec is accepted', () => {
  const bytes = new Uint8Array(32).fill(9)
  assert.deepEqual(secretKeyFrom(nip19.nsecEncode(bytes)), bytes)
})
await ok('64-char hex is accepted', () => {
  assert.deepEqual(secretKeyFrom('0a'.repeat(32)), new Uint8Array(32).fill(10))
})
await ok('anything else reads as unconfigured, not as an error', () => {
  for (const v of ['', '   ', 'hunter2', 'npub1xxx', undefined, null, 42]) {
    assert.equal(secretKeyFrom(v), null)
  }
})

console.log('\nEnd to end, through the handler:')
const SK = new Uint8Array(32).fill(3)

// A KV namespace, near enough: get/put over a Map. The real one is eventually
// consistent, which this cannot model and which the endpoint's comment is
// honest about — the limiter is friction rather than a boundary.
function fakeKV(store = new Map()) {
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v) },
  }
}
function envWith(over = {}) {
  return {
    LB_SIGN_NSEC: nip19.nsecEncode(SK),
    SIGN_RATELIMIT: fakeKV(),
    ...over,
  }
}
function post(body, env = envWith()) {
  return onRequestPost({
    request: new Request('https://localbitcoiners.com/api/sign-boost', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  })
}

const res = await post(realTemplate())
assert.equal(res.status, 200)
const { event } = await res.json()
await ok('the signed event verifies', () => assert.equal(verifyEvent(event), true))
await ok('it is signed by the configured key and nothing else', () => {
  assert.equal(event.pubkey, getPublicKey(SK))
})
await ok('the amount tag survives signing unchanged', () => {
  assert.equal(event.tags.find((t) => t[0] === 'amount')[1], '1000000')
})
await ok('the response is never cached', () => {
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

const noKey = await post(realTemplate(), envWith({ LB_SIGN_NSEC: '' }))
await ok('no key configured answers 503, so the feature is simply off', () => {
  assert.equal(noKey.status, 503)
})

// ⚠️ The one that would otherwise ship silently. An in-memory counter is
// per-isolate on Cloudflare and is no limit at all, so a missing binding must
// not degrade to "unlimited".
const noLimiter = await post(realTemplate(), envWith({ SIGN_RATELIMIT: undefined }))
await ok('no counter bound answers 503 rather than running unrated', () => {
  assert.equal(noLimiter.status, 503)
})

const brokenLimiter = await post(realTemplate(), envWith({
  SIGN_RATELIMIT: { get: async () => { throw new Error('kv down') }, put: async () => {} },
}))
await ok('a counter that throws answers 503, not an unrated 200', () => {
  assert.equal(brokenLimiter.status, 503)
})

const notAKV = await post(realTemplate(), envWith({ SIGN_RATELIMIT: 'true' }))
await ok('a plain text variable is not mistaken for a namespace', () => {
  assert.equal(notAKV.status, 503)
})

// The counter, exercised directly so the window boundary doesn't cost a minute.
console.log('\nThe rate limiter:')
const kv = fakeKV()
const T0 = 1_800_000_000_000
await ok('the first five requests in a window pass', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(await overRateLimit(kv, '203.0.113.7', T0), false, `request ${i + 1}`)
  }
})
await ok('the sixth is refused', async () => {
  assert.equal(await overRateLimit(kv, '203.0.113.7', T0), true)
})
await ok('a different address has its own count', async () => {
  assert.equal(await overRateLimit(kv, '198.51.100.4', T0), false)
})
await ok('the next window starts clean', async () => {
  assert.equal(await overRateLimit(kv, '203.0.113.7', T0 + 60_000), false)
})
await ok('the key expires on its own, so nothing accumulates', async () => {
  const seen = fakeKV()
  await overRateLimit(seen, '203.0.113.7', T0)
  // put() is called with a TTL that outlives the window; KV's floor is 60s.
  assert.equal([...seen.store.keys()][0], `sign-boost:203.0.113.7:${Math.floor(T0 / 1000 / 60)}`)
})

// ⚠️ Filled at the CURRENT window, not at T0. The handler reads its own clock,
// so a counter spent in some other minute is a counter it never looks at — the
// first version of this test asserted 429 and got a clean 200.
const spent = fakeKV()
for (let i = 0; i < 5; i++) await overRateLimit(spent, '203.0.113.7', Date.now())
const limited = await post(realTemplate(), envWith({ SIGN_RATELIMIT: spent }))
await ok('over the limit the handler answers 429 and signs nothing', () => {
  assert.equal(limited.status, 429)
})

const badJson = await post('{not json')
await ok('malformed JSON answers 400, not 500', () => assert.equal(badJson.status, 400))

const rejected = await post({ ...realTemplate(), kind: 0 })
await ok('a refused template answers 400 and signs nothing', async () => {
  assert.equal(rejected.status, 400)
})


// ─── The donation family ───────────────────────────────────────────────────
//
// ⚠️ THE POINT OF THESE IS THAT THE TWO FAMILIES ARE DISJOINT. A donation note
// is not a boost note with fields left out: it must be refused by the boost
// validator and a boost note must be refused by the donation one, or the looser
// looking shape becomes a way around the stricter one. Every template below is
// built by the SHIPPED builder, so a drift between the widget's constants and
// the Function's restatements fails here rather than in production.

function donation(over = {}) {
  return buildDonationNoteTemplate({ paidSats: 2100, message: 'thanks', ...over })
}

await ok('the shipped donation builder validates', () => {
  const t = validateTemplate(donation())
  assert.equal(t.kind, 1)
  assert.equal(t.content, donation().content)
})

await ok('the banner and headline the Function pins are the ones shipped', () => {
  const lines = donation({ paidSats: 2100 }).content.split('\n')
  assert.equal(lines[0], DONATION_BANNER_URL)
  assert.equal(lines[1], donationHeadline(2100))
})

await ok('the dispatcher routes by opening line, with no fallback', () => {
  // A donation reaching the boost validator, and a boost reaching the donation
  // one, must BOTH be refused. If either passed, `validateTemplate` picking the
  // wrong family would be silent.
  assert.throws(() => validateBoostTemplate(donation()))
  assert.throws(() => validateDonationTemplate(realTemplate()))
})

await ok('a donation carries none of the three markers that make it a boost', () => {
  const names = donation().tags.map((t) => t[0])
  for (const forbidden of ['amount', 'i', 'k']) {
    assert.equal(names.includes(forbidden), false, `donation note carries ${forbidden}`)
  }
  const topics = donation().tags.filter((t) => t[0] === 't').map((t) => t[1])
  for (const forbidden of ['boost', 'boostagram', 'value4value']) {
    assert.equal(topics.includes(forbidden), false, `donation note carries t=${forbidden}`)
  }
})

await ok('a boost topic tag smuggled onto a donation is refused', () => {
  // `t` IS an allowed tag name here, so the allowlist alone does not stop this.
  // Without the explicit refusal a caller could put a fabricated boost into
  // this index under the bot identity.
  for (const topic of ['boost', 'boostagram', 'value4value']) {
    const t = donation()
    t.tags = [...t.tags, ['t', topic]]
    assert.throws(() => validateTemplate(t), /unsupported topic/)
  }
})

await ok('an amount tag on a donation is refused by the allowlist', () => {
  const t = donation()
  t.tags = [...t.tags, ['amount', '2100000']]
  assert.throws(() => validateTemplate(t), /unsupported tag/)
})

await ok('a donation may point only at the site itself', () => {
  const t = donation()
  t.tags = t.tags.map((tag) => (tag[0] === 'r' ? ['r', 'https://evil.example/'] : tag))
  assert.throws(() => validateTemplate(t), /unsupported url/)
  assert.equal(donation().tags.find((tag) => tag[0] === 'r')[1], DONATION_URL)
})

await ok('the headline is matched whole, so nothing may precede or follow it', () => {
  const t = donation()
  t.content = t.content.replace(donationHeadline(2100), donationHeadline(2100) + ' and also')
  assert.throws(() => validateTemplate(t), /not a donation note/)
  // ⚠️ Prepending text does not merely break the donation match, it routes the
  // template to the BOOST validator (the dispatcher keys on the first line), so
  // the refusal arrives under that family's wording. Either way nothing signs,
  // which is the property being asserted; pinning the message here would be
  // pinning which validator happened to answer.
  const t2 = donation()
  t2.content = 'free text\n' + t2.content
  assert.throws(() => validateTemplate(t2))
  assert.throws(() => validateDonationTemplate(t2), /not a donation note/)
})

await ok('the donation cap is the boost cap, read out of the headline', () => {
  // ⚠️ The figure has no tag to live in, so the cap is only as good as the
  // headline match. Same number as SITE_SIGN_MAX_SATS, one sat apart.
  validateTemplate(donation({ paidSats: SITE_SIGN_MAX_SATS }))
  assert.throws(() => validateTemplate(donation({ paidSats: SITE_SIGN_MAX_SATS + 1 })), /invalid amount/)
  assert.throws(() => validateTemplate(donation({ paidSats: 0 })), /invalid amount/)
})

await ok('a donation carries the typed name as prose and never as a tag', () => {
  const t = donation({ senderName: 'Reed' })
  validateTemplate(t)
  assert.match(t.content, /^👤 From Reed$/m)
  assert.equal(t.tags.some((tag) => tag[0] === 'p'), false)
  assert.equal(t.tags.some((tag) => tag.includes('Reed')), false)
})


// ── The show-boost family ────────────────────────────────────────────────────
//
// ⚠️ FED FROM THE SHIPPED BUILDER, same rule as the other two: a tag added to
// `buildShowSiteNoteTemplate` without being added to SHOW_ALLOWED_TAGS fails
// here rather than as every site-signed show note silently refused.
console.log('\nThe show-boost family')
const SHOW_SESSION = '123e4567-e89b-42d3-a456-426614174000'
function showTemplate(over = {}) {
  return buildShowSiteNoteTemplate({
    paidSats: 3333,
    message: 'great episode',
    senderName: 'Smoke Tester',
    episode: { number: 24, title: 'Ep. 024 | Something', guid: 'abc-123' },
    pageUrl: 'https://localbitcoiners.com',
    boostSession: SHOW_SESSION,
    ...over,
  })
}
function showRejects(label, template, expected) {
  let message = null
  try { validateShowBoostTemplate(template) } catch (e) { message = e.message }
  assert.notEqual(message, null, `${label}: expected a rejection, got none`)
  if (expected) assert.match(message, expected, `${label}: wrong reason (${message})`)
  passed++
  console.log(`  ✓ ${label} — ${message}`)
}
await ok('the shipped show template validates, and the dispatcher routes it', () => {
  const t = validateShowBoostTemplate(showTemplate())
  assert.equal(t.content, showTemplate().content)
  assert.equal(validateTemplate(showTemplate()).content, t.content)
})
await ok('it is the bots\' standalone note, line for line', () => {
  const lines = showTemplate().content.split('\n')
  assert.equal(lines[0], SHOW_NOTE_HEADLINE)
  assert.equal(lines[1], '💰 3333 sats 📱 via localbitcoiners.com')
  assert.equal(lines[2], '👤 Smoke Tester')
  assert.equal(lines[3], '💬 great episode')
  assert.equal(lines[4], '🎙️ Ep. 024 | Something')
  assert.equal(lines[5], '🔗 https://localbitcoiners.com/ep024')
  assert.equal(lines[6], '')
  assert.equal(lines[7], '#LocalBitcoiners')
})
await ok('a blank name is "A Local Bitcoiner", and a show boost links the site', () => {
  const t = showTemplate({ senderName: '', episode: { number: null, title: '', guid: '' } })
  const lines = t.content.split('\n')
  assert.equal(lines[2], '👤 A Local Bitcoiner')
  assert.equal(lines[3], '💬 great episode')
  assert.equal(lines[4], '🔗 https://localbitcoiners.com')
  assert.equal(t.tags.some((x) => x[0] === 'i' && x[1].startsWith('podcast:item:guid:')), false)
  validateShowBoostTemplate(t)
})
await ok('no p, no P, no e — ever', () => {
  const t = showTemplate()
  assert.equal(t.tags.some((x) => ['p', 'P', 'e'].includes(x[0])), false)
  showRejects('a P tag is refused', { ...t, tags: [...t.tags, ['P', 'a'.repeat(64)]] }, /unsupported tag/)
  showRejects('a p tag is refused', { ...t, tags: [...t.tags, ['p', 'a'.repeat(64)]] }, /unsupported tag/)
})
await ok('the 💰 line and the amount tag must agree', () => {
  const t = showTemplate()
  const tags = t.tags.map((x) => x[0] === 'amount' ? ['amount', '4000000'] : x)
  showRejects('a tag that disagrees with the line', { ...t, tags }, /invalid amount/)
})
showRejects('nothing may precede the headline', { ...showTemplate(), content: 'hello\n' + showTemplate().content }, /not a show boost/)
showRejects('a foreign feed guid is refused', (() => { const t = showTemplate(); return { ...t, tags: t.tags.map((x) => x[0] === 'i' && x[1].startsWith('podcast:guid:') ? ['i', 'podcast:guid:ffffffff-0000-0000-0000-000000000000'] : x) } })(), /not a show boost/)
showRejects('an r off this site is refused', (() => { const t = showTemplate(); return { ...t, tags: t.tags.map((x) => x[0] === 'r' ? ['r', 'https://example.com/x'] : x) } })(), /unsupported url/)
showRejects('a non-uuid boost_session is refused', (() => { const t = showTemplate(); return { ...t, tags: t.tags.map((x) => x[0] === 'boost_session' ? ['boost_session', 'nope'] : x) } })(), /invalid tags/)
showRejects('the cap holds here too', showTemplate({ paidSats: SITE_SIGN_MAX_SATS + 1 }), /invalid amount/)
await ok('the typed name is bounded and cannot break the line structure', () => {
  const t = showTemplate({ senderName: 'a\nb📱c' + 'x'.repeat(100) })
  const line = t.content.split('\n')[2]
  assert.equal(line.startsWith('👤 a bc'), true)
  assert.equal(line.length <= 3 + SHOW_SENDER_NAME_CHARS, true)
  assert.equal(sanitizeShowSender('\u0000x'), 'x')
  validateShowBoostTemplate(t)
})
await ok('a partial boost carries the bots\' parenthetical, and the oracle holds it consistent', () => {
  const t = showTemplate({ paidSats: 299, intendedSats: 433, legsFailed: 1 })
  assert.equal(t.content.split('\n')[1], '💰 299 sats 📱 via localbitcoiners.com (433 sats intended; 1 leg failed)')
  validateShowBoostTemplate(t)
  const two = showTemplate({ paidSats: 299, intendedSats: 433, legsFailed: 2 })
  assert.equal(two.content.split('\n')[1].endsWith('2 legs failed)'), true)
  validateShowBoostTemplate(two)
})
showRejects('a parenthetical claiming less than the headline is refused', (() => {
  const t = showTemplate({ paidSats: 299, intendedSats: 433, legsFailed: 1 })
  return { ...t, content: t.content.replace('(433 sats intended', '(100 sats intended') }
})(), /invalid amount/)
await ok('the 🔗 line prefers the Fountain URL, matching the bot; the r tag stays on this site', () => {
  const t = showTemplate({ episode: { number: 24, title: 'T', guid: 'g', fountainUrl: 'https://fountain.fm/episode/abc123' } })
  assert.equal(t.content.split('\n').some((l) => l === '🔗 https://fountain.fm/episode/abc123'), true)
  assert.deepEqual(t.tags.filter((x) => x[0] === 'r').map((x) => x[1]), ['https://localbitcoiners.com/ep024'])
  validateShowBoostTemplate(t)
  const evil = showTemplate({ episode: { number: 24, title: 'T', guid: 'g', fountainUrl: 'https://evil.example/x' } })
  assert.equal(evil.content.includes('evil.example'), false)
})
await ok('the oracle signs a show template end to end', async () => {
  const res = await post(showTemplate())
  assert.equal(res.status, 200)
  const { event } = await res.json()
  assert.equal(verifyEvent(event), true)
  assert.equal(event.pubkey, getPublicKey(SK))
  assert.equal(event.content, showTemplate().content)
})

console.log(`\n${passed} assertions passed.\n`)
