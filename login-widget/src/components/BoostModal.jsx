import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { isStubUser } from '../lib/stubUser.js'
import * as wallet from '../lib/wallet.js'
import LoginModal from './LoginModal.jsx'

const POLL_INTERVAL_MS = 2500
const PRESETS = [21, 210, 2100, 21000]

export default function BoostModal({ user, onUserChange, onClose }) {
  // Enter / exit transition. requestClose runs the exit animation
  // before invoking the parent's onClose.
  const { visible, requestClose } = useModalTransition(onClose)

  const [amount, setAmount] = useState('21')
  const [message, setMessage] = useState('')

  // Login modal layered on top of the boost modal — opens when the user
  // taps the "Sign in with Nostr" half of the attribution toggle.
  const [loginOpen, setLoginOpen] = useState(false)

  // LNURL metadata. Populated once on mount via the hardcoded recipient
  // address. No kind 0 lookup — there's only one recipient (the show), so
  // a runtime resolution would just add latency + a failure surface.
  const [lnurlMeta, setLnurlMeta] = useState(null)
  const [initError, setInitError] = useState('')

  // Invoice + event state. Bundled into one object because every field
  // is set together when handleGenerate succeeds and cleared together
  // by handleReset — five separate useStates were just bookkeeping noise.
  //   pr             — the bolt11 invoice string ('' before generation)
  //   eventId        — the kind 30078 event id ('' before generation)
  //   verifyUrl      — LUD-21 verify endpoint URL (null when absent)
  //   paymentHash    — extracted bolt11 hash, used by pollVerify
  //   metaPublished  — whether kind 30078 reached at least one relay
  const [inv, setInv] = useState({
    pr: '', eventId: '', verifyUrl: null, paymentHash: '', metaPublished: true,
  })

  // Default: attributed when logged in, anonymous when not. An anonymous
  // donor cannot publish a kind 30078 with their identity — the burner
  // path applies. A logged-in donor opts into anonymous explicitly.
  const donorNpub = user?.npub || ''
  const [anonymous, setAnonymous] = useState(!donorNpub)

  // Mid-flow flow state. phase ∈ 'idle'|'loading'|'paid'; step is a
  // sub-label rendered while loading; error is the last surfaced error.
  // Replaces three separate useStates that always changed together.
  const [flow, setFlow] = useState({ phase: 'idle', step: '', error: '' })

  const [copied, setCopied] = useState(false)

  // Wallet status — when ready (WebLN authorized or NWC unlocked), the
  // show-boost flow pays the invoice via the active wallet instead of
  // falling through to the QR display. The QR remains a fallback if
  // the wallet pay fails or times out, so the user always has a path
  // to settle.
  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])
  const [payingViaWallet, setPayingViaWallet] = useState(false)

  // Share-to-feed (optional kind 1 note). Only available when the donor
  // has a real Nostr signer (logged in + not opting out via anonymous).
  // Bundled because the four fields move as a unit through the share
  // lifecycle (enabled → attempted → published|error).
  const [share, setShare] = useState({
    enabled: false, attempted: false, published: false, error: '',
  })

  const stopPollRef = useRef(null)
  const profile = user?.profile

  // Destructure the bundled state objects back into the names the render
  // JSX already uses. Lets the consolidation stay invisible at the read
  // path; only the setters live in the new shape.
  const { pr: invoice, eventId, verifyUrl, paymentHash, metaPublished } = inv
  const loading = flow.phase === 'loading'
  const paid = flow.phase === 'paid'
  const error = flow.error
  const loadingStep = flow.step
  const {
    enabled: shareToFeed,
    attempted: shareAttempted,
    published: sharePublished,
    error: shareError,
  } = share

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
      () => setFlow(f => ({ ...f, phase: 'paid' })),
      paymentHash || null,
    )
    return () => stopPollRef.current?.()
  }, [verifyUrl, invoice, paid, paymentHash])

  // Force shareToFeed off when anonymous flips on — mutually exclusive.
  useEffect(() => {
    if (anonymous && shareToFeed) setShare(s => ({ ...s, enabled: false }))
  }, [anonymous, shareToFeed])

  // When the user logs in mid-modal (via the inline Sign-in button), flip
  // the attribution toggle to attributed — that's why they signed in.
  // Tracking the previous donorNpub so this only fires on the null → set
  // transition, not on every re-render that happens to have a user.
  const prevDonorRef = useRef(donorNpub)
  useEffect(() => {
    if (!prevDonorRef.current && donorNpub) {
      setAnonymous(false)
    }
    prevDonorRef.current = donorNpub
  }, [donorNpub])

  // Profile loading skeleton. The brief window between login completing
  // and the user's kind 0 profile arriving used to flash 'Your npub'
  // before swapping to the real name. Show a placeholder for ~800 ms
  // after donorNpub appears, then fall through to whatever's available
  // (real name if it loaded, 'Your npub' if the user has no kind 0).
  const PROFILE_PLACEHOLDER_MS = 800
  const [profilePending, setProfilePending] = useState(false)
  useEffect(() => {
    if (!donorNpub) { setProfilePending(false); return }
    setProfilePending(true)
    const id = setTimeout(() => setProfilePending(false), PROFILE_PLACEHOLDER_MS)
    return () => clearTimeout(id)
  }, [donorNpub])

  // Once the profile actually arrives we can drop the placeholder
  // immediately rather than waiting out the timer.
  useEffect(() => {
    if (profile?.displayName || profile?.name || profile?.image) {
      setProfilePending(false)
    }
  }, [profile?.displayName, profile?.name, profile?.image])

  // Logout used to live in this modal as a small "Log out" link below
  // the attribution toggle. It moved to the persistent identity dropdown
  // in the nav, so this modal no longer needs to handle the action.

  // Publish the kind 1 share note once payment confirms — only if the
  // donor opted in, has a signer, and we haven't already attempted.
  // Failures are non-fatal: the boost succeeded; the share is best-effort.
  useEffect(() => {
    if (!paid || !shareToFeed || shareAttempted) return
    if (!canShareToFeed) return
    setShare(s => ({ ...s, attempted: true }))
    let cancelled = false
    ;(async () => {
      try {
        const r = await publishBoostShareNote({
          message: message.trim(),
          pageUrl: SITE_URL,
          amountSats: parseInt(amount, 10) || 0,
        })
        if (cancelled) return
        if (r.published) setShare(s => ({ ...s, published: true }))
        else setShare(s => ({ ...s, error: 'Couldn\'t reach your relays.' }))
      } catch (e) {
        if (cancelled) return
        setShare(s => ({ ...s, error: e?.message || 'Failed to publish to your feed.' }))
      }
    })()
    return () => { cancelled = true }
  }, [paid, shareToFeed, shareAttempted, canShareToFeed, message, amount])

  // Esc-to-close intentionally NOT bound here — losing a half-typed
  // boost message to a stray keystroke is too easy. The X button is
  // the explicit close path.

  // Lock page scroll while the modal is open. Uses position:fixed body
  // pinning rather than overflow:hidden so iOS Safari + mobile keyboards
  // don't shift the page underneath on each keystroke.
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  // When the user clicks Boost during the stub-user window (page just
  // loaded, restoreSession hasn't completed), we can't sign a kind
  // 30078 yet — the NDK signer isn't on the instance. Defer the call
  // and re-fire when the real user lands so attribution mode doesn't
  // produce a payment without metadata.
  const pendingSubmitRef = useRef(false)
  useEffect(() => {
    if (!pendingSubmitRef.current) return
    if (!user || isStubUser(user)) return
    pendingSubmitRef.current = false
    setFlow(f => ({ ...f, error: '' }))
    handleGenerate()
    // handleGenerate is defined in this same render scope; reading it
    // via the closure captures the latest amount/message/anonymous
    // state. Effect intentionally re-runs on user transitions only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  async function handleGenerate() {
    const fail = (msg) => setFlow({ phase: 'idle', step: '', error: msg })
    setFlow({ phase: 'idle', step: '', error: '' })

    // Stub-user gate: signer round-trip required for attributed
    // mode (kind 30078 signing). Anon mode uses a burner key so it
    // would technically work, but we gate uniformly to keep the flow
    // simple and predictable.
    if (isStubUser(user)) {
      pendingSubmitRef.current = true
      fail('Hang on — finishing sign-in. Your boost will fire once that\'s done.')
      return
    }

    const sats = parseInt(amount, 10)
    if (!sats || sats < 1) { fail('Enter a valid amount.'); return }
    if (!lnurlMeta) { fail('Lightning address not ready — try again.'); return }

    const minSats = Math.ceil((lnurlMeta.minSendable || 1000) / 1000)
    const maxSats = Math.floor((lnurlMeta.maxSendable || 1_000_000_000) / 1000)
    if (sats < minSats || sats > maxSats) {
      fail(`Amount must be between ${minSats.toLocaleString()} and ${maxSats.toLocaleString()} sats.`)
      return
    }

    // LNURL comment carries human-readable context (separate from the Nostr event).
    const commentParts = ['[localbitcoiners boost]']
    if (message.trim()) commentParts.push(message.trim())
    const comment = commentParts.join(' — ')
    const maxLen = lnurlMeta.commentAllowed || 0
    const trimmedComment = maxLen > 0 ? comment.slice(0, maxLen) : comment

    setFlow({ phase: 'loading', step: 'Fetching invoice…', error: '' })
    try {
      // 1. Fetch invoice
      const { pr, verify } = await fetchLnurlInvoice(lnurlMeta.callback, sats * 1000, trimmedComment)

      // 2. Extract payment hash — links the kind 30078 to this specific invoice.
      const realPaymentHash = bolt11PaymentHash(pr)
      const paymentHashTag = realPaymentHash || crypto.randomUUID().replace(/-/g, '')

      // 3. Sign + publish kind 30078. Anonymous → single-use burner key
      //    (zeroed immediately after); attributed → donor's real signer,
      //    with a burner fallback if the signer rejects or times out.
      setFlow(f => ({ ...f, step: anonymous ? 'Publishing receipt…' : 'Approve in your signer app…' }))
      const burner = anonymous ? generateBurnerKeypair() : null
      let eid, metaOk
      try {
        let result
        try {
          result = await publishDonationBoostagram({
            burnerSk: burner?.sk || null,
            paymentHash: paymentHashTag,
            donorNpub: anonymous ? '' : donorNpub,
            recipientLud16: RECIPIENT_LUD16,
            amountMsats: sats * 1000,
            message: message.trim(),
            pageUrl: SITE_URL,
          })
        } catch (signErr) {
          // Anon mode is already burner-signed — nothing to fall back to.
          if (anonymous) throw signErr
          // Attributed mode and the signer rejected/timed out. Retry
          // with a single-use burner so the boost still goes through.
          // Strip the donor's npub from the `sender` tag — a burner key
          // can't cryptographically vouch for it, and keeping it would
          // let a hostile signer publish receipts claiming arbitrary
          // identities. Receipt becomes effectively anonymous.
          console.warn('[lb] show-boost user-sign failed; falling back to burner', signErr?.message || signErr)
          setFlow(f => ({ ...f, step: 'Publishing receipt…' }))
          const fb = generateBurnerKeypair()
          try {
            result = await publishDonationBoostagram({
              burnerSk: fb.sk,
              paymentHash: paymentHashTag,
              donorNpub: '',
              recipientLud16: RECIPIENT_LUD16,
              amountMsats: sats * 1000,
              message: message.trim(),
              pageUrl: SITE_URL,
            })
          } finally {
            fb.sk.fill(0)
          }
        }
        eid = result.eventId
        metaOk = result.published
      } finally {
        if (burner?.sk) burner.sk.fill(0)
      }

      // 4. Stamp the invoice + receipt into state. Both the wallet and
      //    QR paths read from `inv`; the difference is which view the
      //    user lands on (success directly vs the QR display).
      setInv({
        pr,
        eventId: eid,
        verifyUrl: verify,
        paymentHash: realPaymentHash || '',
        metaPublished: !!metaOk,
      })

      // 5. Pay path. If the user has a connected wallet (WebLN or NWC),
      //    fire payInvoice and skip the QR entirely. On success the
      //    modal flips to the paid state. On failure (timeout, rejection)
      //    the QR fallback shows so the user can pay with any wallet.
      if (wallet.isReady()) {
        setPayingViaWallet(true)
        setFlow({ phase: 'idle', step: '', error: '' })
        try {
          const payRes = await wallet.getClient().payInvoice({ invoice: pr })
          if (payRes && payRes.preimage) {
            setFlow({ phase: 'paid', step: '', error: '' })
            return
          }
          setFlow({
            phase: 'idle',
            step: '',
            error: 'Wallet didn\'t return a preimage — pay via the QR below to finish.',
          })
        } catch (e) {
          const msg = String(e?.message || e)
          const friendly = /timeout/i.test(msg)
            ? 'Wallet didn\'t reply in time — check your wallet, the payment may have already gone through. Or pay via the QR below.'
            : `Wallet pay failed: ${msg}. Pay via the QR below if you want to retry.`
          setFlow({ phase: 'idle', step: '', error: friendly })
        } finally {
          setPayingViaWallet(false)
        }
      } else {
        // No wallet selected — drop loading state. Phase stays 'idle'
        // until pollVerify flips it to 'paid' once the bolt11 settles.
        setFlow({ phase: 'idle', step: '', error: '' })
      }
    } catch (e) {
      // Log full error for debugging; surface a generic message.
      // SDK / signer errors often include relay URLs and internal
      // event ids that don't help a non-technical user.
      console.warn('[lb] show-boost flow error', e?.message || e)
      const msg = String(e?.message || '')
      // Allow our own pre-validated user-facing messages through
      // (they're already short, friendly, and actionable). Generic
      // anything that looks SDK-shaped or has stack noise.
      const looksFriendly = msg.length > 0 && msg.length < 160 && !/Error:|stack|undefined/i.test(msg)
      fail(looksFriendly ? msg : 'Something went wrong preparing your boost. Try again in a moment.')
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
    setInv({ pr: '', eventId: '', verifyUrl: null, paymentHash: '', metaPublished: true })
    setFlow({ phase: 'idle', step: '', error: '' })
    setShare(s => ({ enabled: s.enabled, attempted: false, published: false, error: '' }))
    setPayingViaWallet(false)
  }

  // Centered-card layout at all sizes. p-3 outer leaves 12px margins on
  // phones; w-full + max-w-sm fills available width and caps at 24rem on
  // desktop. items-start on mobile so the modal hugs the top instead of
  // bouncing around when content height changes (presets → invoice → paid).
  return (
    <>
      {/* Backdrop is purely visual — no click-to-close. The X button
          is the explicit close path so a misclick won't lose typed
          input or interrupt an in-flight boost. */}
      <div
        className={`fixed inset-0 bg-black/70 z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[71] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label="Send us a Boost"
      >
        <div className={`bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-sm flex flex-col shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Boost the Show</h2>
            <button onClick={requestClose} className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none" aria-label="Close">✕</button>
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
                        className={`flex-1 text-xs py-2 rounded border transition-colors ${
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
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
                    placeholder="Custom amount"
                  />
                </div>

                {/* Boost as toggle. When logged out, the "you" half becomes
                    a Sign-in button styled in the site's orange accent —
                    one tap opens the LoginModal layered on top, and a
                    successful login auto-flips the toggle to attributed
                    mode (handled by the donorNpub effect above). */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex gap-2 text-xs">
                    {donorNpub ? (
                      <button
                        onClick={() => setAnonymous(false)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border transition-colors ${
                          !anonymous
                            ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold'
                            : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
                        }`}
                        aria-pressed={!anonymous}
                      >
                        {profilePending ? (
                          // Profile fetch in flight — placeholder avoids the
                          // 'Your npub' → real-name flash on fresh logins.
                          <>
                            <span className="inline-block w-4 h-4 rounded-full bg-neutral-700 animate-pulse" aria-hidden="true" />
                            <span className="inline-block h-3 w-20 rounded bg-neutral-700 animate-pulse" aria-hidden="true" />
                          </>
                        ) : (
                          <>
                            {profile?.image && isSafeUrl(profile.image) && (
                              <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
                            )}
                            <span className="truncate max-w-[140px]">
                              {profile?.displayName || profile?.name || 'Your npub'}
                            </span>
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => setLoginOpen(true)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border border-orange-500 transition-colors bg-orange-500 hover:bg-orange-600 text-white font-medium"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                          <polyline points="10 17 15 12 10 7" />
                          <line x1="15" y1="12" x2="3" y2="12" />
                        </svg>
                        Sign in with Nostr
                      </button>
                    )}
                    <button
                      onClick={() => setAnonymous(true)}
                      className={`flex-1 py-3 px-3 rounded-md border transition-colors ${
                        anonymous
                          ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
                      }`}
                      aria-pressed={anonymous}
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
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
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
                      onChange={e => setShare(s => ({ ...s, enabled: e.target.checked }))}
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
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {loading ? (
                    'Preparing boost…'
                  ) : !lnurlMeta && !initError ? (
                    'Checking lightning address…'
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
                      </svg>
                      Boost
                    </>
                  )}
                </button>
              </>
            )}

            {/* ── Paying via the active wallet (skips the QR entirely on success) ── */}
            {invoice && payingViaWallet && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" aria-hidden="true" />
                <p className="text-sm text-neutral-300">Paying with your wallet…</p>
                <p className="text-[11px] text-neutral-500 max-w-[240px] leading-snug">
                  {parseInt(amount, 10).toLocaleString()} sats to {RECIPIENT_LUD16}
                </p>
              </div>
            )}

            {/* ── QR / waiting (fallback when no wallet ready, or wallet pay failed) ── */}
            {invoice && !paid && !payingViaWallet && (
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
                  onClick={requestClose}
                  className="mt-1 px-6 py-2 rounded bg-green-800 hover:bg-green-700 text-sm text-green-200 transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* LoginModal layered on top when the user taps the inline Sign-in
          button. createPortal so it lives at document.body — siblings to
          the boost modal — and its own z-index puts it above the boost
          surface. On success, onLogin fires and the user prop flips to
          the new identity; the donorNpub useEffect above auto-switches
          the attribution toggle to attributed mode. */}
      {loginOpen && createPortal(
        <LoginModal
          onLogin={(u) => onUserChange?.(u)}
          onClose={() => setLoginOpen(false)}
        />,
        document.body
      )}
    </>
  )
}
