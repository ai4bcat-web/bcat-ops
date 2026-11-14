/** DenseGrid's phone card form: the layout a page passes and the width test. See DenseCards. */
import { useEffect, useState } from 'react'

export const PHONE_MAX_WIDTH = 640

export interface DenseCardLayout {
  /** Column keys for the card's top lines. Missing keys (a hidden column) are skipped. */
  title: string
  /** Customer or carrier: the line under the title. */
  party?: string
  /** Amount or balance: right of the title. */
  amount?: string
  /** Status / invoice-status pills, on their own line under the party. */
  pills?: string[]
  /** How many of the other visible columns show as details (default 6). */
  detailCount?: number
}

/**
 * Widest iPad in landscape (11" Pro / Air: 1194px). The fleet manager pages are read on an iPad (Ryne 2026-11-14), so their wide lists
 * draw as cards up to here; a desktop window is wider and keeps the table.
 */
export const TABLET_MAX_WIDTH = 1194

/** True while the window is at most `maxWidth` wide. Guarded: tests and old browsers without matchMedia get false. */
export function useMaxWidth(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [matches, setMatches] = useState(() => supported && window.matchMedia(query).matches)
  useEffect(() => {
    if (!supported) return undefined
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query, supported])
  return matches
}

/** True at phone width. Guarded: tests and old browsers without matchMedia get the table. */
export function usePhoneWidth(): boolean {
  return useMaxWidth(PHONE_MAX_WIDTH)
}
