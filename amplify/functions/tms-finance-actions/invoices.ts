/**
 * Issuing, sending and voiding a bill.
 *
 * `GENERATE_INVOICE` is the one place UNBILLED becomes UNPAID, and it does four things
 * in a fixed order for a reason: it re-checks readiness against the rows as they are
 * now, it renders the PDF **first** (pure, in memory — a renderer that throws must not
 * leave a numbered invoice behind), it takes the next number with an atomic ADD, and
 * only then opens one transaction that puts the Invoice, moves the order and freezes
 * the load's financials together. The PDF is stored afterwards: S3 is not transactional,
 * and an invoice that exists with no file is repairable (`RENDER_INVOICE_PDF`) while a
 * file with no invoice is garbage.
 *
 * Everything the bill says is copied at issue. Nothing below ever re-reads a charge to
 * answer "what does this invoice say" — the snapshot is the answer, and a disagreement
 * with today's charges is why `VOID_INVOICE` exists.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  assertArrayOf,
  assertRecord,
  assertString,
  optionalBoolean,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import { deliverNotice, type EmailAttachment } from '../_shared/shipmentNotices'
import {
  DEFAULT_INVOICE_NUMBER_FORMAT,
  billingRecipients,
  defaultInvoiceAttachments,
  dueDateFor,
  invoiceCcRecipients,
  invoiceData,
  invoiceLinesFor,
  invoiceNumberFormatError,
  invoiceReadiness,
  invoiceTermsDays,
  remitToFor,
} from '../../../src/lib/invoiceBuild'
import { buildInvoicePdf, invoiceFilename } from '../../../src/lib/invoicePdf'
import {
  DEFAULT_INVOICE_EMAIL_TEMPLATE,
  renderInvoiceEmail,
} from '../../../src/lib/shipmentNotices'
import { canEmailTo, evaluateDocGate, gateLoadIds } from '../../../src/lib/shipmentDocuments'
import type {
  BillToParty,
  CustomerRecord,
  Division,
  DocGateResult,
  InvoiceBillTo,
  InvoiceRecord,
  LoadCarrierRecord,
  LoadChargeRecord,
  OrderRecord,
  OrderReference,
  ShipmentDocumentRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
} from '../../../src/types/tms'
import {
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  FROM_ADDRESS,
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_CHARGES_BY_SHIPMENT,
  IDX_DOCUMENTS_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_CARRIER_TABLE_NAME,
  LOAD_CHARGE_TABLE_NAME,
  LOAD_FINANCIALS_TABLE_NAME,
  LOAD_TABLE_NAME,
  NULL_TYPE_VALUE,
  MAX_BATCH,
  MAX_EMAIL_ATTACHMENT_BYTES,
  ORDER_TABLE_NAME,
  SETTINGS_TABLE_NAME,
  SHIPMENT_DOCUMENT_TABLE_NAME,
  SHIPMENT_NOTICE_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  dynamo,
  getById,
  getDivision,
  getSettings,
  invoicePdfKey,
  nextInvoiceNumber,
  nowIso,
  numberOrNull,
  putPdf,
  putTx,
  queryIndex,
  s3Bytes,
  ses,
  signedDownload,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { commissionVoidWrites, runCommissionsAfter } from './commissions'

const MAX_NOTE = 2000
/** The four prefixes an invoice may carry bytes from. Anything else is refused. */
const EMAILABLE_KEY_PREFIXES = ['invoices/', 'shipment-docs/', 'driver-docs/', 'rate-confirms/']

/** Every row one invoice needs, read once. */
interface OrderContext {
  order: OrderRecord
  shipment: ShipmentRecord
  orders: OrderRecord[]
  loads: ShipmentLoad[]
  loadCarriers: LoadCarrierRecord[]
  charges: LoadChargeRecord[]
  documents: ShipmentDocumentRecord[]
  customer: CustomerRecord | null
  division: Division | null
  settings: TmsSettings
  /** The loads this order bills for, as the document gate counts them. */
  gateLoadIds: string[]
}

