/**
 * EventComposer — single-shot meetup publisher for localbitcoiners.com/newevent.
 *
 * Visually styled with the LB cream-card design system (defined in
 * styles.css under "/newevent cream-card design system") so the
 * composer reads like the rest of the site rather than a foreign
 * dark widget. Layout primitives still use Tailwind utility classes;
 * theme-bearing classes (lb-card, lb-input, lb-btn, etc.) carry the
 * cream/navy/orange palette.
 *
 * After a successful publish, two optional side-effects can fire:
 *   - share-to-nostr  → kind 1 announcement quoting the event
 *   - boost-the-show  → opens the existing show-boost modal with the
 *     announcement prefilled into its boostagram message field
 *
 * Both checkboxes are independent. Failures of either side-effect are
 * swallowed so the underlying event-publish stays the source of truth.
 */
import { useCallback, useRef, useState } from 'react'
import { isSafeUrl } from '../lib/utils.js'
import { uploadToBlossom } from '../lib/blossom.js'
import {
  emptyEventForm,
  getUserTimezone,
  COMMON_TZIDS,
  buildTzDropdownList,
  formToPublishShape,
  eventToForm,
  fetchEventForLoader,
} from '../lib/eventForm.js'
import { publishCalendarEvent } from '../lib/eventPublish.js'
import {
  DEFAULT_KIND1_TEMPLATE,
  DEFAULT_BOOST_TEMPLATE,
  buildEventAnnouncementTemplate,
  publishEventAnnouncement,
  interpolateNaddr,
} from '../lib/eventAnnouncement.js'
import PasswordManagerHoneypot from './PasswordManagerHoneypot.jsx'
import ImportExportDisclosure from './ImportExportDisclosure.jsx'
import MyEventsCopyList from './MyEventsCopyList.jsx'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// Suppress password-manager autofill across the whole composer. None
// of these fields should ever be picked up by LastPass / 1Password /
// Bitwarden / Dashlane / browser autofill. The load-bearing trick is
// `type="search"` on the text inputs — every major password manager
// explicitly skips search inputs, where the data-attr hints alone
// were getting bypassed by their label-heuristic fallbacks. The
// browser-rendered clear-X button on search inputs is hidden in
// styles.css so the field still reads as a plain text input.
const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
}

