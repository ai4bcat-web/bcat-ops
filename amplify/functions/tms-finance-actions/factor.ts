/**
 * Send to Factor.
 *
 * This writes the factoring-queue row that the intake e-mail would have written, links
 * it to the issued invoice, and stops. It does NOT call OTR: `manageOtr submit` is
 * human-initiated by design, and the one person who should decide whether a bill goes
 * to the factor is the one looking at it. The row lands in the existing queue with its
 * eleven OTR fields prefilled from the invoice snapshot, every one still editable there.
 *
 * Double-factoring is impossible by construction: the row id IS the PRO, the put is
 * conditional on the id not existing, and the only row an existing-PRO path will touch
 * is one that has not been submitted (no `otrInvoiceId`). A submitted PRO is refused.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { factoringRowFor, whyNotFactorable } from '../../../src/lib/factorHandoff'
import {
  RELEASE_GATE_ERROR_PREFIX,
  evaluateReleaseGate,
  releaseGateError,
  type ReleaseGateResult,
} from '../../../src/lib/releaseGate'
import { assertNotSquareInvoiced } from '../../../src/lib/invoiceDelivery'
import { isFactorBilled } from '../../../src/lib/factorBilling'
import { factorGapsAtCreate, factoringPoNumber, routeEnds } from '../../../src/lib/factorReadyAtCreate'
import { loadReleaseGateInput } from '../_shared/releaseGateInput'
import { isCustomerUnresolved, unresolvedCustomerMessage } from '../../../src/lib/customerResolution'
import type { FactoringItem, Stop } from '../../../src/types'
import type {
  CustomerRecord,
  InvoiceRecord,
  OrderRecord,
  ShipmentLoad,
  ShipmentRecord,
} from '../../../src/types/tms'
import {
  CARRIED_OVER_MESSAGE,
  isCarriedOver,
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  IDX_LOADS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_TABLE_NAME,
  NULL_TYPE_VALUE,
  ORDER_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  getSettings,
  nowIso,
  numberOrNull,
  putTx,
  queryIndex,
  releaseGateDeps,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { stopsList } from '../../../src/lib/stopPlace'

/**
 * The factor's remit-to name from org settings, when one is configured.
 *
 * Narrowed rather than cast: `factorRemitTo` is a free-form JSON column, and a blob
 * without a name is exactly the case that must read as "no factor configured".
 */
