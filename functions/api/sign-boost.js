/**
 * The signing oracle: the site signs a boost note for a visitor who has no key.
 *
 * A visitor who boosted without a Nostr account has paid a show and has no way
 * to put that boost on Nostr, because indexers count notes and they have no
 * key to sign one with. This endpoint signs a boost note for them and the
 * browser publishes it.
 *
 * ⚠️ THE KEY IS THE LOCAL BITCOINERS SHOW KEY, NOT A SEPARATE BOT NPUB. Reed's
 * call, 2026-08-23, departing from OnlyBoosts' D1: the show npub already
 * publishes every boost note through the bots on the VPS, OnlyBoosts already
 * classifies it as a publisher, and a second npub would split the show's
 * identity in the index. The cost is that this endpoint is an attack surface
 * on the show's own identity, which is why the validator below is an
 * allowlist, the rate limit fails closed, and the binding name is distinct
 * from the bots' copy of the same key.
 *
 * Ported from OnlyBoosts (`functions/api/sign-boost.js` at ob-v113); its
 * `boost-login.md` D2, D11 and D14 carry the arguments.
 *
 * ⚠️ THE PRIVATE KEY IS SERVER-ONLY AND NEVER REACHES THE BROWSER. It is a
 * Pages secret binding, set on BOTH Preview and Production. Unconfigured, this
 * endpoint answers 503 and the feature is simply off.
 *
 * Two bindings are needed and it refuses to run without either:
 *
 *   LB_SIGN_NSEC    secret        the show key, nsec or 64-char hex
 *   SIGN_RATELIMIT  KV namespace  the rate-limit counters
 *
 * The signer is `functions/_shared/nostr-sign.js`, a vendored build rather than
 * an npm import, because this repo has no root package.json and the Functions
 * have no dependencies. **Proven under `wrangler pages dev`**: the bundle
 * imports, signs and self-verifies inside workerd, which was the one assumption
 * in D5 worth testing before anything was built on top of it.
 *
 * ⚠️ WHAT THIS ENDPOINT CANNOT DO IS VERIFY THAT ANYTHING WAS PAID, and no
 * cheap version of it can. Proof-of-payment was designed and rejected on
 * 2026-08-19: a preimage proves only that someone KNOWS the preimage, which is
 * the payer or whoever issued the invoice, so an attacker self-issues an
 * invoice for any amount and passes. A LUD-21 verify URL is worse, being
 * supplied by the same caller. Binding a note to a real payment would mean this
 * server issuing the invoices, which puts it in the middle of a money path.
 *
 * So the evidence standard here is the SAME as the donor-signed path's: the
 * browser's own observation of what settled. That is deliberate rather than a
 * shortfall. On the donor-signed path, possession of the key is what makes the
 * claim accountable; here there is no key to possess, so what stands in for it
 * is containment rather than proof:
 *
 *   - every note is published by ONE identifiable pubkey, so the bot's whole
 *     output is a single filterable set (`client_src = publisher-pubkey`);
 *   - `excludes.json` can remove all of it in one edit, reversibly;
 *   - the caps and the rate limit below bound what one caller can do with it.
 *
 * Worth keeping in proportion: the index already accepts unauthenticated writes
 * from the whole of Nostr, since anyone may publish a boost note from a burner
 * key and the collector will index it. What this endpoint removes is the
 * friction of generating a key, not the capability.
 *
 * ⚠️ WHAT IT MUST NEVER BECOME is a general-purpose signer. Everything below is
 * about one shape of one kind, and the validator is an ALLOWLIST so a new tag
 * in the template fails loudly here rather than being signed silently.
 */
import { finalizeEvent, nip19 } from '../_shared/nostr-sign.js'

