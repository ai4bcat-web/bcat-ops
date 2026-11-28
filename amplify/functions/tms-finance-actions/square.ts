/**
 * Auto shipper → Square (Ryne 2026-11-27): the finance side.
 *
 * A shipment for a customer on the Square channel is invoiced through Square. This file is the only place that
 * talks to Square: it creates the Square customer, order and DRAFT invoice (the moment the shipment is saved), sends
 * the invoice when someone clicks Send, and reads status and payments back so AR stays accurate.
 *
 *  - The shipment is created first and never rolled back by Square. Each Square id is written onto
 *    `Shipment.carShipping.square` the moment Square returns it, so a retry resumes where it stopped, and every Square
 *    call carries an idempotency key derived from the shipment and the step so a retry can never make a second object.
 *  - Square is the truth for what happened to the invoice. The webhook (and the Sync button) only say "look again":
 *    `syncSquare` re-reads the invoice from Square and applies what it says, so duplicate or out-of-order deliveries
 *    are harmless.
 *  - Sending the invoice writes the BCAT `Invoice` (number = PRO, `external.provider = SQUARE`) so AR, aging and the
 *    payment ledger stay whole. It is never rendered or e-mailed from the standard template.
 *  - Nothing carrier-side ever goes into a request: the bodies come from `squareInvoicing.ts`, and `assertClean` runs
 *    `squareBodyLeaks` over every body before it is sent.
 *  - The access token and the webhook key are read from the integration store and never logged, returned or stored on
 *    a shipment. An error message from Square is redacted of the token before it leaves.
 */
import { assertString, type Caller } from '../_shared/actionInputs'
import {
  dateOnly,
  invoiceDescription,
  mirrorActionFor,
  normalizeCarShipping,
  squareCustomerBody,
  squareInvoiceBody,
  squareInvoiceNumber,
  squareOrderBody,
  isSquareChannel,
  type AcceptedMethods,
  type CarShippingData,
  type CarShippingSquare,
  type SquareEnvironment,
} from '../../../src/lib/squareInvoicing'
import {
  CUSTOMER_TABLE_NAME,
  INVOICE_TABLE_NAME,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  LOAD_FINANCIALS_TABLE_NAME,
  LOAD_TABLE_NAME,
  NULL_TYPE_VALUE,
  ORDER_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  callShipmentActions,
  nowIso,
  putTx,
  queryIndex,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { buildSnapshot, readOrderContext, voidInvoice } from './invoices'
import { recordPayment } from './payments'

// ── configuration and the HTTP call ─────────────────────────────────────────
//
// This Lambda decides WHAT to send to Square and records what comes back. It never holds the access token: every Square call goes
// through tms-shipment-actions' system-caller door (`SQUARE_API`, see _shared/squareApi.ts), which already holds the Integration
// read and the credential read. That keeps this Lambda's role and environment exactly as they were: both Lambdas sit in the data
// stack, whose CloudFormation template is within a few hundred bytes of the 1,000,000-byte cap.

export interface SquareConfig {
  environment: SquareEnvironment
  locationId: string
  enabled: boolean
  methods: AcceptedMethods
}

/** How a Square request is made. The default asks the shipment router; tests swap in a fake Square. */
export interface SquareTransport {
  context(): Promise<Row>
  call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Row>
}
const routerTransport: SquareTransport = {
  context: () => callShipmentActions('SQUARE_API', { op: 'CONTEXT' }),
  call: (method, path, body) => callShipmentActions('SQUARE_API', { op: 'CALL', method, path, ...(body !== undefined ? { body } : {}) }),
}
let transport: SquareTransport = routerTransport
/** Test hook: every Square request goes through this. */
export function setSquareTransport(impl: SquareTransport | null): void {
  transport = impl ?? routerTransport
}

/** The system identity the webhook and the sync act as. Never a person; the audit says so. */
export const SQUARE_SYSTEM_CALLER: Caller = { email: 'square-sync@system', sub: 'square-sync', groups: ['ADMIN'], isAdmin: true }

function asJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T } catch { return null }
  }
  return typeof value === 'object' ? (value as T) : null
}

