/**
 * Dollar text in, integer cents out — the one conversion every AR dialog does.
 *
 * `parseCents` throws on anything that is not a plain decimal, which is right for a
 * form that is submitted and wrong for a field somebody is still typing into. These
 * wrappers turn a half-typed amount into `null` so the planner simply sees nothing
 * applied, and nobody is shouted at mid-keystroke.
 */
import { parseCents } from '@/lib/tmsDirectory'

/** Cents for a typed amount, or null while it is blank or not yet a number. */
export function centsFromInput(value: string): number | null {
  try {
    return parseCents(value)
  } catch {
    return null
  }
}

/** Cents as the plain `1234.56` a dollar input holds. Zero renders blank, not `0.00`. */
export function inputFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents === 0) return ''
  const negative = cents < 0
  const abs = Math.abs(cents)
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