// The exact opening `buildExternalNoteTemplate` emits. It constrains the first
// characters and nothing more: the rest is the donor's own typed message, which
// is the feature rather than a hole in it. What it does buy is that this
// endpoint cannot be repurposed to sign something that does not even look like
// a boost.
//
// ⚠️ THE BANNER IS PINNED, NOT SKIPPED, AND THAT IS THE WHOLE POINT. The note
// now opens with an image URL on its own line, so the boost line is line two.
// The lazy fix is to test `/^⚡Just boosted /m` and let anything precede it —
// which hands a caller a free paragraph of arbitrary text at the top of a note
// published under our identity, and a paragraph of arbitrary text is a far
// better vehicle for abuse than the boost line that follows it. So exactly one
// prefix is allowed before the boost line, and it is a constant.
//
// ⚠️ RESTATED FROM `BOOST_BANNER_URL` IN
// `login-widget/src/lib/externalBoostagram.js`. A Function cannot import from
// the widget source, so **the two must be changed together**;
// `scripts/test-sign-boost.mjs` feeds this validator from the shipped builder
// and asserts they agree, so a drift fails there rather than in production.
const BOOST_BANNER_URL = 'https://localbitcoiners.com/assets/LocalBitcoiners_banner.png'
const CONTENT_PREFIX = '⚡Just boosted '
const ALLOWED_OPENINGS = [CONTENT_PREFIX, `${BOOST_BANNER_URL}\n${CONTENT_PREFIX}`]
const MAX_CONTENT = 2000

// ── The donation shape ───────────────────────────────────────────────────────
//
// ⚠️ A DONATION IS A SECOND TEMPLATE FAMILY, NOT A LOOSENING OF THE FIRST. Sats
// to Local Bitcoiners itself are not a podcast boost, so that note deliberately
// carries no NIP-73 `i`/`k` tags, no boost topic tags and no `amount` tag —
// which is exactly the set `validateBoostTemplate` REQUIRES. The two validators
// therefore accept disjoint shapes and neither can be reached by relaxing the
// other. `buildDonationNoteTemplate` in
// `login-widget/src/lib/externalBoostagram.js` is the builder they mirror.
//
// ⚠️ RESTATED FROM `DONATION_BANNER_URL` THERE, same rule as the boost banner:
// change both in one commit, and `scripts/test-sign-boost.mjs` fails on drift.
const DONATION_BANNER_URL = 'https://i.nostr.build/QoXlTuDurz3b4EqNefAzoC.png'

// ⚠️ THE WHOLE LINE, NOT A PREFIX, AND THAT IS DELIBERATE. The boost family can
// afford a prefix test because its figure rides an `amount` tag this validator
// checks separately. A donation note has no such tag, so this line is the only
// place its figure exists — which means the line has to be matched whole and
// the figure read back out of it, or the cap below would be guarding nothing.
// Mirrors `donationHeadline()` in the widget source.
const DONATION_LINE_RE = /^⚡Just donated ([0-9](?:[0-9,]{0,14})) sats to Local Bitcoiners 📱 via localbitcoiners\.com$/

// The complete tag vocabulary of `buildDonationNoteTemplate`. Narrower than the
// boost allowlist by three entries, and every omission is load-bearing:
// `amount`, `i` and `k` are the markers that would file this as a boost.
const DONATION_ALLOWED_TAGS = new Set(['t', 'client', 'r'])

// ⚠️ RESTATED FROM `BOOST_TOPIC_TAGS` IN `bots/global-boost-scan/classify.py`.
// Any one of these on a note makes this site's own collector treat it as a
// boost, so they are the exact set a donation note must never carry. This is a
// third copy of a constant that cannot be imported across the Python/JS split,
// like CALLBACK_HOST_ALLOWLIST and SITE_SIGN_MAX_SATS before it; if the
// collector's set ever grows, grow this one.
const BOOST_TOPIC_TAGS = new Set(['boostagram', 'value4value', 'boost'])
const DONATION_URL = 'https://localbitcoiners.com/'