/** The Integrations page's SQUARE settings for the ACTIVE environment (no secret in it). Throws a sentence a person can act on. */
export async function loadSquareConfig(): Promise<SquareConfig> {
  const ctx = await transport.context()
  if (ctx.connected !== true) throw new Error(String(ctx.reason ?? 'Square is not connected'))
  return {
    environment: ctx.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    locationId: String(ctx.locationId),
    enabled: ctx.enabled === true,
    methods: (ctx.methods ?? {}) as AcceptedMethods,
  }
}

export class SquareApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SquareApiError'
    this.status = status
  }
}

async function sq<T = Row>(_cfg: SquareConfig, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const answer = await transport.call(method, path, body)
  const status = Number(answer.status ?? 0)
  if (status === 0) throw new Error(String(answer.error ?? 'Could not reach Square; try again'))
  if (status < 200 || status >= 300) {
    const errors = Array.isArray((answer.json as Row | undefined)?.errors) ? ((answer.json as Row).errors as Array<{ code?: string; detail?: string }>) : []
    const detail = errors.map((e) => [e.code, e.detail].filter(Boolean).join(': ')).filter(Boolean).join('; ') || String(answer.text ?? '') || `HTTP ${status}`
    throw new SquareApiError(`Square refused the request (${status}): ${detail}`, status)
  }
  return (answer.json ?? {}) as T
}

// ── the shipment's side ─────────────────────────────────────────────────────

interface ShipmentCtx {
  shipmentId: string
  shipment: Row
  data: CarShippingData
  pro: string
  order: Row
  amountCents: number
  route: { pickup: string; delivery: string }
  serviceDate: string | null
}

function stopCity(stops: unknown, type: 'pickup' | 'delivery'): string {
  const list = asJson<Array<{ type?: string; city?: string | null; state?: string | null }>>(stops) ?? []
  const pick = type === 'pickup' ? list.find((s) => s.type === 'pickup') : [...list].reverse().find((s) => s.type === 'delivery')
  return [pick?.city, pick && pick.city && !String(pick.city).includes(',') ? pick.state : null].filter(Boolean).join(', ')
}

async function readShipmentCtx(shipmentId: string): Promise<ShipmentCtx> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const data = asJson<CarShippingData>(shipment.carShipping)
  if (!data?.payer || !data.vehicle) throw new Error('This shipment has no auto shipper details (payer and vehicle): add them first')
  const customer = shipment.customerId ? await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId)) : null
  if (!isSquareChannel(customer as { invoiceChannel?: string | null } | null)) {
    throw new Error('This shipment\'s customer is not invoiced through Square')
  }
  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const order = orders.find((o) => !o.voidedAt) ?? orders[0]
  if (!order) throw new Error('This shipment has no order to invoice')
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const first = loads[0]
  const amountCents = Number(order.customerRateCents ?? order.revenueCents ?? 0)
  const pro = String(shipment.number ?? '').trim()
  if (!pro) throw new Error('This shipment has no PRO number to invoice under')
  return {
    shipmentId,
    shipment,
    data,
    pro,
    order,
    amountCents,
    route: { pickup: stopCity(first?.stops, 'pickup'), delivery: stopCity(first?.stops, 'delivery') },
    serviceDate: dateOnly(String(shipment.pickupAppt ?? first?.pickupAppt ?? '')),
  }
}

/** Merge into `carShipping.square` and write it back. Read-modify-write on the one field; no version bump (a person editing is not conflicted). */
async function saveSquare(ctx: ShipmentCtx, patch: Partial<CarShippingSquare>, remove: Array<keyof CarShippingSquare> = []): Promise<CarShippingSquare> {
  const fresh = await getById(SHIPMENT_TABLE_NAME, ctx.shipmentId)
  const current = asJson<CarShippingData>(fresh?.carShipping) ?? ctx.data
  const square: CarShippingSquare = { ...(current.square ?? {}), ...patch }
  for (const key of remove) delete square[key]
  const next: CarShippingData = { ...current, square }
  await transact(
    [updateTx(SHIPMENT_TABLE_NAME, ctx.shipmentId, { carShipping: next as unknown as Row, updatedAt: nowIso() }, { condition: 'attribute_exists(id)' })],
    'shipment square state',
  )
  ctx.data = next
  return square
}

async function recordError(ctx: ShipmentCtx, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 400)
  try { await saveSquare(ctx, { lastError: message, lastErrorAt: nowIso() }) } catch { /* the original error is the one to report */ }
}

function invoiceNumberFor(ctx: ShipmentCtx): string {
  return squareInvoiceNumber(ctx.pro, ctx.data.square?.reissue ?? 0)
}

