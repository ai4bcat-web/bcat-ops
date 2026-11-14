/**
 * AGING_STATEMENT — a customer's aging report, previewed and (on `send: true`) e-mailed.
 *
 * Preview returns exactly what would go out: To (the customer's AP addresses), CC (always
 * billing@bcatcorp.com, plus the customer's copy list), subject, attachment name, Ryne's body
 * word for word, and a link to the rendered PDF. Send delivers it through the same notice path
 * every invoice uses, stamps `agingStatementSentAt/To` on the customer and writes an audit row.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { deliverNotice } from '../_shared/shipmentNotices'
import {
  AGING_STATEMENT_ALWAYS_CC,
  agingStatementEmail,
  agingStatementFilename,
  buildAgingStatement,
  isFactoredInvoice,
  type StatementShipmentLike,
} from '../../../src/lib/agingStatement'
import { buildAgingStatementPdf } from '../../../src/lib/agingStatementPdf'
import { allApEmails } from '../../../src/lib/billingMethod'
import type { CustomerRecord, InvoiceRecord } from '../../../src/types/tms'
import {
  CUSTOMER_TABLE_NAME,
  FROM_ADDRESS,
  INVOICE_TABLE_NAME,
  SHIPMENT_NOTICE_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  dynamo,
  getById,
  nowIso,
  putPdf,
  queryIndex,
  ses,
  signedDownload,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'

/** Today in Chicago, YYYY-MM-DD. */
function chicagoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export async function agingStatement(input: Row, caller: Caller): Promise<Row> {
  const customerId = assertString(input.customerId, 'customerId')
  const send = input.send === true
  const asOf = optionalString(input.asOf, 10) ?? chicagoToday()

  const customerRow = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!customerRow) throw new Error(`Customer not found: ${customerId}`)
  const customer = customerRow as unknown as CustomerRecord
  const customerName = customer.name ?? customerId

  const invoices = (await queryIndex(INVOICE_TABLE_NAME, 'invoicesByCustomerIdAndIssuedAt', 'customerId', customerId)) as unknown as InvoiceRecord[]
  const shipmentsById = new Map<string, StatementShipmentLike>()
  for (const id of [...new Set(invoices.filter((inv) => inv.balanceCents > 0 && !isFactoredInvoice(inv)).map((inv) => inv.shipmentId))]) {
    const shipment = await getById(SHIPMENT_TABLE_NAME, id)
    if (shipment) shipmentsById.set(id, shipment as StatementShipmentLike)
  }
  const statement = buildAgingStatement({ customerName, asOf, invoices, shipmentsById })
  const { subject, body } = agingStatementEmail(statement)
  const filename = agingStatementFilename(customerName, asOf)

  const to = allApEmails(customer)
  const cc = [AGING_STATEMENT_ALWAYS_CC, ...(customer.invoiceCopyEmails ?? [])]
    .map((e) => e.trim().toLowerCase())
    .filter((e, i, all) => e && all.indexOf(e) === i && !to.includes(e))

  const bytes = await buildAgingStatementPdf(statement)
  const key = `invoices/statements/${customerId}/${asOf}-${Date.now()}.pdf`
  await putPdf(key, bytes)
  const url = await signedDownload(key)
  const summary = { rows: statement.rows.length, totalCents: statement.totalCents, byBucket: statement.byBucket, companyName: statement.companyName, factoredExcluded: statement.factoredExcluded }

  if (!send) return { preview: true, to, cc, subject, body, filename, url, statement: summary }

  if (to.length === 0) throw new Error(`Missing invoice e-mail: ${customerName} has none on file; add one on the customer before sending a statement`)
  if (statement.rows.length === 0) throw new Error(`${customerName} has no open invoices to report`)

  const now = nowIso()
  // The notice log is keyed by shipment: a statement is filed against its oldest open invoice's shipment.
  const reported = invoices.filter((inv) => inv.balanceCents > 0 && !isFactoredInvoice(inv))
  const firstShipmentId = reported.find((inv) => inv.invoiceDate === statement.rows[0].invoiceDate)?.shipmentId ?? reported[0].shipmentId
  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    attachments: [{ filename, bytes, contentType: 'application/pdf' }],
    draft: {
      id: `stmt:${customerId}:${now}`,
      shipmentId: firstShipmentId,
      kind: 'INVOICE',
      channel: 'EMAIL',
      to,
      cc,
      subject,
      body,
      attachments: [{ documentId: filename, name: filename, sizeBytes: bytes.byteLength }],
      createdBy: caller.email,
    },
  })
  if (delivered.status === 'SENT') {
    await transact([updateTx(CUSTOMER_TABLE_NAME, customerId, {
      agingStatementSentAt: now,
      agingStatementSentTo: to.join(', '),
      updatedAt: now,
    })], 'aging statement')
  }
  await writeAudit('Customer', customerId, 'AGING_STATEMENT_SENT', caller, { to, cc, subject, status: delivered.status, ...summary })
  return {
    preview: false,
    emailStatus: delivered.status,
    emailError: delivered.error ?? null,
    to,
    cc,
    subject,
    body,
    filename,
    url,
    sentAt: delivered.status === 'SENT' ? now : null,
    statement: summary,
  }
}
