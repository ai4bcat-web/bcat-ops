/**
 * The four accountant-ready CSVs (DECIDED-2). Pure: callers hand in already-read
 * rows; every join is an in-memory Map. Headers are a published contract: a
 * change is a new file-name suffix (`-v2`), never a silent edit.
 */
import { UTF8_BOM, csvLine, dateOnly, moneyFromCents, sheetText } from './csv'

type Row = Record<string, unknown>

export const INVOICES_HEADERS = [
  'invoice_number', 'pro', 'shipment_number', 'customer_id', 'customer_name', 'invoice_date', 'due_date',
  'terms_days', 'terms_text', 'total', 'paid', 'written_off', 'balance', 'status', 'factored',
  'factoring_item_id', 'division_key', 'issued_by', 'paid_date', 'voided_date', 'void_reason', 'source',
] as const

export const AR_PAYMENTS_HEADERS = [
  'payment_id', 'kind', 'received_date', 'customer_id', 'customer_name', 'method', 'reference', 'payment_amount',
  'applied_amount', 'unapplied_amount', 'applied_to_invoice_number', 'applied_to_pro', 'application_amount',
  'reverses_payment_id', 'reversed_by_payment_id', 'note', 'source',
] as const

export const CARRIER_BILLS_HEADERS = [
  'bill_id', 'bill_number', 'pro', 'shipment_number', 'load_number', 'carrier_id', 'carrier_name', 'carrier_mc',
  'bill_date', 'due_date', 'terms_days', 'gross', 'quick_pay_fee', 'net', 'billed', 'variance', 'paid', 'credited',
  'balance', 'status', 'approved_date', 'approved_by', 'payee_kind', 'voided_date', 'void_reason', 'source',
] as const

export const AP_PAYMENTS_HEADERS = [
  'payment_id', 'kind', 'paid_date', 'carrier_id', 'carrier_name', 'carrier_mc', 'method', 'reference',
  'payment_amount', 'applied_amount', 'unapplied_amount', 'applied_to_bill_id', 'applied_to_bill_number',
  'applied_to_pro', 'application_amount', 'reverses_payment_id', 'reversed_by_payment_id', 'note', 'source',
] as const

export interface AccountingInput {
  invoices: Row[]
  arPayments: Row[]
  carrierBills: Row[]
  apPayments: Row[]
  customers: Row[]
  carriers: Row[]
  shipments: Row[]
  loads: Row[]
}

export interface AccountingFilter {
  /** Inclusive `YYYY-MM-DD`, applied to each file's own date column. */
  from?: string
  to?: string
  /** Applies to invoices and carrier bills only (payments have no status). */
  status?: string | string[]
}

export interface AccountingFile {
  name: 'invoices.csv' | 'ar-payments.csv' | 'carrier-bills.csv' | 'ap-payments.csv'
  content: string
  rows: number
}

export const OPEN_INVOICE_STATUSES = ['ISSUED', 'PARTIAL']

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const sourceOf = (row: Row): string => (row.createdBy === 'aljex-import' ? 'ALJEX_IMPORT' : 'BCAT')

function listOf(value: unknown): Row[] {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : []
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((r) => [str(r.id), r]))
}

function inWindow(date: string, f: AccountingFilter): boolean {
  if (f.from && (!date || date < f.from)) return false
  if (f.to && (!date || date > f.to)) return false
  return true
}

function statusOk(status: unknown, f: AccountingFilter): boolean {
  if (!f.status || f.status.length === 0) return true
  const wanted = Array.isArray(f.status) ? f.status : [f.status]
  return wanted.includes(str(status))
}

