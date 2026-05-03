import { useState, useEffect } from 'react'
import * as wallet from '../lib/wallet.js'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'

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
 * If the user is signed out when this opens, fail fast — wallet
 * encryption requires a signer. The dropdown only surfaces this option
 * when logged in, so this is a safety guard.
 */
export default function WalletConnectModal({ user, onClose, onConnected }) {
  const { visible, requestClose } = useModalTransition(onClose)

  const [uri, setUri] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  // window.webln is provided by browser extensions like Alby and
  // Mutiny. Surfacing this option only when the extension is actually
  // installed avoids a dead button on every other browser.
  const [weblnAvailable] = useState(() => wallet.isWeblnAvailable())

  useEffect(() => {
    function onKey(e) {
      if (connecting) return  // don't let Esc abandon a flight in progress
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose, connecting])

  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  async function handleConnectWebln() {
    setError('')
    setConnecting(true)
    try {
      await wallet.connectWebln()
      onConnected?.()
      requestClose()
    } catch (e) {
      console.warn('[lb-webln] enable failed', e?.message || e)
      const msg = String(e?.message || '')
      const looksFriendly = msg.length > 0 && msg.length < 200 && !/Error:|stack|undefined/i.test(msg)
      setError(looksFriendly ? msg : 'Couldn\'t enable your browser extension. Make sure it\'s unlocked and try again.')
    } finally {
      setConnecting(false)
    }
  }

  async function handleConnect() {
    setError('')
    if (!user) {
      setError('Sign in with Nostr first — your wallet connection is encrypted with your account.')
      return
    }
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
      console.warn('[lb-nwc] connect failed', e?.message || e)
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
        className={`fixed inset-0 bg-black/70 z-[78] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={connecting ? undefined : requestClose}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[79] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label="Connect Lightning Wallet"
        onClick={(e) => { if (e.target === e.currentTarget && !connecting) requestClose() }}
      >
        <div className={`bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-sm flex flex-col shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Connect Lightning Wallet</h2>
            <button
              onClick={requestClose}
              disabled={connecting}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none disabled:opacity-30"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">
            <p className="text-xs text-neutral-400 leading-snug">
              Connect a Lightning wallet to enable one-tap boosts on
              the show and on every episode (each episode boost pays
              all of its split recipients in one shot).
            </p>

            {/* WebLN button — surfaced only when the browser actually
                provides window.webln. One tap, no copy/paste, no
                signer round-trip. */}
            {weblnAvailable && (
              <>
                <button
                  onClick={handleConnectWebln}
                  disabled={connecting}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
                  </svg>
                  {connecting ? 'Connecting…' : 'Use my browser extension'}
                </button>
                <p className="text-[10px] text-neutral-600 leading-snug -mt-2">
                  Detected a Lightning extension (Alby, Mutiny, etc.) —
                  one tap to enable, no copy/paste required.
                </p>

                <div className="flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-neutral-800" />
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">or</span>
                  <div className="flex-1 h-px bg-neutral-800" />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs text-neutral-400 mb-1.5">NWC connection string</label>
              <textarea
                value={uri}
                onChange={e => setUri(e.target.value)}
                rows={3}
                placeholder="nostr+walletconnect://…"
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-100 font-mono focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
              />
              <p className="mt-1.5 text-[10px] text-neutral-600 leading-snug">
                Cross-device option. Get a connection string from Alby
                Hub, Primal, Mutiny, Coinos, or any wallet that
                supports NIP-47. Encrypted to your Nostr key before
                saving.
              </p>
            </div>

            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full py-3 rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-neutral-200 transition-colors"
            >
              {connecting ? 'Connecting…' : 'Connect via NWC'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
