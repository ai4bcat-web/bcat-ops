/**
 * Exact decimal-string -> integer cents. Never goes through floating point.
 * Accepts `$`, thousands commas, spaces, `(12.00)`, `12.00-`, `-12.00`, `+12.00`. A bare `$`
 * is the export's placeholder for "blank" (64,890 cells in Acc Charge 5..8).
 */

/** AppSync `Int` ceiling: a larger cents value cannot be stored. */
export const MAX_CENTS = 2_147_483_647

export type MoneyFlag = 'ROUNDED' | 'INVALID' | 'OVERFLOW' | 'PLACEHOLDER'

export interface MoneyParse {
  /** null for blank, placeholder, invalid and overflowing input. */
  cents: number | null
  flag?: MoneyFlag
}

export function parseMoney(text: string | null | undefined): MoneyParse {
  let s = String(text ?? '').replace(/[\u00a0\s]+/g, '')
  if (s === '') return { cents: null }
  if (s === '$') return { cents: null, flag: 'PLACEHOLDER' }
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  }
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  s = s.replace(/^\$/, '')
  // Thousands separators: commas only between digit groups.
  if (/,/.test(s)) {
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return { cents: null, flag: 'INVALID' }
    s = s.replace(/,/g, '')
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { cents: null, flag: 'INVALID' }
  const whole = m[1] || '0'
  const frac = m[2] ?? ''
  let cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
  let rounded = false
  if (frac.length > 2) {
    const rest = frac.slice(2)
    if (/[1-9]/.test(rest)) rounded = true
    if (rest.charCodeAt(0) >= 53) cents += 1n // half-up on the magnitude
  }
  if (cents > BigInt(MAX_CENTS)) return { cents: null, flag: 'OVERFLOW' }
  const value = Number(cents)
  const signed = negative && value !== 0 ? -value : value
  return rounded ? { cents: signed, flag: 'ROUNDED' } : { cents: signed }
}

/** Blank / placeholder / invalid count as 0 (for sums); use `parseMoney` to tell them apart. */
export function moneyCents(text: string | null | undefined): number {
  return parseMoney(text).cents ?? 0
}

/** `1234567` -> `12,345.67`, `-5` -> `-0.05`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`
}
