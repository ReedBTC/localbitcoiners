/* Boost-wall record rules: pure, no DOM, no network, no nostr-tools.
 *
 * Since the donor-note wall (lb-v86) a record in /api/boost-wall carries two
 * notes for one boost: `event`, the show bot's boost-board reply, always
 * present and the record's identity (thread position, excluded-id list, the
 * New Member payment-hash join, the card cache all key on it), and optionally
 * `donor_event`, the booster's OWN kind-1 as published by their app (Fountain,
 * the site's episode flow, BullishBoosts, …). The site shows ONE card per
 * boost: the donor's note when the record has one, the show's note otherwise.
 * That is the OnlyBoosts model, and it is the whole reason this file exists.
 *
 * Kept as a NEW module on purpose: boosts-thread.js is shared and cached, and
 * a named export added to a cached shared module is a link-time error on
 * every page that imports it. It is also what makes these rules testable in
 * Node (scripts/test-boost-record.mjs) — boosts-thread.js imports the vendored
 * nostr-tools by absolute URL and cannot load outside a browser.
 *
 * Everything here reads the record's payment meta rather than note text
 * wherever it can. A Fountain donor note is just the comment: no sats, no app,
 * no episode anywhere in its text or tags beyond the NIP-73 guid. The text
 * regexes survive only as fallbacks for records without meta (the thread root,
 * Reed's hand-published corrections, third-party replies, the relay fallback).
 */

// ── Record parsing ──────────────────────────────────────────────────
// ⚠️ episode_num is a zero-padded STRING ("019", "001") matching sats.csv's
// column, and is absent rather than 0 when unknown. Compare it through
// episodeNumMatches below, never with `=== 19`.
//
// donor_event is passed through unverified here; boosts-thread.js verifies
// the signature (same chunked pass as `event`) and drops it on failure or on
// a pubkey that disagrees with sender_npub. `"donor_event" in rec` absent
// means "no donor note known"; a record may carry donor_note_id without the
// raw event (known but not fetched yet), which renders as the show note.
export function parseWallRecord(rec) {
  const num = typeof rec.episode_num === 'string' ? rec.episode_num : null
  const donor = rec.donor_event
  return {
    paymentHash:  rec.payment_hash  || null,
    sats:         Number.isFinite(rec.sats) ? rec.sats : null,
    senderNpub:   rec.sender_npub   || null,
    senderName:   rec.sender_name   || null,
    episodeId:    rec.episode_id    || null,
    episodeNum:   num,
    episodeTitle: rec.episode_title || null,
    showLevel:    rec.show_level === true,
    app:          rec.app           || null,
    source:       rec.source        || null,
    settledAt:    rec.settled_at    || null,
    standaloneId: rec.standalone_id || null,
    message:      typeof rec.message === 'string' ? rec.message : null,
    donorNoteId:  rec.donor_note_id || null,
    donorMatch:   rec.donor_match   || null,
    donorEvent:   donor && typeof donor.id === 'string' && donor.kind === 1 ? donor : null,
  }
}

// ── Which note the card shows ───────────────────────────────────────
// The one rule. `showEvent` is the record's `event`; `meta` its parsed
// record (null for anything the relay fallback supplied).
export function displayEventOf(showEvent, meta) {
  return meta?.donorEvent || showEvent
}

export function isDonorCard(meta) {
  return Boolean(meta?.donorEvent)
}

// ── Sats, time, episode: meta first, note text as the fallback ──────
const SATS_LINE_RE = /💰\s*([\d,]+)\s*sats/i

export function boostSatsOf(showEvent, meta) {
  if (meta && Number.isFinite(meta.sats)) return meta.sats
  const m = (showEvent?.content || '').match(SATS_LINE_RE)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0
}

// Unix seconds the boost settled, for sorting and range windows. Never the
// donor note's created_at: measured over 441 matched boosts on 2026-10-17 it
// sits a median 2 s after settlement but ranges from 13 min before to 15 min
// after, and 124 notes precede their own payment. The show note's created_at
// is the bot's publish time, which is what the wall sorted on before and is
// still the fallback for records without meta.
export function boostTimeOf(showEvent, meta) {
  if (meta?.settledAt) {
    const t = Date.parse(meta.settledAt)
    if (Number.isFinite(t)) return Math.floor(t / 1000)
  }
  return showEvent?.created_at || 0
}

// Boost-bot notes carry the episode in the 🎙️ line, copied verbatim from the
// Fountain title. Most episodes read `… | Ep. NNN`; episode 1 is the lone
// exception (`Local Bitcoiners • 001. …`), caught by the second alternative,
// anchored to the show-name prefix so a stray bullet list in a message body
// does not match.
export function episodePattern(epNum) {
  return new RegExp(
    `\\bEp\\.?\\s*0*${epNum}\\b|Local Bitcoiners\\s*•\\s*0*${epNum}\\.`,
    'i',
  )
}

export function episodeNumMatches(showEvent, meta, epNum) {
  if (!Number.isFinite(epNum) || epNum <= 0) return false
  if (meta?.episodeNum) return parseInt(meta.episodeNum, 10) === epNum
  // A record with payment meta but no episode number is a show-level boost
  // or one the bot could not place; the show note's text would not name an
  // episode either, so only meta-less events fall through to the regex.
  if (meta?.paymentHash) return false
  return episodePattern(epNum).test(showEvent?.content || '')
}