async function readOrderContext(orderId: string): Promise<OrderContext> {
  const orderRow = await getById(ORDER_TABLE_NAME, orderId)
  if (!orderRow) throw new Error(`Order not found: ${orderId}`)
  const order = orderRow as unknown as OrderRecord

  const shipmentRow = await getById(SHIPMENT_TABLE_NAME, order.shipmentId)
  if (!shipmentRow) throw new Error(`Shipment not found: ${order.shipmentId}`)
  const shipment = shipmentRow as unknown as ShipmentRecord

  const [orderRows, loadRows, carrierRows, chargeRows, documentRows, customerRow, settings] = await Promise.all([
    queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', order.shipmentId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', order.shipmentId),
    queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', order.shipmentId),
    queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', order.shipmentId),
    queryIndex(SHIPMENT_DOCUMENT_TABLE_NAME, IDX_DOCUMENTS_BY_SHIPMENT, 'shipmentId', order.shipmentId),
    order.customerId ? getById(CUSTOMER_TABLE_NAME, order.customerId) : Promise.resolve(null),
    getSettings(),
  ])

  const orders = orderRows as unknown as OrderRecord[]
  const allLoads = loadRows as unknown as ShipmentLoad[]
  const gateIds = gateLoadIds(allLoads, orders, orderId)
  const loads = allLoads.filter((load) => gateIds.includes(load.id))
  const divisionKey = loads.find((load) => load.divisionKey)?.divisionKey ?? null
  const division = divisionKey ? ((await getDivision(divisionKey)) as unknown as Division | null) : null

  return {
    order,
    shipment,
    orders,
    loads,
    loadCarriers: carrierRows as unknown as LoadCarrierRecord[],
    charges: chargeRows as unknown as LoadChargeRecord[],
    documents: documentRows as unknown as ShipmentDocumentRecord[],
    customer: (customerRow as unknown as CustomerRecord) ?? null,
    division,
    settings: settings as unknown as TmsSettings,
    gateLoadIds: gateIds,
  }
}

function billToOf(customer: CustomerRecord | null, billToId: string | null): BillToParty | null {
  if (!customer) return null
  const parties = customer.billToParties ?? []
  if (billToId) return parties.find((party) => party.id === billToId) ?? null
  return parties.find((party) => party.isDefault) ?? null
}

/** The document gate as step E computes it, so generation refuses what READY_TO_INVOICE did. */
function docGateFor(context: OrderContext): DocGateResult {
  return evaluateDocGate({
    scope: 'CUSTOMER',
    documents: context.documents,
    order: context.order,
    loadIds: context.gateLoadIds,
    loadCarriers: context.loadCarriers,
    customer: context.customer,
    settings: context.settings,
  })
}

/** Only what the customer may see goes on their bill. */
function customerReferences(order: OrderRecord): OrderReference[] {
  return (order.references ?? []).filter((ref) => {
    const visibility = ref.visibility ?? 'ALL'
    return visibility === 'ALL' || visibility === 'CUSTOMER'
  })
}

interface Snapshot {
  invoice: InvoiceRecord
  context: OrderContext
  attachDocumentIds: string[]
}