async function configuredFactorRemitToName(): Promise<string | null> {
  const settings = await getSettings()
  const remitTo = settings.factorRemitTo
  if (!remitTo || typeof remitTo !== 'object' || !('name' in remitTo)) return null
  const name = remitTo.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * The release gate, for the one path that could otherwise walk around it: handing
 * a bill to the factor is handing it to somebody who will advance money on it.
 * A voided shipment, a missing POD or an unsettled carrier bill stops here too.
 */
async function factorReleaseGate(
  invoice: InvoiceRecord,
  rows: { shipment: Row; order: Row; customer: Row; loads: Row[] },
): Promise<ReleaseGateResult> {
  return evaluateReleaseGate(
    await loadReleaseGateInput(releaseGateDeps, {
      shipmentId: invoice.shipmentId,
      orderId: invoice.orderId,
      shipment: rows.shipment,
      order: rows.order,
      loads: rows.loads,
      customer: rows.customer,
    }),
  )
}

/**
 * Step R cutover. An invoice snapshots its order's customer, and an order may carry
 * none: the board shows it unresolved until somebody links one. Factoring is where
 * that has to stop — the factor advances money against a named debtor, and there is
 * no name. Checked before the customer row is even read, because there is no id to
 * read it by.
 */
function assertFactorCustomerResolved(invoice: InvoiceRecord, what: string): void {
  if (isCustomerUnresolved(invoice)) throw new Error(unresolvedCustomerMessage(invoice, what))
}

export async function sendToFactor(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')

  const invoiceRow = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoiceRow) throw new Error(`Invoice not found: ${invoiceId}`)
  if (isCarriedOver(invoiceRow)) throw new Error(CARRIED_OVER_MESSAGE)
  const invoice = invoiceRow as unknown as InvoiceRecord

  // Step R cutover. Refused before the customer is read, not after: an invoice whose
  // order was never matched to a customer record carries no id to read, and handing
  // a bill to somebody who will advance money on it is the last place to find that
  // out. The release gate below still runs on its own; this never replaces it.
  assertFactorCustomerResolved(invoice, 'sending it to the factor')

  const [orderRow, shipmentRow, customerRow, loadRows] = await Promise.all([
    getById(ORDER_TABLE_NAME, invoice.orderId),
    getById(SHIPMENT_TABLE_NAME, invoice.shipmentId),
    getById(CUSTOMER_TABLE_NAME, invoice.customerId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId),
  ])
  if (!orderRow) throw new Error(`Order not found: ${invoice.orderId}`)
  if (!shipmentRow) throw new Error(`Shipment not found: ${invoice.shipmentId}`)
  if (!customerRow) throw new Error(`Customer not found: ${invoice.customerId}`)
  assertNotSquareInvoiced(shipmentRow as unknown as { revDivision?: string | null }, 'sending it to the factor')

  const order = orderRow as unknown as OrderRecord
  const shipment = shipmentRow as unknown as ShipmentRecord
  const customer = customerRow as unknown as CustomerRecord
  const loads = loadRows as unknown as ShipmentLoad[]
  const load = loads.find((row) => row.orderId === invoice.orderId) ?? loads[0] ?? null

  const existingRow = load?.aljexId
    ? ((await getById(FACTORING_ITEM_TABLE_NAME, String(load.aljexId).trim())) as unknown as FactoringItem | null)
    : null

  const factorRemitToName = await configuredFactorRemitToName()
  const refusal = whyNotFactorable({ invoice, order, shipment, customer, load, existingRow, factorRemitToName })
  if (refusal) throw new Error(refusal)
  const release = await factorReleaseGate(invoice, {
    shipment: shipmentRow,
    order: orderRow,
    customer: customerRow,
    loads: loadRows,
  })
  if (!release.ok) throw releaseGateError(release.missing)

  if (!load) throw new Error('That shipment has no load to factor')

  const stops: Stop[] = []
  for (const row of loads) {
    if (row.orderId != null && row.orderId !== invoice.orderId) continue
    for (const stop of stopsList<Stop>(row.stops)) stops.push(stop)
  }

  const now = nowIso()
  const queueRow = factoringRowFor({ invoice, order, load, stops, customer, caller: caller.email, now })

  const writes = [
    // An unsubmitted row for this PRO already in the queue is updated with the invoice
    // link and the prefilled fields rather than refused: the intake e-mail and Send to
    // Factor are two routes to the same bill, and the queue holds one row per PRO.
    existingRow
      ? updateTx(
          FACTORING_ITEM_TABLE_NAME,
          queueRow.id,
          {
            source: 'TMS',
            invoiceId: invoice.id,
            orderId: invoice.orderId,
            shipmentId: invoice.shipmentId,
            loadId: load.id,
            customerId: invoice.customerId,
            // An ARCHIVED row — one a previous void parked — has to come back to the
            // queue, or the invoice would be marked factored against a row nobody sees.
            status: existingRow.status === 'ARCHIVED' ? 'NEED_TO_FACTOR' : existingRow.status,
            otrManualFields: { ...(existingRow.otrManualFields ?? {}), ...queueRow.otrManualFields },
            updatedAt: now,
          },
          {
            condition: `${unsetCondition('otrInvoiceId')} AND (${unsetCondition('invoiceId')} OR invoiceId = :invoiceId)`,
            extraValues: { ':invoiceId': { S: invoice.id }, ':nullType': NULL_TYPE_VALUE },
          },
        )
      : putTx(FACTORING_ITEM_TABLE_NAME, { ...(queueRow as unknown as Row), __typename: 'FactoringItem' }),
    updateTx(
      INVOICE_TABLE_NAME,
      invoiceId,
      {
        factored: true,
        factoringItemId: queueRow.id,
        updatedAt: now,
        updatedBy: caller.email,
        version: (invoice.version ?? 1) + 1,
      },
      { condition: 'attribute_exists(id) AND #st <> :void', extraValues: { ':void': { S: 'VOID' } } },
    ),
    updateTx(
      ORDER_TABLE_NAME,
      invoice.orderId,
      { factoringItemId: queueRow.id, updatedAt: now, updatedBy: caller.email, version: (numberOrNull(orderRow.version) ?? 1) + 1 },
      { condition: 'invoiceId = :invoiceId', extraValues: { ':invoiceId': { S: invoiceId } } },
    ),
  ]
  const invoiceUpdate = writes[1].Update
  if (invoiceUpdate?.ExpressionAttributeNames) invoiceUpdate.ExpressionAttributeNames['#st'] = 'status'

  await transact(writes, 'send to factor')
  await writeAudit('Invoice', invoiceId, 'SEND_TO_FACTOR', caller, {
    factoringItemId: queueRow.id,
    proNumber: queueRow.proNumber,
    reused: Boolean(existingRow),
  })

  return {
    factoringItem: (await getById(FACTORING_ITEM_TABLE_NAME, queueRow.id)) ?? {},
    invoice: (await getById(INVOICE_TABLE_NAME, invoiceId)) ?? {},
    reused: Boolean(existingRow),
  }
}

