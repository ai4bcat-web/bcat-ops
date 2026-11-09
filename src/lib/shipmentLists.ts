/**
 * The Shipments page's two lists, as pure functions of facts already on the board row.
 *
 *   Active = not released to invoicing and not canceled.
 *   All    = every row (the Statuses facet still decides VOIDED / CANCELED visibility),
 *            narrowed to one year or all years. A released shipment is listed here and only here.
 *
 * Released to invoicing = the order has left DOCS_NEEDED: `readyToInvoiceAt` or
 * `invoiceId` is set, or `arStatus` is any other rung (UNBILLED, UNPAID, PAID,
 * INVOICE_NOT_NEEDED, LEGACY). A row with no order data is not released.
 *
 * Imports are relative and type-only so a Lambda could bundle this file.
 */
import type { ArStatus, ShipmentStatus } from '../types/tms'
import { boardStatusOf } from './shipmentViewDefs'

export type ShipmentList = 'active' | 'all'

export interface ListRow {
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  arStatus?: ArStatus | null
  readyToInvoiceAt?: string | null
  invoiceId?: string | null
  pickupMonth?: string | null
  pickupAppt?: string | null
  createdAt?: string | null
}

/** The All tab's year facet: one calendar year, or every year. */
export type ShipmentYear = number | 'all'

const YEAR_RE = /^(\d{4})/

/** The year a shipment belongs to: its pickup month (the key the board windows by), else pickup appointment, else creation. Null when none is dated. */
export function shipmentYearOf(row: ListRow): number | null {
  for (const v of [row.pickupMonth, row.pickupAppt, row.createdAt]) {
    const m = v ? YEAR_RE.exec(v) : null
    if (m) return Number(m[1])
  }
  return null
}

/** An undated row is never hidden by a year. */
export function inShipmentYear(row: ListRow, year: ShipmentYear): boolean {
  if (year === 'all') return true
  const y = shipmentYearOf(row)
  return y === null || y === year
}

/** Years present in the rows, newest first. */
export function shipmentYears(rows: readonly ListRow[]): number[] {
  const years = new Set<number>()
  for (const row of rows) {
    const y = shipmentYearOf(row)
    if (y !== null) years.add(y)
  }
  return [...years].sort((a, b) => b - a)
}

/** The twelve pickup months ('YYYY-MM') of a year. */
export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${String(year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`)
}

/** `?list=` value to list; anything unknown is the default, Active. */
export function parseShipmentList(value: string | null | undefined): ShipmentList {
  return value === 'all' ? 'all' : 'active'
}

export function isReleasedToInvoicing(row: ListRow): boolean {
  return row.readyToInvoiceAt != null || row.invoiceId != null
    || (row.arStatus != null && row.arStatus !== 'DOCS_NEEDED')
}

/** The scope applied BEFORE matchesBoardFilters. */
export function inShipmentList(row: ListRow, list: ShipmentList, year: ShipmentYear = 'all'): boolean {
  if (list === 'all') return inShipmentYear(row, year)
  return !isReleasedToInvoicing(row) && boardStatusOf(row) !== 'CANCELED'
}

/** Voided rows are excluded from both counts (the Statuses facet opts them in). `year` narrows the All count the way the All tab narrows its rows. */
export function shipmentListCounts(rows: readonly ListRow[], year: ShipmentYear = 'all'): { active: number; all: number } {
  let active = 0
  let all = 0
  for (const row of rows) {
    if (boardStatusOf(row) === 'VOIDED') continue
    if (inShipmentList(row, 'all', year)) all += 1
    if (inShipmentList(row, 'active')) active += 1
  }
  return { active, all }
}