// The complete tag vocabulary of `buildExternalNoteTemplate` in
// `login-widget/src/lib/externalBoostagram.js`. An allowlist, not a denylist.
// ⚠️ IF THAT BUILDER EMITS A NEW TAG, ADD IT HERE IN THE SAME CHANGE or every
// site-signed note starts failing.
const ALLOWED_TAGS = new Set(['i', 'k', 'r', 't', 'client', 'amount'])

// ⚠️ `e` AND `p` ARE REFUSED BY OMISSION, AND THAT IS THE POINT OF THE
// ALLOWLIST. Our template emits neither. With an `e` tag a note signed by this
// key appears to REPLY to any note in the world; with `p` tags it becomes a
// mention blast at strangers from an identity carrying our NIP-05. Both are far
// better vehicles for harassment than a standalone post nobody follows, and
// neither is a regression to refuse, because a boost note never has one.

const MAX_TAGS = 24
const MAX_TAG_ITEMS = 4
const MAX_TAG_ITEM_LEN = 512
const MAX_TAGS_TOTAL_LEN = 4096
const CREATED_AT_SKEW_SECS = 300

// ⚠️ KV, BECAUSE PAGES HAS NO RATE LIMITING BINDING. Checked against the
// supported list on 2026-08-19: KV, Durable Objects, R2, D1, Vectorize, Workers
// AI, service bindings, Queues, Hyperdrive, Analytics Engine, variables and
// secrets. Durable Objects would be the textbook counter, but a Pages Function
// can only BIND to a DO class and not define one, so it would mean standing up
// a separate Worker to host it. Don't re-propose the native binding; it isn't
// on this platform.
//
// ⚠️ AND THIS IS FRICTION, NOT A SECURITY BOUNDARY. Two reasons to hold that
// clearly. KV is eventually consistent, so a caller spread across data centres
// is undercounted, and the read-modify-write below loses concurrent increments;
// and an IP limit is bypassed by anyone with a proxy pool regardless of how
// exactly it counts. What actually contains this endpoint is D11's argument:
// one identifiable publisher, `excludes.json`, and the caps above. The limit is
// here to stop casual volume, and being approximate is fine for that.
const RATE_LIMIT = 5
const RATE_WINDOW_SECS = 60

// One boost, capped, and the cap is the modal's own ceiling rather than a
// tighter figure of this endpoint's own.
//
// ⚠️ IT IS A SHAPE BOUND, NOT AN ABUSE BOUND, AND IT WAS RAISED FROM 100k SATS
// ON 2026-08-21 ONCE IT STOPPED BEING BOTH. Reed's call. The reasoning it was
// set on — nothing here can tell a real 500k-sat boost from an invented one —
// is still true, but the escape hatch it leaned on was "above the cap the donor
// still has the donor-signed path", and Anon now routes to this endpoint too.
// So a tight cap no longer only refused fakes; it refused a real anonymous
// booster with no other route, which is the thing this project exists to
// remove.
//
// What actually contains this endpoint is D11's argument rather than this
// number: **the index already accepts unauthenticated writes from the whole of
// Nostr**, since anyone may publish a fabricated boost note from a burner key
// and the collector will index it. A cap here changes what a fake looks like,
// never whether one is possible. What it does still buy is that a single
// request cannot claim a figure the product itself would refuse, so the two
// ceilings are now deliberately the same one.
//
// ⚠️ RESTATED AS `SITE_SIGN_MAX_SATS` IN `login-widget/src/lib/siteSign.js`,
// where the modal reads it to say so in the form rather than letting a donor
// discover it as "invalid amount" after paying. A Pages Function cannot import
// from the widget source and the bundle cannot import from here, the same split
// `CALLBACK_HOST_ALLOWLIST` lives with. **The two copies must stay in step, and
// the widget's `MAX_SATS` is now a third: all three are 5,000,000 sats.**
const MAX_AMOUNT_MSAT = 5_000_000_000   // 5M sats, matching the modal's MAX_SATS

