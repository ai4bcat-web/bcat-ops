import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `true` once the element behind the returned ref has scrolled within `rootMargin` of the
 * viewport (sticky: it never flips back). Content that is below the fold or rarely opened
 * (PERF R6) gates its fetch/compute on this instead of running on mount. Without
 * IntersectionObserver (jsdom, very old browsers) it is visible immediately, so nothing is
 * ever stuck unloaded.
 */
export function useOnVisible<T extends Element = HTMLDivElement>(rootMargin = '0px') {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const nodeRef = useRef<T | null>(null)
  const ref = useCallback((node: T | null) => { nodeRef.current = node }, [])

  useEffect(() => {
    const node = nodeRef.current
    if (visible || !node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible, rootMargin])

  return [ref, visible] as const
}
