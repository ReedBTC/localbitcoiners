/**
 * "Payment still processing — leave anyway?" overlay.
 *
 * Shown over a boost modal when the user hits the ✕ while legs are still
 * in flight. Rather than hard-blocking the close, we make them confirm:
 * the boost survives a close (the background queue keeps paying) but the
 * extra step stops the accidental "I thought it was done" exit that loses
 * the tail end of a big multi-leg boost.
 *
 * Rendered inside the modal panel (which is `relative`), so it covers the
 * form/progress body without escaping the modal frame.
 */
export default function ConfirmLeaveOverlay({ paid = 0, total = 0, onStay, onLeave }) {
  return (
    <div className="absolute inset-0 z-10 rounded-lg bg-[var(--scrim,rgba(11,58,82,0.55))] backdrop-blur-sm flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-xs">
        <p className="text-sm font-semibold text-[var(--brand-d,#068ace)]">Payment still processing</p>
        <p className="text-xs text-[var(--muted,#5a7488)] leading-relaxed">
          {paid} of {total} recipients paid so far. If you leave now, the
          remaining payments may not finish.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onStay}
            className="flex-1 py-2.5 rounded-lg bg-[var(--brand-dd,#0a6fa8)] hover:bg-[var(--brand-ddd,#095e90)] text-sm font-medium text-white transition-colors"
          >
            Keep waiting
          </button>
          <button
            onClick={onLeave}
            className="flex-1 py-2.5 rounded-lg border border-[var(--modal-line,#b9d4e6)] text-sm text-[var(--ink,#0f2733)] hover:bg-[var(--modal-inset,#e6f1f9)] transition-colors"
          >
            Leave anyway
          </button>
        </div>
      </div>
    </div>
  )
}
