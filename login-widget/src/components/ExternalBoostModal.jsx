/**
 * ExternalBoostModal — boost another podcast's episode (Podcasting 2.0 V4V).
 *
 * DELIBERATELY SEPARATE from EpisodeBoostModal / MultiLegBoostForm (the LB
 * boost path, untouched). This runs the external orchestrator (lib/
 * externalBoost.js): pays the episode's value-block recipients via LNURL
 * (lnaddress) and keysend (node), publishes NO kind 30078, and posts a kind-1
 * note tagged to the external show's guid + episode URL. Nothing here touches
 * LB stats/bots.
 *
 * ⚠️ WHAT IS DECLARED IN THE FORM AND WHAT WAITS FOR SETTLEMENT ARE DIFFERENT
 * THINGS, and the distinction is the whole design of this file. The INTENT —
 * whether a note is posted at all, and whose identity signs it — is declared
 * in the form, because it is a choice about the donor rather than about the
 * outcome, and asking for it on the done screen charges the friction to the
 * newcomer this flow exists for. The FIGURES are recomputed at the moment of
 * publishing, because a note reports what settled and no earlier moment knows
 * that (see `handleShare` and D14 in boost-login.md).
 *
 * ⚠️ ANONYMOUS AND PRIVATE ARE DIFFERENT ANSWERS TO DIFFERENT QUESTIONS, and
 * conflating them is what this file used to do. **Anonymous** is about WHOSE
 * name is on the boost: not your Nostr account, and optionally a name you type
 * instead. **Private** is about whether a note exists at all. So an anonymous
 * boost is still published, by Local Bitcoiners, with no npub attached — which is the
 * whole point, because it means an anonymous booster still counts in the feeds
 * and the totals.
 *
 * The outcomes, all falling out of two controls:
 *
 *   as yourself, note on    the donor's own npub signs it, on their press
 *   anon + name, note on    Local Bitcoiners signs it, the name is a line of prose
 *   anon, no name, note on  Local Bitcoiners signs it with no name at all
 *   note off                nothing is published from any key
 *
 * Signed out there is no "as yourself", so the first row simply does not
 * arise; everything else is identical.
 *
 * Progress UI is self-contained (not the LB BoostProgressView) so the external
 * leg shape / skipped legs / keysend-uncertain retry rules stay independent.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { isSafeUrl } from '../lib/utils.js'
import * as wallet from '../lib/wallet.js'
import { payExternalBoost, distributeSats, STATUS } from '../lib/externalBoost.js'
import { buildExternalNoteTemplate, buildDonationNoteTemplate, sanitizeSenderName, MAX_MESSAGE_CHARS, MAX_SENDER_NAME_CHARS } from '../lib/externalBoostagram.js'
import { signKindOneShareWithUser, publishSignedKindOne, confirmInvoiceSettled, fetchLnurlMeta } from '../lib/boostagram.js'
import { signKindOneWithSite } from '../lib/siteSign.js'
import { setBoostModalProgressVisible } from '../lib/boostModalSignal.js'
import { fireConfetti } from '../lib/confetti.js'
import ConfirmLeaveOverlay from './ConfirmLeaveOverlay.jsx'
import LoginButton from './LoginButton.jsx'

// ⚠️ WHAT A BOOST IS "FROM" WHEN NOBODY TYPED ANYTHING. It fills the
// boostagram's `sender_name` only — the field a podcaster's Helipad prints —
// and never the note, whose author is already the Local Bitcoiners bot, where a
// "From localbitcoiners.com listener" line would be the account restating itself.
//
// It names the site rather than a person, so it takes nothing away from an
// anonymous boost; what it buys is that the boost presents as one consistent
// thing instead of blank in one aggregator and "Unknown" in the next.
const DEFAULT_SENDER_NAME = 'localbitcoiners.com listener'

// ⚠️ THE AMOUNT SHIPS EMPTY, DELIBERATELY. It was prefilled at 1000, which is a
// number nobody chose and which a donor in a hurry sends by accident. The
// presets are the fast path instead; the field stays free text, so any amount
// is still one tap away.
const PRESETS = [420, 2100, 3333, 6969]

const MIN_SATS = 21
// ⚠️ `SITE_SIGN_MAX_SATS` IS THE SAME NUMBER AND IS MEANT TO BE. The signing
// oracle refuses an `amount` above its own cap, and the two were 5M and 100k
// until 2026-08-21, so a large signed-out or Anon boost paid fine and then
// could not be posted. Keeping them equal is what makes the advisory lines
// below dead code in practice; they are kept because the two constants live in
// files that cannot import each other, so nothing enforces the equality.
const MAX_SATS = 5_000_000
const WORKING = STATUS.PAYING
// How long an unconfirmed leg keeps being checked after the run ends, and how
// long a donor-pressed re-check runs for. Both are wall-clock budgets rather
// than attempt counts: what matters is how long Lightning is given to settle,
// not how many times we asked.
const WATCH_MS = 90_000
const RECHECK_MS = 30_000

function fmtSats(n) { return Number(n || 0).toLocaleString() }

/**
 * ⚠️ WAITING IS NOT THE SAME EVENT AS GIVING UP, AND THE OLD SCREEN SAID BOTH
 * AT ONCE. An unconfirmed leg arrived carrying "Don't re-send; it may already
 * be on its way" the instant the pay run ended, on a screen headed "Still
 * checking the rest — don't re-send them", in warning amber, and then held
 * that for up to ninety seconds without changing. Every word of it was true.
 * It still read as a fault, and it read as a *stuck* fault, because a screen
 * that cannot be hurried and never changes is indistinguishable from one that
 * has stopped working. Observed on a real boost, 2026-08-19: a leg to a slow
 * provider settled after about a minute, and the wait was the only part of the
 * boost that felt broken.
 *
 * So the two are separated. While the background watcher is running the donor
 * has NO decision to make — there is no Retry on an unconfirmed leg by design
 * — so the screen only reports that it is still working, and does it in copy
 * that CHANGES, which is the part that proves it is alive. The warning belongs
 * at the end of the watch, where a decision finally arrives, and that is where
 * it still is (see the give-up text the watcher writes).
 *
 * The stages escalate in patience, never in alarm. The one thing they must
 * keep carrying is that the sats may already be moving, since the double-pay
 * risk here is not a button — it is a donor who closes this modal and boosts
 * the episode again.
 */
/**
 * ⚠️ THE LONGEST WAIT IS BEFORE THE WATCHER EVER STARTS, and CHECK_STAGES did
 * not cover it. Measured on a real boost, 2026-08-19, four legs through one
 * WebLN extension:
 *
 *   greyturkey26@primal.net   invoice 1.9s   pay  2.3s
 *   chadf@getalby.com         invoice 0.6s   pay 45.5s   → uncertain, settled later
 *   reed@getalby.com          invoice 0.8s   pay  0.4s
 *
 * So the donor sat in front of a spinner and one unchanging line for
 * three-quarters of a minute, and the escalating copy only began once the run
 * ended. **The hang is inside the wallet's own `sendPayment`** — same
 * extension, same session, two sibling legs answering in seconds — so nothing
 * here can hurry it, shorten it, or see progress inside it. What it can do is
 * say how long it has been going, which is the whole of CHECK_STAGES' argument
 * arriving one state earlier.
 *
 * ⚠️ The first stage is deliberately SILENT. A normal leg pays in one to four
 * seconds, and a reassurance that flashes up and vanishes is noise that makes
 * a fast boost look eventful. The line appears only once the wait is long
 * enough to be worth explaining.
 *
 * The ceiling these run under is the wallet adapter's, not this file's: 90s for
 * WebLN, ~60s for NWC's SDK. **Do not shorten either to make this tidier** —
 * the leg above took 45.5 seconds and then paid, and a tighter bound would have
 * turned a successful payment into an UNCERTAIN one.
 */
const PAY_STAGES = [
  { at: 0, text: null },
  { at: 12, text: (name) => `Still waiting on your wallet for ${name}. That happens when a route is slow.` },
  { at: 30, text: (name) => `Still trying to reach ${name}. Nothing has failed; some destinations take longer than others.` },
  { at: 60, text: (name) => `Still going. If ${name} doesn\u2019t answer shortly we\u2019ll move on and tell you exactly where it stands.` },
]
function payStageText(seconds, name) {
  let fn = null
  for (const stage of PAY_STAGES) {
    if (seconds >= stage.at) fn = stage.text
  }
  return typeof fn === 'function' ? fn(name || 'this recipient') : null
}

const CHECK_STAGES = [
  { at: 0,  text: 'Waiting for their wallet to confirm this one.' },
  { at: 15, text: 'Still waiting. Some wallets take a minute to confirm, and nothing has failed.' },
  { at: 35, text: 'Still working on it. Hang tight — the sats may already be on their way.' },
  { at: 60, text: 'Still going. We\u2019ll stop checking shortly and tell you exactly where it stands.' },
]
function checkStageText(seconds) {
  let text = CHECK_STAGES[0].text
  for (const stage of CHECK_STAGES) {
    if (seconds >= stage.at) text = stage.text
  }
  return text
}

