import { useEffect } from 'react'

/**
 * The public pages and the driver app keep their pre-restyle look (src/styles/legacy-skin.css).
 * While one of them is mounted, `data-tms-skin="legacy"` sits on <html> so Radix portals and
 * toasts rendered into document.body pick up the same tokens.
 */
export function useLegacySkin(): void {
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-tms-skin', 'legacy')
    return () => root.removeAttribute('data-tms-skin')
  }, [])
}