// ── actions ─────────────────────────────────────────────────────────────────

interface SquareInvoiceObj {
  id?: string
  version?: number
  status?: string
  public_url?: string
  order_id?: string
  payment_requests?: Array<{ total_completed_amount_money?: { amount?: number } }>
}

/**
 * Make the Square customer, order and DRAFT invoice for a shipment. Resumes from whatever was already made; a price
 * change on a still-draft invoice rebuilds the draft. Never sends anything to the payer.
 */
export async function createSquareInvoice(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const cfg = await loadSquareConfig()
  if (!cfg.enabled) return { skipped: 'Square invoicing is off. Turn on "Create Square invoices for auto shipper shipments" on Integrations → Square.' }
  const ctx = await readShipmentCtx(shipmentId)
  const checked = normalizeCarShipping(ctx.data)
  if (!checked.ok) throw new Error(checked.error)
  if (!(ctx.amountCents > 0)) throw new Error('The shipment has no price yet: the price is the amount on the Square invoice')

  try {
    let state = ctx.data.square ?? {}
    if (state.invoiceId && state.environment && state.environment !== cfg.environment) {
      throw new Error(`This shipment's Square invoice was made in ${state.environment}. Switch the active environment on Integrations → Square back to ${state.environment} to work with it.`)
    }
    if (state.invoiceId) {
      const stale = state.status === 'DRAFT' && state.amountCents != null && state.amountCents !== ctx.amountCents
      if (!stale) return { square: state, existing: true }
      // The price changed while the invoice was still a draft: drop the draft and build it again at the new price.
      try { await sq(cfg, 'DELETE', `/v2/invoices/${state.invoiceId}?version=${state.invoiceVersion ?? 0}`) } catch (err) {
        if (!(err instanceof SquareApiError && err.status === 404)) throw err
      }
      state = await saveSquare(ctx, { gen: (state.gen ?? 0) + 1 }, ['invoiceId', 'orderId', 'invoiceVersion', 'status', 'publicUrl', 'amountCents'])
    }
    const gen = state.gen ?? 0
    const description = invoiceDescription(ctx.data.vehicle, ctx.route)

    if (!state.customerId) {
      const made = await sq<{ customer?: { id?: string } }>(cfg, 'POST', '/v2/customers', squareCustomerBody(ctx.data.payer, shipmentId, ctx.pro))
      const customerId = made.customer?.id
      if (!customerId) throw new Error('Square did not return a customer id')
      state = await saveSquare(ctx, { environment: cfg.environment, customerId, lastError: null })
    }
    if (!state.orderId) {
      const made = await sq<{ order?: { id?: string } }>(cfg, 'POST', '/v2/orders', squareOrderBody({
        locationId: cfg.locationId, customerId: state.customerId as string, pro: ctx.pro, shipmentId, amountCents: ctx.amountCents, description, gen,
      }))
      const orderId = made.order?.id
      if (!orderId) throw new Error('Square did not return an order id')
      state = await saveSquare(ctx, { orderId })
    }
    if (!state.invoiceId) {
      const today = nowIso().slice(0, 10)
      const made = await sq<{ invoice?: SquareInvoiceObj }>(cfg, 'POST', '/v2/invoices', squareInvoiceBody({
        locationId: cfg.locationId, orderId: state.orderId as string, customerId: state.customerId as string,
        invoiceNumber: invoiceNumberFor(ctx), shipmentId, serviceDate: ctx.serviceDate, dueDate: today, description, methods: cfg.methods, gen,
      }))
      const inv = made.invoice
      if (!inv?.id) throw new Error('Square did not return an invoice id')
      state = await saveSquare(ctx, {
        invoiceId: inv.id, invoiceVersion: inv.version ?? 0, status: (inv.status ?? 'DRAFT') as CarShippingSquare['status'],
        amountCents: ctx.amountCents, invoiceNumber: invoiceNumberFor(ctx), lastError: null, lastErrorAt: null,
      })
    }
    await writeAudit('Shipment', shipmentId, 'SQUARE_CREATE_DRAFT', caller, { environment: cfg.environment, invoiceId: state.invoiceId, invoiceNumber: state.invoiceNumber, amountCents: ctx.amountCents })
    return { square: state }
  } catch (err) {
    await recordError(ctx, err)
    throw err
  }
}