export default function EventComposer({
  sessionUser,
  onRequestSignIn,
  onOpenShowBoostWithMessage,
  ensureSignerOk,
}) {
  const [form, setForm] = useState(emptyEventForm)
  const [shareToNostr, setShareToNostr] = useState(false)
  const [shareText, setShareText] = useState(DEFAULT_KIND1_TEMPLATE)

  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')
  const [error, setError] = useState('')
  // null | 'publish' | 'featured' — also names which button shows its spinner.
  const [publishing, setPublishing] = useState(null)
  const [published, setPublished] = useState(null) // {naddr, eventId, dTag, kind, pubkey}

  // "Import from Template" disclosure state.
  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState('')
  const [naddrLoading, setNaddrLoading] = useState(false)
  // Lazy-load the "Import from your meetups" list only once the disclosure
  // is opened — gates the relay round-trip.
  const [ieOpen, setIeOpen] = useState(false)

  const fileInputRef = useRef(null)

  const updateForm = useCallback((patch) => {
    setError('')
    setForm(prev => ({ ...prev, ...patch }))
  }, [])

  // ── "Import from Template" handlers ─────────────────────────────────

  const handleNaddrLoad = useCallback(async () => {
    const trimmed = naddrInput.trim()
    if (!trimmed) return
    setNaddrError('')
    setNaddrLoading(true)
    try {
      const r = await fetchEventForLoader(trimmed)
      if (!r.ok) {
        setNaddrError(r.error || 'Load failed.')
        return
      }
      let snapshot = r.snapshot
      const myPubkey = sessionUser?.pubkey
      if (r.importedFromPubkey && myPubkey && r.importedFromPubkey !== myPubkey) {
        snapshot = { ...snapshot, dTag: '' }
      }
      setForm(snapshot)
      setNaddrInput('')
      setError('')
    } catch (e) {
      setNaddrError(e?.message || 'Load failed.')
    } finally {
      setNaddrLoading(false)
    }
  }, [naddrInput, sessionUser])

  // Copy one of the user's own meetups into the form. Same end state as
  // pasting its naddr — we already hold the raw event from the list, so
  // there's no second relay fetch. The d-tag is stripped so publishing
  // creates a brand-new meetup rather than overwriting the original.
  const handleCopyExisting = useCallback((rawEvent) => {
    if (!rawEvent) return
    const snapshot = eventToForm(rawEvent)
    if (!snapshot) {
      setNaddrError('Could not copy that meetup.')
      return
    }
    setForm({ ...snapshot, dTag: '' })
    setNaddrInput('')
    setNaddrError('')
    setError('')
  }, [])

  const handleImageFile = useCallback(async (file) => {
    if (!file || imageUploading) return
    if (!file.type.startsWith('image/')) {
      setImageError('Pick an image file.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(`Image too large — max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`)
      return
    }
    setImageUploading(true)
    setImageError('')
    try {
      const url = await uploadToBlossom(file)
      updateForm({ image: url })
    } catch (e) {
      setImageError(e?.message || 'Image upload failed')
    } finally {
      setImageUploading(false)
    }
  }, [imageUploading, updateForm])

  // Publishes the NIP-52 event from the user's npub. `makeFeatured` is the
  // "Make Featured" button: after the event is live it opens the show-boost
  // modal prefilled with the event reference, so paying it promotes the meetup
  // into the Featured section. The plain "Publish Meetup" button passes false —
  // it just pushes the event note (plus the optional announcement).
  const handlePublish = useCallback(async (makeFeatured = false) => {
    setError('')
    if (!sessionUser?.pubkey) {
      onRequestSignIn?.()
      return
    }
    // Account-match gate, deferred from modal-open to publish time so the
    // composer opens instantly. Confirms the attached signer reports the
    // same pubkey as the saved session before we publish under it; a
    // mismatch forces re-auth (handled inside ensureSignerOk). No-op when
    // the prop isn't supplied (e.g. the standalone /newevent mount).
    if (ensureSignerOk && !(await ensureSignerOk())) return
    let lowered
    try {
      lowered = formToPublishShape(form)
    } catch (e) {
      setError(e?.message || 'Form is incomplete.')
      return
    }
    setPublishing(makeFeatured ? 'featured' : 'publish')
    try {
      const result = await publishCalendarEvent(lowered)
      setPublished(result)

      // Side-effect: optional kind 1 announcement note. Best-effort.
      if (shareToNostr && result?.naddr) {
        try {
          const tmpl = buildEventAnnouncementTemplate({
            text: shareText,
            naddr: result.naddr,
            kind: result.kind,
            pubkey: result.pubkey,
            dTag: result.dTag,
          })
          publishEventAnnouncement(tmpl).catch(() => {})
        } catch {}
      }

      // "Make Featured": open the show-boost modal with the event reference
      // prefilled. The boost modal handles the wallet/login gates and its own
      // silent failure UX; boosting is what lands the event in Featured.
      if (makeFeatured && result?.naddr && onOpenShowBoostWithMessage) {
        const prefilled = interpolateNaddr(DEFAULT_BOOST_TEMPLATE, result.naddr)
        onOpenShowBoostWithMessage(prefilled)
      }
    } catch (e) {
      setError(e?.message || 'Publish failed.')
    } finally {
      setPublishing(null)
    }
  }, [form, sessionUser, shareToNostr, shareText, onRequestSignIn, onOpenShowBoostWithMessage, ensureSignerOk])

  const resetForNewEvent = useCallback(() => {
    setForm(emptyEventForm())
    setShareToNostr(false)
    setShareText(DEFAULT_KIND1_TEMPLATE)
    setError('')
    setImageError('')
    setPublished(null)
  }, [])

  // No full-screen sign-in gate: the form is just inputs, so a logged-out
  // user can fill it all out. Only the two things that touch their key are
  // gated — publishing (handlePublish → onRequestSignIn, keeping the form
  // intact) and the "copy from your meetups" import list (MyEventsCopyList).
  const loggedOut = !sessionUser?.pubkey

  // ── Success panel ────────────────────────────────────────────────────
  if (published) {
    const manageUrl = sessionUser?.npub ? `https://mynostr.app/${sessionUser.npub}/events` : null
    return (
      <div className="lb-card">
        <h2 className="lb-card-heading" style={{ marginBottom: '0.5rem' }}>Meetup posted</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
          Your meetup is live on Nostr. Anyone with a Nostr client can find and RSVP to it.
        </p>
        <div className="lb-inset" style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>
            Event address (naddr)
          </div>
          <code style={{ fontSize: '0.78rem', color: 'var(--text)', wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {published.naddr}
          </code>
        </div>
        <div className="flex flex-wrap gap-2">
          {manageUrl && (
            <a href={manageUrl} target="_blank" rel="noopener noreferrer" className="lb-btn lb-btn-secondary">
              Manage your events
            </a>
          )}
          <button onClick={resetForNewEvent} className="lb-btn lb-btn-primary">
            Post another meetup
          </button>
        </div>
      </div>
    )
  }

  // ── Composer body ────────────────────────────────────────────────────
  const userTz = getUserTimezone()
  const tzList = buildTzDropdownList(userTz)
  const manageUrl = sessionUser?.npub ? `https://mynostr.app/${sessionUser.npub}/events` : null

  return (
    <div className="lb-card relative space-y-5">
      <PasswordManagerHoneypot />
      <h2 className="lb-card-heading">List your meetup on Nostr</h2>

      <ImportExportDisclosure
        summaryLabel="Import from Template"
        description="Optional — Start with an existing event or event ID as a template"
        pasteIdValue={naddrInput}
        onPasteIdChange={(v) => { setNaddrInput(v); if (naddrError) setNaddrError('') }}
        onLoadId={handleNaddrLoad}
        pasteIdPlaceholder="naddr1… / nevent1…"
        loadButtonLabel="Import"
        loadLoading={naddrLoading}
        loadError={naddrError}
        onToggle={setIeOpen}
      >
        <MyEventsCopyList
          pubkey={sessionUser?.pubkey}
          enabled={ieOpen}
          onCopy={handleCopyExisting}
          manageUrl={manageUrl}
        />
      </ImportExportDisclosure>

      {/* Title */}
      <div>
        <label className="lb-label">Title</label>
        <input
          type="search"
          value={form.title}
          onChange={e => updateForm({ title: e.target.value })}
          placeholder="e.g. Western Mass Bitcoin Meetup"
          className="lb-input"
          maxLength={140}
          {...NO_AUTOFILL}
        />
      </div>

      {/* Description */}
      <div>
        <label className="lb-label">Description</label>
        <textarea
          value={form.description}
          onChange={e => updateForm({ description: e.target.value })}
          placeholder="What is this meetup about? Markdown OK."
          className="lb-input"
          style={{ minHeight: '120px', resize: 'vertical', lineHeight: 1.55 }}
          {...NO_AUTOFILL}
        />
      </div>

      {/* All-day toggle */}
      <label className="lb-check-row" style={{ alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={form.allDay}
          onChange={e => updateForm({ allDay: e.target.checked })}
          style={{ marginTop: 0 }}
        />
        <span>All-day event (no specific time)</span>
      </label>

      {/* Date / time */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="lb-label">Start date</label>
          <input
            type="date"
            value={form.startDate}
            onChange={e => updateForm({ startDate: e.target.value })}
            className="lb-input"
            {...NO_AUTOFILL}
          />
        </div>
        {!form.allDay && (
          <div>
            <label className="lb-label">Start time</label>
            <input
              type="time"
              value={form.startTime}
              onChange={e => updateForm({ startTime: e.target.value })}
              className="lb-input"
              {...NO_AUTOFILL}
            />
          </div>
        )}
        <div>
          <label className="lb-label">
            End date <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            type="date"
            value={form.endDate}
            onChange={e => updateForm({ endDate: e.target.value })}
            className="lb-input"
            {...NO_AUTOFILL}
          />
        </div>
        {!form.allDay && (
          <div>
            <label className="lb-label">
              End time <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              type="time"
              value={form.endTime}
              onChange={e => updateForm({ endTime: e.target.value })}
              className="lb-input"
              {...NO_AUTOFILL}
            />
          </div>
        )}
      </div>

      {/* Timezone (only shown for time-based events) */}
      {!form.allDay && (
        <div>
          <label className="lb-label">Timezone</label>
          <select
            value={form.tzid}
            onChange={e => updateForm({ tzid: e.target.value })}
            className="lb-input"
            {...NO_AUTOFILL}
          >
            {tzList.map(tz => (
              <option key={tz} value={tz}>
                {tz}{tz === userTz ? ' (your local time)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Location */}
      <div>
        <label className="lb-label">Location</label>
        <input
          type="search"
          value={form.location}
          onChange={e => updateForm({ location: e.target.value })}
          placeholder="Venue, city, or 'Online'"
          className="lb-input"
          {...NO_AUTOFILL}
        />
      </div>

      {/* Image */}
      <div>
        <label className="lb-label">
          Image <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
        </label>
        <div className="space-y-2">
          <input
            type="search"
            inputMode="url"
            value={form.image}
            onChange={e => updateForm({ image: e.target.value })}
            placeholder="https://… (or upload below)"
            className="lb-input"
            {...NO_AUTOFILL}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imageUploading}
              style={{ color: 'var(--orange)', fontSize: '0.85rem', fontWeight: 600, background: 'none', border: 'none', cursor: imageUploading ? 'not-allowed' : 'pointer', opacity: imageUploading ? 0.5 : 1, padding: 0 }}
            >
              {imageUploading ? 'Uploading…' : 'Upload from device (Blossom)'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) handleImageFile(f)
              }}
            />
          </div>
          {imageError && <p style={{ color: '#b53b06', fontSize: '0.8rem', margin: 0 }}>{imageError}</p>}
          {form.image && isSafeUrl(form.image) && (
            <img src={form.image} alt="" style={{ maxHeight: '10rem', borderRadius: '6px', border: '1px solid var(--border)' }} />
          )}
        </div>
      </div>

      {/* Hashtags */}
      <div>
        <label className="lb-label">
          Hashtags <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(space or comma separated)</span>
        </label>
        <input
          type="search"
          value={form.hashtags}
          onChange={e => updateForm({ hashtags: e.target.value })}
          placeholder="#meetup #localbitcoiners"
          className="lb-input"
          {...NO_AUTOFILL}
        />
      </div>

      {/* Share-to-Nostr checkbox + editable textarea */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.1rem' }} className="space-y-3">
        <label className="lb-check-row">
          <input
            type="checkbox"
            checked={shareToNostr}
            onChange={e => setShareToNostr(e.target.checked)}
          />
          <span>
            Also share an announcement note on Nostr
            <span className="lb-check-sub">
              Posts a kind 1 note from your npub — event {'{naddr}'} will be included with your note
            </span>
          </span>
        </label>
        {shareToNostr && (
          <textarea
            value={shareText}
            onChange={e => setShareText(e.target.value)}
            className="lb-input"
            style={{ minHeight: '90px', resize: 'vertical', lineHeight: 1.55 }}
            {...NO_AUTOFILL}
          />
        )}
      </div>

      {/* Error + publish actions. Two buttons: "Publish Meetup" just pushes the
          event note (plain/secondary); "Make Featured" publishes then opens the
          boost flow, which is what lands the meetup in the Featured section. */}
      {error && <div className="lb-error">{error}</div>}
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={() => handlePublish(false)}
          disabled={!!publishing}
          className="lb-btn lb-btn-secondary"
          style={{ flex: 1, padding: '0.85rem 1.15rem', fontSize: '1rem' }}
        >
          {publishing === 'publish' ? (
            <>
              <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', opacity: 0.85 }} className="animate-pulse" aria-hidden="true" />
              Publishing…
            </>
          ) : loggedOut ? (
            'Sign in to publish'
          ) : (
            'Publish Meetup'
          )}
        </button>
        <button
          onClick={() => handlePublish(true)}
          disabled={!!publishing}
          className="lb-btn lb-btn-primary"
          style={{ flex: 1, padding: '0.85rem 1.15rem', fontSize: '1rem' }}
        >
          {publishing === 'featured' ? (
            <>
              <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#fff', opacity: 0.85 }} className="animate-pulse" aria-hidden="true" />
              Publishing…
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="currentColor" className="lb-btn-publish-bolt" aria-hidden="true">
                <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
              </svg>
              Make Featured
            </>
          )}
        </button>
      </div>
    </div>
  )
}
