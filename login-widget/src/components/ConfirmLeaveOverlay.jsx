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
    <div className="absolute inset-0 z-10 rounded-lg bg-[var(--scrim,rgba(45,32,16,0.62))] backdrop-blur-sm flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-xs">
        <p className="text-sm font-semibold text-[var(--brand-d,#d97b0e)]">Payment still processing</p>
        <p className="text-xs text-[var(--muted,#6b5a3e)] leading-relaxed">
          {paid} of {total} recipients paid so far. If you leave now, the
          remaining payments may not finish.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onStay}
            className="flex-1 py-2.5 rounded-lg bg-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-ddd,#8a4500)] text-sm font-medium text-white transition-colors"
          >
            Keep waiting
          </button>
          <button
            onClick={onLeave}
            className="flex-1 py-2.5 rounded-lg border border-[var(--modal-line,#d4c4a0)] text-sm text-[var(--ink,#2d2010)] hover:bg-[var(--modal-inset,#f1e8d2)] transition-colors"
          >
            Leave anyway
          </button>
        </div>
      </div>
    </div>
  )
}
