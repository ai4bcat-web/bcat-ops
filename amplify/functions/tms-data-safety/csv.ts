/**
 * CSV primitives for the data-safety Lambda. Pure: no AWS, no clock.
 *
 * Two dialects share this file:
 *  - RAW dumps (`rawCell`): faithful. Nothing is rewritten, so the file can be
 *    re-imported. Nested maps/lists become JSON text, numbers and booleans are
 *    printed as stored (cents stay cents).
 *  - ACCOUNTANT files (`sheetText`, `moneyFromCents`): spreadsheet-safe. Text that
 *    could execute as a formula is defused; money is decimal dollars.
 */
import { createHash } from 'crypto'

export const UTF8_BOM = '\uFEFF'
const EOL = '\r\n'

/** RFC 4180: quote when the cell holds a delimiter, a quote or a line break. */
export function csvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',') + EOL
}

/** Faithful text of one stored attribute. Missing and null both print as empty. */
export function rawCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof Set) return JSON.stringify([...value].map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v)))
  return JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))
}

/** `id` first, then every other attribute alphabetically. `id` is always present. */
export function orderColumns(keys: Iterable<string>): string[] {
  const rest = [...new Set(keys)].filter((k) => k !== 'id').sort()
  return ['id', ...rest]
}

export function rawHeaderLine(columns: readonly string[]): string {
  return csvLine(columns)
}

export function rawRowLine(row: Record<string, unknown>, columns: readonly string[]): string {
  return csvLine(columns.map((c) => rawCell(row[c])))
}

/**
 * A text cell a spreadsheet must not execute. `=`, `+`, `@` (and tab/CR, which
 * Excel also treats as a formula lead-in) get a leading apostrophe; `-` only when
 * it is not the start of a number.
 */
export function sheetText(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/^[=+@\t\r]/.test(text) || /^-(?!\d)/.test(text)) return `'${text}`
  return text
}

/** Integer cents as decimal dollars, two places, leading `-` for negatives. */
export function moneyFromCents(cents: unknown): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return ''
  const rounded = Math.round(cents)
  const abs = Math.abs(rounded)
  const dollars = Math.floor(abs / 100)
  const rem = String(abs % 100).padStart(2, '0')
  return `${rounded < 0 ? '-' : ''}${dollars}.${rem}`
}

/** `YYYY-MM-DD` from a date or ISO datetime; empty when there is none. */
export function dateOnly(value: unknown): string {
  if (typeof value !== 'string') return ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return m ? m[1] : ''
}

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}
