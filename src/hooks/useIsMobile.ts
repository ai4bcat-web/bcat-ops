import { useEffect, useState } from 'react'

/** Mobile breakpoint — keep in sync with the `@media (max-width: 768px)` rules in index.css. */
export const MOBILE_MAX_WIDTH = 768

/**
 * True when the viewport is at or below the mobile breakpoint. Lets inline-styled
 * components branch their layout (the app uses inline styles, which can't use media
 * queries directly).
 */
export function useIsMobile(maxWidth: number = MOBILE_MAX_WIDTH): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return isMobile
}