/**
 * ⚠️ TWO DIFFERENT AFFORDANCES, AND THE SPLIT BETWEEN THEM IS THE DOUBLE-PAY
 * GUARD. They used to be one "Retry" button and that is what paid a recipient
 * twice on 2026-08-19.
 *
 * A FAILED leg is one we know did not pay: it fell over before an invoice was
 * ever handed to the wallet, or the wallet cleanly declined it. Re-paying is
 * safe, because nothing is in flight.
 *
 * An UNCERTAIN leg is one an invoice WAS handed over for and no settlement has
 * been observed. Nothing can prove that leg unpaid — LUD-21 has no negative
 * signal, see confirmInvoiceSettled — so **it is never re-paid from this UI**.
 * The only offer is to look again, which is free and cannot go wrong. If it
 * truly did not land, the donor boosts again from the top, which is one
 * deliberate act rather than a button that quietly risks their money.
 */
function canRepayLeg(recipient, leg) {
  return leg?.status === STATUS.FAILED
}

/** An unconfirmed leg can be re-checked only when there is something to check
 *  against: LUD-21 needs the invoice's own verify URL, which keysend has none
 *  of and some lnaddress providers don't return. */
function canCheckLeg(recipient, leg) {
  return leg?.status === STATUS.UNCERTAIN &&
    recipient?.type === 'lnaddress' && !!leg?.verifyUrl && !!leg?.paymentHash
}

