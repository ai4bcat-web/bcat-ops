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

/** True at phone width. Guarded: tests and old browsers without matchMedia get the table. */
export function usePhoneWidth(): boolean {
  const query = `(max-width: ${PHONE_MAX_WIDTH}px)`
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [phone, setPhone] = useState(() => supported && window.matchMedia(query).matches)
  useEffect(() => {
    if (!supported) return undefined
    const mql = window.matchMedia(query)
    const onChange = () => setPhone(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query, supported])
  return phone
}
