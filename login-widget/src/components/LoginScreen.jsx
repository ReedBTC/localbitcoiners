import { useState, useEffect, useRef } from 'react'
import { NDKNip07Signer, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { createNostrConnectURI } from 'nostr-tools/nip46'
import { QRCodeSVG } from 'qrcode.react'
import { getNDK, resetNDK, connectAndWait, ensureUserWriteRelays } from '../lib/ndk.js'
import { withTimeout } from '../lib/utils.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import {
  connectViaBunkerUrl,
  connectViaNostrConnectUri,
  generateSecretKey,
  getPublicKey,
  bytesToHex,
  hexToBytes,
} from '../lib/nip46Signer.js'
import {
  saveSession,
  buildExtensionRecord,
  buildNip46Record,
  fetchUserProfile,
} from '../lib/sessionPersistence.js'

// Mobile NIP-46 flows need to survive tab reloads and WebSocket suspensions
// — user taps a signer app, approves, comes back, but the browser tab was
// reaped or the relay socket was suspended while they were away. If we
// generate a fresh local secret on every mount, the bunker's reply (sent to
// the old #p filter) is invisible to the new subscription.
//
// Persist enough to rebuild the SAME nostrconnect URI: the client secret
// (hex) and the URI string itself (which carries the shared secret, relays,
// and client pubkey). On restore, reuse both so the bunker's already-
// published response event arrives at a filter that matches.
//
// sessionStorage (not localStorage) because the clientSecret is the hex
// secret key of the ephemeral identity and the URI query-string carries the
// handshake secret — both sensitive and only needed for the duration of the
// in-flight login. sessionStorage dies with the tab, which is the right
// lifetime.
const PENDING_NIP46_KEY = 'lb_pending_nip46'
const PENDING_NIP46_MAX_AGE_MS = 10 * 60 * 1000

function savePendingNip46(state) {
  try {
    if (!state?.clientSecret || !state?.nostrConnectUri) return
    sessionStorage.setItem(PENDING_NIP46_KEY, JSON.stringify({
      clientSecret: state.clientSecret,
      nostrConnectUri: state.nostrConnectUri,
      createdAt: Date.now(),
    }))
  } catch {}
}