// One per-recipient row in the progress list.
function LegRow({ recipient, leg, onRepay, onCheck, checking, locked }) {
  const status = leg?.status || STATUS.PENDING
  const sats = leg?.sats
  const repayable = !!onRepay && canRepayLeg(recipient, leg)
  const checkable = !!onCheck && canCheckLeg(recipient, leg)
  // ⚠️ Suppressed while the watcher runs. The row's own message is the
  // give-up message, and showing it mid-watch is the confusion described on
  // CHECK_STAGES. The spinner and the label carry the row; the one escalating
  // line under the list carries the explanation, once, however many legs are
  // in flight.
  const showError = !checking && (status === STATUS.FAILED || status === STATUS.UNCERTAIN) && !!leg?.error
  const spinner = (
    <svg className="animate-spin w-3.5 h-3.5 text-[var(--brand-d,#d97b0e)]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
  // ⚠️ A PENDING LEG HAD NO MARK AT ALL. The empty ring was a 1px border on a
  // near-white field, which is invisible — so a queued recipient rendered as a
  // name floating in space with a gap where the others have a tick. Filled and
  // ringed, it reads as "waiting its turn", which is what it is.
  let icon = <span className="inline-block w-3 h-3 rounded-full bg-[var(--modal-inset,#f1e8d2)] ring-1 ring-[var(--modal-line,#d4c4a0)]" aria-hidden="true" />
  if (status === STATUS.PAID) icon = <span className="text-[var(--ok,#2f7a3a)]" aria-hidden="true">✓</span>
  else if (status === STATUS.FAILED) icon = <span className="text-[var(--danger,#b3261e)]" aria-hidden="true">✕</span>
  else if (status === STATUS.UNCERTAIN) icon = checking ? spinner : <span className="text-[var(--warn,#7a5c00)]" aria-hidden="true">!</span>
  else if (status === WORKING) icon = spinner

  // One button slot. `locked` keeps it on screen but inert once the note has
  // been published, because a leg that changed afterwards could not be
  // reflected in an event that cannot be edited.
  let action = null
  if (checking) {
    // Orange, not amber: this is the working tone the sending phase uses, not
    // the warning tone a shortfall uses.
    action = <span className="shrink-0 text-[11px] px-2 py-0.5 text-[var(--brand-d,#d97b0e)]">Checking…</span>
  } else if (repayable || checkable) {
    action = (
      <button onClick={locked ? undefined : (repayable ? onRepay : onCheck)} disabled={locked}
        title={locked ? 'Your note is already published, so a change here couldn’t be reflected in it.' : undefined}
        className="shrink-0 text-[11px] px-2 py-0.5 rounded-lg border border-[var(--modal-line,#d4c4a0)] text-[var(--ink,#2d2010)] hover:border-[var(--brand,#f7931a)] hover:text-[var(--brand-dd,#a85500)] disabled:opacity-40 disabled:hover:border-[var(--modal-line,#d4c4a0)] disabled:hover:text-[var(--muted,#6b5a3e)] disabled:cursor-not-allowed transition-colors">
        {repayable ? 'Retry' : 'Check again'}
      </button>
    )
  }

  // A leg that has not been reached yet is deliberately quieter than one that
  // has: the eye should land on what is happening now, not on the queue.
  const idle = status === STATUS.PENDING
  return (
    <li className="py-2.5 text-xs">
      <div className="flex items-center gap-2.5">
        <span className="w-4 flex justify-center shrink-0">{icon}</span>
        <span className={`flex-1 min-w-0 truncate ${idle ? 'text-[var(--muted,#6b5a3e)]' : 'text-[var(--ink,#2d2010)] font-medium'}`}>
          {recipient?.name || recipient?.address || 'Recipient'}
        </span>
        {sats != null && (
          <span className={`shrink-0 tabular-nums ${status === STATUS.PAID ? 'text-[var(--ink,#2d2010)] font-semibold' : 'text-[var(--muted,#6b5a3e)]'}`}>
            {fmtSats(sats)} sats
          </span>
        )}
        {action}
      </div>
      {/* The wallet's own reason, shown rather than hidden: it is the only
          account of why a leg didn't land, and on a leg with no button
          it is the entire response the row has to give. */}
      {showError && (
        <p className={`mt-1 ml-6 text-[11px] leading-snug ${status === STATUS.UNCERTAIN ? 'text-[var(--warn,#7a5c00)]' : 'text-[var(--danger,#b3261e)]'}`}>
          {leg.error}
        </p>
      )}
    </li>
  )
}

export default function ExternalBoostModal({ user, onClose, onRequestSignIn, onRequestWallet, episode, recipientsBundle, donation = false }) {
  const { visible, requestClose } = useModalTransition(onClose)
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  const donorNpub = user?.npub || ''
  const signedIn = !!donorNpub
  const profile = user?.profile

  const recipients = recipientsBundle?.recipients || []
  const totalWeight = recipientsBundle?.totalWeight || 0
  const hasValue = recipients.length > 0 && totalWeight > 0

  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  // The signed-out identity route: a name, or nothing. Held raw so the field
  // behaves like a field; every read of it goes through `typedName`.
  const [nameInput, setNameInput] = useState('')
  // The note control, unchecked by default. ⚠️ IT SUPPRESSES THE NOTE AND
  // NOTHING ELSE — see D12. `anonymous` is about the BOOSTAGRAM, which is what
  // the show's own app receives, and this is about NOSTR. A donor may
  // reasonably want the show to know who boosted while wanting nothing
  // published, and folding the two together leaves no way to say that. The
  // cost accepted is that the word "privately" does not cover the wire, which
  // is why the label carries its own scope rather than reading "Boost
  // privately" alone.
  const [noNote, setNoNote] = useState(false)
  const [error, setError] = useState('')

  const typedName = sanitizeSenderName(nameInput)

  /**
   * ⚠️ THE ONE QUESTION EVERYTHING ELSE HANGS OFF: is this boost going out
   * under the donor's Nostr account, or not?
   *
   * Signed out it never is, because there is no account. Signed in it is
   * unless they pressed Anon. Everything below reads this rather than testing
   * `signedIn` and `anonymous` separately, because the two cases where it is
   * false behave identically and had drifted apart once already.
   */
  const usingProfile = signedIn && !anonymous

  /**
   * ⚠️ THE TWO WIRE SITES, DERIVED ONCE. `sender_name` and `sender_id` in the
   * boostagram TLV, on the first pass and on a retry. They must not be
   * recomputed at a call site: Boost Me Bitch shipped this promise broken
   * twice, each time because one surface learned a rule another didn't (read
   * the header of its `use-share-picker.ts`).
   *
   * ⚠️ ANONYMOUS DOES NOT MEAN UNPUBLISHED, and it does not mean nameless
   * either. Pressing Anon detaches the Nostr account; Local Bitcoiners still posts
   * the note, so the boost still counts, and the boostagram still carries a
   * name. What suppresses the note is the private checkbox, and only that.
   *
   * ⚠️ A BLANK NAME IS REPLACED, NOT OMITTED. An empty `sender_name` renders as
   * blank in one aggregator and "Unknown" in the next, so a boost with nobody's
   * name on it presents differently everywhere it lands. `DEFAULT_SENDER_NAME`
   * makes it one consistent thing, and it names the SITE rather than a person,
   * so it discloses nothing the note's own author does not. Same call BMB makes.
   */
  const wireSenderName = usingProfile
    ? (profile?.displayName || profile?.name || '')
    : (typedName || DEFAULT_SENDER_NAME)
  // ⚠️ NEVER A PUBKEY WITHOUT THE PROFILE BEHIND IT. `sender_id` is what
  // recipient aggregators resolve to an avatar and a name, so carrying it on an
  // Anon boost would undo the anonymity in the one place the donor cannot see.
  // That is the exact leak BMB shipped twice.
  const wireSenderPubkey = usingProfile ? (user?.pubkey || '') : ''

  /**
   * ⚠️ WHO SIGNS THE NOTE, AND WHETHER THERE IS ONE. Three values, and every
   * surface below reads this rather than re-deriving it:
   *
   *   'donor'  the donor's own npub signs it, on their press
   *   'bot'    Local Bitcoiners signs it through /api/sign-boost, published per D14
   *   'none'   nothing is published, from any key
   *
   * ⚠️ THE INTENT IS DECLARED IN THE FORM; THE FIGURES ARE NOT. That is the
   * correction to the rule this file used to state as "the share is a verb, not
   * a checkbox", and the reasoning under that rule is untouched: a note reports
   * what SETTLED, which is unknown until every leg has run and the donor has
   * finished retrying, and an event cannot be edited. So the numbers are still
   * recomputed at the moment of publishing (`handleShare`). What moved into the
   * form is the *choice*, because it is a choice about the donor rather than
   * about the outcome. Asking a newcomer to press a second button after the
   * payment charges the friction to precisely the visitor this flow exists for.
   *
   * ⚠️ ANON ROUTES TO THE BOT, IT DOES NOT SUPPRESS. Reed's call, 2026-08-21,
   * correcting the shape this shipped with hours earlier. Signing with the
   * donor's own npub would undo the anonymity they chose one field up — that
   * part was always right — but the conclusion drawn from it was that no note
   * should exist, which quietly cost an anonymous booster their place in the
   * index. Anonymity is about attribution; the bot route is what serves it.
   * **`'none'` is reachable only through the checkbox.**
   *
   * Nothing is ever in 'none' by accident, which matters most for a signed-out
   * booster: with no key to sign with, the bot route is the only thing standing
   * between a wallet-only boost and this index holding no record of it at all.
   */
  const noteRoute = noNote ? 'none' : (usingProfile ? 'donor' : 'bot')
  const canShareToFeed = noteRoute === 'donor'
  const [shareState, setShareState] = useState('idle')   // 'idle' | 'signing' | 'shared' | 'error'
  const [shareError, setShareError] = useState('')

  const [phase, setPhase] = useState('form')       // 'form' | 'sending' | 'done'
  const [legs, setLegs] = useState([])             // per-recipient live state (aligned to recipients)
  const [confirmLeave, setConfirmLeave] = useState(false)

  useEffect(() => { lockBodyScroll(); return () => unlockBodyScroll() }, [])

  // Resolve every lnaddress recipient's LNURL endpoint in parallel as soon as
  // the modal mounts, so the orchestrator can skip its own resolve step at pay
  // time. Two round trips per leg used to happen while the booster watched a
  // spinner; this moves them to the seconds spent typing an amount. Same
  // arrangement EpisodeBoostModal has had — the external path was the one that
  // never got it.
  //
  // Only lnaddress legs: a node recipient's `address` is a node pubkey, and a
  // keysend has no LNURL step to prefetch. A failed fetch is stored as null
  // rather than omitted, which is the same instruction to the orchestrator
  // either way (fetch it live) and keeps the two cases from looking different.
  const [lnurlCache, setLnurlCache] = useState({})
  useEffect(() => {
    if (recipients.length === 0) return
    let cancelled = false
    const next = {}
    Promise.all(recipients.map(async (r) => {
      if (r?.type !== 'lnaddress' || !r.address) return
      try { next[r.address] = await fetchLnurlMeta(r.address) }
      catch { next[r.address] = null }
    })).then(() => { if (!cancelled) setLnurlCache(next) })
    return () => { cancelled = true }
    // The bundle's own array, not the `|| []` fallback above — that allocates a
    // fresh array on every render and would re-run this effect each time.
  }, [recipientsBundle?.recipients])

  const progressActive = phase === 'sending'
  useEffect(() => {
    setBoostModalProgressVisible(phase !== 'form')
    return () => setBoostModalProgressVisible(false)
  }, [phase])

  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])

  const guardedClose = () => {
    if (progressActive) setConfirmLeave(true)
    else requestClose()
  }

  const updateLeg = useCallback((index, patch) => {
    if (cancelledRef.current) return
    setLegs((prev) => { const next = prev.slice(); next[index] = { ...next[index], ...patch }; return next })
  }, [])

  // The live tally, recomputed every render off leg state, which is what makes
  // a successful Retry count toward the note. Declared here rather than beside
  // the render so `handleShare` and the summary line read the same numbers;
  // two derivations of "how much actually landed" is how the reported figure
  // drifts from the published one.
  //
  // SKIPPED legs are excluded from the denominator: those were allocated zero
  // sats by the split and never attempted, so counting them as unpaid would
  // report a shortfall that never happened.
  const visibleLegs = phase !== 'form'
    ? recipients.map((r, i) => ({ r, leg: legs[i] })).filter(({ leg }) => leg && leg.status !== STATUS.SKIPPED)
    : []
  const paidCount = legs.filter((l) => l?.status === STATUS.PAID).length
  const activeCount = visibleLegs.length
  const paidSats = legs.reduce((a, l) => a + (l?.status === STATUS.PAID ? (l.sats || 0) : 0), 0)

  /**
   * ⚠️ DECLARED ABOVE ITS FIRST READ, AND THAT IS THE WHOLE POINT OF WHERE IT
   * SITS. `paySeconds` below reads `payTick`, and this `useState` used to come
   * after it — a temporal dead zone that threw `Cannot access 'payTick' before
   * initialization` **during render**.
   *
   * It hid for two days because the read is inside a ternary:
   * `payingLeg?.startedAt ? (… payTick …) : 0`. With no leg paying the branch
   * is never evaluated, so the form, the done screen and every test rendered
   * fine. It threw only once a leg was actually in flight, about a second into
   * a real boost — and a render error with no boundary above it **unmounts the
   * React root**, so the symptom was: the modal vanishes mid-payment, the
   * payment completes anyway (the promise is detached and does not care), no
   * note is ever published because `phase` never reaches 'done', and the page's
   * Boost button is dead until a reload because the host root is gone.
   *
   * `scripts/test-boost-modal-render.mjs` now fails on any binding in this
   * component read before its declaration. There is no linter in this repo, so
   * that scan is the only thing standing between here and a repeat.
   *
   * The ticker itself just forces a re-render once a second while a payment is
   * outstanding, so the pay-stage copy can be computed from the leg's own
   * `startedAt` rather than from a second clock kept in step with it.
   */
  const [payTick, setPayTick] = useState(0)
  useEffect(() => {
    if (phase !== 'sending') return
    const id = setInterval(() => setPayTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [phase])

  // The leg the wallet is currently working on, and how long it has been at
  // it. Legs are paid sequentially (see D9 in boost-login.md), so there is at
  // most one, and its own `startedAt` is the clock — the ticker above only
  // forces the re-render that re-reads it.
  const payingIndex = legs.findIndex((l) => l?.status === WORKING)
  const payingLeg = payingIndex >= 0 ? legs[payingIndex] : null
  const payingName = payingIndex >= 0
    ? (recipients[payingIndex]?.name || recipients[payingIndex]?.address || '')
    : ''
  const paySeconds = payingLeg?.startedAt
    ? Math.floor(((payTick || Date.now()) - payingLeg.startedAt) / 1000)
    : 0
  const payNote = phase === 'sending' ? payStageText(paySeconds, payingName) : null

  /**
   * ⚠️ THE OTHER HALF OF THE DOUBLE-PAY FIX. A leg can settle after the 4.5
   * seconds the payment path is willing to wait inline, and the donor is left
   * looking at a screen that has to say something in the meantime. Rather than
   * guess, keep asking: every unconfirmed lnaddress leg is polled to a
   * 90-second budget and flips itself to Paid if it lands late. Most of these
   * resolve with no decision from the donor at all, which is the point — the
   * bug was a screen that asked them to decide on bad information.
   *
   * Keyed on `phase` only. Depending on `legs` would restart the watcher on
   * every poll result it wrote, so the targets are read through a ref at the
   * moment the run finishes.
   */
  const legsRef = useRef(legs)
  legsRef.current = legs
  const [checking, setChecking] = useState({})
  const stillChecking = Object.values(checking).some(Boolean)

  // Seconds since the current watch began, which is the only input the stage
  // copy needs. Keyed on `stillChecking` rather than on the checking map, so a
  // second leg finishing does not restart the clock on the one still running.
  const [checkSeconds, setCheckSeconds] = useState(0)
  useEffect(() => {
    if (!stillChecking) { setCheckSeconds(0); return }
    const startedAt = Date.now()
    setCheckSeconds(0)
    const id = setInterval(() => {
      setCheckSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [stillChecking])

  /**
   * ⚠️ ONE CELEBRATION PER BOOST, LATCHED. It used to fire the moment the first
   * pass returned and again after every retry that landed, so a boost with a
   * failed leg could burst two or three times for one payment.
   *
   * Keyed on `paidCount` rather than on the pass finishing, so a leg the
   * background watcher resolves late still earns the burst if nothing had
   * landed yet — and the ref means it cannot earn a second one.
   */
  const celebratedRef = useRef(false)
  useEffect(() => {
    if (phase !== 'done' || paidCount === 0 || celebratedRef.current) return
    celebratedRef.current = true
    fireConfetti()
  }, [phase, paidCount])

  useEffect(() => {
    if (phase !== 'done') return
    const targets = recipients
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => canCheckLeg(r, legsRef.current[i]))
    if (targets.length === 0) return
    const ctrl = new AbortController()
    setChecking(Object.fromEntries(targets.map(({ i }) => [i, true])))
    for (const { i } of targets) {
      const leg = legsRef.current[i]
      confirmInvoiceSettled(leg.verifyUrl, leg.paymentHash, {
        attempts: 0, deadlineMs: WATCH_MS, intervalMs: 3000, signal: ctrl.signal,
      }).then((res) => {
        if (ctrl.signal.aborted || cancelledRef.current) return
        if (res === 'settled') updateLeg(i, { status: STATUS.PAID, error: null })
        else updateLeg(i, { error: 'Still unconfirmed. Check your wallet before sending anything — this may already have gone through.' })
        setChecking((prev) => ({ ...prev, [i]: false }))
      }).catch(() => {
        if (ctrl.signal.aborted || cancelledRef.current) return
        setChecking((prev) => ({ ...prev, [i]: false }))
      })
    }
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  /**
   * The note this modal publishes, for whichever subject it is boosting.
   *
   * ⚠️ ONE BUILDER FOR BOTH CALL SITES, and that is the point of it existing.
   * The template is built twice — once by `presignNote` before the first leg,
   * once by `handleShare` at publish time — and the publish step re-checks that
   * the pre-signed note's figures still hold. Two separate construction sites
   * choosing their own builder is how a donation gets pre-signed as a boost and
   * then published as a donation, or the reverse.
   *
   * ⚠️ A DONATION IS NOT A BOOST WITH THE SHOW LEFT BLANK. It carries no NIP-73
   * tags, no boost topic tags and no `amount` tag, because this site's own
   * collector would otherwise index sats paid to Local Bitcoiners as a podcast boost
   * to no show. `buildDonationNoteTemplate` carries the full argument, and
   * `functions/api/sign-boost.js` validates the two families as disjoint
   * shapes, so passing the wrong one here fails at the oracle rather than
   * publishing something wrong.
   */
  function noteTemplate(args) {
    if (donation) {
      const { paidSats, message: msg, senderName } = args
      return buildDonationNoteTemplate({ paidSats, message: msg, senderName })
    }
    return buildExternalNoteTemplate(args)
  }

  /**
   * Publish the kind-1 boost note, by whichever route the form declared.
   *
   * ⚠️ THE FIGURES COME FROM LIVE LEG STATE, NOT FROM THE FORM, and that has
   * not changed. `paidSats` and the leg counts are recomputed on every render,
   * so publishing after a successful Retry reports the retried leg. The bug
   * this closed is worth restating because Phase 2 moved a *different* control
   * into the form: the old pre-flight checkbox fired the note with the TYPED
   * amount the instant the first pass ended, which overstated every partial and
   * could never see a retry. What the form declares now is the intent; the
   * numbers are still read here, at the moment of publishing.
   *
   * Failure is reported rather than swallowed to the console. On the donor
   * route they asked for this explicitly, so a silent no-op would leave them
   * believing they had shared; on the bot route the publish was automatic, so
   * silence would leave them believing it worked. ⚠️ EITHER WAY THE SATS ARE
   * ALREADY GONE, which is why a failure offers another attempt at the NOTE
   * and never anything that resembles unwinding a payment.
   */
  async function handleShare() {
    if (noteRoute === 'none' || shareState === 'signing' || shareState === 'shared') return
    if (paidSats <= 0) return
    setShareState('signing')
    setShareError('')
    try {
      const template = noteTemplate({
        paidSats,
        legsPaid: paidCount,
        legsTotal: activeCount,
        message: message.trim(),
        // ⚠️ BOT ROUTE ONLY, and it is a line of prose rather than any kind of
        // claim (D15). A donor-signed note is already from the donor, so a
        // "From" line on it would be the author naming themselves in the third
        // person; and nothing anywhere may turn this string into a `p` tag or
        // an author field, because nothing can verify that the person named
        // authorised a note signed by a key they do not hold.
        //
        // ⚠️ THE DEFAULT GOES IN TOO, so every bot-signed note carries the same
        // line whether or not anybody typed. Without it an anonymous note is
        // just the bot's own voice, which reads as Local Bitcoiners boosting rather
        // than Local Bitcoiners publishing for somebody — a different claim, and the
        // wrong one. It also keeps the note and the boostagram saying the same
        // string, which is the thing a podcaster can cross-check.
        senderName: noteRoute === 'bot' ? (typedName || DEFAULT_SENDER_NAME) : '',
        showTitle: episode?.showTitle,
        episodeTitle: episode?.episodeTitle,
        podcastGuid: episode?.podcastGuid,
        itemGuid: episode?.itemGuid,
        bmbUrl: episode?.bmbUrl,
      })
      // The only difference between the two routes is where the signature
      // comes from. Both produce a signed event and both publish it from the
      // browser through the same relay set, so a bot-signed boost reaches the
      // same audience a donor-signed one does.
      const signed = noteRoute === 'bot'
        ? await signKindOneWithSite(template)
        : await signKindOneShareWithUser(template)
      await publishSignedKindOne(signed)
      if (cancelledRef.current) return
      setShareState('shared')
    } catch (e) {
      console.warn('[lb] external boost share note failed', e?.message || e)
      if (cancelledRef.current) return
      setShareError(e?.message || 'Couldn\u2019t post the note. Your boost still went through.')
      setShareState('error')
    }
  }

  /** The note signed before the payment ran, or null. `{ event, sats, legs }` —
   *  the two figures ride along so the publish step can re-check that they
   *  still describe what happened. Built by `presignNote`, which carries the
   *  reasoning; declared up here because both the effect below and
   *  `publishPresigned` read it, and a `const` read above its declaration is
   *  the exact shape that took the whole widget down on 2026-08-21. */
  const presignedRef = useRef(null)

  /** Publish a note that was signed before the payment. Same reporting rules as
   *  `handleShare` from here on: it is the same event shape, published through
   *  the same relay set, and a failure is a failure to POST rather than to pay. */
  async function publishPresigned(event) {
    setShareState('signing')
    setShareError('')
    try {
      await publishSignedKindOne(event)
      if (cancelledRef.current) return
      setShareState('shared')
    } catch (e) {
      console.warn('[lb] publishing the pre-signed note failed', e?.message || e)
      if (cancelledRef.current) return
      // ⚠️ Dropped, so the retry button signs a FRESH note rather than
      // re-publishing this one. By the time a donor presses it the leg state
      // may have moved, and a stale pre-signed event cannot reflect that.
      presignedRef.current = null
      setShareError(e?.message || 'Couldn\u2019t post the note. Your boost still went through.')
      setShareState('error')
    }
  }

  /**
   * ⚠️ A CLEAN BOOST PUBLISHES ITS NOTE BY ITSELF, ON BOTH ROUTES. Reed's call,
   * 2026-08-21, correcting the version that auto-published only the bot route:
   * *"shouldn't the opt-in to share be enough?"*
   *
   * It is, and the argument for the exception does not survive contact with the
   * form. The press was kept on the donor path because a signer prompt has to
   * be ASKED for, an approval dialog arriving unannounced after a payment being
   * worse than a button. But the ask now happens in the form, one field above
   * the amount: leaving the private box unchecked IS the request. A second
   * press afterwards asks the same question twice and reads as the first answer
   * not having counted.
   *
   * ⚠️ IT STILL FIRES ONLY WHERE THE PRESS COULD NOT HAVE CHANGED THE ANSWER:
   * every active leg PAID and nothing still being checked. A shortfall or an
   * UNCERTAIN leg is exactly the state in which the donor may still retry and
   * change what the note should say, so those get the button, and the screen
   * says which of the two it is. That is the "reports what settled" rule with
   * the press removed from every case where it was ceremony.
   *
   * The one thing this costs is that a NIP-07 or NIP-46 signer prompt now
   * arrives without a press behind it. It is not unannounced — the donor asked
   * for the note in the form — and the screen names what it is waiting for. A
   * signer that times out lands in `shareState === 'error'`, which offers the
   * press back.
   *
   * `autoSharedRef` is what stops a late-settling leg from firing a second
   * publish. `shareState` latches at 'shared' as well, so one boost publishes
   * at most one note either way.
   */
  const autoSharedRef = useRef(false)
  useEffect(() => {
    if (phase !== 'done' || noteRoute === 'none') return
    if (autoSharedRef.current || shareState !== 'idle') return
    if (stillChecking || paidSats <= 0) return
    if (activeCount === 0 || paidCount !== activeCount) return
    autoSharedRef.current = true
    // ⚠️ THE IDENTITY IS RE-CHECKED HERE, NOT ASSUMED. A pre-signed note claims
    // the full typed amount with no shortfall line, which is true only if every
    // attempted leg paid. `paidCount === activeCount` is already established
    // above; this adds the figure itself, because a leg that paid a different
    // amount than it was allocated would satisfy the count and not the total.
    const pre = presignedRef.current
    if (pre && pre.sats === paidSats && pre.legs === activeCount) {
      publishPresigned(pre.event)
      return
    }
    // It did not hold, or there was nothing pre-signed. `handleShare` signs
    // fresh from live leg state, which is the accurate version by construction.
    presignedRef.current = null
    handleShare()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, noteRoute, stillChecking, paidCount, activeCount, paidSats, shareState])

  /**
   * ⚠️ THE WALLET GATE LIVES HERE NOW, NOT IN FRONT OF THE MODAL (D13). It ran
   * inside `openExternalBoost` until Phase 2, so a visitor who pressed Boost
   * was asked to paste an NWC connection string before seeing what they were
   * boosting or what it would cost. Compose first, pay second.
   *
   * ⚠️ THE RESUME IS THE EFFECT BELOW, NOT A CALLBACK AND NOT A pendingAction.
   * `WalletConnectModal` opens OVER this one (z-[78/79] against z-[70/71]), so
   * this modal stays mounted with its state intact and there is nothing to
   * save or restore; re-entering `openExternalBoost` to resume would mount a
   * second modal over the first. What resumes the boost is this component's
   * own `wallet.onChange` subscription seeing a wallet arrive.
   */
  const payStartedRef = useRef(false)
  const [awaitingWallet, setAwaitingWallet] = useState(false)

  async function handleBoost() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS) { setError(`Minimum boost is ${MIN_SATS} sats.`); return }
    if (sats > MAX_SATS) { setError(`Max ${MAX_SATS.toLocaleString()} sats per boost.`); return }

    if (!wallet.isReady()) {
      // Fire and forget. It either unlocks a remembered wallet (in which case
      // the effect below picks the boost straight back up), opens the connect
      // modal, or reports a stalled extension in a toast. Its promise is
      // deliberately not the resume signal: a second path into `startPay`
      // would be a second way to pay twice.
      setAwaitingWallet(true)
      try { await onRequestWallet?.() } catch {}
      return
    }
    startPay(sats)
  }

  /**
   * ⚠️ THE DONOR'S SIGNATURE IS ASKED FOR AT THE PRESS, NOT AFTER THE PAYMENT.
   * Reed's call, 2026-08-21, from watching it land: *"the prompt to publish the
   * note from the signer was awkwardly late."* It was. Auto-publishing at the
   * end put an approval dialog on screen up to a minute after the donor thought
   * they were done, with nothing on screen having asked for it.
   *
   * ⚠️ AND IT DOES NOT REOPEN THE PHASE 0 BUG, BECAUSE OF ONE IDENTITY.
   * `distributeSats` floors every leg and then hands the remainder back a sat
   * at a time, so **the legs it will attempt sum to exactly the typed amount**
   * (a leg allocated zero is skipped and contributes zero). So a note signed now
   * for the full amount, with no shortfall line, is precisely correct in one
   * case: every attempted leg pays. The publish step re-checks that identity
   * and **discards this note if it does not hold**, falling back to the button,
   * which signs fresh against live leg state.
   *
   * So the rule survives intact: *the note reports what settled.* What changed
   * is that the common case is signed in advance rather than after, and the
   * uncommon case still cannot publish a stale figure.
   *
   * Nothing here is fatal. A declined prompt, a signer timeout, a dismissed
   * extension — all leave `presignedRef` null, the boost proceeds regardless
   * (the payment was never contingent on it) and the done screen offers the
   * press. **A boost must never fail because a note could not be signed.**
   */
  async function presignNote(sats) {
    presignedRef.current = null
    if (noteRoute !== 'donor') return
    const projected = distributeSats(sats, recipients, totalWeight).filter((l) => l.sats > 0).length
    if (projected === 0) return
    try {
      const template = noteTemplate({
        paidSats: sats,
        // Equal on purpose: a pre-signed note is only ever published when
        // nothing fell short, so it must carry no shortfall line.
        legsPaid: projected,
        legsTotal: projected,
        message: message.trim(),
        senderName: '',
        showTitle: episode?.showTitle,
        episodeTitle: episode?.episodeTitle,
        podcastGuid: episode?.podcastGuid,
        itemGuid: episode?.itemGuid,
        bmbUrl: episode?.bmbUrl,
      })
      const signed = await signKindOneShareWithUser(template)
      if (cancelledRef.current) return
      presignedRef.current = { event: signed, sats, legs: projected }
    } catch (e) {
      console.warn('[lb] pre-sign declined or failed; the note falls back to a press', e?.message || e)
    }
  }

  async function startPay(sats) {
    if (payStartedRef.current) return
    payStartedRef.current = true
    setAwaitingWallet(false)

    // ⚠️ BEFORE THE PAYMENT, AND AWAITED. Two prompts back to back is the
    // checkout shape a donor expects; a signer prompt arriving after the sats
    // have gone is the thing being fixed. It cannot fail the boost.
    await presignNote(sats)
    if (cancelledRef.current) return

    // Seed one pending row per recipient so the list renders immediately.
    setLegs(recipients.map(() => ({ status: STATUS.PENDING })))
    setPhase('sending')

    let result
    try {
      result = await payExternalBoost({
        recipients,
        totalWeight,
        totalSats: sats,
        message: message.trim(),
        senderName: wireSenderName,
        senderPubkey: wireSenderPubkey,
        meta: {
          showTitle: episode?.showTitle,
          episodeTitle: episode?.episodeTitle,
          podcastGuid: episode?.podcastGuid,
          itemGuid: episode?.itemGuid,
          url: episode?.bmbUrl,
        },
        // ⚠️ A DONATION SKIPS THE BOOSTBOX DESCRIPTOR. That descriptor exists so
        // a PODCASTER's Helipad can resolve who boosted them and for what; on a
        // donation the recipient is Local Bitcoiners, so there is no third party to
        // inform and the record would be metadata about ourselves, spending the
        // rate budget to say nothing.
        donation,
        lnurlCache,
        onLeg: (i, legState) => updateLeg(i, legState),
      })
    } catch (e) {
      setError(e?.message || 'Boost failed to start')
      setPhase('form')
      payStartedRef.current = false
      return
    }
    if (cancelledRef.current) return
    setPhase('done')
  }

  // The resume. Keyed on the wallet actually being connected rather than on
  // whatever `onRequestWallet` reported, so a connection made in the modal, an
  // at-rest unlock and a wallet connected in another tab all land the same way.
  useEffect(() => {
    if (!awaitingWallet || !walletStatus.connected) return
    if (phase !== 'form' || payStartedRef.current) return
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS || sats > MAX_SATS) { setAwaitingWallet(false); return }
    startPay(sats)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingWallet, walletStatus.connected, phase])

  /**
   * Re-pay a leg. ⚠️ FAILED ONLY — see canRepayLeg. There is deliberately no
   * branch here for an unconfirmed leg: the version of this function that had
   * one decided it was "safe to re-pay" off a LUD-21 `settled: false`, which
   * is not a statement that the payment failed, and a recipient was paid
   * twice as a result.
   */
  async function handleRepay(index) {
    const recipient = recipients[index]
    const leg = legs[index]
    if (!recipient || !leg) return
    if (!canRepayLeg(recipient, leg)) return
    if (shareState === 'shared') return
    if (!wallet.isReady()) { updateLeg(index, { status: STATUS.FAILED, error: 'Wallet not connected' }); return }
    updateLeg(index, { status: STATUS.PAYING, error: null })
    try {
      const res = await payExternalBoost({
        recipients: [recipient],
        totalWeight: recipient.splitWeight || 1,
        totalSats: leg.sats || 0,
        message: message.trim(),
        senderName: wireSenderName,
        senderPubkey: wireSenderPubkey,
        meta: {
          showTitle: episode?.showTitle, episodeTitle: episode?.episodeTitle,
          podcastGuid: episode?.podcastGuid, itemGuid: episode?.itemGuid, url: episode?.bmbUrl,
        },
        donation,
        // A leg that failed at the LNURL step has a null cache entry, so a
        // retry re-fetches it live; one that failed at the payment reuses the
        // metadata it already had. Both are what the retry wants.
        lnurlCache,
        onLeg: (_i, ls) => updateLeg(index, { ...ls, sats: leg.sats }),
      })
    } catch (e) {
      // ⚠️ Never downgrade a leg that already reported in. payExternalBoost
      // throws only on its own pre-flight validation, so today this cannot
      // clobber anything — but `onLeg` writes leg state on the way through, and
      // turning an UNCERTAIN leg into a FAILED one hands it back a re-pay
      // button it must not have.
      const cur = legsRef.current[index]?.status
      if (cur === STATUS.PAID || cur === STATUS.UNCERTAIN) return
      updateLeg(index, { status: STATUS.FAILED, error: e?.message || 'Retry failed' })
    }
  }

  /** Look at an unconfirmed leg again. Pays nothing and can never pay anything;
   *  it re-polls the ORIGINAL invoice's verify URL, so the worst outcome is
   *  learning nothing new. */
  async function handleCheck(index) {
    const recipient = recipients[index]
    const leg = legs[index]
    if (!canCheckLeg(recipient, leg)) return
    if (shareState === 'shared' || checking[index]) return
    setChecking((prev) => ({ ...prev, [index]: true }))
    try {
      const res = await confirmInvoiceSettled(leg.verifyUrl, leg.paymentHash, {
        attempts: 0, deadlineMs: RECHECK_MS, intervalMs: 3000,
      })
      if (cancelledRef.current) return
      if (res === 'settled') updateLeg(index, { status: STATUS.PAID, error: null })
      else updateLeg(index, { error: 'Still unconfirmed. Check your wallet before sending anything — this may already have gone through.' })
    } finally {
      if (!cancelledRef.current) setChecking((prev) => ({ ...prev, [index]: false }))
    }
  }

  // ⚠️ ONE COPY TABLE, THE SAME PATTERN THE FEED RENDERERS USE. The donation
  // and the boost are one flow with one subject swapped, so the wording is a
  // lookup rather than a branch scattered through the markup. Anything that
  // differs beyond these strings is a sign the subjects have really diverged.
  const copy = donation
    ? {
        header: '⚡ Donate to Local Bitcoiners',
        subject: 'Local Bitcoiners',
        subjectNote: 'Every sat goes to the site. There are no other splits.',
        noteHint: 'Posts a note saying you donated to Local Bitcoiners. It carries no podcast tags, so it does not appear in the boost feeds.',
      }
    : {
        header: '⚡ Boost episode',
        subject: episode?.showTitle || '',
        subjectNote: '',
        noteHint: '',
      }
  const headerTitle = copy.header
  const allPaid = phase === 'done' && activeCount > 0 && paidCount === activeCount

  // ⚠️ THE SUMMARY MUST NOT TELL THE DONOR TO RE-SEND A LEG WE CANNOT PROVE
  // UNPAID. It used to say "Retry any that didn't", which on an unconfirmed
  // leg was advice to pay twice. So the three states are named separately: a
  // leg still being checked is not a shortfall yet, a re-payable leg is one
  // the wallet declined, and an unconfirmed one points at the wallet.
  const repayableCount = visibleLegs.filter(({ r, leg }) => canRepayLeg(r, leg)).length
  const unconfirmedCount = visibleLegs.filter(({ leg }) => leg?.status === STATUS.UNCERTAIN).length
  let tail
  // ⚠️ Calm while the watcher runs. This line is the loudest thing on the
  // screen, and a leg that is merely slow is not a shortfall yet. See
  // CHECK_STAGES.
  const checkingCount = Object.values(checking).filter(Boolean).length
  if (stillChecking) tail = checkingCount === 1 ? 'Still confirming the last one.' : 'Still confirming the rest.'
  else if (repayableCount > 0) tail = 'Retry any that were declined.'
  else if (unconfirmedCount > 0) tail = 'The rest are unconfirmed — check your wallet rather than re-sending.'
  else tail = 'Check your wallet for the rest.'
  const summaryLine = paidCount > 0
    ? `${paidCount} of ${activeCount} legs sent. ${tail}`
    : `Nothing confirmed yet. ${tail}`

  return (
    <>
      <div className={`fixed inset-0 bg-[var(--scrim,rgba(45,32,16,0.62))] z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-3 sm:p-4 overflow-hidden" role="dialog" aria-label={headerTitle}>
        <div className={`relative bg-[var(--modal-bg,#fbf6ea)] border border-[var(--modal-line,#d4c4a0)] rounded-lg w-full max-w-lg max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28),0_0_0_1px_rgba(11,58,82,0.06)] transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--modal-line,#d4c4a0)] shrink-0">
            <h2 className="text-base font-semibold text-[var(--ink,#2d2010)] font-[family-name:var(--font-display,'Playfair_Display',Georgia,serif)]">{headerTitle}</h2>
            <button onClick={guardedClose} className="text-[var(--muted,#6b5a3e)] hover:text-[var(--ink,#2d2010)] transition-colors text-lg leading-none" aria-label="Close">✕</button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
            {copy.subject && (
              <div className="text-xs text-[var(--muted,#6b5a3e)] leading-snug">
                <span className="font-semibold text-[var(--ink,#2d2010)]">{copy.subject}</span>
                {!donation && episode?.episodeTitle && <span className="block italic mt-0.5">"{episode.episodeTitle}"</span>}
                {copy.subjectNote && <span className="block mt-0.5">{copy.subjectNote}</span>}
              </div>
            )}

            {!hasValue && (
              <div className="space-y-3 text-center py-2">
                <p className="text-sm text-[var(--muted,#6b5a3e)]">{donation ? "Local Bitcoiners' own Lightning address isn't configured, so there's nothing to donate to." : "This episode doesn't have a Podcasting 2.0 value block, so there's no split to boost to."}</p>
                <button onClick={requestClose} className="px-4 py-2 rounded-lg bg-[var(--modal-inset,#f1e8d2)] hover:bg-[var(--border,#d4c4a0)] text-sm text-[var(--ink,#2d2010)] transition-colors">Close</button>
              </div>
            )}

            {hasValue && phase === 'form' && (
              <>
                <div>
                  <label htmlFor="ob-boost-amount" className="block text-xs font-medium text-[var(--muted,#6b5a3e)] mb-1.5">Amount (sats)</label>
                  {/* The presets come first because they are the fast path and
                      the field is the fallback, not the other way round. A
                      pressed preset stays lit, so the row doubles as the
                      current-value readout for the common case. */}
                  <div className="flex gap-1.5 mb-2">
                    {PRESETS.map((n) => {
                      const active = amount === String(n)
                      return (
                        <button key={n} type="button" onClick={() => { setAmount(String(n)); setError('') }}
                          aria-pressed={active}
                          className={`flex-1 py-2 rounded-lg border text-xs font-semibold tabular-nums transition-colors ${active
                            /* ⚠️ --brand-dd, NOT --brand, AND THIS IS THE SECOND
                               TIME. White on --brand is a contrast ratio of
                               2.50:1 — Reed reported the picked amount as
                               "basically invisible", the same words the wallet
                               menu's log-in button drew in `b7cba03`, which was
                               white on the same fill. --brand-dd takes it to
                               5.45:1, and a DARKER fill also reads as pressed
                               where a lighter one reads as disabled. Ink on
                               --brand measures higher still (6.18:1) and was not
                               used: the unpicked state is already dark-on-tint,
                               so it would say "more of the same" rather than
                               "this one". Any new filled control in this widget
                               is the same trap. */
                            ? 'bg-[var(--brand-dd,#a85500)] border-[var(--brand-dd,#a85500)] text-white shadow-[0_1px_0_rgba(11,58,82,0.10)]'
                            /* ⚠️ Tinted, not white. Unset they were a white
                               button on a near-white panel with a hairline
                               border, which is the same thing as no button.
                               The tint is what makes the row read as four
                               choices before anything is pressed. */
                            /* The hover carried the identical fault: it swapped
                               to white on --brand, so the label thinned out at
                               the moment the pointer was on it. */
                            : 'bg-[var(--brand-tint,rgba(247,147,26,0.14))] border-[rgba(0,175,240,0.45)] text-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-dd,#a85500)] hover:border-[var(--brand-dd,#a85500)] hover:text-white'}`}>
                          {n.toLocaleString()}
                        </button>
                      )
                    })}
                  </div>
                  <input id="ob-boost-amount" type="number" inputMode="numeric" min={MIN_SATS} max={MAX_SATS}
                    value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-[var(--modal-field,#fffdf7)] border border-[var(--modal-line,#d4c4a0)] rounded-lg px-3 py-2.5 text-sm text-[var(--ink,#2d2010)] focus:outline-none focus:border-[var(--brand,#f7931a)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(247,147,26,0.35))]"
                    placeholder="Or type any amount" />
                </div>

                {signedIn && (
                <div>
                  <label className="block text-xs text-[var(--muted,#6b5a3e)] mb-1.5">Boost as</label>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => setAnonymous(false)} aria-pressed={!anonymous}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border transition-colors ${!anonymous ? 'bg-[var(--brand-tint,rgba(247,147,26,0.14))] border-[var(--brand,#f7931a)] text-[var(--brand-dd,#a85500)] font-semibold' : 'bg-[var(--modal-field,#fffdf7)] border-[var(--modal-line,#d4c4a0)] text-[var(--muted,#6b5a3e)] hover:text-[var(--ink,#2d2010)] hover:border-[var(--brand,#f7931a)]'}`}>
                      {profile?.image && isSafeUrl(profile.image) && <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={(e) => { e.target.style.display = 'none' }} />}
                      <span className="truncate max-w-[140px]">{profile?.displayName || profile?.name || 'Your npub'}</span>
                    </button>
                    <button onClick={() => setAnonymous(true)} aria-pressed={anonymous}
                      className={`flex-1 py-3 px-3 rounded-md border transition-colors ${anonymous ? 'bg-[var(--brand-tint,rgba(247,147,26,0.14))] border-[var(--brand,#f7931a)] text-[var(--brand-dd,#a85500)] font-semibold' : 'bg-[var(--modal-field,#fffdf7)] border-[var(--modal-line,#d4c4a0)] text-[var(--muted,#6b5a3e)] hover:text-[var(--ink,#2d2010)] hover:border-[var(--brand,#f7931a)]'}`}>Anon</button>
                  </div>
                </div>
                )}

                {/* ⚠️ THE NAME FIELD BELONGS TO "NOT UNDER A NOSTR ACCOUNT",
                    NOT TO "SIGNED OUT". A signed-in donor who presses Anon is
                    in exactly the same position as a signed-out one: their
                    account is detached from the boost, and a typed name is the
                    only attribution left. Rendering it only when signed out
                    would have made Anon mean "no name, ever", which is a
                    narrower thing than the button says.

                    ⚠️ AND IT IS EXCLUSIVE WITH THE PROFILE, which is why it is
                    absent rather than disabled while the profile is in use: a
                    typed name beside a signed-in identity would be a second
                    identity claim on one note.

                    Vocabulary is deliberate. "Your name" and "Log in", never
                    anything about keys — this may be someone's first contact
                    with Nostr and they need not know that is what it is. */}
                {!usingProfile && (
                  <div>
                    <label htmlFor="ob-boost-from" className="block text-xs font-medium text-[var(--muted,#6b5a3e)] mb-1.5">From</label>
                    {/* ⚠️ ONE LINE, BECAUSE THEY ARE ONE CHOICE. A full-width
                        divider above the button read as a section break, which
                        made the two halves look like unrelated things — the
                        opposite of what it was for. Side by side with a small
                        "or", the name field and the button are visibly two
                        ways of answering the same question. */}
                    <div className="flex items-stretch gap-2.5">
                    {/* ⚠️ EVERY ATTRIBUTE HERE IS A PASSWORD MANAGER OPT-OUT,
                        AND `autoComplete="off"` ALONE IS NOT ONE. LastPass
                        ignores it outright and was offering to fill this field;
                        1Password and Dashlane read their own attributes. The
                        `id` is also deliberately not `name` or `user`, since
                        several managers match on the token in the id before
                        they look at anything else. */}
                    <input
                      id="ob-boost-from"
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value.slice(0, MAX_SENDER_NAME_CHARS))}
                      maxLength={MAX_SENDER_NAME_CHARS}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      data-lpignore="true"
                      data-1p-ignore=""
                      data-bwignore="true"
                      data-form-type="other"
                      className="flex-1 min-w-0 bg-[var(--modal-field,#fffdf7)] border border-[var(--modal-line,#d4c4a0)] rounded-lg px-3 py-2.5 text-sm text-[var(--ink,#2d2010)] focus:outline-none focus:border-[var(--brand,#f7931a)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(247,147,26,0.35))]"
                      placeholder={DEFAULT_SENDER_NAME} />
                      {!signedIn && onRequestSignIn && (
                        <>
                          <span className="self-center text-[10px] uppercase tracking-wider text-[var(--muted,#6b5a3e)] shrink-0" aria-hidden="true">or</span>
                          <LoginButton variant="checkout" onClick={onRequestSignIn} className="shrink-0" />
                        </>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-[var(--muted,#6b5a3e)] leading-snug">
                      Left blank, boosts are sent as “{DEFAULT_SENDER_NAME}”.
                    </p>

                  </div>
                )}

                <div>
                  <label className="block text-xs text-[var(--muted,#6b5a3e)] mb-1.5">Message (optional)</label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS))} rows={3} maxLength={MAX_MESSAGE_CHARS}
                    className="w-full bg-[var(--modal-field,#fffdf7)] border border-[var(--modal-line,#d4c4a0)] rounded-lg px-3 py-2 text-sm text-[var(--ink,#2d2010)] focus:outline-none focus:border-[var(--brand,#f7931a)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(247,147,26,0.35))] resize-none leading-relaxed"
                    placeholder="Say something to the show (rides along with the boost)" />
                  <p className="mt-1 text-[10px] text-[var(--muted,#6b5a3e)] text-right">{message.length}/{MAX_MESSAGE_CHARS}</p>
                </div>

                {/* ⚠️ THE LABEL CARRIES ITS OWN SCOPE, and a bare "Boost
                    privately" is not allowed to replace it (D12). This
                    suppresses the NOTE. The sats and the message still cross
                    Lightning to the show's own app, which is the half the word
                    "privately" does not cover, so the parenthesis is the whole
                    point of the string rather than decoration on it.

                    ⚠️ IT IS NEVER IMPLIED BY ANON. Anonymous is about whose
                    name is on the boost; private is about whether a note
                    exists. This is the only control that reaches 'none', which
                    is what lets an anonymous booster still count. */}
                <label className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${noNote ? 'border-[var(--modal-line,#d4c4a0)] bg-[var(--modal-inset,#f1e8d2)]' : 'border-[var(--modal-line,#d4c4a0)] bg-[var(--modal-field,#fffdf7)] hover:border-[var(--brand,#f7931a)]'}`}>
                  <input
                    type="checkbox"
                    checked={noNote}
                    onChange={(e) => setNoNote(e.target.checked)}
                    className="mt-0.5 w-3.5 h-3.5 shrink-0 accent-[var(--brand,#f7931a)]" />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--ink,#2d2010)] leading-snug">Private Boost</span>
                    {/* One line, and no explanation of the unticked case.
                        The default IS the unticked case, so describing it here
                        was explaining the absence of a choice. */}
                    <span className="block text-[10px] text-[var(--muted,#6b5a3e)] leading-snug mt-0.5">Do not share to nostr.</span>
                  </span>
                </label>

                {error && <p className="text-xs text-[var(--danger,#b3261e)]">{error}</p>}

                <button onClick={handleBoost}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-ddd,#8a4500)] text-sm font-medium text-white transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/></svg>
                  Boost episode
                </button>
                {/* Said before the press rather than only after it, because
                    the wallet gate now sits behind this button: a reader who
                    has none should know one more step is coming rather than
                    meeting a second modal unannounced. The awaiting line stays
                    until the wallet lands, and pressing Boost again re-opens
                    the connect modal, so a dismissed one is never a dead end.

                    ⚠️ REMEMBERED IS NOT DISCONNECTED, and this line said it was.
                    `connected` means a live client; a saved NWC blob or an
                    enabled extension reports `remembered` and engages on the
                    first press. The old gate ran that unlock BEFORE the modal
                    mounted, so the distinction never surfaced here; now the
                    modal opens first, and a returning user with a wallet — with
                    the identity dot showing green — was being told they had
                    none. They are one press from paying, so the honest thing is
                    to say nothing at all. */}
                {!walletStatus.connected && (awaitingWallet || !walletStatus.remembered) && (
                  <p className="text-[10px] text-[var(--muted,#6b5a3e)] leading-snug text-center">
                    {awaitingWallet
                      ? 'Waiting for a wallet. Connect one and this boost sends itself.'
                      : 'No wallet connected yet. We\u2019ll ask for one when you press Boost.'}
                  </p>
                )}
              </>
            )}

            {hasValue && phase !== 'form' && (
              <div className="flex flex-col gap-3 min-h-[280px]">
                {phase === 'sending' && (
                  <div className="rounded-lg bg-[var(--brand-tint,rgba(247,147,26,0.14))] border border-[var(--brand,#f7931a)] px-3 py-2.5">
                    <p className="text-sm font-semibold text-[var(--brand-dd,#a85500)]">Sending your boost</p>
                    <p className="text-[11px] text-[var(--muted,#6b5a3e)] mt-0.5">Keep this window open.</p>
                  </div>
                )}
                {/* Silent on a normal leg; see PAY_STAGES. It sits under the
                    headline rather than on the row, because the row already
                    carries the spinner that says WHICH leg, and one moving
                    line beats the same sentence repeated per row. */}
                {payNote && (
                  <p className="text-[11px] text-[var(--muted,#6b5a3e)] leading-snug">{payNote}</p>
                )}
                {allPaid && <p className="text-base font-semibold text-[var(--ok,#2f7a3a)]">⚡ Boost delivered!</p>}
                {phase === 'done' && !allPaid && (
                  <p className={`text-sm font-semibold ${stillChecking ? 'text-[var(--brand-d,#d97b0e)]' : 'text-[var(--warn,#7a5c00)]'}`}>
                    {summaryLine}
                  </p>
                )}
                {/* ⚠️ THE LIST IS A CARD, NOT LOOSE TEXT. Four names and four
                    figures floating on the panel with invisible rules between
                    them read as an unfinished screen rather than as a payment
                    running — and this is the surface a donor watches for up to
                    ninety seconds while their sats move. A filled, bordered,
                    rounded container is what says "these four things belong
                    together and something is happening to them". */}
                <ul className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-[var(--modal-line,#d4c4a0)] bg-[var(--modal-field,#fffdf7)] px-3 divide-y divide-[var(--modal-line,#d4c4a0)]">
                  {visibleLegs.map(({ r, leg }) => {
                    const realIndex = recipients.indexOf(r)
                    return <LegRow key={`${r.address}-${realIndex}`} recipient={r} leg={leg}
                      onRepay={phase === 'done' ? () => handleRepay(realIndex) : null}
                      onCheck={phase === 'done' ? () => handleCheck(realIndex) : null}
                      checking={!!checking[realIndex]}
                      locked={shareState === 'shared'} />
                  })}
                </ul>
                {/* The share control. Withheld until something actually paid,
                    because a note about a boost that didn't land is worse than
                    no note. Withheld entirely on an anonymous boost — see the
                    canShareToFeed note above. */}
                {/* ⚠️ NOT OFFERED WHILE A LEG IS STILL BEING CHECKED. The
                    note is a final statement about the boost, and a leg that
                    settles thirty seconds from now would make it wrong with no
                    way to correct it. */}
                {/* The one line that changes. Rendered for every donor, not
                    only one who can share: an anonymous booster is watching
                    the same spinner and is owed the same account of it. */}
                {phase === 'done' && stillChecking && (
                  <p className="text-[11px] text-[var(--muted,#6b5a3e)] leading-snug">
                    {checkStageText(checkSeconds)}
                    {noteRoute !== 'none' && ' The Nostr note waits for this, so it reports what actually landed.'}
                  </p>
                )}
                {phase === 'done' && noteRoute !== 'none' && paidSats > 0 && !stillChecking && (
                  <div className="rounded-md border border-[var(--modal-line,#d4c4a0)] bg-[var(--modal-field,#fffdf7)] p-3 space-y-2">
                    {shareState === 'shared' ? (
                      <p className="text-xs text-[var(--ok,#2f7a3a)] leading-snug">
                        {noteRoute === 'bot'
                          ? `\u2713 Posted to Nostr by Local Bitcoiners${paidCount < activeCount ? ` (${fmtSats(paidSats)} sats, ${paidCount} of ${activeCount} splits)` : ''}.`
                          : `\u2713 Posted to your feed${paidCount < activeCount ? ` (${fmtSats(paidSats)} sats, ${paidCount} of ${activeCount} splits)` : ''}.`}
                        {noteRoute === 'bot' && (
                          <span className="block text-[10px] text-[var(--muted,#6b5a3e)] mt-1">
                            Your boost is on Nostr, where OnlyBoosts and this site's feeds can find it.
                            {signedIn
                              ? ' It went out under the Local Bitcoiners show account, so your own account is not on it.'
                              : ' It went out under the Local Bitcoiners show account, since this browser has none of its own.'}
                          </span>
                        )}
                      </p>
                    ) : shareState === 'signing' ? (
                      /* ⚠️ THE AUTO-PUBLISH WINDOW, AND ON THE DONOR ROUTE IT
                         CARRIES AN INSTRUCTION RATHER THAN A STATUS. Nothing
                         was pressed, so a signer prompt is about to appear with
                         no obvious cause; a donor who does not know to go and
                         approve it will simply watch this time out. The bot
                         route has nothing to approve and says so. */
                      <p className="text-xs text-[var(--ink,#2d2010)] leading-snug">
                        {noteRoute === 'bot'
                          ? 'Posting your boost to Nostr…'
                          : 'Approve this in your signer to post it to Nostr…'}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-[var(--ink,#2d2010)] leading-snug">
                          {shareState === 'error'
                            ? 'The note didn’t post'
                            : (donation ? 'Post this donation to Nostr?' : 'Post this boost to Nostr?')}
                          <span className="block text-[10px] text-[var(--muted,#6b5a3e)] mt-1">
                            {/* ⚠️ A DONATION'S NOTE MAKES THE OPPOSITE PROMISE
                                TO A BOOST'S, so it cannot share the boost copy.
                                A boost note is what puts a boost in the feeds
                                and the totals; a donation note deliberately
                                carries no podcast tags and so appears in
                                neither. Telling a donor otherwise would be
                                selling them a place in an index they will then
                                go and fail to find themselves in. */}
                            {donation
                              ? `${copy.noteHint}${noteRoute === 'bot' ? ` It posts under the Local Bitcoiners account${signedIn ? ', not yours' : ''}.` : ''}`
                              : noteRoute === 'bot'
                                ? `Boost indexes like OnlyBoosts count boosts they can find on Nostr, so this is what puts yours in the feeds and the totals. It posts under the Local Bitcoiners show account${signedIn ? ', not yours' : ''}.`
                                : 'Posts a note from your own account, tagged to this episode. Boost indexes like OnlyBoosts count boosts they can find on Nostr, so this is what puts yours in the feeds and the totals.'}
                          </span>
                        </p>
                        {/* ⚠️ WHY IT IS ASKING AT ALL, ON EITHER ROUTE. A clean
                            boost publishes itself, so reaching this branch means
                            a leg fell short or went unconfirmed — exactly the
                            state in which a retry would change what the note
                            should say. Saying so is what makes the button read
                            as a decision rather than a step appearing at
                            random, which is the whole reason the press was
                            removed from the clean case. */}
                        {shareState !== 'error' && (
                          <p className="text-[10px] text-[var(--warn,#7a5c00)] leading-snug">
                            Waiting on you because not every split landed. Retry what you can first;
                            the note reports whatever has settled when you press.
                          </p>
                        )}
                        {/* Naming the figure the note will carry, before it is
                            signed. On a partial the number is not the one the
                            donor typed, and finding that out by reading their
                            own published note is the wrong order. */}
                        <p className="text-[10px] text-[var(--muted,#6b5a3e)] leading-snug">
                          The note will say <span className="tabular-nums text-[var(--muted,#6b5a3e)]">{fmtSats(paidSats)} sats</span>
                          {paidCount < activeCount && <> and <span className="text-[var(--muted,#6b5a3e)]">{paidCount} of {activeCount} splits paid</span></>}
                          {noteRoute === 'bot' && <>, from <span className="text-[var(--muted,#6b5a3e)]">{typedName || DEFAULT_SENDER_NAME}</span></>}.
                        </p>
                        {/* ⚠️ A FAILED SIGN IS NOT A FAILED BOOST, and the copy
                            has to say so or a donor reads it as their sats
                            being lost. The sats are gone either way, which is
                            why the offer is another attempt at the note rather
                            than anything that looks like unwinding a payment. */}
                        {shareState === 'error' && shareError && (
                          <p className="text-[11px] text-[var(--danger,#b3261e)] leading-snug">{shareError}</p>
                        )}
                        <button onClick={handleShare} disabled={shareState === 'signing'}
                          className="w-full py-2 rounded-lg bg-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-ddd,#8a4500)] disabled:bg-[var(--modal-inset,#f1e8d2)] disabled:text-[var(--muted,#6b5a3e)] text-xs font-medium text-white transition-colors">
                          {shareState === 'error' ? 'Try posting again' : 'Post to Nostr'}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {/* ⚠️ SILENCE IS WHAT A FAILURE LOOKS LIKE, so the suppressed
                    case says out loud that nothing was posted and that it was
                    the donor's own choice. Without it the screen a private
                    boost ends on is identical to the screen a broken one would
                    end on. */}
                {phase === 'done' && noteRoute === 'none' && paidSats > 0 && !stillChecking && (
                  <p className="text-[11px] text-[var(--muted,#6b5a3e)] leading-snug">
                    Nothing was posted to Nostr, as you asked. Your sats and your message reached
                    the show, and this boost stays out of the boost feeds and totals.
                  </p>
                )}
                {phase === 'done' && (
                  <button onClick={requestClose} className="mt-1 w-full py-2.5 rounded-lg bg-[var(--modal-inset,#f1e8d2)] hover:bg-[var(--border,#d4c4a0)] text-sm text-[var(--ink,#2d2010)] transition-colors">Done</button>
                )}
              </div>
            )}
          </div>

          {confirmLeave && progressActive && (
            <ConfirmLeaveOverlay paid={paidCount} total={activeCount || recipients.length} onStay={() => setConfirmLeave(false)} onLeave={requestClose} />
          )}
        </div>
      </div>
    </>
  )
}