function buildSnapshot(
  context: OrderContext,
  args: { number: string; invoiceDate: string; dueAt: string | null; billToId: string | null; note: string | null; attachDocumentIds: string[] | null },
  caller: Caller,
  now: string,
): Snapshot {
  const { order, shipment, customer, division, settings } = context
  const billTo = billToOf(customer, args.billToId)
  const termsDays = invoiceTermsDays(customer, billTo, settings)
  const dueAt = args.dueAt ?? dueDateFor(args.invoiceDate, termsDays)
  if (dueAt < args.invoiceDate) throw new Error('The due date cannot be before the invoice date')

  const { lines, subtotalCents } = invoiceLinesFor(context.charges, order.id)
  const remitTo = remitToFor(division, customer, settings)
  const billToSnapshot: InvoiceBillTo = billTo
    ? { name: billTo.name, address: billTo.address ?? null, email: billTo.email ?? null }
    : {
        name: customer?.name ?? order.customerName ?? '',
        address: customer?.billingAddress ?? null,
        email: customer?.billingEmail ?? null,
      }

  const attachDocumentIds = args.attachDocumentIds
    ?? defaultInvoiceAttachments(context.documents, { id: order.id, loadIds: context.gateLoadIds }, customer, settings)

  const invoice: InvoiceRecord = {
    id: args.number,
    number: args.number,
    orderId: order.id,
    shipmentId: order.shipmentId,
    shipmentNumber: shipment.number,
    customerId: order.customerId,
    customerName: customer?.name ?? order.customerName ?? null,
    billToId: billTo?.id ?? null,
    billTo: billToSnapshot,
    divisionKey: division?.key ?? null,
    status: 'ISSUED',
    invoiceDate: args.invoiceDate,
    issuedAt: now,
    issuedBy: caller.email,
    dueAt,
    termsDays,
    termsText: settings.invoiceTerms?.trim() || `Net ${termsDays}`,
    invoiceMonth: args.invoiceDate.slice(0, 7),
    lines,
    references: customerReferences(order),
    subtotalCents,
    totalCents: subtotalCents,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: subtotalCents,
    arOpen: 'OPEN',
    remitTo,
    factored: customer?.factored === true,
    attachDocumentIds,
    sentCount: 0,
    note: args.note,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
  }
  return { invoice, context, attachDocumentIds }
}

export async function previewInvoice(input: Row, caller: Caller): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const invoiceDate = optionalString(input.invoiceDate, 10) ?? nowIso().slice(0, 10)
  const billToId = optionalString(input.billToId, 64)

  const context = await readOrderContext(orderId)
  const gate = docGateFor(context)
  const readiness = invoiceReadiness({
    order: context.order,
    shipment: context.shipment,
    customer: context.customer,
    settings: context.settings,
    charges: context.charges,
    gate,
  })
  const { invoice, attachDocumentIds } = buildSnapshot(
    context,
    { number: 'PREVIEW', invoiceDate, dueAt: null, billToId, note: null, attachDocumentIds: null },
    caller,
    nowIso(),
  )
  const to = billingRecipients(context.customer, invoice.billToId)
  const cc = invoiceCcRecipients(context.customer).filter((email) => !to.includes(email))

  return {
    readiness,
    gate,
    snapshot: invoice as unknown as Row,
    recipients: { to, cc },
    attachments: context.documents
      .filter((doc) => attachDocumentIds.includes(doc.id))
      .map((doc) => ({ id: doc.id, type: doc.type, name: doc.name, sizeBytes: doc.sizeBytes })),
  }
}

/**
 * Issue one bill.
 *
 * The transaction is the whole of the state change: the Invoice row (guarded by
 * `attribute_not_exists(id)`, so two generations racing on the same number cannot both
 * land), the order moved to UNPAID and conditioned on still being UNBILLED with no
 * invoice, and a freeze on every one of the order's loads. Either all of that is true
 * afterwards or none of it is.
 */