/** The BCAT invoice behind a published Square invoice: AR, aging and the ledger need it. Written once; never rendered from the standard template. */
async function mirrorInvoice(ctx: ShipmentCtx, state: CarShippingSquare, caller: Caller): Promise<string> {
  if (state.bcatInvoiceId) return state.bcatInvoiceId
  const context = await readOrderContext(String(ctx.order.id))
  const number = invoiceNumberFor(ctx)
  const today = nowIso().slice(0, 10)
  const now = nowIso()
  const { invoice } = buildSnapshot(context, { number, invoiceDate: today, dueAt: today, billToId: null, note: null, attachDocumentIds: [] }, caller, now)
  if (invoice.totalCents !== ctx.amountCents) {
    throw new Error(`The charges on the shipment ($${(invoice.totalCents / 100).toFixed(2)}) no longer match the Square invoice ($${(ctx.amountCents / 100).toFixed(2)}): reissue the invoice`)
  }
  const payerName = ctx.data.payer.company?.trim() || ctx.data.payer.name
  const row: Row = {
    ...(invoice as unknown as Row),
    __typename: 'Invoice',
    billTo: { name: payerName, address: null, email: ctx.data.payer.email },
    factored: false,
    attachDocumentIds: [],
    external: { provider: 'SQUARE', invoiceId: state.invoiceId ?? '', orderId: state.orderId ?? null, publicUrl: state.publicUrl ?? null },
    sentCount: 1,
    createdAt: now,
    updatedAt: now,
  }
  const writes = [
    putTx(INVOICE_TABLE_NAME, row),
    updateTx(
      ORDER_TABLE_NAME,
      String(ctx.order.id),
      {
        arStatus: 'UNPAID', arStatusChangedAt: now, invoiceId: invoice.id, invoiceNumber: invoice.number, invoicedAt: now,
        arBalanceCents: invoice.totalCents, updatedAt: now, updatedBy: caller.email, version: (Number(ctx.order.version) || 1) + 1,
      },
      {
        remove: ['factoringItemId'],
        // A new shipment's order waits at DOCS_NEEDED (car shipping skips the document gate); an order already released waits at UNBILLED.
        condition: `(arStatus = :unbilled OR arStatus = :docs) AND ${unsetCondition('invoiceId')}`,
        extraValues: { ':unbilled': { S: 'UNBILLED' }, ':docs': { S: 'DOCS_NEEDED' }, ':nullType': NULL_TYPE_VALUE },
      },
    ),
    ...context.loads.map((load) =>
      updateTx(LOAD_FINANCIALS_TABLE_NAME, load.id, { frozenAt: now, frozenBy: caller.email, updatedAt: now, updatedBy: caller.email }, { condition: 'attribute_exists(id)' })),
  ]
  await transact(writes, 'square invoice mirror')
  await writeAudit('Invoice', invoice.id, 'SQUARE_MIRROR_INVOICE', caller, { shipmentId: ctx.shipmentId, totalCents: invoice.totalCents, squareInvoiceId: state.invoiceId })
  return invoice.id
}

/** Publish the draft (Square e-mails the payer) and write the BCAT invoice. The only thing here that reaches a customer. */
export async function sendSquareInvoice(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const cfg = await loadSquareConfig()
  if (!cfg.enabled) throw new Error('Square invoicing is off. Turn it on at Integrations → Square first.')
  const ctx = await readShipmentCtx(shipmentId)
  let state = ctx.data.square ?? {}
  if (!state.invoiceId) throw new Error('There is no Square draft yet: create it first')
  if (state.environment && state.environment !== cfg.environment) {
    throw new Error(`This invoice was made in ${state.environment}; the active environment is ${cfg.environment}`)
  }
  // An auto shipper is invoiced once it is delivered (Ryne 2026-11-28). A draft waits; an invoice already published is only finished.
  if (state.status === 'DRAFT' && ctx.shipment.status !== 'DELIVERED') {
    throw new Error('Mark the shipment Delivered before sending the Square invoice. The draft is ready and waits.')
  }
  try {
    if (state.status === 'DRAFT') {
      const made = await sq<{ invoice?: SquareInvoiceObj }>(cfg, 'POST', `/v2/invoices/${state.invoiceId}/publish`, {
        version: state.invoiceVersion ?? 0,
        idempotency_key: `${shipmentId}:pub:${state.gen ?? 0}`.slice(0, 192),
      })
      const inv = made.invoice
      state = await saveSquare(ctx, {
        invoiceVersion: inv?.version ?? (state.invoiceVersion ?? 0) + 1,
        status: (inv?.status ?? 'UNPAID') as CarShippingSquare['status'],
        publicUrl: inv?.public_url ?? state.publicUrl ?? null,
        lastError: null, lastErrorAt: null,
      })
      await writeAudit('Shipment', shipmentId, 'SQUARE_SEND_INVOICE', caller, { environment: cfg.environment, invoiceId: state.invoiceId, status: state.status })
    } else if (state.status === 'CANCELED') {
      throw new Error('That Square invoice was canceled: reissue it')
    }
    // Published already (or just now): make sure the BCAT invoice exists. A retry after a half-finished send lands here.
    const bcatInvoiceId = await mirrorInvoice(ctx, state, caller)
    state = await saveSquare(ctx, { bcatInvoiceId })
    return { square: state }
  } catch (err) {
    await recordError(ctx, err)
    throw err
  }
}