function loadPendingNip46() {
  try {
    const raw = sessionStorage.getItem(PENDING_NIP46_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.clientSecret || !parsed?.nostrConnectUri) return null
    if (Date.now() - Number(parsed.createdAt) > PENDING_NIP46_MAX_AGE_MS) {
      sessionStorage.removeItem(PENDING_NIP46_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function clearPendingNip46() {
  try { sessionStorage.removeItem(PENDING_NIP46_KEY) } catch {}
}

export default function LoginScreen({ onLogin, embedded = false }) {
  const isMobile = useIsMobile()
  const [nsecValue, setNsecValue] = useState('')
  const [bunkerValue, setBunkerValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Mid-flow loading sub-state — tells the user *what* we're waiting on.
  // Especially valuable for the extension flow on mobile where a permission
  // popup may have appeared in a place the user can't easily see (Firefox
  // Android tucks them under the menu).
  const [loadingStep, setLoadingStep] = useState('')
  const [hasExtension, setHasExtension] = useState(false)
  const [ncTab, setNcTab] = useState(null) // 'qr' | 'paste' — set after mount based on device
  const [qrUri, setQrUri] = useState(null)
  const [qrWaiting, setQrWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  // Bunker/NIP-46 can request user-approval via a web URL (nsec.app etc).
  // On mobile, window.open from an async callback is blocked by popup blockers,
  // so we surface the URL in the UI for the user to tap manually. The *user
  // gesture* of tapping the rendered link bypasses the blocker.
  const [authUrl, setAuthUrl] = useState(null)
  const qrSignerRef = useRef(null)
  // Bus the active QR flow listens to for "resubscribe now" signals.
  // Fired by the visibilitychange handler when the tab returns from
  // background — tears down the bunker-reply WebSocket pool and rebuilds
  // it, in case the OS killed the original sockets.
  const qrResubscribeBusRef = useRef(null)
  // "Did your approval seem to get lost?" prompt visibility.
  // Set when, after a tab-return resubscribe on mobile, the bunker still
  // hasn't replied within ~10s — the irrecoverable ephemeral-event case
  // (NIP-46 24133 isn't retained by relays per NIP-01). User taps Retry
  // to start a fresh URI + fresh approval.
  const [qrStuckPrompt, setQrStuckPrompt] = useState(false)
  const qrStuckTimerRef = useRef(null)
  // Token for the extension-detection poll so a competing login flow can abort it.
  const extPollTokenRef = useRef({ aborted: true })

  function abortExtensionPoll() {
    extPollTokenRef.current.aborted = true
  }

  useEffect(() => {
    if (window.nostr) { setHasExtension(true); return }
    const interval = setInterval(() => {
      if (window.nostr) { setHasExtension(true); clearInterval(interval) }
    }, 100)
    const timeout = setTimeout(() => clearInterval(interval), 3000)
    return () => { clearInterval(interval); clearTimeout(timeout) }
  }, [])

  // Default Nostr Connect tab based on device
  useEffect(() => {
    setNcTab(isMobile ? 'paste' : 'qr')
  }, [isMobile])

  // Auto-start the QR flow ONLY on mobile — pre-generating the
  // nostrconnect:// URI so the first tap of "Open in Signer App"
  // navigates immediately instead of stalling on link generation.
  useEffect(() => {
    if (isMobile) startQrFlow()
    return () => {
      if (qrSignerRef.current) {
        try { qrSignerRef.current.abort?.() } catch {}
        qrSignerRef.current = null
      }
    }
  }, [isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile NIP-46 recovery. Background tabs on iOS Safari / Chrome iOS
  // get their WebSockets killed within ~30s. The bunker's reply (kind
  // 24133) is ephemeral so any reply that arrived while we were
  // suspended is gone from the relay — but the bunker may still be
  // online and willing to retry on reconnect, OR the user may need to
  // re-approve. Two-stage recovery on visibility resume:
  //
  //   1. Fire 'resubscribe' on the active flow's bus → connectViaNostr-
  //      ConnectUri rebuilds its pool with fresh sockets.
  //   2. Arm a 10s timer. If still waiting at the end, surface a "Did
  //      your approval get lost?" retry prompt.
  useEffect(() => {
    function onVis() {
      if (document.visibilityState !== 'visible') return
      if (!qrWaiting) return
      if (qrResubscribeBusRef.current) {
        try {
          qrResubscribeBusRef.current.dispatchEvent(new Event('resubscribe'))
        } catch {}
      }
      if (qrStuckTimerRef.current) clearTimeout(qrStuckTimerRef.current)
      // 5s on mobile (was 10s) — when the user comes back from the signer
      // app and we haven't received the response, it's almost always
      // because the OS killed the WebSocket while they were tabbed away
      // and the bunker's reply landed on a now-dead socket. Faster prompt
      // = faster path to "fresh URI, try once more" recovery.
      const stuckDelay = isMobile ? 5000 : 10000
      qrStuckTimerRef.current = setTimeout(() => {
        qrStuckTimerRef.current = null
        if (qrSignerRef.current && qrWaiting) {
          setQrStuckPrompt(true)
        }
      }, stuckDelay)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [qrWaiting, isMobile])

  function cancelActiveQrFlow() {
    if (qrSignerRef.current) {
      try { qrSignerRef.current.abort?.() } catch {}
      qrSignerRef.current = null
    }
    setQrWaiting(false)
    clearPendingNip46()
    abortExtensionPoll()
  }

  // Detect Firefox WebExtensions message-channel errors that fire when the
  // extension opened a permission popup but the user hasn't tapped it yet.
  // Once the user approves the origin, subsequent calls succeed silently.
  function isExtensionApprovalPendingError(msg) {
    return /onMessage listener went out of scope|message channel closed|Receiving end does not exist/i.test(msg || '')
  }

  // The actual NIP-07 handshake. Pulled out of loginWithExtension so we
  // can call it twice for the auto-retry on the "approval pending" error.
  async function performExtensionLogin() {
    resetNDK()
    const signer = new NDKNip07Signer()
    const ndk = getNDK()
    ndk.signer = signer
    setLoadingStep('Approve in your extension…')
    // 60s ceiling because mobile users may have to dig through a menu
    // to find the extension's approval popup (Firefox Android tucks it
    // under the main menu). The timeout is only hit on failure, so a
    // longer ceiling doesn't slow down the happy path.
    await withTimeout(signer.blockUntilReady(), 60000, '__timeout__')
    setLoadingStep('Connecting to relays…')
    await connectAndWait(ndk)
    const pubkey = await signer.user()
    await ensureUserWriteRelays(ndk, pubkey.pubkey)
    const user = await fetchUserProfile(ndk, pubkey.pubkey)
    saveSession(buildExtensionRecord(pubkey.pubkey))
    return user
  }

  async function loginWithExtension() {
    setError('')
    setLoading(true)
    setLoadingStep('Looking for your extension…')
    const token = { aborted: false }
    extPollTokenRef.current = token
    // 3000ms (was 1500) — content-script injection on mobile (especially
    // Firefox Android with nos2x-fox) can take 2–3s on slow devices, and
    // bailing too early gave a misleading "no extension detected" error
    // even when the extension was installed and working.
    if (!window.nostr) {
      const start = Date.now()
      while (!window.nostr && !token.aborted && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    if (token.aborted) { setLoading(false); setLoadingStep(''); return }
    if (!window.nostr) {
      const insecureOrigin = typeof window !== 'undefined'
        && window.location?.protocol === 'http:'
        && window.location?.hostname !== 'localhost'
        && window.location?.hostname !== '127.0.0.1'
      const base = 'No Nostr extension detected. Supported: Alby, nos2x, keys.band, Nostore.'
      const originHint = insecureOrigin
        ? ' If you have one installed, this page origin may not be permitted — try http://localhost instead of a LAN IP, or use HTTPS.'
        : ''
      setError(base + originHint)
      setLoading(false)
      setLoadingStep('')
      return
    }
    try {
      const user = await performExtensionLogin()
      onLogin(user)
    } catch (err) {
      const msg = err?.message || 'unknown error'
      if (msg === '__timeout__') {
        setError('Extension did not respond in time. If you are using keys.band, open the extension and approve this site first, then try again.')
      } else if (isExtensionApprovalPendingError(msg)) {
        // First attempt failed because of the message-channel race. Show
        // the helpful prompt, then auto-retry once after a 5s delay —
        // that's typically enough time for the user to find and tap the
        // approval popup. If THAT fails, we keep the error and let the
        // user retry manually.
        setLoadingStep('Waiting for extension approval…')
        setError('Your extension needs to approve this site. Open the extension (Firefox menu → Extensions → nos2x / Alby / etc.), tap Allow on the pending prompt — we\'ll retry automatically.')
        await new Promise(r => setTimeout(r, 5000))
        try {
          const user = await performExtensionLogin()
          setError('')
          onLogin(user)
        } catch (retryErr) {
          const retryMsg = retryErr?.message || 'unknown error'
          if (isExtensionApprovalPendingError(retryMsg)) {
            setError('Still waiting on your extension. Open it, tap Allow on the pending prompt for this site, then click Login again.')
          } else if (retryMsg === '__timeout__') {
            setError('Extension did not respond in time. Try opening the extension manually and approving this site, then click Login again.')
          } else {
            setError('Extension login failed: ' + retryMsg)
          }
        }
      } else {
        setError('Extension login failed: ' + msg)
      }
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  async function loginWithKey() {
    setError('')
    cancelActiveQrFlow()
    // Lowercase the value before bech32 decode. Bech32 is case-sensitive
    // in the sense that mixed-case strings are invalid — and iOS likes
    // to capitalize the first character of pasted text, producing
    // "Nsec1..." which fails decode with a confusing "Invalid checksum".
    // All-lowercase is what nip19.decode wants.
    const val = nsecValue.trim().toLowerCase()
    if (!val) {
      setError('Please paste your nsec key.')
      return
    }
    setLoading(true)
    try {
      resetNDK()
      const decoded = nip19.decode(val)
      const ndk = getNDK()

      if (decoded.type !== 'nsec') {
        throw new Error('Input must be an nsec private key.')
      }

      const signer = new NDKPrivateKeySigner(decoded.data)
      ndk.signer = signer
      await connectAndWait(ndk)
      const ndkUser = await signer.user()
      await ensureUserWriteRelays(ndk, ndkUser.pubkey)
      const user = await fetchUserProfile(ndk, ndkUser.pubkey)
      // nsec is in-memory only — intentionally not persisted.
      onLogin(user)
    } catch (err) {
      setError(err.message || 'Invalid key.')
    } finally {
      setLoading(false)
      setNsecValue('')
    }
  }

  function switchNcTab(tab) {
    if (qrSignerRef.current) {
      try { qrSignerRef.current.abort?.() } catch {}
      try { qrSignerRef.current.close?.() } catch {}
      qrSignerRef.current = null
    }
    setQrUri(null)
    setQrWaiting(false)
    setError('')
    clearPendingNip46()
    setNcTab(tab)
  }

  async function startQrFlow() {
    setError('')
    setQrStuckPrompt(false)
    if (qrStuckTimerRef.current) {
      clearTimeout(qrStuckTimerRef.current)
      qrStuckTimerRef.current = null
    }
    setQrWaiting(true)
    const aborter = new AbortController()
    const resubscribeBus = new EventTarget()
    qrResubscribeBusRef.current = resubscribeBus
    const handle = { abort: () => aborter.abort(), close: () => aborter.abort() }
    qrSignerRef.current = handle
    try {
      const ndk = getNDK()
      await connectAndWait(ndk)

      // Different signers publish the connect response to different relays;
      // advertise + subscribe to a broad set so whichever relay the signer
      // picks, we'll see the response. nsec.app, primal, and damus cover
      // most named bunkers; nos.lol + relay.nostr.band catch Amber-on-
      // Android configurations that publish to a wider set or fall back
      // to a "well-known" relay when the user's preferred isn't reachable.
      const NC_RELAYS = [
        'wss://relay.nsec.app',
        'wss://relay.primal.net',
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ]

      // Reuse the saved secret + URI if we published one recently.
      let clientSecretKey
      let clientSecret
      let nostrConnectUri
      const pending = loadPendingNip46()
      if (pending) {
        try {
          clientSecretKey = hexToBytes(pending.clientSecret)
          clientSecret = pending.clientSecret
          nostrConnectUri = pending.nostrConnectUri
        } catch {
          clearPendingNip46()
        }
      }
      if (!clientSecretKey) {
        clientSecretKey = generateSecretKey()
        clientSecret = bytesToHex(clientSecretKey)
        const clientPubkey = getPublicKey(clientSecretKey)
        const secretBytes = new Uint8Array(16)
        crypto.getRandomValues(secretBytes)
        const secret = bytesToHex(secretBytes)
        nostrConnectUri = createNostrConnectURI({
          clientPubkey,
          relays: NC_RELAYS,
          secret,
          name: 'Local Bitcoiners',
          url: 'https://localbitcoiners.com',
        })
        savePendingNip46({ clientSecret, nostrConnectUri })
      }
      setQrUri(nostrConnectUri)

      const signer = await connectViaNostrConnectUri({
        ndk,
        connectionUri: nostrConnectUri,
        clientSecretKey,
        signal: aborter.signal,
        resubscribeBus,
        onAuthUrl: (url) => {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
            if (!isMobile) {
              window.open(url, '_blank', 'width=600,height=700,noopener,noreferrer')
            }
            setAuthUrl(url)
          } catch {}
        },
        timeoutMs: 300000,
      })

      if (qrSignerRef.current !== handle) {
        try { await signer.close() } catch {}
        return
      }
      qrSignerRef.current = signer
      qrResubscribeBusRef.current = null
      setQrStuckPrompt(false)
      if (qrStuckTimerRef.current) {
        clearTimeout(qrStuckTimerRef.current)
        qrStuckTimerRef.current = null
      }

      setQrWaiting(false)
      setLoading(true)
      ndk.signer = signer
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, signer.pubkey)
      const user = await fetchUserProfile(ndk, signer.pubkey)
      const nip46Record = buildNip46Record({
        clientSecret,
        bunkerPointer: signer.bunkerPointer,
        userPubkey: signer.pubkey,
      })
      if (nip46Record) saveSession(nip46Record)
      clearPendingNip46()
      onLogin(user)
    } catch (err) {
      if (qrSignerRef.current !== handle) return
      setQrWaiting(false)
      qrResubscribeBusRef.current = null
      if (qrStuckTimerRef.current) {
        clearTimeout(qrStuckTimerRef.current)
        qrStuckTimerRef.current = null
      }
      setError('QR login failed: ' + (err.message || 'unknown error'))
    } finally {
      setLoading(false)
    }
  }

  function cancelQrFlow() {
    if (qrSignerRef.current) {
      try { qrSignerRef.current.abort?.() } catch {}
      try { qrSignerRef.current.close?.() } catch {}
      qrSignerRef.current = null
    }
    qrResubscribeBusRef.current = null
    if (qrStuckTimerRef.current) {
      clearTimeout(qrStuckTimerRef.current)
      qrStuckTimerRef.current = null
    }
    setQrStuckPrompt(false)
    setQrUri(null)
    setQrWaiting(false)
    setError('')
    clearPendingNip46()
    startQrFlow()
  }

  async function copyQrUri() {
    if (!qrUri) return
    try {
      await navigator.clipboard.writeText(qrUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not access the clipboard — select and copy manually.')
    }
  }

  // No openInSignerApp() function — the "Open in Signer App" button is
  // rendered as an actual <a href={qrUri}> below. Anchor taps register as
  // genuine user gestures with the browser, so iOS Safari and Firefox
  // Android won't silently no-op the navigation the way they sometimes
  // do for `window.location.href = scheme://...` from a button onClick.

  async function loginWithBunker() {
    setError('')
    setAuthUrl(null)
    cancelActiveQrFlow()
    const token = bunkerValue.trim()
    if (!token) {
      setError('Please paste your bunker:// connection string.')
      return
    }
    if (!token.startsWith('bunker://')) {
      setError('Connection string must start with bunker://')
      return
    }
    setLoading(true)
    setLoadingStep('Sending connect request…')
    let authRequested = false
    const clientSecretKey = generateSecretKey()
    const clientSecret = bytesToHex(clientSecretKey)
    try {
      resetNDK()
      const ndk = getNDK()
      const signer = await connectViaBunkerUrl({
        ndk,
        bunkerUrl: token,
        clientSecretKey,
        onAuthUrl: (url) => {
          authRequested = true
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
            setAuthUrl(url)
            if (!isMobile) {
              try { window.open(url, '_blank', 'width=600,height=700,noopener,noreferrer') } catch {}
            }
          } catch {}
        },
        // Stage labels distinguish "waiting on connect ack" (first
        // Amber prompt) from "waiting on get_public_key ack" (often a
        // SECOND Amber prompt that users miss because they returned
        // to the browser after approving the first one). Without this,
        // a stuck second-prompt looks identical to a stuck connect.
        onStage: (stage) => {
          if (stage === 'connect') {
            setLoadingStep('Waiting for approval in your signer app…')
          } else if (stage === 'get_public_key') {
            setLoadingStep('Got connect ack — waiting for read-pubkey approval (check your signer for a SECOND prompt)')
          }
        },
        timeoutMs: 180000,
      })
      setLoadingStep('Connecting to relays…')
      ndk.signer = signer
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, signer.pubkey)
      const user = await fetchUserProfile(ndk, signer.pubkey)
      const nip46Record = buildNip46Record({
        clientSecret,
        bunkerPointer: signer.bunkerPointer,
        userPubkey: signer.pubkey,
      })
      if (nip46Record) saveSession(nip46Record)
      onLogin(user)
    } catch (err) {
      const msg = err?.message || 'unknown error'
      if (/return the user pubkey/i.test(msg)) {
        // Specific failure: connect succeeded (we'd have errored on
        // bs.connect() otherwise) but get_public_key never returned.
        // 95% of the time this is "user didn't see the second prompt
        // in their signer app". Tell them exactly what to look for.
        setError('Connect was acknowledged, but the signer didn\'t return your pubkey. Open your signer app — there\'s usually a SECOND prompt asking to read your pubkey. Approve it, then try again.')
      } else if (/timeout|did not/i.test(msg)) {
        setError(authRequested
          ? 'Bunker requested approval but never completed. Tap the approval link above, then try again.'
          : 'Bunker did not respond in time. Check that the connection string is valid and the bunker is online.')
      } else {
        setError('Bunker login failed: ' + msg)
      }
    } finally {
      setLoading(false)
      setLoadingStep('')
      setBunkerValue('')
      setAuthUrl(null)
    }
  }

  // ─── Shared sub-components ──────────────────────────────────────────────────

  const Divider = () => (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-px bg-neutral-800" />
      <span className="text-xs text-neutral-600">or</span>
      <div className="flex-1 h-px bg-neutral-800" />
    </div>
  )

  const KeySection = () => (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="nsec-input" className="block text-sm text-neutral-400">
          {isMobile ? 'Paste your nsec' : 'Private key (nsec)'}
        </label>
        <input
          id="nsec-input"
          type="password"
          value={nsecValue}
          onChange={e => setNsecValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loginWithKey()}
          placeholder="nsec1..."
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 font-mono text-sm"
          aria-label="Nostr nsec input"
        />
      </div>

      <p className="text-xs text-amber-500/80 leading-relaxed">
        Your key is held in memory only and cleared when you close this page. Never stored.
      </p>

      <button
        onClick={loginWithKey}
        disabled={loading || !nsecValue.trim()}
        className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
      >
        {loading ? 'Connecting...' : 'Login with Key'}
      </button>
    </div>
  )

  const ExtensionSection = () => (
    <div className="space-y-3">
      <button
        onClick={loginWithExtension}
        disabled={loading}
        className="w-full py-3 px-4 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
      >
        {loading ? 'Connecting...' : 'Login with Extension'}
      </button>
      {/* Loading sub-state — visible only during an extension login.
          Tells the user *what* we're waiting on, especially valuable
          on mobile where the extension's permission popup may not be
          obvious (Firefox Android tucks them under the menu). */}
      {loading && loadingStep && (
        <p className="text-xs text-orange-400 flex items-center gap-1.5 justify-center">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
          {loadingStep}
        </p>
      )}
      {!hasExtension && !isMobile && (
        <p className="text-xs text-neutral-500 text-center">
          Works with Alby, nos2x, Nostore, keys.band, and other NIP-07 extensions.
        </p>
      )}
    </div>
  )

  const NostrConnectSection = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-400">Nostr Connect</span>
        {!isMobile && (
          <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
            <button
              onClick={() => switchNcTab('qr')}
              className={`px-3 py-1.5 transition-colors ${ncTab === 'qr' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
            >
              Scan QR
            </button>
            <button
              onClick={() => switchNcTab('paste')}
              className={`px-3 py-1.5 transition-colors border-l border-neutral-700 ${ncTab === 'paste' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
            >
              Paste string
            </button>
          </div>
        )}
      </div>

      {/* Mobile: signer app launch + paste input. The launch is an actual
          <a href> so the browser treats the tap as a real user gesture —
          this avoids silent no-ops on iOS Safari / Firefox Android that
          can happen when navigating to a custom scheme via window.location
          from a button's onClick. While the URI is still being generated
          we render a disabled-style button as a placeholder. */}
      {isMobile && (
        <div className="space-y-3">
          {qrUri ? (
            <a
              href={qrUri}
              className="w-full py-3 px-4 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors flex items-center justify-center gap-2"
              style={{ textDecoration: 'none' }}
              aria-label="Open in signer app"
            >
              Open in Signer App
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="w-full py-3 px-4 rounded-lg bg-orange-500 opacity-40 cursor-not-allowed text-white font-medium flex items-center justify-center gap-2"
            >
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </button>
          )}
          {qrUri && (
            <button
              onClick={copyQrUri}
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-300 text-xs border border-neutral-700 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy connection link'}
            </button>
          )}
          {qrWaiting && qrUri && !qrStuckPrompt && (
            <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
              <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
              Waiting for signer...
            </div>
          )}

          {qrWaiting && qrUri && qrStuckPrompt && (
            <div className="space-y-2 px-3 py-2.5 rounded-lg border border-amber-900/60 bg-amber-950/20">
              <p className="text-xs text-amber-300 leading-snug">
                Didn't see your approval. Mobile can drop the connection
                while you're in the signer — try again with a fresh
                connection link.
              </p>
              <button
                type="button"
                onClick={cancelQrFlow}
                className="w-full py-1.5 px-3 rounded text-xs bg-amber-700 hover:bg-amber-600 text-white transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          <p className="text-xs text-neutral-500 text-center">
            Your phone will open whichever signer app claimed the nostrconnect link. Using a different signer? Copy the link above and paste it in.
          </p>

          {/* Amber-specific guidance. Amber on Android frequently fails on
              the first connect because (a) the user has to find the
              Approve button in Amber, return here, and the OS may have
              killed our WebSocket meanwhile, and (b) Amber may prompt a
              second time for the get_public_key permission scope. The
              recommended fallback (the bunker:// URL flow below) avoids
              all of this — Amber generates a stable URL with the user's
              pubkey already embedded, no relay round-trip handshake. */}
          <div className="rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-[11px] text-neutral-400 leading-relaxed">
            <strong className="text-neutral-300">Amber on Android?</strong> If login gets stuck, tap "Open in Signer App" again — Amber will remember your approval and reconnect quickly. Still stuck? Use the <strong>bunker URL</strong> option below instead: in Amber, go to Settings → Connected Apps → Generate bunker URL, then paste it here. That path is more reliable on mobile.
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-neutral-800" />
            <span className="text-xs text-neutral-600">or paste a bunker string</span>
            <div className="flex-1 h-px bg-neutral-800" />
          </div>

          <div className="space-y-2">
            <input
              id="bunker-input-mobile"
              type="password"
              value={bunkerValue}
              onChange={e => setBunkerValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loginWithBunker()}
              placeholder="bunker://..."
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 font-mono text-sm"
            />
            <button
              onClick={loginWithBunker}
              disabled={loading || !bunkerValue.trim()}
              className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
            {/* Stage label during bunker URL connect. Amber on Android
                often shows TWO permission prompts in sequence (connect,
                then get_public_key). Without a stage label, the second
                one is invisible to the user — they think login is stuck
                when really there's a prompt waiting in their signer. */}
            {loading && loadingStep && (
              <p className="text-xs text-orange-400 flex items-center gap-1.5 leading-snug">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse flex-shrink-0 mt-0.5" />
                <span>{loadingStep}</span>
              </p>
            )}
          </div>
        </div>
      )}

      {/* Desktop: QR code tab */}
      {!isMobile && ncTab === 'qr' && (
        <div className="space-y-3">
          {qrWaiting && qrUri ? (
            <>
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="p-3 bg-white rounded-lg">
                  <QRCodeSVG value={qrUri} size={200} />
                </div>
                <p className="text-xs text-neutral-400 text-center">
                  Scan with Amber, Primal, or any NIP-46 signer app
                </p>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={copyQrUri}
                    className="flex-1 py-2 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                  >
                    {copied ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    onClick={cancelQrFlow}
                    className="flex-1 py-2 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                  >
                    Refresh QR
                  </button>
                </div>
                {!qrStuckPrompt && (
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                    Waiting for signer to connect...
                  </div>
                )}
                {qrStuckPrompt && (
                  <div className="w-full space-y-2 px-3 py-2.5 rounded-lg border border-amber-900/60 bg-amber-950/20">
                    <p className="text-xs text-amber-300 leading-snug">
                      Didn't see your approval. The connection may have
                      been dropped while you were in the signer — try
                      again with a fresh QR.
                    </p>
                    <button
                      type="button"
                      onClick={cancelQrFlow}
                      className="w-full py-1.5 px-3 rounded text-xs bg-amber-700 hover:bg-amber-600 text-white transition-colors"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : qrWaiting ? (
            <div className="flex flex-col items-center py-4">
              <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-neutral-500 mt-2">Generating QR...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center py-4 gap-2">
              <button
                type="button"
                onClick={startQrFlow}
                className="py-2 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm border border-neutral-700 transition-colors"
              >
                Generate QR code
              </button>
              <p className="text-[11px] text-neutral-600 text-center max-w-[260px]">
                Click to open a one-time NIP-46 signer invite.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Desktop: paste bunker string tab */}
      {!isMobile && ncTab === 'paste' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="bunker-input" className="block text-xs text-neutral-500">
              Paste your bunker:// connection string
            </label>
            <input
              id="bunker-input"
              type="password"
              value={bunkerValue}
              onChange={e => setBunkerValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loginWithBunker()}
              placeholder="bunker://..."
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 font-mono text-sm"
            />
          </div>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Generate a connection string from Nsec.app or any NIP-46 bunker, then paste it here.
          </p>
          <button
            onClick={loginWithBunker}
            disabled={loading || !bunkerValue.trim()}
            className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
          >
            {loading ? 'Connecting...' : 'Login with Bunker'}
          </button>
          {loading && loadingStep && (
            <p className="text-xs text-orange-400 flex items-center gap-1.5 leading-snug">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse flex-shrink-0 mt-0.5" />
              <span>{loadingStep}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )

  // ─── Render ─────────────────────────────────────────────────────────────────

  const outerClass = embedded
    ? 'flex flex-col items-center px-4'
    : 'flex flex-col items-center justify-center min-h-screen px-4'

  return (
    <div className={outerClass}>
      <div className="w-full max-w-md space-y-6">

        {/* Logo */}
        <div className="text-center">
          <img src="/assets/LocalBitcoiners.png" alt="Local Bitcoiners" className="h-16 w-16 mx-auto mb-2 rounded-full" />
          <p className="mt-2 text-neutral-400 text-sm">Sign in with Nostr</p>
        </div>

        {isMobile ? (
          <>
            {hasExtension && (
              <>
                <ExtensionSection />
                <Divider />
              </>
            )}
            <KeySection />
            <Divider />
            <NostrConnectSection />
          </>
        ) : (
          <>
            <ExtensionSection />
            <Divider />
            <KeySection />
            <Divider />
            <NostrConnectSection />
          </>
        )}

        {/* Bunker requested web approval — surface the URL as a real <a>
            so mobile popup blockers don't eat it. */}
        {authUrl && (
          <div className="rounded-lg border border-orange-700 bg-orange-950/40 p-3 text-center space-y-2">
            <p className="text-xs text-orange-200">
              Your bunker is asking you to approve this connection.
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block w-full py-2 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium transition-colors"
            >
              Open approval page
            </a>
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              Approve in the new tab, then return here. Login finishes automatically.
            </p>
          </div>
        )}

        {/* Error display */}
        {error && (
          <p className="text-sm text-red-400 text-center" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
