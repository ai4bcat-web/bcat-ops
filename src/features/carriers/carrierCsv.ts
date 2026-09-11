import { isValidEmail } from '@/lib/apiClient'
import type { CarrierContact, CarrierLane } from '@/types'

export interface CsvRow {
  email: string
  firstName?: string
  lastName?: string
  company?: string
}

export interface ImportPreview {
  new: CsvRow[]
  duplicates: CsvRow[]
  invalid: CsvRow[]
}

const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'emailaddress', 'e mail']
const FIRST_NAME_HEADERS = ['first', 'first name', 'firstname', 'first_name', 'first-name']
const LAST_NAME_HEADERS = ['last', 'last name', 'lastname', 'last_name', 'last-name']
const COMPANY_HEADERS = ['company', 'company name', 'companyname', 'carrier', 'mc name', 'mcname', 'mc_name']

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ')
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader)
  for (const candidate of candidates) {
    const target = normalizeHeader(candidate)
    const idx = normalized.indexOf(target)
    if (idx >= 0) return idx
  }
  return -1
}

function cleanCell(value: string): string {
  let v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/""/g, '"')
  } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1)
  }
  return v
}

/** Parse a CSV text into rows. Very simple: splits on newlines, then commas. */
export function parseCarrierCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return []

  const headers = lines[0].split(',').map((h) => cleanCell(h))
  const emailIdx = findColumnIndex(headers, EMAIL_HEADERS)
  const firstIdx = findColumnIndex(headers, FIRST_NAME_HEADERS)
  const lastIdx = findColumnIndex(headers, LAST_NAME_HEADERS)
  const companyIdx = findColumnIndex(headers, COMPANY_HEADERS)

  if (emailIdx < 0) return []

  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => cleanCell(v))
    const email = values[emailIdx]?.toLowerCase().trim() ?? ''
    if (!email) continue
    rows.push({
      email,
      firstName: firstIdx >= 0 ? values[firstIdx]?.trim() || undefined : undefined,
      lastName: lastIdx >= 0 ? values[lastIdx]?.trim() || undefined : undefined,
      company: companyIdx >= 0 ? values[companyIdx]?.trim() || undefined : undefined,
    })
  }
  return rows
}

/** Parse pasted text: one email per line, comma-separated, or semicolon-separated. */
export function parseCarrierPaste(text: string): CsvRow[] {
  const separators = /[\n,;]+/
  const parts = text.split(separators)
  return parts
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((email) => ({ email }))
}

/**
 * Build an import preview: new rows, duplicates against existing contacts,
 * and rows with invalid emails. Duplicates are checked within the file AND
 * against existing contacts in the same lane.
 */
export function buildImportPreview(
  rows: CsvRow[],
  existing: CarrierContact[],
  lane: CarrierLane
): ImportPreview {
  const seen = new Set<string>()
  const result: ImportPreview = { new: [], duplicates: [], invalid: [] }

  for (const row of rows) {
    if (!isValidEmail(row.email)) {
      result.invalid.push(row)
      continue
    }
    const existingContact = existing.find((c) => c.email === row.email && c.lane === lane)
    if (existingContact || seen.has(row.email)) {
      result.duplicates.push(row)
      continue
    }
    seen.add(row.email)
    result.new.push({ ...row, email: row.email.toLowerCase().trim() })
  }

  return result
}

/** Convert preview rows into inputs ready for createCarrierContact. */
export function previewToContactInputs(
  rows: CsvRow[],
  lane: CarrierLane,
  source: string,
  addedBy: string
): Omit<CarrierContact, 'id' | 'createdAt' | 'updatedAt'>[] {
  return rows.map((row) => ({
    lane,
    email: row.email.toLowerCase().trim(),
    firstName: row.firstName || null,
    lastName: row.lastName || null,
    company: row.company || null,
    status: 'active' as const,
    source,
    addedBy,
    addedAt: new Date().toISOString(),
    lastCampaignId: null,
    lastSentAt: null,
    notes: null,
  }))
}
