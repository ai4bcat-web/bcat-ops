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

/** Normalize any phone input to E.164 (+1XXXXXXXXXX) */
export function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const local = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  return `+1${local}`
}
