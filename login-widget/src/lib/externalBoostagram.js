/**
 * Boostagram + Nostr-note builders for the EXTERNAL-episode boost flow.
 *
 * DELIBERATELY SEPARATE from lib/boostagram.js. That file drives the LB boost
 * (kind 30078 metadata for the LB bot, LB-branded kind-1 share). This file has
 * nothing to do with LB stats/bots: external boosts publish no 30078, and the
 * kind-1 note carries the *external* show's guid tags — none of the
 * LocalBitcoinersEp / site-feed markers the site pipeline filters on.
 *
 * Wire format mirrors Boost Me Bitch / the Podcasting 2.0 boostagram spec so
 * the podcasters' tooling (Helipad, etc.) parses our boosts like any other.
 */

const TLV_BOOSTAGRAM = 7629169  // Podcasting 2.0 TLV record for the boostagram JSON
export const MAX_MESSAGE_CHARS = 200  // match Boost Me Bitch's message cap
// Rides in the TLV record, so it is what the recipient's Helipad (or any other
// boostagram reader) shows as the sending app. Left as LB's on fork; every
// boost sent before this was mislabelled to the podcaster.
const APP_NAME = 'Local Bitcoiners'

/**
 * The banner every boost note opens with.
 *
 * A bare image URL on its own line is what Nostr clients render inline, so this
 * is the note's picture rather than a link in it. It leads the content because
 * that is where a client puts the preview.
 *
 * ⚠️ THE SIGNING ORACLE PINS THIS EXACT STRING. `functions/api/sign-boost.js`
 * refuses anything that does not open with a boost note's own shape, and with a
 * URL in front of that shape the check has to know the URL. **Change it here
 * and change `BOOST_BANNER_URL` there in the same commit**, or every site-signed
 * note starts failing; `scripts/test-sign-boost.mjs` asserts the two agree, so
 * that failure lands in the test rather than in production.
 *
 * ⚠️ IT IS NOT AN `r` TAG. `r` is the episode's own URL, which is what a client
 * and this index both read as "what this note is about". A second one pointing
 * at a decoration would make that ambiguous.
 */
export const BOOST_BANNER_URL = 'https://localbitcoiners.com/assets/LocalBitcoiners_banner.png'

/**
 * The banner a SITE DONATION note opens with.
 *
 * ⚠️ A DONATION IS NOT A BOOST, AND THE TWO NOTES ARE DELIBERATELY DIFFERENT
 * OBJECTS. A boost pays a third party's value block and belongs in this index;
 * a donation pays Local Bitcoiners and must not. Giving them one banner would make
 * the one visible difference between them the wording of a single line.
 *
 * ⚠️ THE SIGNING ORACLE PINS THIS STRING TOO, exactly as it pins the boost
 * banner. `functions/api/sign-boost.js` restates it as `DONATION_BANNER_URL`;
 * change it here and there in one commit, and `scripts/test-sign-boost.mjs`
 * fails if the two drift.
 */
export const DONATION_BANNER_URL = 'https://i.nostr.build/QoXlTuDurz3b4EqNefAzoC.png'

/** Where a donation note points. The site itself: there is no episode. */
export const DONATION_URL = 'https://localbitcoiners.com/'

/**
 * A typed "From" name, as it is allowed to appear in a note the BOT signs.
 *
 * ⚠️ THIS IS THE ONLY PLACE A DONOR'S TYPED TEXT BECOMES ONE OF THE BOT'S OWN
 * STRUCTURED LINES, so it is bounded here rather than at the call site. Two
 * things are stripped and both are about the collector rather than about
 * looks:
 *
 *   - **Newlines**, because the body is read line by line. A name carrying one
 *     could add a whole line of its own to a note published under our identity.
 *   - **The mobile-phone emoji**, because `📱 via <App>` is the attribution
 *     line `clients.py#_VIA_RE` reads to fill `client_via`. That regex
 *     `.search`es, so our own line 1 wins today whatever the name says; the
 *     strip is what keeps that true if the lines are ever reordered.
 *
 * The cap is 40 characters, matching the 16-character display cap on
 * `/booster` in spirit rather than in figure: this one is a line of prose in a
 * permanent public note, not a button label.
 */
export const MAX_SENDER_NAME_CHARS = 40
export function sanitizeSenderName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\u{1F4F1}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SENDER_NAME_CHARS)
    .trim()
}