export async function generateInvoice(input: Row, caller: Caller): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const invoiceDate = optionalString(input.invoiceDate, 10) ?? nowIso().slice(0, 10)
  const dueAt = optionalString(input.dueAt, 10)
  const billToId = optionalString(input.billToId, 64)
  const note = optionalString(input.note, MAX_NOTE)
  const attachDocumentIds = input.attachDocumentIds == null
    ? null
    : assertArrayOf<string>(input.attachDocumentIds, 'attachDocumentIds', (item, index) =>
        assertString(item, `attachDocumentIds[${index}]`), 20)

  const context = await readOrderContext(orderId)
  const gate = docGateFor(context)
  const readiness = invoiceReadiness({
    order: context.order,
    shipment: context.shipment,
    customer: context.customer,
    settings: context.settings,
    charges: context.charges,
    gate,
  })
  if (!readiness.ready) throw new Error(readiness.reasons.join(' '))

  if (attachDocumentIds) {
    for (const id of attachDocumentIds) {
      const doc = context.documents.find((row) => row.id === id)
      if (!doc) throw new Error(`Document ${id} does not belong to this shipment`)
      if (doc.status === 'VOID') throw new Error(`${doc.name} is void and cannot be attached`)
      if (doc.audience === 'INTERNAL') throw new Error(`${doc.name} is internal and cannot be sent to a customer`)
      if (doc.reviewStatus === 'PENDING' || doc.reviewStatus === 'REJECTED') {
        throw new Error(`${doc.name} has not been accepted yet`)
      }
    }
  }

  const prefix = context.division?.invoicePrefix?.trim() || 'INV-'
  const format = context.settings.invoiceNumberFormat ?? DEFAULT_INVOICE_NUMBER_FORMAT
  const formatError = invoiceNumberFormatError(format)
  if (formatError) throw new Error(formatError)

  const now = nowIso()
  // Rendered before a number is taken: a renderer that throws must not burn one.
  const dryRun = buildSnapshot(context, { number: 'DRAFT', invoiceDate, dueAt, billToId, note, attachDocumentIds }, caller, now)
  await buildInvoicePdf(invoiceData({
    invoice: dryRun.invoice,
    bundle: { shipment: context.shipment, loads: context.loads },
    customer: context.customer,
    division: context.division,
    settings: context.settings,
  }))

  const number = await nextInvoiceNumber(caller, prefix, invoiceDate)
  const { invoice } = buildSnapshot(context, { number, invoiceDate, dueAt, billToId, note, attachDocumentIds }, caller, now)

  const writes: TransactWriteItem[] = [
    putTx(INVOICE_TABLE_NAME, { ...(invoice as unknown as Row), __typename: 'Invoice', createdAt: now, updatedAt: now }),
    updateTx(
      ORDER_TABLE_NAME,
      orderId,
      {
        arStatus: 'UNPAID',
        arStatusChangedAt: now,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoicedAt: now,
        arBalanceCents: invoice.totalCents,
        updatedAt: now,
        updatedBy: caller.email,
        version: (context.order.version ?? 1) + 1,
      },
      {
        // A fresh bill never inherits the previous one's factoring link.
        remove: ['factoringItemId'],
        // Somebody else invoicing, voiding or moving this order between the read and
        // the write loses here rather than double-billing the customer.
        condition: `arStatus = :unbilled AND ${unsetCondition('invoiceId')}`,
        extraValues: { ':unbilled': { S: 'UNBILLED' }, ':nullType': NULL_TYPE_VALUE },
      },
    ),
  ]
  for (const load of context.loads) {
    writes.push(
      updateTx(
        LOAD_FINANCIALS_TABLE_NAME,
        load.id,
        { frozenAt: now, frozenBy: caller.email, updatedAt: now, updatedBy: caller.email },
        { condition: 'attribute_exists(id)' },
      ),
    )
  }

  await transact(writes, 'invoice')
  await writeAudit('Invoice', invoice.id, 'GENERATE_INVOICE', caller, {
    orderId,
    shipmentId: invoice.shipmentId,
    totalCents: invoice.totalCents,
    dueAt: invoice.dueAt,
  })

  // Step I. The money is frozen by the transaction above, which is the first
  // moment a commission can be computed on a number that will not move again.
  // Best-effort like the PDF below: a run that fails is fixed by the next one.
  await runCommissionsAfter(invoice.id, caller, 'RUN')

  const stored = await storePdf(invoice, context, caller)
  return { invoice: stored as unknown as Row, gate }
}

