import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  RECIPIENT_LUD16,
  SITE_URL,
  fetchLnurlMeta,
  fetchLnurlInvoice,
  bolt11PaymentHash,
  generateBurnerKeypair,
  publishDonationBoostagram,
  publishBoostShareNote,
  pollVerify,
} from '../lib/boostagram.js'
import { isSafeUrl } from '../lib/utils.js'

const POLL_INTERVAL_MS = 2500
const PRESETS = [21, 210, 2100, 21000]

export default function BoostModal({ user, onClose }) {
  const [amount, setAmount] = useState('21')
  const [message, setMessage] = useState('')

  // LNURL metadata. Populated once on mount via the hardcoded recipient
  // address. No kind 0 lookup — there's only one recipient (the show), so
  // a runtime resolution would just add latency + a failure surface.
  const [lnurlMeta, setLnurlMeta] = useState(null)
  const [initError, setInitError] = useState('')

  // Invoice + event state
  const [invoice, setInvoice] = useState('')
  const [eventId, setEventId] = useState('')
  const [verifyUrl, setVerifyUrl] = useState(null)
  // payment_hash from the bolt11. Used for the optional LUD-21 preimage
  // cross-check during verify polling.
  const [paymentHash, setPaymentHash] = useState('')
  // Whether the kind 30078 metadata event reached at least one boost relay.
  // Surfaced in the success view so the user knows if their boost will be
  // visible to a future bot watching the metadata stream.
  const [metaPublished, setMetaPublished] = useState(true)

  // Default: attributed when logged in, anonymous when not. An anonymous
  // donor cannot publish a kind 30078 with their identity — the burner
  // path applies. A logged-in donor opts into anonymous explicitly.
  const donorNpub = user?.npub || ''
  const [anonymous, setAnonymous] = useState(!donorNpub)
  const [loading, setLoading] = useState(false)
  // Mid-flow loading sub-state — tells the user *what* we're waiting on.
  // Especially useful during the signer round-trip in attributed mode (a
  // NIP-07 / bunker prompt may pop up in another window/app and the user
  // wouldn't otherwise know to look for it).
  const [loadingStep, setLoadingStep] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [paid, setPaid] = useState(false)

  // Share-to-feed (optional kind 1 note) — only available when the donor
  // has a real Nostr signer (logged in + not opting out via anonymous).
  const [shareToFeed, setShareToFeed] = useState(false)
  const [shareAttempted, setShareAttempted] = useState(false)
  const [sharePublished, setSharePublished] = useState(false)
  const [shareError, setShareError] = useState('')

  const stopPollRef = useRef(null)
  const profile = user?.profile

  const canShareToFeed = !anonymous && !!donorNpub

  // Fetch LNURL metadata once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meta = await fetchLnurlMeta(RECIPIENT_LUD16)
        if (!cancelled) setLnurlMeta(meta)
      } catch (e) {
        if (!cancelled) setInitError(`Couldn't reach lightning address: ${e.message}`)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Start polling once we have an invoice + verify URL. When `paid` flips
  // true the effect re-runs and the previous run's cleanup fires — that's
  // what stops the polling. Single effect handles both start and stop.
  useEffect(() => {
    if (!verifyUrl || !invoice || paid) return
    stopPollRef.current = pollVerify(
      verifyUrl,
      POLL_INTERVAL_MS,
      () => setPaid(true),
      paymentHash || null,
    )
    return () => stopPollRef.current?.()
  }, [verifyUrl, invoice, paid, paymentHash])

  // Force shareToFeed off when anonymous flips on — mutually exclusive.
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  // Publish the kind 1 share note once payment confirms — only if the
  // donor opted in, has a signer, and we haven't already attempted.
  // Failures are non-fatal: the boost succeeded; the share is best-effort.
  useEffect(() => {
    if (!paid || !shareToFeed || shareAttempted) return
    if (!canShareToFeed) return
    setShareAttempted(true)
    let cancelled = false
    ;(async () => {
      try {
        const r = await publishBoostShareNote({
          message: message.trim(),
          pageUrl: SITE_URL,
          amountSats: parseInt(amount, 10) || 0,
        })
        if (cancelled) return
        if (r.published) setSharePublished(true)
        else setShareError('Couldn\'t reach your relays.')
      } catch (e) {
        if (cancelled) return
        setShareError(e?.message || 'Failed to publish to your feed.')
      }
    })()
    return () => { cancelled = true }
  }, [paid, shareToFeed, shareAttempted, canShareToFeed, message, amount])

  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Lock page scroll while the modal is open so swipes inside the modal
  // don't scroll the page underneath (especially on mobile where the
  // modal becomes a full-viewport sheet).
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  async function handleGenerate() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!sats || sats < 1) { setError('Enter a valid amount.'); return }
    if (!lnurlMeta) { setError('Lightning address not ready — try again.'); return }

    const minSats = Math.ceil((lnurlMeta.minSendable || 1000) / 1000)
    const maxSats = Math.floor((lnurlMeta.maxSendable || 1_000_000_000) / 1000)
    if (sats < minSats || sats > maxSats) {
      setError(`Amount must be between ${minSats.toLocaleString()} and ${maxSats.toLocaleString()} sats.`)
      return
    }

    // LNURL comment carries human-readable context (separate from the Nostr event).
    const commentParts = ['[localbitcoiners boost]']
    if (message.trim()) commentParts.push(message.trim())
    const comment = commentParts.join(' — ')
    const maxLen = lnurlMeta.commentAllowed || 0
    const trimmedComment = maxLen > 0 ? comment.slice(0, maxLen) : comment

    setLoading(true)
    setLoadingStep('Fetching invoice…')
    try {
      // 1. Fetch invoice
      const { pr, verify } = await fetchLnurlInvoice(lnurlMeta.callback, sats * 1000, trimmedComment)

      // 2. Extract payment hash — links the kind 30078 to this specific invoice.
      const realPaymentHash = bolt11PaymentHash(pr)
      const paymentHashTag = realPaymentHash || crypto.randomUUID().replace(/-/g, '')
      setPaymentHash(realPaymentHash || '')

      // 3. Sign + publish kind 30078. Anonymous → single-use burner key
      //    (zeroed immediately after); attributed → donor's real signer.
      setLoadingStep(anonymous
        ? 'Publishing receipt…'
        : 'Approve in your signer app…')
      const burner = anonymous ? generateBurnerKeypair() : null
      try {
        const { eventId: eid, published } = await publishDonationBoostagram({
          burnerSk: burner?.sk || null,
          paymentHash: paymentHashTag,
          donorNpub: anonymous ? '' : donorNpub,
          recipientLud16: RECIPIENT_LUD16,
          amountMsats: sats * 1000,
          message: message.trim(),
          pageUrl: SITE_URL,
        })

        setInvoice(pr)
        setEventId(eid)
        setVerifyUrl(verify)
        setMetaPublished(!!published)
      } finally {
        if (burner?.sk) burner.sk.fill(0)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(invoice)
    } catch {
      try {
        const el = document.createElement('textarea')
        el.value = invoice
        el.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(el)
        el.focus()
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      } catch {
        return
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleReset() {
    stopPollRef.current?.()
    setInvoice('')
    setEventId('')
    setVerifyUrl(null)
    setPaymentHash('')
    setMetaPublished(true)
    setPaid(false)
    setError('')
    setShareAttempted(false)
    setSharePublished(false)
    setShareError('')
  }

  // Centered-card layout at all sizes. p-3 outer leaves 12px margins on
  // phones; w-full + max-w-sm fills available width and caps at 24rem on
  // desktop. items-start on mobile so the modal hugs the top instead of
  // bouncing around when content height changes (presets → invoice → paid).
  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-[70]" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed inset-0 z-[71] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label="Send us a Boost"
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-sm flex flex-col shadow-2xl my-4 sm:my-8">

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Boost the Show</h2>
            <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none" aria-label="Close">✕</button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">
            {initError && (
              <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">{initError}</p>
            )}

            {/* ── Form ── */}
            {!invoice && (
              <>
                <p className="text-xs text-neutral-500">
                  Support the Local Bitcoiners podcast with a lightning payment.{' '}
                  <span className="text-neutral-600 font-mono">{RECIPIENT_LUD16}</span>
                </p>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
                  <div className="flex gap-1.5 mb-2">
                    {PRESETS.map(p => (
                      <button
                        key={p}
                        onClick={() => setAmount(String(p))}
                        className={`flex-1 text-xs py-1 rounded border transition-colors ${
                          amount === String(p)
                            ? 'border-orange-600 text-orange-400 bg-orange-950/30'
                            : 'border-neutral-700 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
                        }`}
                      >
                        {p.toLocaleString()}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="1"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500"
                    placeholder="Custom amount"
                  />
                </div>

                {/* Boost as toggle. When the donor isn't logged in, the
                    attributed option is disabled — anon is the only path. */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
                    <button
                      onClick={() => setAnonymous(false)}
                      disabled={!donorNpub}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 transition-colors ${
                        !donorNpub
                          ? 'bg-neutral-900 text-neutral-700 cursor-not-allowed opacity-40'
                          : !anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
                      title={!donorNpub ? 'Sign in with Nostr to boost as yourself' : ''}
                    >
                      {profile?.image && isSafeUrl(profile.image) && (
                        <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
                      )}
                      <span className="truncate max-w-[140px]">
                        {profile?.displayName || profile?.name || (donorNpub ? 'Your npub' : 'Sign in to attribute')}
                      </span>
                    </button>
                    <button
                      onClick={() => setAnonymous(true)}
                      className={`flex-1 py-2 px-3 border-l border-neutral-700 transition-colors ${
                        anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
                    >
                      Anon
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Message (optional)</label>
                  <input
                    type="text"
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    maxLength={140}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500"
                    placeholder="Leave a note with your boost"
                  />
                </div>

                {/* Share-to-feed opt-in — only when the donor has a real
                    signer to publish a kind 1 with. Hidden in anonymous
                    mode since a kind 1 burner-signed note isn't useful. */}
                {canShareToFeed && (
                  <label className="flex items-start gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={shareToFeed}
                      onChange={e => setShareToFeed(e.target.checked)}
                      className="accent-orange-500 mt-0.5"
                    />
                    <span className="leading-snug">
                      Share to my feed
                      <span className="block text-[10px] text-neutral-600 mt-0.5">
                        Posts a kind 1 note to your followers — your
                        message + a link back here.
                      </span>
                    </span>
                  </label>
                )}

                {error && <p className="text-xs text-red-400">{error}</p>}

                {/* Loading sub-state — visible while mid-flow. Especially
                    useful during the attributed-mode signer round-trip. */}
                {loading && loadingStep && (
                  <p className="text-xs text-orange-400 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                    {loadingStep}
                  </p>
                )}

                <button
                  onClick={handleGenerate}
                  disabled={loading || !!initError || !lnurlMeta}
                  className="w-full py-2 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {loading ? 'Preparing boost…' : !lnurlMeta && !initError ? 'Connecting…' : 'Boost ⚡'}
                </button>
              </>
            )}

            {/* ── QR / waiting ── */}
            {invoice && !paid && (
              <>
                <div className="flex justify-center py-2">
                  <div className="bg-white p-3 rounded-lg">
                    <QRCodeSVG value={`lightning:${invoice.toUpperCase()}`} size={200} />
                  </div>
                </div>

                <p className="text-xs text-neutral-500 text-center">
                  Scan with any lightning wallet · {parseInt(amount, 10).toLocaleString()} sats
                </p>

                {verifyUrl && (
                  <p className="text-xs text-neutral-600 text-center flex items-center justify-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                    Waiting for payment…
                  </p>
                )}

                <button
                  onClick={handleCopy}
                  className="w-full py-2 rounded border border-neutral-700 text-xs text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors font-mono truncate px-3"
                  title={invoice}
                >
                  {copied ? '✓ Copied invoice' : invoice.slice(0, 32) + '…'}
                </button>

                <button onClick={handleReset} className="w-full py-1.5 text-xs text-neutral-600 hover:text-neutral-400 transition-colors">
                  ← Different amount
                </button>
              </>
            )}

            {/* ── Paid confirmation ── */}
            {paid && (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <div className="w-14 h-14 rounded-full bg-green-950 border border-green-700 flex items-center justify-center text-2xl">
                  ✓
                </div>
                <div>
                  <p className="text-base font-semibold text-green-400">
                    {parseInt(amount, 10).toLocaleString()} sats received!
                  </p>
                  <p className="text-xs text-neutral-500 mt-1">
                    Thanks for the boost ⚡ It helps keep the show going.
                  </p>
                </div>
                {/* Share-to-feed result. Only relevant when the donor opted in. */}
                {shareToFeed && shareAttempted && !sharePublished && !shareError && (
                  <p className="text-xs text-neutral-500 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                    Sharing to your feed…
                  </p>
                )}
                {shareToFeed && sharePublished && (
                  <p className="text-xs text-green-400 flex items-center gap-1.5">
                    <span>✓</span>
                    Shared to your feed
                  </p>
                )}
                {shareToFeed && shareError && (
                  <p className="text-xs text-orange-400 max-w-xs">
                    Couldn't share to your feed — {shareError}
                  </p>
                )}

                {/* Metadata-publish warning. The Lightning payment succeeded,
                    but no relay in the boost set ack'd the kind 30078 — bots
                    watching the metadata stream won't see this boost. */}
                {!metaPublished && (
                  <p className="text-xs text-orange-400 max-w-xs">
                    Boost succeeded, but the metadata event didn't reach
                    any boost relay. Future bots watching the metadata
                    stream won't see your message attached.
                  </p>
                )}

                {eventId && (
                  <p className="text-xs text-neutral-700 font-mono break-all">
                    receipt: {eventId.slice(0, 16)}…
                  </p>
                )}
                <button
                  onClick={onClose}
                  className="mt-1 px-6 py-2 rounded bg-green-800 hover:bg-green-700 text-sm text-green-200 transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