// Hex-encode a UTF-8 string (browser — no Buffer).
export function hexEncode(str) {
  return [...new TextEncoder().encode(str)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 32-byte random preimage, hex. Some NWC wallets (Zeus embedded node) require
// the client to supply the keysend preimage; wallets that generate their own
// ignore it and return theirs.
export function randomPreimageHex() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Build a Podcasting 2.0 boostagram for a single leg.
 * @param {object} p
 * @param {number} p.legMsats     - this leg's amount (msats)
 * @param {number} p.totalMsats   - the whole boost's amount (msats)
 * @param {string} [p.message]
 * @param {string} [p.senderName]
 * @param {string} [p.senderPubkey] - hex pubkey when the booster is signed in
 * @param {string} [p.showTitle]
 * @param {string} [p.episodeTitle]
 * @param {string} [p.podcastGuid]
 * @param {string} [p.itemGuid]
 * @param {string} [p.url]         - the Boost Me Bitch episode URL
 * @param {string} [p.recipientName]
 * @param {string} [p.boostUuid]
 */
export function buildBoostagram({
  legMsats, totalMsats, message, senderName, senderPubkey,
  showTitle, episodeTitle, podcastGuid, itemGuid, url, recipientName, boostUuid,
}) {
  const b = {
    action: 'boost',
    app_name: APP_NAME,
    value_msat: legMsats,
    value_msat_total: totalMsats,
    ts: 0,
  }
  const msg = (message || '').trim()
  if (msg) b.message = msg.slice(0, MAX_MESSAGE_CHARS)
  if (senderName) b.sender_name = senderName
  if (senderPubkey) b.sender_id = senderPubkey
  if (showTitle) b.podcast = showTitle
  if (episodeTitle) b.episode = episodeTitle
  if (podcastGuid) b.guid = podcastGuid
  if (itemGuid) b.episode_guid = itemGuid
  if (url) { b.url = url; b.boost_link = url }
  if (recipientName) b.name = recipientName
  if (boostUuid) b.uuid = boostUuid
  return b
}

// NWC pay_keysend TLV records — values HEX-encoded per NIP-47.
export function toTlvHex(boostagram, recipient) {
  const records = [{ type: TLV_BOOSTAGRAM, value: hexEncode(JSON.stringify(boostagram)) }]
  if (recipient.customKey && recipient.customValue) {
    const ck = Number(recipient.customKey)
    if (Number.isFinite(ck)) records.push({ type: ck, value: hexEncode(recipient.customValue) })
  }
  return records
}

// WebLN keysend customRecords — PLAIN UTF-8. WebLN providers (Alby, Mutiny)
// hex-encode internally; pre-hexing here double-encodes and the receiver
// can't JSON.parse the boostagram.
export function toWeblnRecords(boostagram, recipient) {
  const records = { [String(TLV_BOOSTAGRAM)]: JSON.stringify(boostagram) }
  if (recipient.customKey && recipient.customValue) records[recipient.customKey] = recipient.customValue
  return records
}

/**
 * Unsigned kind-1 "I boosted" note for an external episode. Uses the external
 * show's NIP-73 guid tags + the Boost Me Bitch episode URL; keeps
 * client=localbitcoiners.com; NO `nostr:` mention (external shows have no
 * Nostr identity we can vouch for). Published only when the booster is signed
 * in (user-signed), after settlement confirms — the caller enforces that.
 *
 * ⚠️ `paidSats` IS WHAT ACTUALLY SETTLED, NOT WHAT THE DONOR TYPED. A boost
 * distributes across a show's value block and any leg of it can fail, so the
 * two numbers differ on every partial. Reporting the intended amount credits
 * the donor with sats no recipient received, and because Local Bitcoiners indexes
 * its own notes, that number then becomes a row in this site's own dataset —
 * the `amount` tag below is exactly what the collector reads. The caller
 * recomputes this from live leg state at the moment of sharing, so a leg that
 * succeeded on retry is counted.
 *
 * `legsPaid` / `legsTotal` disclose the shortfall in words. `legsTotal`
 * excludes legs allocated zero sats: a leg that was never attempted did not
 * fail, and counting it would understate the outcome.
 */
export function buildExternalNoteTemplate({
  paidSats, legsPaid, legsTotal, message, senderName, showTitle, episodeTitle, podcastGuid, itemGuid, bmbUrl,
}) {
  const sats = Number(paidSats) || 0
  const paid = Number(legsPaid) || 0
  const total = Number(legsTotal) || 0
  const msg = (message || '').trim()
  const showEp = episodeTitle
    ? `${showTitle || 'a podcast'} • ${episodeTitle}`
    : (showTitle || 'a podcast')
  const from = sanitizeSenderName(senderName)
  const lines = [
    BOOST_BANNER_URL,
    `⚡Just boosted ${sats.toLocaleString()} sats 📱 via localbitcoiners.com`,
  ]
  // "splits" rather than "legs": it is the word the value-block spec and the
  // podcast apps use, and this line is read by people outside this codebase.
  if (total > 0 && paid < total) lines.push(`⚠️ ${paid} of ${total} splits paid`)
  // ⚠️ THE NAME IS PROSE AND NOTHING ELSE — no `p` tag, no author claim, no
  // `proxy_for_pubkey` (boost-login.md D2/D15). Nothing can verify that the
  // person named authorised a note signed by a key they do not hold, so the
  // booster this index credits is the signing identity and only that. The line
  // exists so a reader of the note can see who the sats came from; the same
  // string rides the boostagram TLV, which is what the podcaster reads.
  //
  // Only the caller on the bot path passes it. A donor-signed note is already
  // from the donor, and a "From" line on it would be the author naming
  // themselves in the third person.
  if (from) lines.push(`👤 From ${from}`)
  if (msg) lines.push(`💬 "${msg.slice(0, MAX_MESSAGE_CHARS)}"`)
  lines.push('')
  lines.push(`🎙️ ${showEp}`)
  if (bmbUrl) lines.push(bmbUrl)

  const tags = [
    ['t', 'boost'],
    ['t', 'podcast'],
    // Topic tags NIP-73 boost consumers key on to tell a boost note from any
    // other kind 1. Our own collector also accepts a bare `t=boost`
    // (classify.py#BOOST_TOPIC_TAGS), but nothing else does, so a note without
    // these is invisible to every indexer but ours.
    ['t', 'boostagram'],
    ['t', 'value4value'],
    ['client', 'localbitcoiners.com'],
  ]
  if (bmbUrl) tags.push(['r', bmbUrl])
  if (podcastGuid) { tags.push(['i', `podcast:guid:${podcastGuid}`]); tags.push(['k', 'podcast:guid']) }
  if (itemGuid) { tags.push(['i', `podcast:item:guid:${itemGuid}`]); tags.push(['k', 'podcast:item:guid']) }
  tags.push(['amount', String(Math.round(sats * 1000))])

  return { kind: 1, created_at: Math.floor(Date.now() / 1000), content: lines.join('\n'), tags }
}

/**
 * The Nostr note for a SITE DONATION: sats to Local Bitcoiners itself, one leg at
 * 100% to `RECIPIENT_LUD16`, no podcast and no episode behind it.
 *
 * It is the boost note's twin by design — same banner-then-⚡-line shape, same
 * `👤 From` line on the bot path, same `💬 "…"` message — because a reader
 * should recognise it instantly as the same site speaking. What differs is
 * every machine-readable part, and that is the whole point of it being a
 * separate builder:
 *
 * ⚠️ IT CARRIES NO NIP-73 TAGS, NO BOOST TOPIC TAGS AND NO `amount` TAG, AND
 * ALL THREE OMISSIONS ARE LOAD-BEARING. This site's own collector decides what
 * is a boost in two places, and a donation must fail both:
 *
 *   - `scan.py` REQs `{kinds:[1], "#k": BOOST_FILTER_K}`, so a note with no `k`
 *     tag is never even fetched. That is what keeps the existing site tip out
 *     of the index today, and it is the outer guard here.
 *   - `classify.py` then sets `is_boost` from EITHER a `t` tag in
 *     {boostagram, value4value, boost} OR a positive `amount` tag. So carrying
 *     either one would make a donation an indexed boost the moment anything
 *     widened that filter — a boost to no show, in an index whose whole subject
 *     is podcast boosts.
 *
 * This follows the decision `FEED_GUID = null` already records: Local Bitcoiners is a
 * client, not a podcast, so it has nothing to claim a boost against. The sats
 * figure lives in the note's own text, where a reader can see it and no indexer
 * will mistake it for a boostagram.
 *
 * ⚠️ AND IT IS WHY THE ORACLE NEEDS A SECOND SHAPE. `validateBoostTemplate`
 * REQUIRES `t=boostagram`, `t=value4value` and exactly one `amount` — the exact
 * three things this note must not have — so a donation cannot be signed by the
 * bot through the boost path. See `validateDonationTemplate` there.
 */
export function buildDonationNoteTemplate({ paidSats, message, senderName }) {
  const sats = Number(paidSats) || 0
  const msg = (message || '').trim()
  const from = sanitizeSenderName(senderName)
  const lines = [
    DONATION_BANNER_URL,
    donationHeadline(sats),
  ]
  // Same rule as the boost note: prose only, never a `p` tag or an author
  // claim. Only the bot path passes a name; a donor-signed note is already
  // from the donor.
  if (from) lines.push(`👤 From ${from}`)
  if (msg) lines.push(`💬 "${msg.slice(0, MAX_MESSAGE_CHARS)}"`)
  lines.push('')
  lines.push(DONATION_URL)

  const tags = [
    // `donation` and `localbitcoiners` are deliberately outside the collector's
    // BOOST_TOPIC_TAGS set. Do not add `boost`, `boostagram` or `value4value`
    // here to "make it findable"; that is the one change that files a donation
    // as a podcast boost.
    ['t', 'donation'],
    ['t', 'localbitcoiners'],
    ['client', 'localbitcoiners.com'],
    ['r', DONATION_URL],
  ]

  return { kind: 1, created_at: Math.floor(Date.now() / 1000), content: lines.join('\n'), tags }
}

/**
 * The donation note's second line, and the ONLY place its wording is decided.
 *
 * ⚠️ THE ORACLE MATCHES THIS LINE WHOLE, NOT AS A PREFIX. A donation note
 * carries no `amount` tag, so this string is where the figure lives, and
 * `functions/api/sign-boost.js` reads the sats back out of it to apply the same
 * cap the boost path applies to its tag. Change the wording here and the
 * regex there in one commit; `scripts/test-sign-boost.mjs` feeds the validator
 * from this builder, so a drift fails the test rather than production.
 */
export function donationHeadline(sats) {
  return `⚡Just donated ${Number(sats || 0).toLocaleString('en-US')} sats to Local Bitcoiners 📱 via localbitcoiners.com`
}

/**
 * The LNURL comment an lnaddress leg sends, carrying a BoostBox descriptor when
 * one could be stored.
 *
 * Helipad reads `rss::payment::boost <url>` out of the invoice memo, HEADs that
 * URL and pulls the full boostagram from an `x-rss-payment` header. That is the
 * only channel an lnaddress leg has: a keysend leg carries its metadata inline
 * in the TLV, and this one has nothing but the comment.
 *
 * ⚠️ THE DESCRIPTOR IS WHOLE OR IT IS ABSENT, AND THAT IS THE ENTIRE POINT OF
 * THIS FUNCTION. The obvious version is `${desc} ${message}`.slice(0, allowed),
 * and it is wrong in a way that looks fine: `commentAllowed` is 255 at Alby, a
 * truncation cuts from the RIGHT, and the descriptor is on the left — so a long
 * message does not lose its own tail, it shortens the URL into a dead link
 * while having spent the whole allowance on it. The podcaster then gets a
 * comment that is mostly a broken URL and a fetch that 404s, which is worse
 * than the bare message they get today.
 *
 * So: if the descriptor does not fit whole, it is dropped and the message takes
 * the full allowance. If it fits, the message takes whatever is left.
 *
 * ⚠️ AND A MISSING DESCRIPTOR IS NEVER FATAL. `/api/boostbox` fails closed on an
 * unconfigured key, a timeout or an upstream refusal, and every one of those
 * arrives here as an empty `descriptorUrl`. The leg still pays and the
 * podcaster still gets the message, which is exactly what shipped before any of
 * this existed.
 */
export function buildLnurlComment({ descriptorUrl, message, commentAllowed }) {
  const allowed = Number(commentAllowed) || 0
  if (allowed <= 0) return ''
  const msg = (message || '').trim().slice(0, MAX_MESSAGE_CHARS)
  const url = (descriptorUrl || '').trim()
  if (!url) return msg.slice(0, allowed)

  const descriptor = `rss::payment::boost ${url}`
  // Not merely "too long to be useful": a partial URL is an active harm,
  // because the recipient's tooling will try to fetch it.
  if (descriptor.length > allowed) return msg.slice(0, allowed)
  if (!msg) return descriptor

  // One space between them, so the remaining budget is what is left after it.
  const remaining = allowed - descriptor.length - 1
  if (remaining <= 0) return descriptor
  return `${descriptor} ${msg.slice(0, remaining)}`
}
