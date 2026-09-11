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
  return header.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ')
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

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (line[i + 1] === '"') {
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === delimiter && !quoted) {
      count++
    }
  }
  return count
}

function detectDelimiter(firstLine: string): string {
  const tab = countDelimiterOutsideQuotes(firstLine, '\t')
  const semi = countDelimiterOutsideQuotes(firstLine, ';')
  const comma = countDelimiterOutsideQuotes(firstLine, ',')
  if (tab > 0) return '\t'
  if (semi > 0 && semi >= comma) return ';'
  return ','
}

/**
 * Quote-aware, multiline-aware CSV parser. Returns rows of raw cell strings.
 * Handles "fields, with commas", ""escaped quotes"", and quoted line breaks.
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0

  const pushRow = () => {
    row.push(cell)
    if (row.some((c) => c.trim() !== '')) {
      rows.push(row)
    }
    row = []
    cell = ''
  }

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (ch === '"') {
        if (next === '"') {
          cell += '"'
          i += 2
        } else {
          quoted = false
          i++
        }
      } else {
        cell += ch
        i++
      }
    } else {
      if (ch === '"') {
        quoted = true
        i++
      } else if (ch === delimiter) {
        row.push(cell)
        cell = ''
        i++
      } else if (ch === '\r' && next === '\n') {
        pushRow()
        i += 2
      } else if (ch === '\n' || ch === '\r') {
        pushRow()
        i++
      } else {
        cell += ch
        i++
      }
    }
  }

  if (quoted) throw new Error('Unclosed quote in CSV. Close the quoted field and upload the file again.')

  if (cell !== '' || row.length > 0) {
    pushRow()
  }

  return rows
}

const NO_EMAIL_COLUMN_ERROR =
  'No recognizable email column. Add a header such as "Email" or "Email Address", or provide a single-column list of emails.'

/** How many leading rows may be title/banner noise above the header row. */
const MAX_BANNER_ROWS = 5

/**
 * Map a sheet of raw cell strings onto contact rows. Shared by CSV and Excel.
 *
 * The header row is located by scanning the first few rows, so exports that
 * carry a title or summary banner above the header still import.
 */
function rowsToCarrierRows(rows: string[][]): CsvRow[] {
  if (rows.length === 0) return []

  const trimmed = rows.map((row) => row.map((c) => c.trim()))
  const headerIdx = trimmed
    .slice(0, MAX_BANNER_ROWS)
    .findIndex((row) => findColumnIndex(row, EMAIL_HEADERS) >= 0)

  let headers: string[]
  let dataRows: string[][]

  if (headerIdx >= 0) {
    headers = trimmed[headerIdx]
    dataRows = trimmed.slice(headerIdx + 1)
  } else if (trimmed[0].length === 1 && isValidEmail(trimmed[0][0])) {
    headers = ['email']
    dataRows = trimmed
  } else {
    throw new Error(NO_EMAIL_COLUMN_ERROR)
  }

  const resolvedEmailIdx = findColumnIndex(headers, EMAIL_HEADERS)
  const firstNameIdx = findColumnIndex(headers, FIRST_NAME_HEADERS)
  const lastNameIdx = findColumnIndex(headers, LAST_NAME_HEADERS)
  const companyIdx = findColumnIndex(headers, COMPANY_HEADERS)

  const result: CsvRow[] = []
  for (const raw of dataRows) {
    const values = raw.map((c) => c.trim())
    const email = values[resolvedEmailIdx]?.toLowerCase().trim() ?? ''
    if (!email) continue
    result.push({
      email,
      firstName: firstNameIdx >= 0 ? values[firstNameIdx]?.trim() || undefined : undefined,
      lastName: lastNameIdx >= 0 ? values[lastNameIdx]?.trim() || undefined : undefined,
      company: companyIdx >= 0 ? values[companyIdx]?.trim() || undefined : undefined,
    })
  }
  return result
}

/**
 * Parse a CSV text into rows.
 *
 * Supports real CSV quoting (commas, escaped quotes, multiline fields), BOM and
 * CRLF normalization, tab/semicolon delimiter auto-detection, and headerless
 * single-column email lists. Throws an actionable error when no email column can
 * be recognized.
 */
export function parseCarrierCsv(text: string): CsvRow[] {
  const cleaned = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!cleaned.trim()) return []

  const firstLine = cleaned.split('\n').find((l) => l.trim() !== '') ?? ''
  if (!firstLine) return []

  return rowsToCarrierRows(parseCsv(cleaned, detectDelimiter(firstLine)))
}

/** Excel cell values arrive typed; contacts are text, so normalize to strings. */
function excelCellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value).trim()
}

function isExcelFile(file: File): boolean {
  return /\.xlsx$/i.test(file.name) ||
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

/**
 * Parse an uploaded contact list. Excel workbooks (.xlsx) are read from their
 * first worksheet; everything else is treated as delimited text. Throws an
 * actionable error for legacy .xls workbooks, which carry no readable sheet XML.
 */
export async function parseCarrierFile(file: File): Promise<CsvRow[]> {
  if (/\.xls$/i.test(file.name) || file.type === 'application/vnd.ms-excel') {
    throw new Error('Legacy .xls workbooks are not supported. Save the file as .xlsx or CSV and upload it again.')
  }

  if (isExcelFile(file)) {
    const { readSheet } = await import('read-excel-file/browser')
    const sheet = await readSheet(file)
    return rowsToCarrierRows(sheet.map((row) => row.map(excelCellToString)))
  }

  return parseCarrierCsv(await file.text())
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
