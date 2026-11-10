/**
 * The full CSV of a directory (all customers, all carriers, all locations): every field of every record, not the columns on screen,
 * and every row, whatever the page's tab, search or filters say. One column per field; a nested object becomes one column per key
 * (`address.city`), a list of plain values joins with "; ", anything more complex is written as JSON so nothing is dropped.
 */

type Flat = Record<string, string>

function scalar(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function flattenInto(out: Flat, prefix: string, value: unknown): void {
  if (value == null) { out[prefix] = ''; return }
  if (Array.isArray(value)) {
    out[prefix] = value.every((v) => v == null || typeof v !== 'object') ? value.map(scalar).join('; ') : JSON.stringify(value)
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) { out[prefix] = ''; return }
    for (const [k, v] of entries) flattenInto(out, `${prefix}.${k}`, v)
    return
  }
  out[prefix] = scalar(value)
}

/** One record as a flat map of column name to text. */
export function flattenRecord(record: object): Flat {
  const out: Flat = {}
  for (const [k, v] of Object.entries(record)) {
    if (k === '__typename') continue
    flattenInto(out, k, v)
  }
  return out
}

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Every record, every field, one header row. Columns are the union of the records' fields, `id` and `name` first, the rest in first-seen order. */
export function recordsToFullCsv(records: readonly object[]): string {
  const rows = records.map(flattenRecord)
  const columns: string[] = []
  const seen = new Set<string>()
  for (const lead of ['id', 'name']) if (rows.some((r) => lead in r)) { columns.push(lead); seen.add(lead) }
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k) }
  const lines = [columns.map(cell).join(',')]
  for (const r of rows) lines.push(columns.map((c) => cell(r[c] ?? '')).join(','))
  return lines.join('\r\n')
}

/** Hand the text to the browser as a file (UTF-8 with a byte-order mark so Excel reads accents correctly). */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