/** Render the snapshot and put the bytes. A failure here leaves `pdfKey` null and says so. */
async function storePdf(invoice: InvoiceRecord, context: OrderContext, caller: Caller): Promise<InvoiceRecord> {
  const version = (invoice.pdfVersion ?? 0) + 1
  const key = invoicePdfKey(invoice.customerId, invoice.number, version)
  try {
    const bytes = await buildInvoicePdf(invoiceData({
      invoice,
      bundle: { shipment: context.shipment, loads: context.loads },
      customer: context.customer,
      division: context.division,
      settings: context.settings,
    }))
    await putPdf(key, bytes)
    const now = nowIso()
    await transact(
      [updateTx(INVOICE_TABLE_NAME, invoice.id, {
        pdfKey: key,
        pdfSizeBytes: bytes.byteLength,
        pdfVersion: version,
        updatedAt: now,
        updatedBy: caller.email,
      })],
      'invoice pdf',
    )
    return { ...invoice, pdfKey: key, pdfSizeBytes: bytes.byteLength, pdfVersion: version }
  } catch (err) {
    console.error('[tms-finance-actions] invoice PDF failed', invoice.id, String(err))
    return { ...invoice, pdfKey: null, pdfSizeBytes: null, pdfVersion: null }
  }
}

export async function renderInvoicePdf(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  // A void invoice keeps the document the customer actually received; re-rendering
  // would repoint `pdfKey` at a file nobody was ever sent.
  if (row.status === 'VOID') throw new Error('That invoice is void; its PDF is the record of what was sent')
  const invoice = row as unknown as InvoiceRecord
  const context = await readOrderContext(invoice.orderId)
  const stored = await storePdf(invoice, context, caller)
  if (!stored.pdfKey) throw new Error('The invoice PDF could not be rendered; try again')
  return { invoice: stored as unknown as Row }
}

/**
 * One invoice per order, in sequence.
 *
 * Never one transaction across orders: forty orders would blow the item limit, and a
 * single bad row would refuse the other thirty-nine. Each result stands alone.
 */