/** What Send to Factor would do, and why it would not. Writes nothing. */
export async function previewFactor(input: Row): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const note = optionalString(input.note, 200)

  const invoiceRow = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoiceRow) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = invoiceRow as unknown as InvoiceRecord

  assertFactorCustomerResolved(invoice, 'sending it to the factor')

  const [orderRow, shipmentRow, customerRow, loadRows] = await Promise.all([
    getById(ORDER_TABLE_NAME, invoice.orderId),
    getById(SHIPMENT_TABLE_NAME, invoice.shipmentId),
    getById(CUSTOMER_TABLE_NAME, invoice.customerId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId),
  ])
  if (!orderRow || !shipmentRow || !customerRow) throw new Error('That invoice no longer has a complete order behind it')

  const order = orderRow as unknown as OrderRecord
  const shipment = shipmentRow as unknown as ShipmentRecord
  const customer = customerRow as unknown as CustomerRecord
  const loads = loadRows as unknown as ShipmentLoad[]
  const load = loads.find((row) => row.orderId === invoice.orderId) ?? loads[0] ?? null
  const existingRow = load?.aljexId
    ? ((await getById(FACTORING_ITEM_TABLE_NAME, String(load.aljexId).trim())) as unknown as FactoringItem | null)
    : null

  const release = await factorReleaseGate(invoice, {
    shipment: shipmentRow,
    order: orderRow,
    customer: customerRow,
    loads: loadRows,
  })
  const refusal = whyNotFactorable({
    invoice, order, shipment, customer, load, existingRow,
    factorRemitToName: await configuredFactorRemitToName(),
  })
  if (!release.ok) {
    return {
      ready: false,
      refusal: `${RELEASE_GATE_ERROR_PREFIX}: ${release.missing.map((item) => item.message).join('; ')}`,
      releaseGate: release,
      note,
    }
  }
  if (refusal || !load) {
    return { ready: false, refusal: refusal ?? 'That shipment has no load to factor', releaseGate: release, note }
  }

  const stops: Stop[] = []
  for (const row of loads) {
    if (row.orderId != null && row.orderId !== invoice.orderId) continue
    for (const stop of stopsList<Stop>(row.stops)) stops.push(stop)
  }
  const queueRow = factoringRowFor({ invoice, order, load, stops, customer, caller: 'preview', now: nowIso() })
  return {
    ready: true,
    refusal: null,
    releaseGate: release,
    proNumber: queueRow.proNumber,
    fields: queueRow.otrManualFields ?? {},
    existing: existingRow ? { id: existingRow.id, status: existingRow.status } : null,
    note,
  }
}

/** The most orders one PREVIEW_FACTOR_READY reads; the page asks in pages of this size. */
export const FACTOR_READY_LIMIT = 50

/**
 * Ready to factor, for the rows of Ready to invoice (Ryne 2026-11-14). Writes nothing.
 *
 * Per order: whether its customer is billed through the factor, and — when it is —
 * every reason it could not be factored right now, in one list: the release gate (delivery,
 * POD, rate confirmation, carrier pay), the factor-ready fields from booking (PO, rate, both
 * ends' city/state/ZIP, MC), the factor's remit-to, and a PRO already at OTR. A draft invoice
 * already on the order is judged the way Send to Factor judges it (`whyNotFactorable`).
 */
