/**
 * The Shipments page's two lists, as pure functions of facts already on the board row.
 *
 *   Active = not released to invoicing and not canceled.
 *   All    = every row (the Statuses facet still decides VOIDED / CANCELED visibility).
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
export function inShipmentList(row: ListRow, list: ShipmentList): boolean {
  if (list === 'all') return true
  return !isReleasedToInvoicing(row) && boardStatusOf(row) !== 'CANCELED'
}

/** Voided rows are excluded from both counts (the Statuses facet opts them in). */
export function shipmentListCounts(rows: readonly ListRow[]): { active: number; all: number } {
  let active = 0
  let all = 0
  for (const row of rows) {
    if (boardStatusOf(row) === 'VOIDED') continue
    all += 1
    if (inShipmentList(row, 'active')) active += 1
  }
  return { active, all }
}
