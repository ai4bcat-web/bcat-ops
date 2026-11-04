/**
 * Step AG §6.1 — raw DynamoDB rows → the `Ledger` the matcher reads. Pure: `store.ts` does the
 * reads (open bills, awaiting assignments, need-to-pay payables, then a batch of loads / shipments /
 * carriers) and hands the rows here, so the mapping is tested without AWS.
 */
import type {
  Ledger,
  LedgerAssignment,
  LedgerBill,
  LedgerBillStatus,
  LedgerCarrier,
  LedgerVendorPayable,
} from '../../../src/lib/apInbox/types'

export type Row = Record<string, unknown>

/** More open rows than this and the Load / Shipment / Carrier enrichment is skipped (and said so). */
export const LEDGER_MAX = 5000

/** `a.json()` read back: a native value, or a JSON string another writer left. */
export function jsonOf<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const BILL_STATUSES: readonly string[] = ['IN_REVIEW', 'TO_BE_PAID', 'PARTIAL']

export function toLedgerCarrier(row: Row): LedgerCarrier {
  return {
    id: String(row.id),
    name: str(row.name) ?? '',
    dbaName: str(row.dbaName),
    legalName: str(row.legalName),
    mcNumber: str(row.mcNumber),
    dotNumber: str(row.dotNumber),
    remitToName: str(row.remitToName),
  }
}

function refsOf(...rows: (Row | null | undefined)[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (!r) continue
    for (const key of ['pickupNumber', 'tmsId', 'tripNumber']) {
      const v = str(r[key])
      if (v && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/** Null when the row is not an open bill (PAID / VOID never match). */
export function toLedgerBill(row: Row, load: Row | null): LedgerBill | null {
  const status = String(row.status ?? '')
  if (!BILL_STATUSES.includes(status)) return null
  const remit = jsonOf<{ name?: unknown }>(row.remitTo)
  return {
    id: String(row.id),
    status: status as LedgerBillStatus,
    version: int(row.version) ?? 0,
    loadCarrierId: String(row.loadCarrierId ?? ''),
    loadId: String(row.loadId ?? ''),
    shipmentId: String(row.shipmentId ?? ''),
    shipmentNumber: str(row.shipmentNumber),
    loadNumber: str(row.loadNumber),
    aljexId: str(load?.aljexId),
    refs: refsOf(load),
    carrierId: String(row.carrierId ?? ''),
    carrierName: str(row.carrierName),
    carrierMc: str(row.carrierMc),
    billNumber: str(row.billNumber),
    billDate: String(row.billDate ?? ''),
    billMonth: String(row.billMonth ?? ''),
    dueAt: String(row.dueAt ?? ''),
    termsDays: int(row.termsDays) ?? 0,
    billedCents: int(row.billedCents) ?? 0,
    grossCents: int(row.grossCents) ?? 0,
    paidCents: int(row.paidCents) ?? 0,
    creditedCents: int(row.creditedCents) ?? 0,
    remitToName: str(remit?.name),
    apInboxItemId: str(row.apInboxItemId),
  }
}

/** Null unless the assignment is an outside-carrier leg still awaiting its invoice. */
export function toLedgerAssignment(row: Row, load: Row | null, shipment: Row | null): LedgerAssignment | null {
  if (row.apStatus !== 'AWAITING_INVOICE') return null
  return {
    loadCarrierId: String(row.id),
    loadId: String(row.loadId ?? ''),
    shipmentId: String(row.shipmentId ?? ''),
    shipmentNumber: str(shipment?.number),
    aljexId: str(load?.aljexId),
    refs: refsOf(load, row),
    carrierId: String(row.carrierId ?? ''),
    carrierName: str(row.carrierName),
    rateCents: int(row.carrierRateCents) ?? int(row.costCents),
  }
}

export function toLedgerVendor(row: Row): LedgerVendorPayable {
  return {
    id: String(row.id),
    status: String(row.status ?? ''),
    vendor: str(row.vendor),
    invoiceNumber: str(row.invoiceNumber),
    invoiceDate: str(row.invoiceDate),
    dueDate: str(row.dueDate),
    amount: int(row.amount),
  }
}

export interface RawLedger {
  bills: Row[]
  assignments: Row[]
  vendors: Row[]
  loads: Record<string, Row>
  shipments: Record<string, Row>
  carriers: Record<string, Row>
  enrichmentSkipped?: boolean
}

export function buildLedger(raw: RawLedger): Ledger {
  const bills: LedgerBill[] = []
  for (const row of raw.bills) {
    const b = toLedgerBill(row, raw.loads[String(row.loadId)] ?? null)
    if (b) bills.push(b)
  }
  const assignments: LedgerAssignment[] = []
  for (const row of raw.assignments) {
    const a = toLedgerAssignment(row, raw.loads[String(row.loadId)] ?? null, raw.shipments[String(row.shipmentId)] ?? null)
    if (a) assignments.push(a)
  }
  const vendorPayables = raw.vendors.filter((v) => v.status === 'NEED_TO_PAY').map(toLedgerVendor)
  const carriers: Record<string, LedgerCarrier> = {}
  for (const [id, row] of Object.entries(raw.carriers)) carriers[id] = toLedgerCarrier(row)
  return { bills, assignments, vendorPayables, carriers, ...(raw.enrichmentSkipped ? { enrichmentSkipped: true } : {}) }
}