// ── The meta strip ──────────────────────────────────────────────────
// Printed on every card with payment meta, so a donor card says what the
// show card's text says: how much, from which app, on which episode. Returns
// the parts as strings; the renderer joins them.
export function metaStripParts(meta) {
  if (!meta || !Number.isFinite(meta.sats)) return []
  const parts = [`⚡ ${meta.sats.toLocaleString('en-US')} sats`]
  if (meta.app) parts.push(`via ${meta.app}`)
  if (meta.episodeNum) {
    const n = parseInt(meta.episodeNum, 10)
    parts.push(Number.isFinite(n) ? `Ep. ${n}` : `Ep. ${meta.episodeNum}`)
  } else if (meta.showLevel) {
    parts.push('Show boost')
  }
  return parts
}

// ── Fountain's trailer ──────────────────────────────────────────────
// Fountain appends `\n\nhttps://fountain.fm/episode/<id>\n\nnostr:nevent1…`
// to every boost comment it publishes, the nevent being the kind-9735 zap
// receipt. Rendered verbatim that is a dead episode link plus a "quoted note
// not available" embed under every Fountain card. Mirrors
// strip_fountain_trailer in bots/shared/boost_formatter.py: a no-op unless
// the trailing nevent decodes to kind 9735, so a donor who quoted a note on
// purpose keeps it. Render-time only; the signed event is never rewritten.
const FOUNTAIN_TRAILER_RE =
  /\s*https?:\/\/fountain\.fm\/episode\/\S+\s+(?:nostr:)?(nevent1[02-9ac-hj-np-z]+)\s*$/i

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

// Kind TLV (type 3) of an nevent, or null. A hand-rolled decoder so this
// module stays free of nostr-tools; the bech32 checksum is not checked, since
// a corrupt string can only make this return null and leave the text alone.
export function neventKind(entity) {
  try {
    const s = String(entity || '').toLowerCase()
    if (!s.startsWith('nevent1')) return null
    const data = s.slice(s.lastIndexOf('1') + 1, -6)
    const five = []
    for (const c of data) {
      const v = BECH32_CHARSET.indexOf(c)
      if (v < 0) return null
      five.push(v)
    }
    const bytes = []
    let acc = 0, bits = 0
    for (const v of five) {
      acc = (acc << 5) | v
      bits += 5
      while (bits >= 8) {
        bits -= 8
        bytes.push((acc >> bits) & 0xff)
      }
    }
    let i = 0
    while (i + 1 < bytes.length) {
      const t = bytes[i], ln = bytes[i + 1]
      if (t === 3) {
        let k = 0
        for (const b of bytes.slice(i + 2, i + 2 + ln)) k = k * 256 + b
        return k
      }
      i += 2 + ln
    }
    return null
  } catch {
    return null
  }
}

export function stripFountainTrailer(text) {
  if (!text) return text || ''
  const m = text.match(FOUNTAIN_TRAILER_RE)
  if (!m || neventKind(m[1]) !== 9735) return text
  return text.slice(0, m.index).replace(/\s+$/, '')
}

// The text a card body renders: the donor note minus Fountain's trailer, or
// the show note verbatim.
export function displayContentOf(showEvent, meta) {
  const ev = displayEventOf(showEvent, meta)
  const text = ev?.content || ''
  return isDonorCard(meta) ? stripFountainTrailer(text) : text
}

// ── Donor-event sanity (shape only; the signature is the caller's) ──
// The wall file is transport, not trust: a donor_event must be a kind 1 and,
// when the record names the sender, must be signed by that sender. Returns
// the reason it was dropped, or null when it may be shown.
export function donorEventProblem(meta, senderPubkeyHex) {
  const ev = meta?.donorEvent
  if (!ev) return null
  if (ev.kind !== 1) return 'not-kind-1'
  if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return 'bad-pubkey'
  if (senderPubkeyHex && ev.pubkey.toLowerCase() !== senderPubkeyHex.toLowerCase()) return 'pubkey-mismatch'
  if (!fountainCommentMatches(meta)) return 'comment-mismatch'
  return null
}

// The ledger's "no comment" sentinel (bots/shared/boost_formatter.py).
const NO_COMMENT = '*no comment with boost*'

// A comment as it reads after Fountain and the ledger have each had their
// way with it: trailing fountain.fm episode URL (with or without the nevent
// Fountain appends) gone, the no-comment sentinel empty, whitespace folded.
export function normalizeComment(text) {
  let t = typeof text === 'string' ? text : ''
  if (t.trim() === NO_COMMENT) return ''
  // The ledger keeps a comment's line breaks as a literal backslash-n pair.
  t = t.replace(/\\n/g, ' ')
  // Fountain's trailer, in either form: the episode URL alone, or the URL
  // followed by the nevent (a zap receipt on a note; older ledger rows kept
  // it too). Kind is not checked here: this is a comparison, not a render.
  t = t.replace(/\s*https?:\/\/fountain\.fm\/episode\/\S+(?:\s+(?:nostr:)?nevent1[02-9ac-hj-np-z]+)?\s*$/i, '')
  return t.replace(/\s+/g, ' ').trim()
}

// A Fountain note is the booster's comment verbatim, so a note whose comment
// is not the record's message belongs to another boost (two boosts by one
// npub minutes apart look alike to the bots' npub-only match). Only Fountain
// records are checked: the site's own notes wrap the message in a sentence,
// and a record without a message cannot be checked at all.
export function fountainCommentMatches(meta) {
  if (!meta?.donorEvent || meta.app !== 'Fountain') return true
  if (typeof meta.message !== 'string') return true
  return normalizeComment(meta.donorEvent.content) === normalizeComment(meta.message)
}