/** Cancel in Square (a draft is deleted). A published invoice with nothing paid has its BCAT invoice voided with it. */
export async function cancelSquareInvoice(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : ''
  const cfg = await loadSquareConfig()
  const ctx = await readShipmentCtx(shipmentId)
  const state = ctx.data.square ?? {}
  if (!state.invoiceId) throw new Error('There is no Square invoice to cancel')
  if (state.environment && state.environment !== cfg.environment) throw new Error(`This invoice was made in ${state.environment}; the active environment is ${cfg.environment}`)
  try {
    if (state.status === 'DRAFT') {
      await sq(cfg, 'DELETE', `/v2/invoices/${state.invoiceId}?version=${state.invoiceVersion ?? 0}`)
      await saveSquare(ctx, { gen: (state.gen ?? 0) + 1 }, ['invoiceId', 'orderId', 'invoiceVersion', 'status', 'publicUrl', 'amountCents'])
      await writeAudit('Shipment', shipmentId, 'SQUARE_DELETE_DRAFT', caller, { invoiceId: state.invoiceId })
      return { square: ctx.data.square ?? {}, deleted: true }
    }
    if (state.status !== 'CANCELED') {
      const made = await sq<{ invoice?: SquareInvoiceObj }>(cfg, 'POST', `/v2/invoices/${state.invoiceId}/cancel`, { version: state.invoiceVersion ?? 0 })
      await saveSquare(ctx, { status: (made.invoice?.status ?? 'CANCELED') as CarShippingSquare['status'], invoiceVersion: made.invoice?.version ?? state.invoiceVersion })
    }
    await applyStatus(ctx, cfg, SQUARE_SYSTEM_CALLER, reason || 'Canceled in Square')
    await writeAudit('Shipment', shipmentId, 'SQUARE_CANCEL_INVOICE', caller, { invoiceId: state.invoiceId, reason: reason || null })
    return { square: ctx.data.square ?? {} }
  } catch (err) {
    await recordError(ctx, err)
    throw err
  }
}

/** The price changed after the invoice went out: cancel it, then make the next one as <PRO>-2. The draft is NOT sent. */
export async function reissueSquareInvoice(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const ctx = await readShipmentCtx(shipmentId)
  const state = ctx.data.square ?? {}
  if (!state.invoiceId || state.status === 'DRAFT') throw new Error('Only an invoice that was sent can be reissued; a draft is simply rebuilt at the new price')
  if ((state.status === 'PAID' || state.status === 'PARTIALLY_PAID')) throw new Error('Money has been paid on this invoice: refund it in Square first')
  await cancelSquareInvoice({ shipmentId, reason: 'Reissued at a new price' }, caller)
  const after = await readShipmentCtx(shipmentId)
  const cur = after.data.square ?? {}
  await saveSquare(after, { gen: (cur.gen ?? 0) + 1, reissue: (cur.reissue ?? 0) + 1 }, ['invoiceId', 'orderId', 'invoiceVersion', 'status', 'publicUrl', 'amountCents', 'bcatInvoiceId'])
  return createSquareInvoice({ shipmentId }, caller)
}