export async function batchGenerate(input: Row, caller: Caller): Promise<Row> {
  const orderIds = assertArrayOf<string>(input.orderIds, 'orderIds', (item, index) =>
    assertString(item, `orderIds[${index}]`), MAX_BATCH)
  const invoiceDate = optionalString(input.invoiceDate, 10)

  const results: Row[] = []
  for (const orderId of orderIds) {
    try {
      const done = await generateInvoice({ orderId, ...(invoiceDate ? { invoiceDate } : {}) }, caller)
      const invoice = done.invoice as unknown as InvoiceRecord
      results.push({ orderId, invoiceId: invoice.id, number: invoice.number, totalCents: invoice.totalCents })
    } catch (err) {
      results.push({ orderId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { results }
}

// ── sending ─────────────────────────────────────────────────────────────────

async function attachmentsFor(invoice: InvoiceRecord, documents: ShipmentDocumentRecord[]): Promise<EmailAttachment[]> {
  const keys: { name: string; contentType: string; key: string }[] = []
  if (invoice.pdfKey) {
    keys.push({
      name: invoiceFilename(invoice.number, invoice.pdfVersion ?? 1),
      contentType: 'application/pdf',
      key: invoice.pdfKey,
    })
  }
  for (const id of invoice.attachDocumentIds ?? []) {
    const doc = documents.find((row) => row.id === id)
    if (!doc?.s3Key) continue
    // Re-checked at SEND time, not only at issue: a document voided, retyped or made
    // INTERNAL after the invoice was raised must not go out with a resend.
    if (!canEmailTo(doc, 'CUSTOMER')) continue
    keys.push({ name: doc.name, contentType: doc.contentType ?? 'application/pdf', key: doc.s3Key })
  }
  for (const entry of keys) {
    if (!EMAILABLE_KEY_PREFIXES.some((prefix) => entry.key.startsWith(prefix))) {
      throw new Error(`${entry.name} is not stored somewhere an invoice may send from`)
    }
  }

  const attachments: EmailAttachment[] = []
  let total = 0
  for (const entry of keys) {
    const { bytes, contentType } = await s3Bytes(entry.key)
    total += bytes.byteLength
    if (total > MAX_EMAIL_ATTACHMENT_BYTES) {
      const mb = Math.round((total / (1024 * 1024)) * 10) / 10
      throw new Error(
        `Those attachments come to ${mb} MB; one e-mail carries at most ${MAX_EMAIL_ATTACHMENT_BYTES / (1024 * 1024)} MB — send fewer`,
      )
    }
    attachments.push({ filename: entry.name, contentType: entry.contentType || contentType, bytes })
  }
  return attachments
}

function emailList(value: unknown, label: string): string[] {
  if (value == null) return []
  return assertArrayOf<string>(value, label, (item, index) => assertString(item, `${label}[${index}]`), 20)
}

export async function emailInvoice(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const copyOnly = optionalString(input.via, 16) === 'COPY'
  const message = optionalString(input.message, MAX_NOTE)

  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = row as unknown as InvoiceRecord
  if (invoice.status === 'VOID') throw new Error('That invoice is void; it cannot be sent')

  const context = await readOrderContext(invoice.orderId)
  const to = emailList(input.to, 'to').length > 0
    ? emailList(input.to, 'to')
    : billingRecipients(context.customer, invoice.billToId)
  const cc = emailList(input.cc, 'cc').length > 0
    ? emailList(input.cc, 'cc')
    : invoiceCcRecipients(context.customer).filter((email) => !to.includes(email))
  if (to.length === 0 && !copyOnly) {
    throw new Error('Nobody is listed to receive this invoice; add a billing contact or type an address')
  }

  const attachments = await attachmentsFor(invoice, context.documents)
  const rendered = renderInvoiceEmail({
    invoice,
    customerName: invoice.customerName ?? context.customer?.name ?? '',
    contactName: null,
    brokerName: context.division?.name ?? 'BCAT',
    template: context.settings.invoiceEmailTemplate ?? DEFAULT_INVOICE_EMAIL_TEMPLATE,
  })
  const body = message ? `${message}\n\n${rendered.body}` : rendered.body

  const sentCount = (invoice.sentCount ?? 0) + 1
  const noticeId = `inv:${invoice.id}:${sentCount}`
  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    attachments,
    draft: {
      id: noticeId,
      shipmentId: invoice.shipmentId,
      kind: 'INVOICE',
      milestone: 'INVOICE_SENT',
      channel: copyOnly ? 'COPY' : 'EMAIL',
      to,
      cc,
      subject: rendered.subject,
      body,
      attachments: attachments.map((a) => ({ documentId: a.filename, name: a.filename, sizeBytes: a.bytes.byteLength })),
      createdBy: caller.email,
    },
  })

  const now = nowIso()
  if (delivered.status === 'SENT') {
    await transact(
      [updateTx(INVOICE_TABLE_NAME, invoiceId, {
        sentAt: now,
        sentTo: to.join(', '),
        sentCount,
        lastNoticeId: noticeId,
        updatedAt: now,
        updatedBy: caller.email,
        version: (invoice.version ?? 1) + 1,
      })],
      'invoice send',
    )
  }

  // SES is denied on dev and the customer still needs their bill, so a refused send
  // hands back the exact bytes that would have gone out.
  const downloads = delivered.status === 'SENT'
    ? []
    : await Promise.all(
        (invoice.pdfKey ? [{ name: invoiceFilename(invoice.number, invoice.pdfVersion ?? 1), key: invoice.pdfKey }] : [])
          .concat(
            (invoice.attachDocumentIds ?? [])
              .map((id) => context.documents.find((doc) => doc.id === id))
              .filter((doc): doc is ShipmentDocumentRecord => doc != null && Boolean(doc.s3Key))
              .map((doc) => ({ name: doc.name, key: String(doc.s3Key) })),
          )
          .map(async (entry) => ({ name: entry.name, url: await signedDownload(entry.key) })),
      )

  await writeAudit('Invoice', invoiceId, 'EMAIL_INVOICE', caller, { to, cc, status: delivered.status })
  return {
    notice: delivered.notice as unknown as Row,
    emailStatus: delivered.status,
    emailError: delivered.error,
    subject: rendered.subject,
    body,
    to,
    cc,
    downloads,
  }
}

export async function batchEmail(input: Row, caller: Caller): Promise<Row> {
  const invoiceIds = assertArrayOf<string>(input.invoiceIds, 'invoiceIds', (item, index) =>
    assertString(item, `invoiceIds[${index}]`), MAX_BATCH)
  const results: Row[] = []
  for (const invoiceId of invoiceIds) {
    try {
      const sent = await emailInvoice({ invoiceId }, caller)
      results.push({ invoiceId, emailStatus: sent.emailStatus, emailError: sent.emailError })
    } catch (err) {
      results.push({ invoiceId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { results }
}

export async function markInvoiceSent(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const note = optionalString(input.note, MAX_NOTE)
  if (!note) throw new Error('Marking an invoice sent needs a note saying how it went out')

  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  if (row.status === 'VOID') throw new Error('That invoice is void')

  const now = nowIso()
  // `sentAt` means SES accepted the message. Marking an invoice sent by hand records
  // that a person sent it some other way — stamping `sentAt` here would make the
  // shipment card say "E-mailed" about an e-mail this system never sent. The note goes
  // in its own field so it cannot overwrite the note the invoice was issued with.
  await transact(
    [updateTx(INVOICE_TABLE_NAME, invoiceId, {
      markedSentAt: now,
      markedSentBy: caller.email,
      markedSentNote: note,
      updatedAt: now,
      updatedBy: caller.email,
      version: (numberOrNull(row.version) ?? 1) + 1,
    })],
    'invoice mark sent',
  )
  await writeAudit('Invoice', invoiceId, 'MARK_SENT', caller, { note })
  return { invoice: (await getById(INVOICE_TABLE_NAME, invoiceId)) ?? {} }
}

/**
 * The only way back out of UNPAID.
 *
 * Refused once a penny has been taken against it — reverse the payment first — and
 * once the invoice has been submitted to OTR, because the factor has already advanced
 * against a bill we would be un-issuing. The row is kept VOID with its PDF: somebody
 * out there has a copy of that document and the file is the record of what they got.
 */
export async function voidInvoice(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('A void needs a reason')

  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = row as unknown as InvoiceRecord
  if (invoice.status === 'VOID') throw new Error('That invoice is already void')
  if ((invoice.paidCents ?? 0) > 0 || (invoice.writtenOffCents ?? 0) > 0) {
    throw new Error('Money has been applied to this invoice; reverse the payment first')
  }

  const factoringRow = invoice.factoringItemId
    ? await getById(FACTORING_ITEM_TABLE_NAME, invoice.factoringItemId)
    : null
  if (factoringRow?.otrInvoiceId) {
    throw new Error(`This invoice was submitted to OTR as invoice ${String(factoringRow.otrInvoiceId)}; it cannot be voided here`)
  }

  const order = await getById(ORDER_TABLE_NAME, invoice.orderId)
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId)
  const now = nowIso()

  const writes: TransactWriteItem[] = [
    updateTx(
      INVOICE_TABLE_NAME,
      invoiceId,
      {
        status: 'VOID',
        voidedAt: now,
        voidedBy: caller.email,
        voidReason: reason,
        balanceCents: 0,
        updatedAt: now,
        updatedBy: caller.email,
        version: (invoice.version ?? 1) + 1,
      },
      {
        remove: ['arOpen'],
        condition: 'paidCents = :zero AND writtenOffCents = :zero',
        extraValues: { ':zero': { N: '0' } },
      },
    ),
  ]
  if (order) {
    writes.push(
      updateTx(
        ORDER_TABLE_NAME,
        invoice.orderId,
        {
          arStatus: 'UNBILLED',
          arStatusChangedAt: now,
          updatedAt: now,
          updatedBy: caller.email,
          version: (numberOrNull(order.version) ?? 1) + 1,
        },
        {
          remove: ['invoiceId', 'invoiceNumber', 'invoicedAt', 'arBalanceCents', 'paidAt', 'factoringItemId'],
          condition: 'invoiceId = :invoiceId',
          extraValues: { ':invoiceId': { S: invoiceId } },
        },
      ),
    )
  }
  for (const load of loads) {
    if (load.orderId != null && load.orderId !== invoice.orderId) continue
    writes.push(
      updateTx(
        LOAD_FINANCIALS_TABLE_NAME,
        String(load.id),
        { updatedAt: now, updatedBy: caller.email },
        { remove: ['frozenAt', 'frozenBy'], condition: 'attribute_exists(id)' },
      ),
    )
  }
  if (factoringRow && !factoringRow.otrInvoiceId && factoringRow.source === 'TMS') {
    // The row is parked AND released: a voided invoice no longer exists, so leaving
    // its number on the queue row would block the re-issued bill from ever being
    // handed to the factor under the same PRO. The void itself is in the audit log.
    writes.push(updateTx(
      FACTORING_ITEM_TABLE_NAME,
      String(factoringRow.id),
      { status: 'ARCHIVED', updatedAt: now },
      { remove: ['invoiceId'] },
    ))
  }

  // Step I. The commissions ride INSIDE the void's own transaction: an unapproved
  // row is cancelled, an approved or paid one is reversed, and neither can end up
  // disagreeing with the invoice because neither commits without the other.
  writes.push(...(await commissionVoidWrites(invoiceId, caller, now)))

  await transact(writes, 'void invoice')
  await writeAudit('Invoice', invoiceId, 'VOID_INVOICE', caller, { reason, orderId: invoice.orderId })
  return { invoice: (await getById(INVOICE_TABLE_NAME, invoiceId)) ?? {} }
}

export async function saveArSettings(input: Row, caller: Caller): Promise<Row> {
  const format = optionalString(input.invoiceNumberFormat, 64)
  if (format) {
    const error = invoiceNumberFormatError(format)
    if (error) throw new Error(error)
  }
  const template = optionalString(input.invoiceEmailTemplate, 4000)
  if (template && !template.includes('{number}')) {
    throw new Error('The invoice e-mail template must contain {number}')
  }
  const attachTypes = input.invoiceAttachTypes == null
    ? null
    : assertArrayOf<string>(input.invoiceAttachTypes, 'invoiceAttachTypes', (item, index) =>
        assertString(item, `invoiceAttachTypes[${index}]`), 20)
  const batchMode = optionalString(input.invoiceBatchEmail, 20)
  if (batchMode && batchMode !== 'PER_INVOICE' && batchMode !== 'PER_BILL_TO') {
    throw new Error('invoiceBatchEmail must be PER_INVOICE or PER_BILL_TO')
  }

  const now = nowIso()
  const patch: Row = {
    __typename: 'TmsSettings',
    updatedAt: now,
    updatedBy: caller.email,
  }
  if (format) patch.invoiceNumberFormat = format
  if (template) patch.invoiceEmailTemplate = template
  if (attachTypes) patch.invoiceAttachTypes = attachTypes
  if (batchMode) patch.invoiceBatchEmail = batchMode
  const terms = optionalString(input.invoiceTerms, 4000)
  if (terms) patch.invoiceTerms = terms
  const adminOnly = optionalBoolean(input.arPostingAdminOnly)
  if (adminOnly != null) patch.arPostingAdminOnly = adminOnly
  const termsDays = optionalInteger(input.defaultPaymentTermsDays, { min: 0, max: 365, label: 'defaultPaymentTermsDays' })
  if (termsDays != null) patch.defaultPaymentTermsDays = termsDays
  if (input.factorRemitTo != null) {
    // A blob without a name silently turns every factored customer's bill back into
    // "pay us", which is the one mistake this whole field exists to prevent.
    const remitTo = assertRecord(input.factorRemitTo, 'factorRemitTo')
    patch.factorRemitTo = {
      name: assertString(remitTo.name, 'factorRemitTo.name'),
      address: remitTo.address ?? null,
      email: optionalString(remitTo.email, 320),
      noticeText: optionalString(remitTo.noticeText, 2000),
    }
  }

  await transact(
    [updateTx(SETTINGS_TABLE_NAME, 'default', patch)],
    'AR settings',
  )
  await writeAudit('TmsSettings', 'default', 'SAVE_AR_SETTINGS', caller, patch)
  return { settings: await getSettings() }
}
