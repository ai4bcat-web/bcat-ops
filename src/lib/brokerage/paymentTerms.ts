/**
 * Payment terms catalog (Step L).
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */

export interface PaymentTerm {
  key: string
  name: string
  days: number
  description?: string | null
  quickPayFeeBps?: number | null
  apOnly?: boolean | null
  doNotUse?: boolean | null
}

const MAX_TERMS = 50
const MAX_NAME = 120
const MAX_DESCRIPTION = 500
const MIN_DAYS = 0
const MAX_DAYS = 180
const MIN_FEE_BPS = 0
const MAX_FEE_BPS = 2000

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} is too long.`)
  return trimmed
}

function wholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a whole number.`)
  }
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number.`)
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`)
  return value
}

function optionalWholeNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null
  return wholeNumber(value, label, min, max)
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'boolean') throw new Error('Boolean value must be true or false.')
  return value
}

/** `'Net 30'`, `'1.5% 10 Net 30'` → `'net-30'`. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Validate the org's payment-terms catalog.
 *
 * - keys are slugified from the name and must be unique
 * - days 0..180, quickPayFeeBps 0..2000
 * - a doNotUse term may not be the default (the default is the term whose days
 *   match settings.defaultPaymentTermsDays, or the first non-doNotUse term)
 */
export function validatePaymentTerms(
  value: unknown,
  settings?: { defaultPaymentTermsDays?: number | null } | null,
): PaymentTerm[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Payment terms must be a list.')
  if (value.length > MAX_TERMS) throw new Error(`At most ${MAX_TERMS} payment terms are allowed.`)

  const terms: PaymentTerm[] = []
  const keysSeen: Record<string, true> = {}

  for (let i = 0; i < value.length; i++) {
    const raw = asRecord(value[i])
    if (!raw) throw new Error(`Payment term ${i + 1} must be an object.`)

    const name = text(raw.name, MAX_NAME, `Payment term ${i + 1} name`)
    if (!name) throw new Error(`Payment term ${i + 1} needs a name.`)

    const key = raw.key === null || raw.key === undefined
      ? slugifyName(name)
      : text(raw.key, 40, `Payment term ${i + 1} key`)
    if (!key) throw new Error(`Payment term ${i + 1} needs a key.`)
    if (keysSeen[key]) throw new Error(`Payment term key "${key}" is used twice.`)
    keysSeen[key] = true

    const days = wholeNumber(raw.days, `Payment term ${i + 1} days`, MIN_DAYS, MAX_DAYS)
    const quickPayFeeBps = optionalWholeNumber(raw.quickPayFeeBps, `Payment term ${i + 1} quick-pay fee`, MIN_FEE_BPS, MAX_FEE_BPS)
    const apOnly = optionalBoolean(raw.apOnly)
    const doNotUse = optionalBoolean(raw.doNotUse)
    const description = raw.description === null || raw.description === undefined
      ? null
      : text(raw.description, MAX_DESCRIPTION, `Payment term ${i + 1} description`)

    terms.push({
      key,
      name,
      days,
      description,
      quickPayFeeBps,
      apOnly,
      doNotUse,
    })
  }

  // Default term check: the term that matches defaultPaymentTermsDays must not be doNotUse.
  const defaultDays = settings?.defaultPaymentTermsDays
  if (defaultDays != null && Number.isFinite(defaultDays)) {
    const defaultTerm = terms.find((t) => t.days === defaultDays)
    if (defaultTerm?.doNotUse) {
      throw new Error(`The default term "${defaultTerm.name}" cannot be marked do not use.`)
    }
  }

  return terms
}

/** Find a term by its slugified key. */
export function termByKey(terms: PaymentTerm[] | null | undefined, key: string): PaymentTerm | null {
  if (!terms) return null
  const needle = key.trim().toLowerCase()
  return terms.find((t) => t.key.toLowerCase() === needle) ?? null
}

/**
 * Resolve the payment term that applies to a customer.
 *
 * Falls back through: the customer's days, the org default days, and the
 * hard-coded Net 30 default.
 */
export function defaultTermFor(
  customer: { paymentTermsDays?: number | null } | null | undefined,
  settings: { paymentTerms?: PaymentTerm[] | null; defaultPaymentTermsDays?: number | null } | null | undefined,
): PaymentTerm | null {
  const terms = settings?.paymentTerms ?? []
  const targetDays = customer?.paymentTermsDays ?? settings?.defaultPaymentTermsDays ?? null
  if (targetDays != null && Number.isFinite(targetDays)) {
    const byDays = terms.find((t) => t.days === targetDays && !t.doNotUse)
    if (byDays) return byDays
  }
  const firstUsable = terms.find((t) => !t.doNotUse)
  if (firstUsable) return firstUsable
  return null
}

/**
 * Invoice date plus term days, in UTC. Local time would move a due date by a
 * day for anyone west of Greenwich on the last of a month, and AR is read in days.
 */
export function netDueDate(invoiceDate: string, term: Pick<PaymentTerm, 'days'>): string {
  const [y, m, d] = invoiceDate.slice(0, 10).split('-').map(Number)
  const days = Number.isFinite(term.days) ? Math.trunc(term.days) : 0
  const at = Date.UTC(y, m - 1, d + days)
  return new Date(at).toISOString().slice(0, 10)
}
