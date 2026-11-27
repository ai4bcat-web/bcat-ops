/**
 * Auto shipper loads (Ryne 2026-11-27): every shipment of the AUTO SHIPPER customer on one page under CAR SHIPPING, with what
 * the customer still owes and what each carrier is owed, so the office can see at a glance which loads have money outstanding
 * and which carriers need paying or have been paid.
 *
 * Pure: the page hands in what it read; this file decides. Customer money comes from the AR invoice (the order's cached AR
 * fields are the fallback), carrier money from the same recorded bills the Payables page works, so the two pages cannot
 * disagree. Carrier payment still runs through the regular AP screens: nothing here pays a carrier.
 *
 * Money is access-gated here, not only on screen: with no AR access the rows carry no price or customer payment, with no AP
 * access no carrier money, so a view built for someone without the grant has nothing to leak.
 */
import { daysLate } from '@/lib/arAging'
import { squareStatusLabel, isSquareChannel, type CarShippingData, type SquareInvoiceStatus } from '@/lib/squareInvoicing'
import { payeeLabel } from '@/features/ap/apViews'
import { AP_FROM_AUTO_SHIPPER, openBillPath, payBillPath, recordLegBillPath } from '@/features/ap/apLinks'
import { recordPaymentPath } from '@/features/payments/links'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type {
  CarrierBillRecord, CustomerRecord, InvoiceRecord, LoadCarrierRecord, OrderRecord, ShipmentRecord, ShipmentStatus,
} from '@/types/tms'

/** The customer record every auto shipment sits under. The real payer is on `Shipment.carShipping`. */
const AUTO_SHIPPER_KEY = 'AUTOSHIPPER'