/** Edit the payer or vehicle on a shipment whose Square invoice has not been sent yet. */
export async function saveSquareDetails(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const checked = normalizeCarShipping(input.carShipping)
  if (!checked.ok) throw new Error(checked.error)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const customer = shipment.customerId ? await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId)) : null
  if (!isSquareChannel(customer as { invoiceChannel?: string | null } | null)) throw new Error('This shipment\'s customer is not invoiced through Square')
  const current = asJson<CarShippingData>(shipment.carShipping)
  const status = current?.square?.status
  if (status && status !== 'DRAFT') throw new Error('The Square invoice was already sent: its payer cannot change. Cancel it and reissue instead')
  const next: CarShippingData = { payer: checked.value.payer, vehicle: checked.value.vehicle, ...(current?.square ? { square: { ...current.square, customerId: null, orderId: null, invoiceId: null, status: null } } : {}) }
  // A changed payer means a new Square customer, so any draft is dropped by the next create; the ids stay out of the row.
  await transact([updateTx(SHIPMENT_TABLE_NAME, shipmentId, { carShipping: next as unknown as Row, updatedAt: nowIso() }, { condition: 'attribute_exists(id)' })], 'shipment square details')
  await writeAudit('Shipment', shipmentId, 'SQUARE_SAVE_DETAILS', caller, { carShipping: true })
  return { square: next.square ?? {}, carShipping: { payer: next.payer, vehicle: next.vehicle } }
}

// ── reading Square back ─────────────────────────────────────────────────────

interface SquareTender {
  id?: string
  payment_id?: string
  created_at?: string
  amount_money?: { amount?: number }
  type?: string
  card_details?: { card?: { card_brand?: string; last_4?: string } }
}

/** Apply what Square says about the invoice to BCAT's side: the mirror's status, payments, a void, a review flag. */
async function applyStatus(ctx: ShipmentCtx, cfg: SquareConfig, actor: Caller, reason?: string): Promise<void> {
  const state = ctx.data.square ?? {}
  const action = mirrorActionFor(state.status)
  const bcatId = state.bcatInvoiceId
  if (!bcatId) return
  const invoice = await getById(INVOICE_TABLE_NAME, bcatId)
  if (!invoice) return

  if (action === 'VOID') {
    if (invoice.status !== 'VOID' && Number(invoice.paidCents ?? 0) === 0 && Number(invoice.writtenOffCents ?? 0) === 0) {
      await voidInvoice({ invoiceId: bcatId, reason: reason ?? 'Canceled in Square' }, actor)
    }
    return
  }
  if (action === 'REVIEW') {
    const flag = state.status === 'FAILED'
      ? 'Square says the payment failed: check the invoice in Square.'
      : 'Square shows a refund on this invoice. If the money went back, reverse the payment on Payments Received.'
    if (state.reviewFlag !== flag) await saveSquare(ctx, { reviewFlag: flag })
    return
  }
  if (action !== 'OPEN' && action !== 'PARTIAL' && action !== 'PAID') return

  // Payments: one per Square tender, keyed by the tender id so a repeat is a no-op.
  const order = await sq<{ order?: { tenders?: SquareTender[] } }>(cfg, 'GET', `/v2/orders/${state.orderId}`)
  const tenders = order.order?.tenders ?? []
  for (const tender of tenders) {
    const amountCents = Number(tender.amount_money?.amount ?? 0)
    const key = String(tender.payment_id ?? tender.id ?? '')
    if (!key || !(amountCents > 0)) continue
    const card = tender.card_details?.card
    const reference = `Square ${card?.card_brand ? `${card.card_brand} ${card.last_4 ?? ''}`.trim() : (tender.type ?? 'payment')}`.slice(0, 120)
    try {
      await recordPayment({
        customerId: String(invoice.customerId),
        receivedAt: (tender.created_at ?? nowIso()).slice(0, 10),
        method: tender.type === 'CARD' || card ? 'CARD' : 'OTHER',
        reference,
        amountCents,
        applications: [{ invoiceId: bcatId, amountCents }],
        note: `Paid on the Square invoice ${state.invoiceNumber ?? ''}`.trim(),
        clientRequestId: `sq:${key}`.slice(0, 64),
      }, actor)
    } catch (err) {
      // Square cannot be told about a payment recorded here by hand (its API refuses payments on an invoice's order), so the payer can
      // still pay in Square after the invoice was settled here. That money is never added a second time: the invoice has no balance for
      // it, so it is flagged for a person (refund it in Square, or reverse the hand payment) and the rest of the sync carries on.
      const fresh = await getById(INVOICE_TABLE_NAME, bcatId)
      if (fresh && Number(fresh.balanceCents ?? 0) < amountCents) {
        const flag = `Square shows a payment of $${(amountCents / 100).toFixed(2)} on this invoice, but it is already paid here (recorded by hand). It was not added again. If the payer paid twice, refund the extra in Square; if the hand payment was wrong, reverse it on Payments Received.`
        if (state.reviewFlag !== flag) await saveSquare(ctx, { reviewFlag: flag })
        continue
      }
      throw err
    }
  }
}