// The attribution is OURS and is not caller-settable. A `client` tag naming
// something else would put a false publisher on a note we signed.
const CLIENT_TAG = 'localbitcoiners.com'

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** http(s) only, and parseable. An `r` tag is a link published under our own
 *  identity, so the same rule the site applies to any third-party URL applies
 *  to one we are about to sign. */
function isSafeUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch { return false }
}

/**
 * Bound the oracle to one shape of one kind. Throws with a caller-facing
 * message; every message is safe to return, none of them echo the input back.
 */
/**
 * Structural checks every template family shares: the tags are an array of
 * bounded string arrays, they are within the total-size budget, and every tag
 * name is in the caller's allowlist.
 *
 * ⚠️ SHARED ON PURPOSE. Two validators with their own copies of this is one
 * validator getting a fix the other does not, which in an allowlist is the
 * failure that does not announce itself. What each family may CONTAIN stays in
 * its own function; only the shape lives here.
 */
function checkTagShape(rawTags, allowed) {
  if (!Array.isArray(rawTags) || rawTags.length > MAX_TAGS) throw new Error('invalid tags')
  const shaped = rawTags.every((tag) =>
    Array.isArray(tag) &&
    tag.length > 0 &&
    tag.length <= MAX_TAG_ITEMS &&
    tag.every((x) => typeof x === 'string' && x.length <= MAX_TAG_ITEM_LEN))
  if (!shaped) throw new Error('invalid tags')
  const totalLen = rawTags.reduce((n, tag) => n + tag.reduce((m, x) => m + x.length, 0), 0)
  if (totalLen > MAX_TAGS_TOTAL_LEN) throw new Error('invalid tags')
  if (!rawTags.every((tag) => allowed.has(tag[0]))) throw new Error('unsupported tag')
  return rawTags
}

/** ±5 minutes, shared by both families. A note dated outside this window is
 *  either a clock problem or an attempt to place it somewhere else in the
 *  timeline. */
function checkCreatedAt(value) {
  const now = Math.floor(Date.now() / 1000)
  const createdAt = Number.isFinite(value) ? Math.floor(value) : now
  if (Math.abs(createdAt - now) > CREATED_AT_SKEW_SECS) throw new Error('created_at out of range')
  return createdAt
}

export function validateBoostTemplate(body) {
  if (!body || typeof body !== 'object') throw new Error('bad template')
  if (body.kind !== 1) throw new Error('only kind 1 boost notes may be signed')

  if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT) {
    throw new Error('invalid content')
  }
  if (!ALLOWED_OPENINGS.some((p) => body.content.startsWith(p))) throw new Error('not a boost note')

  const tags = checkTagShape(body.tags, ALLOWED_TAGS)

  // The two markers every NIP-73 boost consumer keys on. Their presence is what
  // makes this a boost note rather than a kind 1 that merely opens like one.
  const hasTopic = (v) => tags.some((tag) => tag[0] === 't' && tag[1] === v)
  if (!hasTopic('boostagram') || !hasTopic('value4value')) throw new Error('not a boost note')

  for (const tag of tags) {
    if (tag[0] === 'r' && !isSafeUrl(tag[1] || '')) throw new Error('unsupported url')
    if (tag[0] === 'client' && tag[1] !== CLIENT_TAG) throw new Error('unsupported client')
  }

  // ⚠️ Exactly one `amount`, and it is the figure this index will read off the
  // published note. Two of them would let a caller decide which one the
  // collector picked up.
  const amounts = tags.filter((tag) => tag[0] === 'amount')
  if (amounts.length !== 1) throw new Error('invalid amount')
  // ⚠️ PLAIN DIGITS, NOT MERELY SOMETHING `Number()` LIKES. `Number('1.5e6')` is
  // an integer, so a shape check on the parsed value alone would sign the
  // string `1.5e6` into the tag — which reads as 1,500,000 to a JavaScript
  // consumer and raises in the collector's `int()`. The same note would then
  // mean different amounts to different indexers, which is the one thing this
  // tag cannot be allowed to do. Caught by scripts/test-sign-boost.mjs.
  const raw = amounts[0][1]
  if (typeof raw !== 'string' || !/^[0-9]{1,15}$/.test(raw)) throw new Error('invalid amount')
  const msat = Number(raw)
  if (!Number.isInteger(msat) || msat <= 0 || msat > MAX_AMOUNT_MSAT) {
    throw new Error('invalid amount')
  }

  const createdAt = checkCreatedAt(body.created_at)

  return { kind: 1, created_at: createdAt, tags, content: body.content }
}

