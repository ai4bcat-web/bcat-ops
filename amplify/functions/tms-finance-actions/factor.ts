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
import type { FactoringItem, Stop } from '../../../src/types'
import type {
  CustomerRecord,
  InvoiceRecord,
  OrderRecord,
  ShipmentLoad,
  ShipmentRecord,
} from '../../../src/types/tms'
import {
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
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'

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

export async function sendToFactor(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')

  const invoiceRow = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoiceRow) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = invoiceRow as unknown as InvoiceRecord

  const [orderRow, shipmentRow, customerRow, loadRows] = await Promise.all([
    getById(ORDER_TABLE_NAME, invoice.orderId),
    getById(SHIPMENT_TABLE_NAME, invoice.shipmentId),
    getById(CUSTOMER_TABLE_NAME, invoice.customerId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId),
  ])
  if (!orderRow) throw new Error(`Order not found: ${invoice.orderId}`)
  if (!shipmentRow) throw new Error(`Shipment not found: ${invoice.shipmentId}`)
  if (!customerRow) throw new Error(`Customer not found: ${invoice.customerId}`)

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
  if (!load) throw new Error('That shipment has no load to factor')

  const stops: Stop[] = []
  for (const row of loads) {
    if (row.orderId != null && row.orderId !== invoice.orderId) continue
    for (const stop of row.stops ?? []) stops.push(stop)
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

  const refusal = whyNotFactorable({
    invoice, order, shipment, customer, load, existingRow,
    factorRemitToName: await configuredFactorRemitToName(),
  })
  if (refusal || !load) return { ready: false, refusal: refusal ?? 'That shipment has no load to factor', note }

  const stops: Stop[] = []
  for (const row of loads) {
    if (row.orderId != null && row.orderId !== invoice.orderId) continue
    for (const stop of row.stops ?? []) stops.push(stop)
  }
  const queueRow = factoringRowFor({ invoice, order, load, stops, customer, caller: 'preview', now: nowIso() })
  return {
    ready: true,
    refusal: null,
    proNumber: queueRow.proNumber,
    fields: queueRow.otrManualFields ?? {},
    existing: existingRow ? { id: existingRow.id, status: existingRow.status } : null,
    note,
  }
}