/** Re-read the Square invoice and apply it. The webhook calls this with a shipment id it looked up; the Sync button calls it directly. */
export async function syncSquare(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const cfg = await loadSquareConfig()
  const ctx = await readShipmentCtx(shipmentId)
  const state = ctx.data.square ?? {}
  if (!state.invoiceId) return { square: state, synced: false }
  if (state.environment && state.environment !== cfg.environment) return { square: state, synced: false, note: `Made in ${state.environment}` }
  try {
    const got = await sq<{ invoice?: SquareInvoiceObj }>(cfg, 'GET', `/v2/invoices/${state.invoiceId}`)
    const inv = got.invoice
    if (!inv) throw new Error('Square returned no invoice')
    await saveSquare(ctx, {
      status: (inv.status ?? state.status) as CarShippingSquare['status'],
      invoiceVersion: inv.version ?? state.invoiceVersion,
      publicUrl: inv.public_url ?? state.publicUrl ?? null,
      lastSyncAt: nowIso(),
      ...(typeof input.eventId === 'string' ? { lastEventId: input.eventId } : {}),
      lastError: null, lastErrorAt: null,
    })
    await applyStatus(ctx, cfg, caller.isAdmin ? caller : SQUARE_SYSTEM_CALLER)
    return { square: ctx.data.square ?? {}, synced: true }
  } catch (err) {
    await recordError(ctx, err)
    throw err
  }
}

/**
 * The shipment a published Square invoice belongs to, for the webhook. The BCAT invoice written at Send has the Square
 * invoice number as its id (the PRO, or <PRO>-2 after a reissue) and records the Square invoice id, so this is two reads
 * and one comparison: no scan, and an event for an invoice BCAT Ops did not make finds nothing.
 */
export async function shipmentIdForSquareInvoice(invoiceNumber: string, squareInvoiceId: string): Promise<string | null> {
  const row = await getById(INVOICE_TABLE_NAME, invoiceNumber)
  const external = asJson<{ provider?: string; invoiceId?: string }>(row?.external)
  if (!row || external?.provider !== 'SQUARE' || external.invoiceId !== squareInvoiceId) return null
  return typeof row.shipmentId === 'string' ? row.shipmentId : null
}

/**
 * The scheduled pass: every Square invoice still open in AR is re-read from Square and applied. This is what turns Square's
 * webhook (which the public tracking Lambda can only verify and receipt, since it holds nothing on AR) into payments on the
 * books within minutes, and it catches anything a webhook missed (Square only retries for 24 hours). Capped per tick; one
 * invoice failing never stops the rest.
 */
const RECONCILE_MAX = 40
export async function reconcileSquare(): Promise<Row> {
  try {
    const cfg = await loadSquareConfig()
    if (!cfg.enabled) return { skipped: 'Square invoicing is off' }
  } catch {
    return { skipped: 'Square is not connected' }
  }
  const open = await queryIndex(INVOICE_TABLE_NAME, 'invoicesByArOpenAndDueAt', 'arOpen', 'OPEN')
  const mine = open
    .filter((inv) => inv.status !== 'VOID' && asJson<{ provider?: string }>(inv.external)?.provider === 'SQUARE' && typeof inv.shipmentId === 'string')
    .slice(0, RECONCILE_MAX)
  let synced = 0
  let failed = 0
  for (const inv of mine) {
    try {
      await syncSquare({ shipmentId: String(inv.shipmentId) }, SQUARE_SYSTEM_CALLER)
      synced += 1
    } catch (err) {
      failed += 1
      console.warn('[tms-finance-actions] square reconcile failed for', String(inv.id), String(err).slice(0, 200))
    }
  }
  return { checked: mine.length, synced, failed }
}