const keyOf = (name: string | null | undefined): string => (name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The one place that says which customers are auto shippers: the customer an admin switched to the Square invoice channel,
 * or the one named AUTO SHIPPER. Every match on this page goes through here.
 */
export function isAutoShipperCustomer(customer: Pick<CustomerRecord, 'name' | 'invoiceChannel'> | null | undefined): boolean {
  if (!customer) return false
  return isSquareChannel(customer) || keyOf(customer.name) === AUTO_SHIPPER_KEY
}

/** A shipment of one of those customers (by id), or one still named AUTO SHIPPER with no customer resolved. */
export function isAutoShipperShipment(
  shipment: Pick<ShipmentRecord, 'customerId' | 'customerName'>,
  autoShipperCustomerIds: ReadonlySet<string>,
): boolean {
  if (shipment.customerId && autoShipperCustomerIds.has(shipment.customerId)) return true
  return !shipment.customerId && keyOf(shipment.customerName) === AUTO_SHIPPER_KEY
}

// ── Customer side ───────────────────────────────────────────────────────────

export type CustomerPayState = 'NOT_INVOICED' | 'UNPAID' | 'PARTIAL' | 'PAID'

export const CUSTOMER_PAY_LABEL: Record<CustomerPayState, string> = {
  NOT_INVOICED: 'Not invoiced',
  UNPAID: 'Invoiced, unpaid',
  PARTIAL: 'Partly paid',
  PAID: 'Paid',
}

export interface CustomerPay {
  state: CustomerPayState
  invoiceNumber: string | null
  invoiceId: string | null
  totalCents: number
  paidCents: number
  /** What the customer still owes: the invoice balance, or the whole price while nothing is invoiced. */
  owedCents: number
  /** YYYY-MM-DD the invoice was dated; null until it is invoiced. */
  invoiceDate: string | null
  /** Whole days since the invoice date while money is owed on it; null otherwise. */
  daysOutstanding: number | null
  /** What Square last said, once the Square invoice exists (Phase 2 writes it on `carShipping.square`). */
  squareStatus: SquareInvoiceStatus | null
  squareLabel: string | null
}

/** The live invoice of a shipment: not void, the latest issued. */
function liveInvoice(invoices: readonly InvoiceRecord[]): InvoiceRecord | null {
  let best: InvoiceRecord | null = null
  for (const inv of invoices) {
    if (inv.status === 'VOID') continue
    if (!best || inv.issuedAt > best.issuedAt) best = inv
  }
  return best
}

function customerPayFor(
  price: number,
  invoices: readonly InvoiceRecord[],
  order: OrderRecord | undefined,
  car: CarShippingData | null | undefined,
  asOf: string,
): CustomerPay {
  const squareStatus = car?.square?.status ?? null
  const squareLabel = squareStatus ? squareStatusLabel(squareStatus) : null
  const inv = liveInvoice(invoices)
  if (inv) {
    const state: CustomerPayState = inv.status === 'PAID' || inv.balanceCents <= 0 ? 'PAID' : inv.paidCents > 0 ? 'PARTIAL' : 'UNPAID'
    return {
      state,
      invoiceNumber: inv.number,
      invoiceId: inv.id,
      totalCents: inv.totalCents,
      paidCents: inv.paidCents,
      owedCents: state === 'PAID' ? 0 : Math.max(0, inv.balanceCents),
      invoiceDate: inv.invoiceDate,
      daysOutstanding: state === 'PAID' ? null : Math.max(0, daysLate(inv.invoiceDate, asOf)),
      squareStatus,
      squareLabel,
    }
  }
  // No invoice read for this shipment: fall back to what the order cached when it was invoiced.
  if (order?.invoiceId || order?.invoiceNumber) {
    if (order.arStatus === 'PAID') {
      return { state: 'PAID', invoiceNumber: order.invoiceNumber ?? null, invoiceId: order.invoiceId ?? null, totalCents: price, paidCents: price, owedCents: 0, invoiceDate: null, daysOutstanding: null, squareStatus, squareLabel }
    }
    const owed = Math.max(0, order.arBalanceCents ?? price)
    const date = order.invoicedAt ? order.invoicedAt.slice(0, 10) : null
    return {
      state: owed < price && owed > 0 ? 'PARTIAL' : 'UNPAID',
      invoiceNumber: order.invoiceNumber ?? null,
      invoiceId: order.invoiceId ?? null,
      totalCents: price,
      paidCents: Math.max(0, price - owed),
      owedCents: owed,
      invoiceDate: date,
      daysOutstanding: date ? Math.max(0, daysLate(date, asOf)) : null,
      squareStatus,
      squareLabel,
    }
  }
  return { state: 'NOT_INVOICED', invoiceNumber: null, invoiceId: null, totalCents: price, paidCents: 0, owedCents: price, invoiceDate: null, daysOutstanding: null, squareStatus, squareLabel }
}

// ── Carrier side ────────────────────────────────────────────────────────────

/** Where one carrier's money stands, read off the recorded bill the Payables page works. */
export type CarrierPayState = 'NO_BILL' | 'BILL_RECORDED' | 'APPROVED' | 'SCHEDULED' | 'PARTIAL' | 'PAID' | 'OWN_TRUCK'

export const CARRIER_PAY_LABEL: Record<CarrierPayState, string> = {
  NO_BILL: 'No bill yet',
  BILL_RECORDED: 'Bill recorded',
  APPROVED: 'Approved to pay',
  SCHEDULED: 'Scheduled to pay',
  PARTIAL: 'Partly paid',
  PAID: 'Paid',
  OWN_TRUCK: 'Own truck',
}

export interface CarrierPay {
  legId: string
  carrierId: string | null
  carrierName: string
  state: CarrierPayState
  /** The bill's net, else the leg's carrier rate. Internal: never on any customer output. */
  amountCents: number | null
  /** What is still owed to this carrier on this load (0 once paid or for an own truck). */
  owedCents: number
  paidAt: string | null
  /** Who the money goes to (the factor, the carrier, or the payee frozen on the bill); null with no bill. */
  payTo: string | null
  billId: string | null
}

const UNPAID_CARRIER: ReadonlySet<CarrierPayState> = new Set(['NO_BILL', 'BILL_RECORDED', 'APPROVED', 'SCHEDULED', 'PARTIAL'])

/** The bill that stands for a leg: a live (not void) one, the most recently recorded. */
function liveBill(bills: readonly CarrierBillRecord[]): CarrierBillRecord | null {
  let best: CarrierBillRecord | null = null
  for (const bill of bills) {
    if (bill.status === 'VOID') continue
    if (!best || bill.recordedAt > best.recordedAt) best = bill
  }
  return best
}

function carrierPayFor(leg: LoadCarrierRecord, bills: readonly CarrierBillRecord[], payTo: (bill: CarrierBillRecord) => string): CarrierPay {
  const carrierName = (leg.carrierName ?? leg.driverName ?? '').trim() || 'Carrier'
  const base = { legId: leg.id, carrierId: leg.carrierId ?? null, carrierName }
  if (leg.kind === 'OWN_ASSET') {
    return { ...base, carrierName: (leg.driverName ?? leg.truckNumber ?? carrierName).toString() || 'Own truck', state: 'OWN_TRUCK', amountCents: null, owedCents: 0, paidAt: null, payTo: null, billId: null }
  }
  const bill = liveBill(bills)
  if (!bill) {
    const rate = leg.carrierRateCents ?? leg.costCents ?? null
    // The leg's own AP rung can be ahead of the bill list (a paid leg whose bill sits past the read window).
    if (leg.apStatus === 'PAID') {
      return { ...base, state: 'PAID', amountCents: rate, owedCents: 0, paidAt: leg.apPaidAt ?? null, payTo: null, billId: null }
    }
    return { ...base, state: 'NO_BILL', amountCents: rate, owedCents: rate ?? 0, paidAt: null, payTo: null, billId: null }
  }
  let state: CarrierPayState
  if (bill.status === 'PAID') state = 'PAID'
  else if (bill.status === 'PARTIAL') state = 'PARTIAL'
  else if (bill.status === 'TO_BE_PAID') state = bill.selectedForPayment ? 'SCHEDULED' : 'APPROVED'
  else state = 'BILL_RECORDED'
  return {
    ...base,
    state,
    amountCents: bill.netCents,
    owedCents: state === 'PAID' ? 0 : Math.max(0, bill.balanceCents),
    paidAt: bill.paidAt ?? null,
    payTo: payTo(bill),
    billId: bill.id,
  }
}

/** One load's carrier money in a word: nothing to pay, all paid, or something still owed. */
export type CarrierRollup = 'NO_CARRIER' | 'OWN_TRUCK' | 'UNPAID' | 'PAID'

export const CARRIER_ROLLUP_LABEL: Record<CarrierRollup, string> = {
  NO_CARRIER: 'No carrier',
  OWN_TRUCK: 'Own truck',
  UNPAID: 'Carrier unpaid',
  PAID: 'Carrier paid',
}

export function carrierRollupOf(carriers: readonly CarrierPay[]): CarrierRollup {
  if (carriers.length === 0) return 'NO_CARRIER'
  const payable = carriers.filter((c) => c.state !== 'OWN_TRUCK')
  if (payable.length === 0) return 'OWN_TRUCK'
  return payable.some((c) => UNPAID_CARRIER.has(c.state)) ? 'UNPAID' : 'PAID'
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface AutoShipperRow {
  /** The shipment id. */
  id: string
  pro: string
  /** The customer record the shipment sits under (AUTO SHIPPER); Mark paid hands it to Payments Received. */
  customerId: string | null
  /** The real payer (company, else name) off `carShipping`; the customer's own name when none was entered. */
  payer: string
  /** YYYY-MM-DD, or null. */
  pickup: string | null
  delivery: string | null
  route: string
  vehicle: string
  status: ShipmentStatus
  delivered: boolean
  /** Customer price; null when the viewer has no AR access. */
  priceCents: number | null
  /** Null when the viewer has no AR access. */
  customer: CustomerPay | null
  /** Null when the viewer has no AP access. */
  carriers: CarrierPay[] | null
  /** Null when the viewer has no AP access. */
  carrierRollup: CarrierRollup | null
}

export interface AutoShipperInput {
  shipments: readonly ShipmentRecord[]
  orders: readonly OrderRecord[]
  invoices: readonly InvoiceRecord[]
  legs: readonly LoadCarrierRecord[]
  bills: readonly CarrierBillRecord[]
  /** `shipmentId` -> the car-shipping details (payer, vehicle, Square) the page read for it. */
  carShipping: ReadonlyMap<string, CarShippingData | null>
  /** The payee label for a bill (the Payables page's own `payeeNameFor`, with the live payment methods). */
  payTo?: (bill: CarrierBillRecord) => string
  asOf: string
  /** The viewer holds the AR grant: only then do rows carry a price or a customer payment. */
  showAr: boolean
  /** The viewer holds the AP grant: only then do rows carry any carrier money. */
  showAp: boolean
}

const ymd = (iso: string | null | undefined): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null)

function group<T>(rows: readonly T[], keyFor: (row: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyFor(row)
    if (!key) continue
    const list = out.get(key)
    if (list) list.push(row)
    else out.set(key, [row])
  }
  return out
}

export function vehicleText(car: CarShippingData | null | undefined): string {
  const v = car?.vehicle
  if (!v) return ''
  return [v.year, v.make, v.model].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
}

export function payerText(car: CarShippingData | null | undefined, customerName: string | null | undefined): string {
  const payer = car?.payer
  const named = (payer?.company ?? '').trim() || (payer?.name ?? '').trim()
  return named || (customerName ?? '').trim()
}

export function buildAutoShipperRows(input: AutoShipperInput): AutoShipperRow[] {
  const { asOf, showAr, showAp } = input
  const orderByShipment = new Map<string, OrderRecord>()
  for (const o of input.orders) if (o.shipmentId && !orderByShipment.has(o.shipmentId)) orderByShipment.set(o.shipmentId, o)
  const invoicesByShipment = group(input.invoices, (i) => i.shipmentId)
  const legsByShipment = group(input.legs.filter((l) => l.status === 'ACTIVE'), (l) => l.shipmentId)
  const billsByLeg = group(input.bills, (b) => b.loadCarrierId)
  const payTo = input.payTo ?? ((bill: CarrierBillRecord) => payeeLabel(bill))

  const rows: AutoShipperRow[] = []
  for (const s of input.shipments) {
    if (s.voidedAt || s.status === 'CANCELED') continue
    const car = input.carShipping.get(s.id) ?? null
    const order = orderByShipment.get(s.id)
    const price = order?.revenueCents ?? order?.customerRateCents ?? 0
    const carriers = showAp
      ? (legsByShipment.get(s.id) ?? [])
        .filter((l) => l.kind === 'OWN_ASSET' || l.carrierId || l.carrierName)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((leg) => carrierPayFor(leg, billsByLeg.get(leg.id) ?? [], payTo))
      : null
    const origin = (s.originCity ?? '').trim()
    const dest = (s.destinationCity ?? '').trim()
    rows.push({
      id: s.id,
      pro: s.number,
      customerId: s.customerId ?? order?.customerId ?? null,
      payer: payerText(car, s.customerName ?? order?.customerName),
      pickup: ymd(s.pickupAppt),
      delivery: ymd(s.deliveryAppt),
      route: origin || dest ? `${origin || '?'} → ${dest || '?'}` : '',
      vehicle: vehicleText(car),
      status: s.status,
      delivered: s.status === 'DELIVERED' || Boolean(s.deliveredAt),
      priceCents: showAr ? price : null,
      customer: showAr ? customerPayFor(price, invoicesByShipment.get(s.id) ?? [], order, car, asOf) : null,
      carriers,
      carrierRollup: carriers ? carrierRollupOf(carriers) : null,
    })
  }
  // Newest pickup first; a load with no date sinks.
  return rows.sort((a, b) => (b.pickup ?? '').localeCompare(a.pickup ?? '') || b.pro.localeCompare(a.pro, undefined, { numeric: true }))
}

// ── Views ───────────────────────────────────────────────────────────────────

export type AutoShipperTab = 'all' | 'customer-unpaid' | 'carrier-unpaid' | 'paid'

export const AUTO_SHIPPER_TABS: ReadonlyArray<{ key: AutoShipperTab; label: string; title: string }> = [
  { key: 'all', label: 'All', title: 'Every auto shipper load' },
  { key: 'customer-unpaid', label: 'Customer unpaid', title: 'The customer has not paid in full: not invoiced yet, invoiced and unpaid, or partly paid' },
  { key: 'carrier-unpaid', label: 'Carrier unpaid', title: 'A carrier on the load has not been paid in full' },
  { key: 'paid', label: 'Both paid', title: 'The customer paid in full and every carrier is paid (or it is an own truck)' },
]

export function customerUnpaid(row: AutoShipperRow): boolean {
  return row.customer != null && row.customer.state !== 'PAID'
}

export function carrierUnpaid(row: AutoShipperRow): boolean {
  return row.carrierRollup === 'UNPAID'
}

export function bothPaid(row: AutoShipperRow): boolean {
  const customerPaid = row.customer?.state === 'PAID'
  const carrierPaid = row.carrierRollup === 'PAID' || row.carrierRollup === 'OWN_TRUCK'
  return customerPaid && carrierPaid
}

/** What each tab shows. A tab needing money the viewer cannot see is empty: the page does not offer it. */
export function inTab(row: AutoShipperRow, tab: AutoShipperTab): boolean {
  switch (tab) {
    case 'all': return true
    case 'customer-unpaid': return customerUnpaid(row)
    case 'carrier-unpaid': return carrierUnpaid(row)
    case 'paid': return bothPaid(row)
  }
}

export function tabCounts(rows: readonly AutoShipperRow[]): Record<AutoShipperTab, number> {
  return {
    all: rows.length,
    'customer-unpaid': rows.filter(customerUnpaid).length,
    'carrier-unpaid': rows.filter(carrierUnpaid).length,
    paid: rows.filter(bothPaid).length,
  }
}

export type DateRangeKey = 'all' | 'month' | 'last30' | 'last90' | 'year'

export const DATE_RANGE_OPTIONS: ReadonlyArray<{ key: DateRangeKey; label: string }> = [
  { key: 'all', label: 'All dates' },
  { key: 'month', label: 'This month' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'year', label: 'This year' },
]

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** The first pickup day a range keeps (inclusive), or null for all dates. */
export function rangeStart(range: DateRangeKey, asOf: string): string | null {
  switch (range) {
    case 'all': return null
    case 'month': return `${asOf.slice(0, 7)}-01`
    case 'last30': return addDays(asOf, -30)
    case 'last90': return addDays(asOf, -90)
    case 'year': return `${asOf.slice(0, 4)}-01-01`
  }
}

/** A load with no pickup date is always kept: dropping it would hide money still owed. */
export function inRange(row: AutoShipperRow, range: DateRangeKey, asOf: string): boolean {
  const start = rangeStart(range, asOf)
  if (!start || !row.pickup) return true
  return row.pickup >= start
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface AutoShipperSummary {
  /** Loads the customer still owes on, and the dollars (an uninvoiced load counts at its whole price). */
  customersOwe: { count: number; cents: number }
  /** Of those, loads not invoiced yet. */
  notInvoiced: number
  /** Delivered loads with a carrier still to pay, and what is owed them. */
  carriersToPay: { count: number; cents: number }
  /** Loads whose every carrier is paid. */
  carriersPaid: number
}

/** What the load's carriers are paid in all: the recorded bill amounts, else the carrier rate. Null with no AP access, no carrier, or an own truck only. */
export function carrierPayCents(row: Pick<AutoShipperRow, 'carriers'>): number | null {
  const payable = (row.carriers ?? []).filter((c) => c.state !== 'OWN_TRUCK' && c.amountCents != null)
  return payable.length === 0 ? null : payable.reduce((sum, c) => sum + (c.amountCents ?? 0), 0)
}

/** The carrier pay of the rows shown, for the strip above the grid. */
export function carrierPayTotal(rows: readonly AutoShipperRow[]): { cents: number; count: number } {
  let cents = 0
  let count = 0
  for (const r of rows) {
    const c = carrierPayCents(r)
    if (c != null) { cents += c; count += 1 }
  }
  return { cents, count }
}

export function summarize(rows: readonly AutoShipperRow[]): AutoShipperSummary {
  const out: AutoShipperSummary = { customersOwe: { count: 0, cents: 0 }, notInvoiced: 0, carriersToPay: { count: 0, cents: 0 }, carriersPaid: 0 }
  for (const row of rows) {
    if (customerUnpaid(row) && row.customer) {
      out.customersOwe.count += 1
      out.customersOwe.cents += row.customer.owedCents
      if (row.customer.state === 'NOT_INVOICED') out.notInvoiced += 1
    }
    if (carrierUnpaid(row) && row.delivered && row.carriers) {
      out.carriersToPay.count += 1
      out.carriersToPay.cents += row.carriers.filter((c) => UNPAID_CARRIER.has(c.state)).reduce((sum, c) => sum + c.owedCents, 0)
    }
    if (row.carrierRollup === 'PAID') out.carriersPaid += 1
  }
  return out
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function cell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const dollars = (cents: number | null | undefined): string => (cents == null ? '' : (cents / 100).toFixed(2))

/** The filtered view as a CSV. Money columns appear only for a viewer who may see that money. */
export function autoShipperCsv(rows: readonly AutoShipperRow[], opts: { showAr: boolean; showAp: boolean }): string {
  const header = ['PRO', 'Payer', 'Pickup', 'Delivery', 'Route', 'Vehicle', 'Shipment status']
  if (opts.showAr) header.push('Customer price', 'Customer payment', 'Invoice', 'Customer owes', 'Days outstanding', 'Square status')
  if (opts.showAp) header.push('Carrier', 'Carrier payment', 'Pay to', 'Carrier pay', 'Carrier owed', 'Carrier paid on')
  const lines = [header.map(cell).join(',')]
  for (const r of rows) {
    const base: Array<string | number | null> = [r.pro, r.payer, r.pickup, r.delivery, r.route, r.vehicle, r.status]
    if (opts.showAr) {
      const c = r.customer
      base.push(dollars(r.priceCents), c ? CUSTOMER_PAY_LABEL[c.state] : '', c?.invoiceNumber ?? '', dollars(c?.owedCents), c?.daysOutstanding ?? '', c?.squareLabel ?? '')
    }
    if (opts.showAp) {
      const legs = r.carriers ?? []
      base.push(
        legs.map((c) => c.carrierName).join('; '),
        legs.length ? legs.map((c) => CARRIER_PAY_LABEL[c.state]).join('; ') : CARRIER_ROLLUP_LABEL.NO_CARRIER,
        legs.map((c) => c.payTo ?? '').filter(Boolean).join('; '),
        legs.map((c) => dollars(c.amountCents)).filter(Boolean).join('; '),
        legs.map((c) => dollars(c.owedCents)).filter(Boolean).join('; '),
        legs.map((c) => c.paidAt?.slice(0, 10) ?? '').filter(Boolean).join('; '),
      )
    }
    lines.push(base.map(cell).join(','))
  }
  return lines.join('\r\n')
}


// ── Row actions (Ryne 2026-11-27) ───────────────────────────────────────────
// Nothing is paid on this page. Each action is a link to the one place the money is recorded: Payments Received for a customer
// payment, Accounts Payable for a carrier, each opened on the right invoice or bill.

export interface RowAction {
  label: string
  /** Where the button goes; null when there is nothing to open yet. */
  to: string | null
  /** Why there is no button (or what it does), shown under or beside it. */
  note: string | null
  /** A second link for a blocked action (Not invoiced yet -> Mark invoiced). */
  helpTo?: string
  helpLabel?: string
}

/** Receivables, opened on the Ready to invoice tab where Mark invoiced lives. */
const READY_TO_INVOICE_PATH = '/tms/invoicing?tab=ready'

/** The customer side: Mark paid for an open invoice, Not invoiced yet (with the way to invoice it), or nothing once paid. */
export function customerAction(row: Pick<AutoShipperRow, 'customer' | 'customerId'>): RowAction | null {
  const c = row.customer
  if (!c || c.state === 'PAID') return null
  if (c.state === 'NOT_INVOICED') {
    return { label: 'Not invoiced yet', to: null, note: 'Invoice it first, then record the payment.', helpTo: READY_TO_INVOICE_PATH, helpLabel: 'Mark invoiced' }
  }
  if (!row.customerId) return { label: 'Mark paid', to: null, note: 'This load has no customer on it, so Payments Received cannot be opened on it.' }
  const base = recordPaymentPath({ customerId: row.customerId, invoiceId: c.invoiceId })
  return { label: 'Mark paid', to: `${base}&from=${AP_FROM_AUTO_SHIPPER}`, note: null }
}

/** The carrier side, one carrier on the load: record the bill, approve it, or pay it, in Accounts Payable. */
export function carrierAction(carrier: CarrierPay, shipmentId: string): RowAction | null {
  if (carrier.state === 'OWN_TRUCK' || carrier.state === 'PAID') return null
  if (carrier.state === 'NO_BILL') {
    return carrier.legId
      ? { label: 'Record bill', to: recordLegBillPath(carrier.legId, AP_FROM_AUTO_SHIPPER), note: 'No carrier bill yet. Record it in Accounts Payable, then pay it.' }
      : { label: 'Record bill', to: `${shipmentEditorPath(shipmentId)}?tab=carrierPay`, note: null }
  }
  if (!carrier.billId) return { label: 'Pay carrier', to: `${shipmentEditorPath(shipmentId)}?tab=carrierPay`, note: null }
  if (carrier.state === 'BILL_RECORDED') {
    return { label: 'Review bill', to: openBillPath(carrier.billId, AP_FROM_AUTO_SHIPPER), note: 'The bill is still in review. Approve it in Accounts Payable, then pay it.' }
  }
  return { label: 'Pay carrier', to: payBillPath(carrier.billId, AP_FROM_AUTO_SHIPPER), note: null }
}