export async function previewFactorReady(input: Row): Promise<Row> {
  const orderIds = Array.isArray(input.orderIds) ? input.orderIds.map(String).filter(Boolean) : []
  if (orderIds.length === 0) return { results: [] }
  if (orderIds.length > FACTOR_READY_LIMIT) throw new Error(`At most ${FACTOR_READY_LIMIT} orders at a time`)
  const factorRemitToName = await configuredFactorRemitToName()
  const results = await Promise.all(orderIds.map(async (orderId) => {
    try {
      return await factorReadyFor(orderId, factorRemitToName)
    } catch (err) {
      return { orderId, factorBilled: false, ready: false, missing: [err instanceof Error ? err.message : String(err)] }
    }
  }))
  return { results }
}

async function factorReadyFor(orderId: string, factorRemitToName: string | null): Promise<Row> {
  const orderRow = await getById(ORDER_TABLE_NAME, orderId)
  if (!orderRow) throw new Error(`Order not found: ${orderId}`)
  const order = orderRow as unknown as OrderRecord
  const shipmentId = String(order.shipmentId ?? '')
  const [shipmentRow, customerRow, loadRows, invoiceRow] = await Promise.all([
    getById(SHIPMENT_TABLE_NAME, shipmentId),
    order.customerId ? getById(CUSTOMER_TABLE_NAME, String(order.customerId)) : Promise.resolve(null),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    order.invoiceId ? getById(INVOICE_TABLE_NAME, String(order.invoiceId)) : Promise.resolve(null),
  ])
  if (!shipmentRow) throw new Error(`Shipment not found: ${shipmentId}`)
  const customer = customerRow as unknown as CustomerRecord | null
  if (!customer) return { orderId, factorBilled: false, ready: false, missing: ['No customer record is linked to this order.'] }
  if (!isFactorBilled(customer)) return { orderId, factorBilled: false, ready: false, missing: [] }

  const shipment = shipmentRow as unknown as ShipmentRecord
  const loads = loadRows as unknown as ShipmentLoad[]
  const load = loads.find((row) => row.orderId === orderId) ?? loads[0] ?? null
  const stops: Stop[] = []
  for (const row of loads) {
    if (row.orderId != null && row.orderId !== orderId) continue
    for (const stop of stopsList<Stop>(row.stops)) stops.push(stop)
  }

  const missing: string[] = []
  const release = evaluateReleaseGate(await loadReleaseGateInput(releaseGateDeps, {
    shipmentId, orderId, shipment: shipmentRow, order: orderRow, loads: loadRows, customer: customerRow,
  }))
  for (const reason of release.missing) missing.push(reason.message)
  for (const gap of factorGapsAtCreate({
    customer,
    poNumber: factoringPoNumber(order.references, load?.tmsId as string | null | undefined),
    customerRateCents: numberOrNull(order.revenueCents),
    ...routeEnds(stops),
  })) missing.push(gap.message)
  if (!factorRemitToName) missing.push('No factor remit-to is set up in AR settings.')
  if (!load || !String(load.aljexId ?? '').trim()) missing.push('The load has no PRO number, which is the id OTR files the invoice under.')

  const existingRow = load?.aljexId
    ? ((await getById(FACTORING_ITEM_TABLE_NAME, String(load.aljexId).trim())) as unknown as FactoringItem | null)
    : null
  if (existingRow && String(existingRow.otrInvoiceId ?? '').trim()) {
    missing.push(`PRO ${existingRow.proNumber} was already submitted to OTR as invoice ${existingRow.otrInvoiceId}.`)
  }
  const invoice = invoiceRow as unknown as InvoiceRecord | null
  if (invoice) {
    const refusal = whyNotFactorable({ invoice, order, shipment, customer, load, existingRow, factorRemitToName })
    if (refusal && !missing.includes(refusal)) missing.push(refusal)
  }
  return {
    orderId,
    factorBilled: true,
    ready: missing.length === 0,
    missing: [...new Set(missing)],
    invoiceId: invoice?.id ?? null,
    factoringItemId: existingRow?.id ?? null,
  }
}
