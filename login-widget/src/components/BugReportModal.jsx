/**
 * Bug-report modal (ported from ReedBTC/mynostr).
 *
 * Credit: the bug-report pipeline (modal → dedicated tag-gated relay →
 * polling watcher → GitHub issues) is inspired by Plebeian Market's
 * widget. https://plebeian.market — see lib/bugReport.js for the note.
 *
 * Single textarea pre-seeded with a brief template, plus auto-injected
 * page URL, browser, screen size, timezone, and build mode (pasted into
 * the body so the user can review/edit before sending — we never scrape
 * anything beyond what's visible there). Image attach (drag/paste/click)
 * uploads via the shared Blossom helper and splices a `[image: <url>]`
 * marker into the body.
 *
 * Close is X-only (no backdrop / Esc) — matches LB's modal convention so
 * a misclick can't discard a half-typed report.
 */
import { useRef, useState } from 'react'
import { uploadToBlossom } from '../lib/blossom.js'
import { publishBugReport } from '../lib/bugReport.js'

const TEMPLATE = `What went wrong:


Steps to reproduce:
1.
2.
3.

What you expected:


What happened instead:


Anything else (optional):

`

function shortNpub(npub) {
  if (!npub || npub.length < 18) return npub || ''
  return npub.slice(0, 12) + '…' + npub.slice(-6)
}

function buildContextBlock() {
  const lines = []
  try { lines.push(`Page: ${window.location.href}`) } catch {}
  try {
    const { width, height } = window.screen || {}
    if (width && height) lines.push(`Screen: ${width}×${height}, viewport ${window.innerWidth}×${window.innerHeight}`)
  } catch {}
  try { lines.push(`Browser: ${navigator.userAgent}`) } catch {}
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) lines.push(`Timezone: ${tz}`)
  } catch {}
  try { lines.push(`Build: ${import.meta.env.MODE}`) } catch {}
  if (lines.length === 0) return ''
  return `\n---\n${lines.join('\n')}\n`
}

