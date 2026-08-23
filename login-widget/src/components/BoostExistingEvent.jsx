/**
 * BoostExistingEvent — "boost an existing meetup" card.
 *
 * Accepts EITHER a Nostr calendar-event naddr (kind 31922/31923) or an
 * external URL (meetup.com, Eventbrite, anywhere). The boost-the-show
 * modal opens prefilled with the assembled boostagram message either
 * way; only naddr-based meetups show up in the boosted-meetup list on
 * /meetups (that list is intentionally NIP-52-only).
 *
 * Visually styled with the LB cream-card design system; see styles.css.
 */
import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { interpolateNaddr } from '../lib/eventAnnouncement.js'
import PasswordManagerHoneypot from './PasswordManagerHoneypot.jsx'

const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
}

// Detect what the user pasted. URL → external link; naddr1… → Nostr
// calendar event; anything else (or nostr:naddr decoded to something
// other than naddr) → error. Both the URL and naddr branches feed the
// same boost-the-show modal, just with different placeholder substitution.
function classify(raw) {
  const s = String(raw || '').trim().replace(/^nostr:/i, '')
  if (!s) return { kind: 'empty' }
  if (/^https?:\/\//i.test(s)) {
    try {
      // Validates structure (rejects "https://"" with nothing after, etc.).
      // eslint-disable-next-line no-new
      new URL(s)
      return { kind: 'url', value: s }
    } catch {
      return { kind: 'invalid', reason: 'That URL doesn’t look right — include the full https://… address.' }
    }
  }
  try {
    const decoded = nip19.decode(s)
    if (decoded.type !== 'naddr') {
      return { kind: 'invalid', reason: 'That’s a Nostr identifier but not a calendar event address (naddr1…).' }
    }
    return { kind: 'naddr', value: s }
  } catch {
    return { kind: 'invalid', reason: 'Couldn’t recognize that — paste an naddr1… string or a full https://… URL.' }
  }
}

export default function BoostExistingEvent({
  sessionUser,
  onRequestSignIn,
  onOpenShowBoostWithMessage,
}) {
  const [input, setInput] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleBoost = () => {
    setError('')
    const cls = classify(input)
    if (cls.kind === 'empty') {
      setError('Paste your event’s naddr or URL to boost.')
      return
    }
    if (cls.kind === 'invalid') {
      setError(cls.reason)
      return
    }
    // No login check here on purpose: the boost handoff goes through
    // openShowBoost, which prompts login when needed AND re-opens itself
    // prefilled with this message after sign-in (via its pending action).
    // Short-circuiting to onRequestSignIn here would just drop the message.
    // For naddrs, interpolateNaddr prefixes the value with `nostr:` when
    // appending; for URLs we want the URL inline as-is. Same {naddr}
    // placeholder behavior either way (replace where the user kept it,
    // otherwise append at the end).
    let prefilled
    if (cls.kind === 'naddr') {
      prefilled = interpolateNaddr(message, cls.value)
    } else {
      const t = String(message || '')
      if (t.includes('{naddr}')) {
        prefilled = t.replaceAll('{naddr}', cls.value)
      } else if (t.includes(cls.value)) {
        prefilled = t
      } else {
        prefilled = t.trim() + (t.trim() ? '\n\n' : '') + cls.value
      }
    }
    onOpenShowBoostWithMessage?.(prefilled)
  }

  return (
    <div className="lb-card relative space-y-3">
      <PasswordManagerHoneypot />
      <h2 className="lb-card-heading">
        Boost an existing meetup
      </h2>
      <p className="lb-muted" style={{ fontSize: '0.85rem' }}>
        Paste a Nostr calendar event (naddr1…) or any external URL — meetup.com,
        Eventbrite, your group’s site, etc.
      </p>
      <div>
        <label className="lb-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Event naddr or external URL
        </label>
        <input
          type="search"
          value={input}
          onChange={e => { setError(''); setInput(e.target.value) }}
          placeholder="naddr1… or https://…"
          spellCheck="false"
          autoCapitalize="off"
          autoCorrect="off"
          {...NO_AUTOFILL}
          className="lb-input"
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' }}
        />
        <p style={{ fontSize: '0.78rem', color: 'var(--muted,#5a7488)', marginTop: '0.35rem' }}>
          External URLs <strong>won’t appear in the listings</strong> on this page (those are
          reserved for NIP-52 calendar events) — but the boost still goes through.
        </p>
      </div>
      <div>
        <label className="lb-label">
          Boost message <span style={{ color: 'var(--muted,#5a7488)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(editable)</span>
        </label>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          className="lb-input"
          style={{ minHeight: '90px', resize: 'vertical', lineHeight: 1.55 }}
          {...NO_AUTOFILL}
        />
        <p style={{ fontSize: '0.78rem', color: 'var(--muted,#5a7488)', marginTop: '0.35rem' }}>
          Your naddr or URL will be included with your boost message
        </p>
      </div>
      {error && <div className="lb-error">{error}</div>}
      <button onClick={handleBoost} className="lb-btn lb-btn-primary" style={{ width: '100%', padding: '0.85rem 1.15rem', fontSize: '1rem' }}>
        <svg viewBox="0 0 24 24" fill="currentColor" className="lb-btn-publish-bolt" aria-hidden="true">
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
        Boost this meetup
      </button>
    </div>
  )
}
