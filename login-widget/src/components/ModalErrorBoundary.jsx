/**
 * A boundary around one modal, so a render error in it cannot take the page
 * down with it.
 *
 * ⚠️ WITHOUT ONE, A RENDER ERROR UNMOUNTS THE WHOLE `createRoot` IT LIVES IN,
 * AND THE SYMPTOMS DO NOT LOOK LIKE A CRASH. Observed on a real boost,
 * 2026-08-21: `ExternalBoostModal` read a `useState` binding declared thirty
 * lines below it, inside a ternary branch that is only evaluated once a leg is
 * actually paying. About a second into the payment it threw during render, and
 * what the donor saw was:
 *
 *   - the modal vanishing mid-payment, with no message;
 *   - the payment completing anyway, because `payExternalBoost`'s promise is
 *     detached and does not care that its component is gone;
 *   - no Nostr note, because `phase` never reached 'done' and the publish
 *     lives there;
 *   - the page's Boost button dead until a reload, because the host root that
 *     renders the modal no longer existed to answer the next open.
 *
 * Four unrelated-looking faults, one missing line order, and nothing anywhere
 * saying "an error was thrown". **That is what this exists to prevent.** The
 * underlying bug is fixed and `scripts/test-boost-modal-render.mjs` guards its
 * shape; this guards the *class*, which is the part that will happen again.
 *
 * ⚠️ IT IS CONTAINMENT, NOT RECOVERY, AND THE COPY MUST NOT PRETEND OTHERWISE.
 * The component's state is gone, so if a payment was in flight this cannot say
 * what happened to it — and on a money path "it failed" is the one thing that
 * must never be guessed (see `confirmInvoiceSettled`). So the message sends the
 * reader to their wallet and explicitly tells them not to re-send, which is the
 * same rule the UNCERTAIN leg state follows for the same reason.
 *
 * Errors are re-logged rather than swallowed: `componentDidCatch` stops React
 * unmounting the root, and it also stops the error reaching the console on its
 * own.
 */
import { Component } from 'react'

export default class ModalErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('[lb] modal render error', this.props.label || '', error, info?.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <>
        <div className="fixed inset-0 bg-[var(--scrim,rgba(11,58,82,0.55))] z-[70]" aria-hidden="true" />
        <div className="fixed inset-0 z-[71] flex items-center justify-center p-3" role="dialog" aria-label="Something went wrong">
          <div className="bg-[var(--modal-bg,#f4fafd)] border border-[var(--modal-line,#b9d4e6)] rounded-lg w-full max-w-sm p-5 space-y-3 shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28)]">
            <h2 className="text-base font-semibold text-[var(--ink,#0f2733)] font-[family-name:var(--font-display,'Playfair_Display',Georgia,serif)]">Something went wrong on this screen</h2>
            {/* ⚠️ Never "your boost failed". This boundary cannot know: the
                component's state died with it, and the payment may well have
                gone through. Pointing at the wallet is the only honest
                instruction, and "don't re-send" is the same double-pay guard
                the UNCERTAIN leg state carries. */}
            <p className="text-xs text-[var(--muted,#5a7488)] leading-relaxed">
              If you had already pressed Boost, check your wallet before sending anything
              again. The payment may have gone through even though this screen didn’t
              finish.
            </p>
            <button
              onClick={() => this.props.onClose?.()}
              className="w-full py-2.5 rounded-lg bg-[var(--modal-inset,#e6f1f9)] hover:bg-[var(--border,#cfe2ee)] text-sm text-[var(--ink,#0f2733)] transition-colors">
              Close
            </button>
          </div>
        </div>
      </>
    )
  }
}
