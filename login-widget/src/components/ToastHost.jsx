import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { onToastChange, getToasts, dismissToast } from '../lib/toast.js'

/**
 * Renders the live toast queue at the bottom-right of the viewport.
 *
 * Mounted once by index.jsx. Stays out of the way otherwise — when
 * the toast list is empty, this returns null and adds zero DOM weight.
 *
 * Each toast is dismissable via its X button; auto-dismisses on its
 * own timer in lib/toast.js.
 */
export default function ToastHost() {
  const [list, setList] = useState(() => getToasts())
  useEffect(() => onToastChange(setList), [])

  if (list.length === 0) return null

  return createPortal(
    <div className="lb-w"><div
      className="fixed z-[95] bottom-4 right-4 left-4 sm:left-auto sm:max-w-sm flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {list.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28),0_0_0_1px_rgba(11,58,82,0.06)] px-4 py-3 flex items-start gap-3 text-sm text-[var(--ink,#0f2733)] ${
            t.kind === 'error'
              ? 'bg-[var(--modal-bg,#f4fafd)] border border-[var(--danger,#b3261e)]'
              : t.kind === 'success'
              ? 'bg-[var(--modal-bg,#f4fafd)] border border-[var(--ok,#0b7a4b)]'
              : 'bg-[var(--modal-bg,#f4fafd)] border border-[var(--modal-line,#b9d4e6)]'
          }`}
        >
          <span className="flex-1 leading-snug">{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="text-[var(--muted,#5a7488)] hover:text-[var(--ink,#0f2733)] transition-colors text-base leading-none flex-shrink-0"
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div></div>,
    document.body,
  )
}
