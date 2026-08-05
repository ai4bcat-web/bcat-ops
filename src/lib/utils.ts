import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format E.164 phone to (XXX) XXX-XXXX */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  const local = digits.slice(-10)
  if (local.length !== 10) return e164
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
}

/**
 * VINs are uppercase by standard (ISO 3779 — and the alphabet excludes I, O and Q to
 * avoid confusion with 1 and 0). Operators type them in mixed case, so normalise on the
 * way in AND on the way out: use this at every display site so a record saved before
 * normalisation still reads correctly.
 */
export function formatVin(vin?: string | null): string {
  return (vin ?? '').trim().toUpperCase()
}

/** Normalize any phone input to E.164 (+1XXXXXXXXXX) */
export function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const local = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  return `+1${local}`
}
