/**
 * Ask the site's own signing oracle to sign a boost note under the Local Bitcoiners
 * bot identity.
 *
 * This is the client half of `functions/api/sign-boost.js`, and it exists for
 * one visitor: someone who boosted with a wallet and has no Nostr account. The
 * index counts notes, and they have no key to sign one with, so a wallet-only
 * boost would pay the show and put nothing here. See `boost-login.md` D1 (why
 * a separate npub), D2 (the bot owns what it publishes) and D11 (the evidence
 * standard is the browser's own observation of what settled, the same standard
 * the donor-signed path is held to).
 *
 * ⚠️ THIS RETURNS A SIGNED EVENT AND PUBLISHES NOTHING. The endpoint never
 * touches a relay — an outbound socket per request is a second thing to abuse —
 * so the caller hands the result to `publishSignedKindOne`, exactly as it does
 * with an event a signer returned. The two paths differ in where the signature
 * came from and nowhere else.
 *
 * ⚠️ EVERY FAILURE HERE IS A FAILURE TO POST A NOTE, NEVER A FAILURE TO BOOST.
 * The sats left the wallet before this runs. The caller's copy has to say so,
 * and the offer has to be "try posting again" rather than anything that looks
 * like unwinding a payment.
 */

export const SITE_SIGN_ENDPOINT = '/api/sign-boost'

/**
 * ⚠️ A RESTATEMENT OF `MAX_AMOUNT_MSAT` IN `functions/api/sign-boost.js`, AND
 * THE TWO COPIES MUST STAY IN STEP. A Pages Function cannot import from
 * `login-widget/src` and this bundle cannot import from `functions/`, which is
 * the same split `CALLBACK_HOST_ALLOWLIST` lives with on the LNURL path.
 *
 * It is here so the modal can SAY SO rather than have a donor discover it: the
 * endpoint's own answer is `invalid amount`, which is accurate and tells
 * somebody who has just paid nothing about what to do.
 *
 * **It equals `MAX_SATS` in `ExternalBoostModal.jsx`, so in practice it never
 * bites.** That is deliberate as of 2026-08-21: the endpoint's cap used to be
 * 100k on the argument that a larger claim could go down the donor-signed path
 * instead, and Anon routing to this endpoint took that escape away. The guard
 * kept here is only that one request cannot claim a figure the product itself
 * would refuse. See the long note at `MAX_AMOUNT_MSAT` for why the number was
 * never the thing containing this endpoint.
 */
export const SITE_SIGN_MAX_SATS = 5_000_000

// The signature is one secp256k1 operation in a V8 isolate, so the budget is
// almost entirely network. Long enough to survive a cold isolate, short enough
// that a donor sitting on a done screen is not left watching it.
const TIMEOUT_MS = 12_000

// Bounded, because it is a third-party-shaped read even though the third party
// is us: a Function answering with something unexpected must not be able to
// stall the browser inside `.json()`.
const MAX_BYTES = 64 * 1024

/**
 * The endpoint's own explanation, preferred over ours.
 *
 * Same discipline as `readErrorReason` on the LNURL path: the server said
 * something specific, and replacing it with our own wording deletes the only
 * account the donor gets. Two answers are worth naming, because neither is the
 * donor's fault and neither is retryable in the next few seconds:
 *
 *   503  the bindings are absent, so the feature is off on this deployment
 *   429  the fixed-window KV counter, 5/min/IP
 */
function messageForFailure(status, reason) {
  if (status === 503) return 'Posting to Nostr isn’t switched on right now. Your boost still went through.'
  if (status === 429) return 'Too many notes from this connection just now. Wait a minute and try posting again.'
  if (reason) return `Couldn’t post the note: ${reason}. Your boost still went through.`
  return 'Couldn’t post the note. Your boost still went through.'
}

async function readReason(resp) {
  try {
    const text = await resp.text()
    if (!text || text.length > MAX_BYTES) return ''
    const body = JSON.parse(text)
    const reason = typeof body?.error === 'string' ? body.error : ''
    // Control characters stripped and the whole thing capped, the same
    // treatment any other server-supplied string gets before it reaches a
    // screen. React escapes it at render; this is about shape, not markup.
    return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 180)
  } catch { return '' }
}

/**
 * @param {object} template  the output of `buildExternalNoteTemplate`
 * @returns {Promise<object>} a signed nostr event, ready for publishSignedKindOne
 */
export async function signKindOneWithSite(template) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(SITE_SIGN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(template),
      signal: ctrl.signal,
      // No credentials: the endpoint is unauthenticated by design and there is
      // nothing about this caller worth sending.
      credentials: 'omit',
    })
  } catch {
    throw new Error('Couldn’t reach Local Bitcoiners to post the note. Your boost still went through.')
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) throw new Error(messageForFailure(resp.status, await readReason(resp)))

  let body
  try { body = await resp.json() } catch { throw new Error(messageForFailure(0, '')) }
  const event = body?.event
  // ⚠️ Checked rather than assumed. `publishSignedKindOne` answers
  // `{published:false}` on an event with no `sig` rather than throwing, so an
  // unsigned reply would otherwise read to the donor as a note that posted.
  if (!event?.id || !event?.sig) throw new Error(messageForFailure(0, ''))
  return event
}
