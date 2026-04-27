import { useState, useEffect } from 'react'

export function useIsMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return mobile
}