/** date asc, then id asc, on the already-computed sort keys. */
function sortRows<T extends { date: string; id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function render(headers: readonly string[], lines: string[][]): string {
  return UTF8_BOM + csvLine(headers) + lines.map((l) => csvLine(l)).join('')
}

export function buildAccountingFiles(input: AccountingInput, filter: AccountingFilter = {}): AccountingFile[] {
  const customers = byId(input.customers)
  const carriers = byId(input.carriers)
  const shipments = byId(input.shipments)
  const loadsById = byId(input.loads)
  const loadsByOrder = new Map<string, Row[]>()
  const loadsByShipment = new Map<string, Row[]>()
  for (const l of input.loads) {
    for (const [map, key] of [[loadsByOrder, str(l.orderId)], [loadsByShipment, str(l.shipmentId)]] as const) {
      if (!key) continue
      const list = map.get(key) ?? []
      list.push(l)
      map.set(key, list)
    }
  }
  const firstPro = (loads: Row[] | undefined): string => {
    if (!loads || loads.length === 0) return ''
    const sorted = [...loads].sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0) || str(a.id).localeCompare(str(b.id)))
    return str(sorted[0].aljexId)
  }
  const invoicesById = byId(input.invoices)
  const invoicePro = (inv: Row): string => firstPro(loadsByOrder.get(str(inv.orderId))) || firstPro(loadsByShipment.get(str(inv.shipmentId)))
  const billsById = byId(input.carrierBills)

  // ── invoices.csv
  const invoiceRows = input.invoices
    .filter((i) => inWindow(dateOnly(i.invoiceDate), filter) && statusOk(i.status, filter))
    .map((i) => ({ date: dateOnly(i.invoiceDate), id: str(i.id), row: i }))
  const invoices = sortRows(invoiceRows).map(({ row: i }) => {
    const shipment = shipments.get(str(i.shipmentId))
    return [
      sheetText(i.number ?? i.id), sheetText(invoicePro(i)), sheetText(i.shipmentNumber ?? shipment?.number),
      sheetText(i.customerId), sheetText(i.customerName ?? customers.get(str(i.customerId))?.name),
      dateOnly(i.invoiceDate), dateOnly(i.dueAt), str(i.termsDays), sheetText(i.termsText),
      moneyFromCents(i.totalCents), moneyFromCents(i.paidCents), moneyFromCents(i.writtenOffCents),
      moneyFromCents(i.balanceCents), str(i.status), i.factored ? 'true' : 'false', sheetText(i.factoringItemId),
      sheetText(i.divisionKey), sheetText(i.issuedBy), dateOnly(i.paidAt), dateOnly(i.voidedAt),
      sheetText(i.voidReason), sourceOf(i),
    ]
  })

  // ── ar-payments.csv (one row per application; none → one blank-application row)
  const arLines: string[][] = []
  const arSorted = sortRows(
    input.arPayments
      .filter((p) => inWindow(dateOnly(p.receivedAt), filter))
      .map((p) => ({ date: dateOnly(p.receivedAt), id: str(p.id), row: p })),
  )
  for (const { row: p } of arSorted) {
    let apps = listOf(p.applications).map((a) => ({ invoiceId: str(a.invoiceId), cents: a.amountCents }))
    if (apps.length === 0 && p.kind === 'WRITE_OFF' && p.invoiceId) {
      apps = [{ invoiceId: str(p.invoiceId), cents: Number(p.appliedCents) > 0 ? p.appliedCents : p.amountCents }]
    }
    apps.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
    const head = (): string[] => [
      sheetText(p.id), str(p.kind), dateOnly(p.receivedAt), sheetText(p.customerId),
      sheetText(customers.get(str(p.customerId))?.name), str(p.method), sheetText(p.reference),
      moneyFromCents(p.amountCents), moneyFromCents(p.appliedCents), moneyFromCents(p.unappliedCents),
    ]
    const tail = (): string[] => [sheetText(p.reversesPaymentId), sheetText(p.reversedByPaymentId), sheetText(p.note), sourceOf(p)]
    if (apps.length === 0) arLines.push([...head(), '', '', '', ...tail()])
    for (const a of apps) {
      const inv = invoicesById.get(a.invoiceId)
      arLines.push([...head(), sheetText(inv?.number ?? a.invoiceId), sheetText(inv ? invoicePro(inv) : ''), moneyFromCents(a.cents), ...tail()])
    }
  }

  // ── carrier-bills.csv
  const billSorted = sortRows(
    input.carrierBills
      .filter((b) => inWindow(dateOnly(b.billDate), filter) && statusOk(b.status, filter))
      .map((b) => ({ date: dateOnly(b.billDate), id: str(b.id), row: b })),
  )
  const billLines = billSorted.map(({ row: b }) => {
    const carrier = carriers.get(str(b.carrierId))
    const load = loadsById.get(str(b.loadId))
    const shipment = shipments.get(str(b.shipmentId))
    return [
      sheetText(b.id), sheetText(b.billNumber), sheetText(load?.aljexId), sheetText(b.shipmentNumber ?? shipment?.number),
      sheetText(b.loadNumber ?? load?.loadNumber), sheetText(b.carrierId), sheetText(b.carrierName ?? carrier?.name),
      sheetText(b.carrierMc ?? carrier?.mcNumber), dateOnly(b.billDate), dateOnly(b.dueAt), str(b.termsDays),
      moneyFromCents(b.grossCents), moneyFromCents(b.quickPayFeeCents), moneyFromCents(b.netCents),
      moneyFromCents(b.billedCents), moneyFromCents(b.varianceCents), moneyFromCents(b.paidCents),
      moneyFromCents(b.creditedCents), moneyFromCents(b.balanceCents), str(b.status), dateOnly(b.approvedAt),
      sheetText(b.approvedBy), str(b.payeeKind), dateOnly(b.voidedAt), sheetText(b.voidReason), sourceOf(b),
    ]
  })

  // ── ap-payments.csv
  const apLines: string[][] = []
  const apSorted = sortRows(
    input.apPayments
      .filter((p) => inWindow(dateOnly(p.paidAt), filter))
      .map((p) => ({ date: dateOnly(p.paidAt), id: str(p.id), row: p })),
  )
  for (const { row: p } of apSorted) {
    const carrier = carriers.get(str(p.carrierId))
    const apps = listOf(p.applications).map((a) => ({ billId: str(a.billId), cents: a.amountCents }))
    apps.sort((a, b) => a.billId.localeCompare(b.billId))
    const head = [
      sheetText(p.id), str(p.kind), dateOnly(p.paidAt), sheetText(p.carrierId), sheetText(carrier?.name),
      sheetText(carrier?.mcNumber), str(p.method), sheetText(p.reference), moneyFromCents(p.amountCents),
      moneyFromCents(p.appliedCents), moneyFromCents(p.unappliedCents),
    ]
    const tail = [sheetText(p.reversesPaymentId), sheetText(p.reversedByPaymentId), sheetText(p.note), sourceOf(p)]
    if (apps.length === 0) apLines.push([...head, '', '', '', '', ...tail])
    for (const a of apps) {
      const bill = billsById.get(a.billId)
      const pro = bill ? str(loadsById.get(str(bill.loadId))?.aljexId) : ''
      apLines.push([...head, sheetText(a.billId), sheetText(bill?.billNumber), sheetText(pro), moneyFromCents(a.cents), ...tail])
    }
  }

  return [
    { name: 'invoices.csv', content: render(INVOICES_HEADERS, invoices), rows: invoices.length },
    { name: 'ar-payments.csv', content: render(AR_PAYMENTS_HEADERS, arLines), rows: arLines.length },
    { name: 'carrier-bills.csv', content: render(CARRIER_BILLS_HEADERS, billLines), rows: billLines.length },
    { name: 'ap-payments.csv', content: render(AP_PAYMENTS_HEADERS, apLines), rows: apLines.length },
  ]
}

/** Σ balance of the open invoices in cents — the number the `arOpen` index adds up to. */
export function openInvoiceBalanceCents(invoices: Row[]): number {
  return invoices
    .filter((i) => OPEN_INVOICE_STATUSES.includes(str(i.status)))
    .reduce((sum, i) => sum + (typeof i.balanceCents === 'number' ? i.balanceCents : 0), 0)
}
