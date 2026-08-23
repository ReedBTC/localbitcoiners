import { useState, useEffect } from 'react'
import * as wallet from '../lib/wallet.js'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { scrubSecrets } from '../lib/utils.js'

/**
 * Standalone NWC connect modal — extracted from EpisodeBoostModal's
 * inline gate panel so connecting a wallet is a first-class action
 * triggered from the identity dropdown rather than a side-effect of
 * trying to boost.
 *
 * Behavior:
 *   1. Validate URI shape ('nostr+walletconnect://')
 *   2. Probe the wallet via getBalance (8s timeout)
 *   3. Encrypt the URI to the user's Nostr key (NIP-44 → NIP-04, 8s timeout)
 *   4. Persist + activate, fire onConnected so any pending action runs
 *
 * ⚠️ A SIGNED-OUT VISITOR MAY CONNECT HERE, and the modal says what that
 * costs: steps 3 and 4 are skipped, so the wallet is live for this page
 * and gone on reload. There is nothing to encrypt the URI to without a
 * signer, and writing it in the clear is not an option — it is a bearer
 * credential with a spend budget. The copy states the trade before the
 * paste rather than letting the user discover it by reloading.
 */
export default function WalletConnectModal({ user, onClose, onConnected, onRequestSignIn }) {
  const { visible, requestClose } = useModalTransition(onClose)

  const [uri, setUri] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  // window.webln is provided by browser extensions like Alby and
  // Mutiny. Surfacing this option only when the extension is actually
  // installed avoids a dead button on every other browser.
  const [weblnAvailable] = useState(() => wallet.isWeblnAvailable())

  // No Esc / backdrop close — site convention for wallet-and-payment
  // modals is an explicit ✕ only, so a misclick can't discard a pasted
  // NWC connection string.
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  async function handleConnectWebln() {
    setError('')
    setConnecting(true)
    try {
      await wallet.connectWebln(user)
      onConnected?.()
      requestClose()
    } catch (e) {
      console.warn('[lb-webln] enable failed', scrubSecrets(String(e?.message || e)))
      const msg = String(e?.message || '')
      const looksFriendly = msg.length > 0 && msg.length < 200 && !/Error:|stack|undefined/i.test(msg)
      setError(looksFriendly ? msg : 'Couldn\'t enable your browser extension. Make sure it\'s unlocked and try again.')
    } finally {
      setConnecting(false)
    }
  }

  async function handleConnect() {
    setError('')
    const trimmed = uri.trim()
    if (!trimmed) { setError('Paste your NWC connection string above.'); return }

    setConnecting(true)
    try {
      await wallet.connectNwc(trimmed, user)
      setUri('')
      onConnected?.()
      requestClose()
    } catch (e) {
      // Log full error to console; surface a clean message. nwc.connect
      // already wraps SDK / signer errors generically, so most messages
      // here are already user-friendly — but anything that slipped
      // through gets normalized.
      console.warn('[lb-nwc] connect failed', scrubSecrets(String(e?.message || e)))
      const msg = String(e?.message || '')
      const looksFriendly = msg.length > 0 && msg.length < 200 && !/Error:|stack|undefined/i.test(msg)
      setError(looksFriendly ? msg : 'Couldn\'t connect to your wallet. Check the connection string and that your wallet is online.')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <>
      <div
        className={`fixed inset-0 bg-[var(--scrim,rgba(11,58,82,0.55))] z-[78] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[79] flex items-start sm:items-center justify-center p-3 pt-20 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label="Connect Lightning Wallet"
      >
        <div className={`bg-[var(--modal-bg,#f4fafd)] border border-[var(--modal-line,#b9d4e6)] rounded-lg w-full max-w-sm flex flex-col shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28),0_0_0_1px_rgba(11,58,82,0.06)] my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--modal-line,#b9d4e6)]">
            <h2 className="text-base font-semibold text-[var(--ink,#0f2733)] font-[family-name:var(--font-display,'Playfair_Display',Georgia,serif)]">⚡ Connect Lightning Wallet</h2>
            <button
              onClick={requestClose}
              disabled={connecting}
              className="text-[var(--muted,#5a7488)] hover:text-[var(--ink,#0f2733)] transition-colors text-lg leading-none disabled:opacity-30"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">
            {/* ⚠️ ONE LINE, AND IT SAYS THE ONLY THING THIS SCREEN HAS TO
                SAY. It ran to three lines explaining that an episode boost
                pays every split recipient in one shot — true, and an answer
                to a question nobody has while looking at a Connect button.
                Reed's note, 2026-08-22: nobody reads this much. The gate now
                opens FROM the Boost button, so the reader already knows why
                they are here; what they do not know is whose wallet pays. */}
            <p className="text-xs text-[var(--muted,#5a7488)] leading-snug">
              Boosts are paid from your own wallet.
            </p>

            {/* The session-only trade, stated before the paste. A wallet
                that quietly vanished on reload would read as a bug, and
                the reason it can't persist is worth one sentence: the
                connection is encrypted to the user's own Nostr key, and
                a signed-out visitor hasn't got one. */}
            {!user && (
              <div className="rounded-lg border border-[var(--modal-line,#b9d4e6)] bg-[var(--modal-field,#ffffff)] px-3 py-2.5 space-y-1.5">
                {/* ⚠️ THE TRADE IS STILL STATED BEFORE THE PASTE, which is the
                    rule — a wallet that quietly vanished on reload reads as a
                    bug. What went is the MECHANISM: two sentences about
                    connections being encrypted to a Nostr key answered "why"
                    when the reader only needed "what happens". The three
                    Nostr words went with it; this modal predates the
                    vocabulary rule the rest of the widget follows. */}
                <p className="text-[11px] text-[var(--ink,#0f2733)] leading-snug">
                  <strong className="font-semibold">This tab only.</strong>{' '}
                  You can boost right away, but it won't be here next time.
                </p>
                {onRequestSignIn && (
                  <button
                    type="button"
                    onClick={onRequestSignIn}
                    disabled={connecting}
                    className="text-[11px] font-medium text-[var(--brand-d,#068ace)] hover:text-[var(--brand-dd,#0a6fa8)] disabled:opacity-40 transition-colors"
                  >
                    Log in to save it
                  </button>
                )}
              </div>
            )}

            {/* WebLN button — surfaced only when the browser actually
                provides window.webln. One tap, no copy/paste, no
                signer round-trip. */}
            {weblnAvailable && (
              <>
                <button
                  onClick={handleConnectWebln}
                  disabled={connecting}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-[var(--brand-dd,#0a6fa8)] hover:bg-[var(--brand-ddd,#095e90)] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
                  </svg>
                  {connecting ? 'Connecting…' : 'Use my browser extension'}
                </button>
                {/* The caption here read "Detected a Lightning extension
                    (Alby, Mutiny, etc.) — one tap to enable, no copy/paste
                    required." The button above it says "Use my browser
                    extension" and only renders when one was detected, so
                    every word of that was already on screen. */}

                <div className="flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-[var(--modal-field,#ffffff)]" />
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted,#5a7488)]">or</span>
                  <div className="flex-1 h-px bg-[var(--modal-field,#ffffff)]" />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs text-[var(--muted,#5a7488)] mb-1.5">NWC connection string</label>
              <textarea
                value={uri}
                onChange={e => setUri(e.target.value)}
                rows={3}
                placeholder="nostr+walletconnect://…"
                className="w-full bg-[var(--modal-field,#ffffff)] border border-[var(--modal-line,#b9d4e6)] rounded-lg px-3 py-2 text-xs text-[var(--ink,#0f2733)] font-mono focus:outline-none focus:border-[var(--brand,#00aff0)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))]"
              />
              {/* The wallet names stay: they are how a reader recognises
                  that they have one of these. What went is "Cross-device
                  option" (the label above already implies it) and the
                  restatement of the storage rule, which the box above
                  makes for a signed-out reader. */}
              <p className="mt-1.5 text-[10px] text-[var(--muted,#5a7488)] leading-snug">
                From Alby Hub, Primal, Mutiny, Coinos or any NIP-47 wallet.{' '}
                {user ? 'Encrypted before saving.' : 'Never written to storage.'}
              </p>
            </div>

            {error && (
              <p className="text-xs text-[var(--danger,#b3261e)]">{error}</p>
            )}

            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full py-3 rounded-lg bg-[var(--modal-inset,#e6f1f9)] border border-[var(--brand,#00aff0)] hover:bg-[var(--brand-tint,rgba(0,175,240,0.12))] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold text-[var(--brand-dd,#0a6fa8)] transition-colors"
            >
              {connecting ? 'Connecting…' : 'Connect via NWC'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
