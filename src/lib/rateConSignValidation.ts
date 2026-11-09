/**
 * The rules a rate-confirmation signature must satisfy. ONE copy: the public signing page uses it to
 * block the Sign button, and the rate-con-sign-api Lambda uses the same functions to refuse a request
 * that skipped the page. Pure, no imports, so both bundles can take it by relative path.
 */

export const MAX_SIGNER_NAME = 120
export const MAX_FIELD_VALUE = 120

/** Letters (incl. Latin-1 accents), apostrophe, period, hyphen, space: what a standard PDF font can print. */
const NAME_PATTERN = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF'\u2019.\- ]*$/

export function cleanName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** Null when acceptable, else the message to show. A typed signature is a real name: 2+ letters, printable. */
export function signerNameError(raw: unknown, label = 'Your name'): string | null {
  const name = cleanName(raw)
  if (!name) return `${label} is required`
  if (name.length > MAX_SIGNER_NAME) return `${label} is too long`
  if (!NAME_PATTERN.test(name) || (name.match(/[A-Za-z\u00C0-\u00FF]/g)?.length ?? 0) < 2) {
    return `${label} must be a real name written with letters only`
  }
  return null
}

/**
 * US/Canada (NANP) number -> E.164 (`+15551234567`), or null. Accepts 10 digits or 11 with a leading 1
 * and any punctuation; refuses area codes / exchanges starting 0 or 1 and the 555-01xx style placeholders
 * no real driver has (all-same-digit numbers).
 */
export function normalizeUsPhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length !== 10) return null
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null
  if (/^(\d)\1{9}$/.test(ten)) return null
  return `+1${ten}`
}

/** `(312) 555-0147` for display, from an E.164 value. */
export function formatUsPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

const LABELS: Record<string, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck number',
  TRAILER_NUMBER: 'Trailer number',
  PICKUP_ETA: 'Pickup ETA',
  PLATES: 'Plates',
  VIN: 'VIN',
  DISPATCHER_EMAIL: 'Dispatcher email',
}

/**
 * One field's error, or null. `value` is the trimmed text. Empty is "required"; the rest are shape checks
 * that also apply to an OPTIONAL field the carrier chose to fill (a bad phone is never stored).
 */
export function fieldError(field: string, value: string): string | null {
  const label = LABELS[field] ?? field
  if (!value) return `${label} is required`
  if (value.length > MAX_FIELD_VALUE) return `${label} is too long`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${label} has characters that are not allowed`
  switch (field) {
    case 'DRIVER_PHONE':
      return normalizeUsPhone(value) ? null : 'Driver phone must be a valid 10-digit US phone number'
    case 'DRIVER_NAME':
      return signerNameError(value, 'Driver name')
    case 'TRUCK_NUMBER':
    case 'TRAILER_NUMBER':
      return /[A-Za-z0-9]/.test(value) ? null : `${label} must contain letters or numbers`
    case 'PICKUP_ETA':
      return Number.isNaN(Date.parse(value)) ? 'Pickup ETA must be a valid date and time' : null
    default:
      return null
  }
}

/** The value as it is stored: phone as E.164, the rest trimmed. */
export function normalizeFieldValue(field: string, value: string): string {
  const trimmed = value.trim()
  return field === 'DRIVER_PHONE' ? (normalizeUsPhone(trimmed) ?? trimmed) : trimmed
}

export interface SignAttempt {
  signerName: unknown
  agreed: unknown
  /** field key -> value as typed (or prefilled). */
  fields: Record<string, string>
  /** The fields this link still requires (the server's `requiredFields`). */
  required: readonly string[]
}

/** Every reason this attempt may not sign, keyed by field (`signerName`, `agreed`, or a field key). Empty = may sign. */
export function signErrors(attempt: SignAttempt): Record<string, string> {
  const errors: Record<string, string> = {}
  const nameError = signerNameError(attempt.signerName)
  if (nameError) errors.signerName = nameError
  if (attempt.agreed !== true) errors.agreed = 'You must tick the box to agree before signing'
  for (const field of attempt.required) {
    const error = fieldError(field, (attempt.fields[field] ?? '').trim())
    if (error) errors[field] = error
  }
  // A field that is not required but was filled must still be well formed.
  for (const [field, raw] of Object.entries(attempt.fields)) {
    if (attempt.required.includes(field)) continue
    const value = raw.trim()
    if (!value) continue
    const error = fieldError(field, value)
    if (error) errors[field] = error
  }
  return errors
}