/**
 * A SITE DONATION note: sats to Local Bitcoiners itself, no podcast behind them.
 *
 * ⚠️ THIS IS NOT `validateBoostTemplate` WITH THE REQUIREMENTS REMOVED. The two
 * families accept disjoint shapes: a boost MUST carry `t=boostagram`,
 * `t=value4value` and exactly one `amount`, and a donation may carry NONE of
 * them, because those are precisely the markers that would make this site's own
 * collector file a donation as a podcast boost. Anything that satisfies one
 * validator is refused by the other, which is what stops the looser-looking
 * shape here from becoming a way around the stricter one.
 *
 * The figure is read out of the headline rather than a tag, so the amount cap
 * applies to donations exactly as it does to boosts.
 */
export function validateDonationTemplate(body) {
  if (!body || typeof body !== 'object') throw new Error('bad template')
  if (body.kind !== 1) throw new Error('only kind 1 notes may be signed')

  if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT) {
    throw new Error('invalid content')
  }

  // ⚠️ THE BANNER IS MANDATORY HERE, where the boost family allows the bare
  // line too. That leniency exists for boost notes published before the banner
  // did; a donation note has no such history, so there is nothing to be
  // backward-compatible with and no reason to accept a second opening.
  const lines = body.content.split('\n')
  if (lines[0] !== DONATION_BANNER_URL) throw new Error('not a donation note')
  const m = DONATION_LINE_RE.exec(lines[1] || '')
  if (!m) throw new Error('not a donation note')

  // ⚠️ THE FIGURE IS RE-DERIVED FROM THE MATCHED TEXT, NOT TRUSTED AS TYPED.
  // The regex admits comma grouping because the builder emits it via
  // toLocaleString, so `1,000,000` and `1000000` both reach here; stripping the
  // separators is what makes the cap below compare numbers rather than strings.
  const sats = Number(m[1].replace(/,/g, ''))
  if (!Number.isInteger(sats) || sats <= 0 || sats * 1000 > MAX_AMOUNT_MSAT) {
    throw new Error('invalid amount')
  }

  const tags = checkTagShape(body.tags, DONATION_ALLOWED_TAGS)

  // The marker that makes this a donation note rather than a kind 1 that merely
  // opens like one, and the mirror of the boost family's topic requirement.
  if (!tags.some((tag) => tag[0] === 't' && tag[1] === 'donation')) {
    throw new Error('not a donation note')
  }
  // ⚠️ REFUSED EXPLICITLY, NOT MERELY ABSENT FROM THE ALLOWLIST. `t` IS an
  // allowed tag name here, so without this a caller could ask for
  // `t=boostagram` on a note the bot signs and put a fabricated boost into this
  // index under our own identity. The allowlist stops `i`, `k` and `amount`;
  // only this stops the third marker.
  if (tags.some((tag) => tag[0] === 't' && BOOST_TOPIC_TAGS.has(tag[1]))) {
    throw new Error('unsupported topic')
  }

  for (const tag of tags) {
    // The only URL a donation note names is the site's own front door. It is
    // published under our identity and points at us, so unlike the boost
    // family's `r` there is no third-party URL to allow.
    if (tag[0] === 'r' && tag[1] !== DONATION_URL) throw new Error('unsupported url')
    if (tag[0] === 'client' && tag[1] !== CLIENT_TAG) throw new Error('unsupported client')
  }

  const createdAt = checkCreatedAt(body.created_at)

  return { kind: 1, created_at: createdAt, tags, content: body.content }
}

