/**
 * Customer settings (Step L) — portal defaults and customer tags.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */
import { SHIPMENT_STATUSES } from '../shipmentStatus'

export interface CustomerPortalDefaults {
  ltlQuoting?: 'OFF' | 'RATE_CARD' | 'SMC3' | null
  portalDispatchMode?: 'OFF' | 'QUOTE_ONLY' | 'FULL' | null
  portalStatusMask?: string[] | null
  blockedLtlCarrierIds?: string[] | null
  defaultQuoteNotes?: string | null
}

export interface CustomerTag {
  key: string
  label: string
  color: string
}

const LTL_QUOTING_MODES = ['OFF', 'RATE_CARD', 'SMC3'] as const
const PORTAL_DISPATCH_MODES = ['OFF', 'QUOTE_ONLY', 'FULL'] as const
const MAX_NOTES = 4000
const MAX_TAGS = 50
const TAG_KEY_RE = /^[A-Z0-9_-]{1,24}$/i
const TAG_LABEL_MAX = 60
const TAG_COLOR_MAX = 40
const STATUS_MASK_MAX = 50

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Text value must be a string.')
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error('Text value is too long.')
  return trimmed || null
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Enum value must be a string.')
  if (!allowed.includes(value as T)) throw new Error(`Must be one of ${allowed.join(', ')}.`)
  return value as T
}

/**
 * Validate customer portal defaults. Unknown statuses in the mask are refused.
 */
export function validateCustomerPortalDefaults(value: unknown): CustomerPortalDefaults | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('Customer portal defaults must be an object.')

  const statusSet: Record<string, true> = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s, true]))
  const mask = Array.isArray(row.portalStatusMask) ? row.portalStatusMask : []
  if (mask.length > STATUS_MASK_MAX) throw new Error(`At most ${STATUS_MASK_MAX} statuses may be masked.`)
  for (const s of mask) {
    if (typeof s !== 'string' || !statusSet[s]) throw new Error(`"${s}" is not a shipment status.`)
  }

  const blocked = Array.isArray(row.blockedLtlCarrierIds) ? row.blockedLtlCarrierIds : []
  if (blocked.length > 50) throw new Error('At most 50 blocked LTL carriers are allowed.')
  for (const id of blocked) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Blocked carrier ids must be non-empty strings.')
  }

  return {
    ltlQuoting: optionalEnum(row.ltlQuoting, LTL_QUOTING_MODES),
    portalDispatchMode: optionalEnum(row.portalDispatchMode, PORTAL_DISPATCH_MODES),
    portalStatusMask: mask as string[],
    blockedLtlCarrierIds: blocked.map((id) => String(id).trim()),
    defaultQuoteNotes: optionalString(row.defaultQuoteNotes, MAX_NOTES),
  }
}

/**
 * Validate customer tags. Keys are upper-case tokens; colours are free text
 * (the theme validates the actual token list client-side).
 */
export function validateCustomerTags(value: unknown): CustomerTag[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error('Customer tags must be a list.')
  if (value.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} customer tags are allowed.`)

  const out: CustomerTag[] = []
  const seen: Record<string, true> = {}
  for (let i = 0; i < value.length; i++) {
    const raw = asRecord(value[i])
    if (!raw) throw new Error(`Tag ${i + 1} must be an object.`)

    const key = typeof raw.key === 'string' ? raw.key.trim().toUpperCase() : ''
    if (!key) throw new Error(`Tag ${i + 1} needs a key.`)
    if (!TAG_KEY_RE.test(key)) {
      throw new Error(`Tag key "${key}" must be 1-24 letters, numbers, underscores or hyphens.`)
    }
    if (seen[key]) throw new Error(`Tag key "${key}" is used twice.`)
    seen[key] = true

    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (!label) throw new Error(`Tag ${i + 1} needs a label.`)
    if (label.length > TAG_LABEL_MAX) throw new Error(`Tag ${i + 1} label is too long.`)

    const color = typeof raw.color === 'string' ? raw.color.trim() : ''
    if (color.length > TAG_COLOR_MAX) throw new Error(`Tag ${i + 1} color is too long.`)

    out.push({ key, label, color })
  }
  return out.length ? out : null
}
