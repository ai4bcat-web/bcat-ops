/**
 * The per-file Aljex kinds (everything except the big export): how a file is recognised from its header row, which
 * layout id its import job carries, and which columns are refused or stripped before the file is stored.
 * Shared by the browser wizard, the router and the operator CLI so all three agree. Only header names are read here.
 */
import { detectCarriersLayout, CARRIERS_MASTER_ID } from './layouts/carriers'
import { detectCustomersLayout, CUSTOMERS_MASTER_ID } from './layouts/customers'
import { AP_AGING_LAYOUT_ID, parseApAging } from './layouts/apAging'
import { AP_EXPECTED_LAYOUT_ID, parseApExpected } from './layouts/apExpected'
import { ACTIVE_SHIPMENTS_LAYOUT_ID, parseActiveShipments } from './layouts/activeShipments'
import { AR_REPORT_LAYOUT_ID, parseArReport } from './layouts/arReport'
import { normalizeHeader } from './layout'
import { findSensitiveHeaders } from './sensitiveColumns'

export const FILE_KINDS = ['CUSTOMERS_MASTER', 'CARRIERS_MASTER', 'AP_AGING', 'AP_EXPECTED', 'ACTIVE_SHIPMENTS', 'AR_REPORT'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export const FILE_KIND_LAYOUT_ID: Record<FileKind, string> = {
  CUSTOMERS_MASTER: CUSTOMERS_MASTER_ID,
  CARRIERS_MASTER: CARRIERS_MASTER_ID,
  AP_AGING: AP_AGING_LAYOUT_ID,
  AP_EXPECTED: AP_EXPECTED_LAYOUT_ID,
  ACTIVE_SHIPMENTS: ACTIVE_SHIPMENTS_LAYOUT_ID,
  AR_REPORT: AR_REPORT_LAYOUT_ID,
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  CUSTOMERS_MASTER: 'Customer list',
  CARRIERS_MASTER: 'Carrier list',
  AP_AGING: 'AP aging (open carrier bills)',
  AP_EXPECTED: 'AP expected (carrier cost not yet billed)',
  ACTIVE_SHIPMENTS: 'Active shipments (check only)',
  AR_REPORT: 'AR report (open invoices)',
}

export function fileKindOfLayoutId(layoutId: string | null | undefined): FileKind | null {
  return FILE_KINDS.find((k) => FILE_KIND_LAYOUT_ID[k] === layoutId) ?? null
}

/** A header-only parse: a layout that throws is not this layout (the parsers refuse missing required columns). */
function parses(fn: () => unknown): boolean {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

/** The kind a header row matches, or null (the full export is detected elsewhere). Sensitive columns do not stop detection. */
export function detectFileKind(headers: readonly string[]): FileKind | null {
  const row = [...headers]
  if (detectCustomersLayout(row).matches) return 'CUSTOMERS_MASTER'
  if (detectCarriersLayout(row).matches) return 'CARRIERS_MASTER'
  // The AP layouts also refuse sensitive headers; remove them from the probe so detection and refusal stay separate.
  const probe = row.filter((h) => findSensitiveHeaders([h]).length === 0)
  if (parses(() => parseApAging([probe]))) return 'AP_AGING'
  if (parses(() => parseApExpected([probe]))) return 'AP_EXPECTED'
  if (parses(() => parseActiveShipments([probe]))) return 'ACTIVE_SHIPMENTS'
  if (parses(() => parseArReport([probe]))) return 'AR_REPORT'
  return null
}

const norm = (h: string): string => normalizeHeader(h)

/**
 * The headers of this file that must be refused before storage: the shared sensitive set (Fed/SS #, Bank Account,
 * Routing #, Web Password) plus, for the carrier list, `Account #` (in that export it carries the tax-id shape).
 */
export function refusedHeaders(kind: FileKind | null, headers: readonly string[]): string[] {
  const found = new Set(findSensitiveHeaders(headers))
  if (kind === 'CARRIERS_MASTER') for (const h of headers) if (norm(h) === norm('Account #')) found.add(h)
  return headers.filter((h) => found.has(h))
}

/** The operator CLI's stripped copy: the refused columns removed from the header and every row. */
export function stripRefusedColumns(kind: FileKind, headers: readonly string[], rows: ReadonlyArray<readonly string[]>): { headers: string[]; rows: string[][]; dropped: string[] } {
  const refused = new Set(refusedHeaders(kind, headers))
  const keep = headers.map((h, i) => (refused.has(h) ? -1 : i)).filter((i) => i >= 0)
  return {
    headers: keep.map((i) => headers[i]),
    rows: rows.map((r) => keep.map((i) => String(r[i] ?? ''))),
    dropped: headers.filter((h) => refused.has(h)),
  }
}