/**
 * Which family a submitted template belongs to, decided by its opening line and
 * nothing else.
 *
 * ⚠️ THERE IS NO FALLBACK BETWEEN THEM. A template that opens as a donation is
 * validated as a donation and refused if it does not hold up; it is never
 * retried against the boost validator. Trying both and accepting either would
 * turn two strict shapes into one loose one, and the error a caller sees would
 * name whichever validator happened to complain last.
 */
export function validateTemplate(body) {
  const content = body && typeof body.content === 'string' ? body.content : ''
  return content.startsWith(DONATION_BANNER_URL)
    ? validateDonationTemplate(body)
    : validateBoostTemplate(body)
}

/** nsec or 64-char hex, to a 32-byte key. Returns null on anything else, which
 *  the caller treats as unconfigured rather than as an error to report. */
export function secretKeyFrom(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  try {
    if (raw.startsWith('nsec1')) {
      const { type, data } = nip19.decode(raw)
      return type === 'nsec' ? data : null
    }
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      const bytes = new Uint8Array(32)
      for (let i = 0; i < 32; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
      return bytes
    }
  } catch {}
  return null
}

/**
 * Fixed-window counter in KV. Exported for the test, which is the only way to
 * exercise the window boundary without waiting a minute.
 *
 * The window is derived from the clock rather than stored, so there is nothing
 * to initialise and an abandoned counter expires itself. `expirationTtl` is
 * twice the window because KV's minimum is 60 seconds and a key must outlive
 * the window it counts.
 */
export async function overRateLimit(kv, ip, now = Date.now()) {
  const window = Math.floor(now / 1000 / RATE_WINDOW_SECS)
  const key = `sign-boost:${ip}:${window}`
  const current = Number(await kv.get(key)) || 0
  if (current >= RATE_LIMIT) return true
  await kv.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_SECS * 2 })
  return false
}

export async function onRequestPost({ request, env }) {
  const sk = secretKeyFrom(env.LB_SIGN_NSEC)
  if (!sk) return bad('site signing identity not configured', 503)

  // ⚠️ FAIL CLOSED WITH NO COUNTER BOUND. An in-memory counter is per-isolate
  // on Cloudflare and is therefore no limit at all, which is the shape the plan
  // called out in BMB's version. Refusing to run is what forces the operator to
  // decide, rather than shipping an oracle with nothing in front of it.
  const kv = env.SIGN_RATELIMIT
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return bad('site signing identity not configured', 503)
  }
  // Keyed on the caller's address. CF-Connecting-IP is set by the edge and
  // cannot be spoofed by a client header, unlike X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  try {
    if (await overRateLimit(kv, ip)) return bad('too many requests', 429)
  } catch {
    // A counter we cannot read is a counter we cannot honour. Same answer as
    // no binding at all, for the same reason.
    return bad('site signing identity not configured', 503)
  }

  let body
  try { body = await request.json() } catch { return bad('invalid JSON') }

  let template
  try { template = validateTemplate(body) } catch (e) {
    return bad(e instanceof Error ? e.message : 'invalid template')
  }

  const event = finalizeEvent(template, sk)
  // ⚠️ THE BROWSER PUBLISHES IT. This endpoint never touches a relay: an
  // outbound socket per request is a second thing to abuse, and the client
  // already holds the relay set and the publish path.
  return new Response(JSON.stringify({ event }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// Only POST is exported deliberately. A GET then falls through to the asset
// handler and answers 404, measured under `wrangler pages dev` — NOT the 405
// this comment first claimed. An `onRequest` catch-all returning 405 for other
// methods was written and removed: beside a method-specific handler its
// precedence is easy to get wrong, and 404 on a path that only exists for POST
// is an honest answer.
