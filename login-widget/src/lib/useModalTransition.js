import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Coordinates enter + exit transitions for a modal whose lifetime is
 * controlled by a parent (which mounts/unmounts based on its own state).
 *
 * Pattern:
 *   const { visible, requestClose } = useModalTransition(onClose)
 *   <div className={visible ? 'opacity-100' : 'opacity-0'}>
 *
 * Returned:
 *   visible       — false on first paint, flips to true on next frame
 *                   so the enter transition runs from initial state.
 *                   Flips back to false on requestClose so the exit
 *                   transition runs before unmount.
 *   requestClose  — call instead of onClose. Triggers exit, then fires
 *                   the real onClose after EXIT_DURATION_MS.
 *   closing       — true between requestClose and unmount; useful for
 *                   disabling click handlers mid-exit.
 *
 * The duration constant must match the CSS transition duration on the
 * elements that use `visible`. Bumping one without the other causes a
 * pop or a stutter.
 */

export const ENTER_DURATION_MS = 180
export const EXIT_DURATION_MS = 180

export function useModalTransition(onClose) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef(null)

  // Flip to visible on the next frame so the initial render paints
  // with the "from" state (opacity-0, translate-y-2). Without the rAF
  // hop the browser can collapse the two states into one paint and
  // skip the transition.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => {
      cancelAnimationFrame(id)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const requestClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setVisible(false)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      onClose?.()
    }, EXIT_DURATION_MS)
  }, [closing, onClose])

  return { visible, closing, requestClose }
}