export default function BugReportModal({ user, onClose }) {
  const [content, setContent] = useState(() => TEMPLATE + buildContextBlock())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [contactNpub, setContactNpub] = useState('')
  const taRef = useRef(null)

  const isLoggedIn = !!user?.pubkey

  async function handleImageFile(file) {
    if (!file || !file.type?.startsWith('image/')) return
    if (uploading) return
    const MAX_BYTES = 25 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setError('Image too large (max 25 MB).')
      return
    }
    setUploading(true)
    setError('')
    try {
      const url = await uploadToBlossom(file)
      const ta = taRef.current
      const insert = `\n[image: ${url}]\n`
      if (ta) {
        const start = ta.selectionStart ?? content.length
        const end   = ta.selectionEnd   ?? content.length
        const next  = content.slice(0, start) + insert + content.slice(end)
        setContent(next)
        requestAnimationFrame(() => {
          ta.focus()
          const pos = start + insert.length
          ta.setSelectionRange(pos, pos)
        })
      } else {
        setContent(c => c + insert)
      }
    } catch (e) {
      setError(e?.message || 'Image upload failed.')
    } finally {
      setUploading(false)
    }
  }

  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'))
    if (!item) return
    const file = item.getAsFile()
    if (file) {
      e.preventDefault()
      handleImageFile(file)
    }
  }

  function onDrop(e) {
    const file = e.dataTransfer?.files?.[0]
    if (file?.type?.startsWith('image/')) {
      e.preventDefault()
      handleImageFile(file)
    }
  }

  async function handleSubmit() {
    if (submitting) return
    if (!content.trim()) {
      setError('Tell us what went wrong before sending.')
      return
    }
    let finalContent = content
    // Logged-out reporters can optionally attribute an npub for follow-up;
    // logged-in reports are already attributed by their signature.
    if (!isLoggedIn) {
      const np = contactNpub.trim()
      if (np) {
        if (!/^npub1[0-9a-z]{58}$/.test(np)) {
          setError('That doesn’t look like an npub — leave it blank or paste a valid npub1…')
          return
        }
        finalContent = `${content}\n\nContact npub (for follow-up): ${np}`
      }
    }
    setSubmitting(true)
    setError('')
    try {
      await publishBugReport(finalContent)
      setDone(true)
    } catch (e) {
      setError(e?.message || 'Couldn\'t send. Try again in a moment.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-[var(--scrim,rgba(11,58,82,0.55))] z-[70]" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[71] flex items-center justify-center p-4 sm:p-6"
        role="dialog"
        aria-label="Report a bug"
      >
        <div
          className="bg-[var(--modal-bg,#f4fafd)] border border-[var(--modal-line,#b9d4e6)] rounded-lg w-full max-w-lg flex flex-col max-h-[90vh] shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28)]"
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--modal-line,#b9d4e6)] shrink-0">
            <h2 className="text-base font-semibold text-[var(--ink,#0f2733)] font-[family-name:var(--font-display,'Playfair_Display',Georgia,serif)]">🐛 Report a bug</h2>
            <button
              onClick={onClose}
              disabled={submitting}
              className="text-[var(--muted,#5a7488)] hover:text-[var(--ink,#0f2733)] transition-colors text-lg leading-none disabled:opacity-30"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {done ? (
            <div className="px-4 py-8 text-center space-y-4">
              <div className="text-3xl">✅</div>
              <p className="text-sm text-[var(--ink,#0f2733)] font-medium">Report sent.</p>
              <p className="text-xs text-[var(--muted,#5a7488)] leading-snug">
                Thanks for reporting! It'll be turned into a GitHub issue shortly. If we need
                clarification we'll DM the npub you signed with.
              </p>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-[var(--modal-field,#ffffff)] hover:bg-[var(--modal-inset,#e6f1f9)] text-sm text-[var(--ink,#0f2733)] transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-4 pt-3 pb-2 text-[11px] text-[var(--muted,#5a7488)] leading-snug shrink-0 space-y-1">
                <p>
                  Drag, paste, or click to attach a screenshot. Edit anything below before sending — page URL,
                  browser, screen size, timezone, and build mode are auto-included.
                </p>
                <p className="text-rose-300/90">
                  ⚠️ Don't paste passwords, private keys (nsec…), or API tokens. Reports are public.
                </p>
              </div>

              {isLoggedIn ? (
                <div className="px-4 pb-2 text-[11px] text-[var(--muted,#5a7488)] shrink-0">
                  Reporting as <code className="text-[var(--ink,#0f2733)]">{shortNpub(user.npub)}</code>
                </div>
              ) : (
                <div className="px-4 pb-2 shrink-0">
                  <input
                    type="text"
                    value={contactNpub}
                    onChange={e => { setContactNpub(e.target.value); if (error) setError('') }}
                    placeholder="Your npub (optional — so we can follow up)"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full bg-[var(--modal-field,#ffffff)] border border-[var(--modal-line,#b9d4e6)] rounded-lg px-3 py-1.5 text-xs text-[var(--ink,#0f2733)] font-mono focus:outline-none focus:border-[var(--brand,#00aff0)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))] placeholder:text-[var(--muted,#5a7488)]"
                  />
                </div>
              )}

              <div className="flex-1 min-h-0 px-4 pb-3 overflow-y-auto">
                <textarea
                  ref={taRef}
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onPaste={onPaste}
                  rows={14}
                  spellCheck
                  className="w-full bg-[var(--modal-field,#ffffff)] border border-[var(--modal-line,#b9d4e6)] rounded-lg px-3 py-2 text-xs text-[var(--ink,#0f2733)] font-mono resize-y focus:outline-none focus:border-[var(--brand,#00aff0)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))]"
                  placeholder="Describe the bug…"
                />
              </div>

              <div className="px-4 py-3 border-t border-[var(--modal-line,#b9d4e6)] shrink-0 flex items-center gap-2 flex-wrap">
                <label className={`text-xs px-2.5 py-1.5 rounded-lg border border-[var(--modal-line,#b9d4e6)] text-[var(--ink,#0f2733)] hover:bg-[var(--modal-inset,#e6f1f9)] cursor-pointer transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {uploading ? 'Uploading…' : '📎 Attach image'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleImageFile(f)
                      e.target.value = ''
                    }}
                  />
                </label>
                <div className="flex-1" />
                {error && (
                  <p className="text-[11px] text-[var(--danger,#b3261e)] w-full sm:w-auto sm:max-w-[20rem] order-3 sm:order-2">
                    {error}
                  </p>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="px-4 py-1.5 rounded-lg bg-[var(--brand-dd,#0a6fa8)] hover:bg-[var(--brand-ddd,#095e90)] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors order-2 sm:order-3"
                >
                  {submitting ? 'Sending…' : 'Send report'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
