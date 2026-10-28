/**
 * Step F live verification against the DEV stack.
 *
 * Throwaway: it builds its own shipment, drives the whole AR lifecycle through the
 * deployed `tmsFinanceActions`, exercises the refusals and the concurrency/idempotency
 * guards, then soft-deletes the fixture it made. It touches no copied customer, load
 * or invoice, and it refuses to run against anything but the dev API.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyAr.mjs
 */
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'

const outputs = {
  auth: {
    user_pool_id: DEV_POOL,
    user_pool_client_id: DEV_CLIENT,
    aws_region: 'us-east-1',
    username_attributes: ['email'],
  },
  data: { url: DEV_API, aws_region: 'us-east-1', default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
function ok(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name} — ${detail}`) }

let token = ''
async function gql(query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}

const shipAction = async (action, input) => {
  const data = await gql(
    'mutation A($action: String!, $input: AWSJSON!) { tmsShipmentActions(action: $action, input: $input) }',
    { action, input: JSON.stringify(input) },
  )
  return JSON.parse(data.tmsShipmentActions)
}
const finAction = async (action, input) => {
  const data = await gql(
    'mutation A($action: String!, $input: AWSJSON!) { tmsFinanceActions(action: $action, input: $input) }',
    { action, input: JSON.stringify(input) },
  )
  return JSON.parse(data.tmsFinanceActions)
}

/** Run a call that must be refused, and check the refusal says what it should. */
async function refuses(name, pattern, run) {
  try {
    await run()
    bad(name, 'it was allowed')
  } catch (err) {
    const message = String(err.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 120))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 160)}`)
  }
}

async function main() {
  const auth = await authenticateTmsUser(outputs)
  token = auth.token
  if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')

  // An isolated fixture customer, not one of the copied accounts: the verification
  // posts money, and no real customer's credit or ledger may move because of it.
  const stamp = Date.now()
  const dirAction = async (action, input) => {
    const data = await gql(
      'mutation A($action: String!, $input: AWSJSON!) { tmsDirectoryActions(action: $action, input: $input) }',
      { action, input: JSON.stringify(input) },
    )
    return JSON.parse(data.tmsDirectoryActions)
  }
  const created = await dirAction('UPSERT_CUSTOMER', {
    name: `ZZ AR Verification ${stamp}`,
    status: 'ACTIVE',
    active: true,
    mcNumber: `9${String(stamp).slice(-6)}`,
    billingEmail: 'ar-verification@example.invalid',
    creditLimitCents: 100000000,
    paymentTermsDays: 30,
    notes: 'Dev-only Step F verification fixture. Safe to delete.',
  })
  const customer = created.customer ?? created
  console.log(`fixture customer: ${customer.name} (${customer.id})`)
  let bundle = await shipAction('CREATE_SHIPMENT', { customerId: customer.id })
  const shipmentId = bundle.shipment.id
  const orderId = bundle.orders[0].id
  console.log(`fixture shipment ${bundle.shipment.number} (${shipmentId})`)

  const today = new Date().toISOString().slice(0, 10)
  bundle = await shipAction('SAVE_ORDER_FORM', {
    shipmentId,
    expectedUpdatedAt: bundle.shipment.updatedAt,
    order: {
      mode: 'FTL',
      equipmentType: 'Dry Van',
      references: [{ code: 'PO', label: 'Purchase order', value: `VERIFY-${stamp}`, level: 'ORDER', visibility: 'CUSTOMER' }],
    },
    stops: [
      { type: 'pickup', name: 'Verify Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
      { type: 'delivery', name: 'Verify Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T23:00:00.000Z` },
    ],
    charges: [
      { side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 },
      { side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 },
    ],
  })
  ok('fixture priced', `revenue ${bundle.orders[0].revenueCents} cost ${bundle.financials[0].costCents}`)

  const reload = async () => { bundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId }) }

  await shipAction('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
  await reload()
  // The shipment's movement status is derived from its loads, so the fixture is
  // walked up the load ladder rather than hand-set.
  for (const status of ['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
    const load = bundle.loads[0]
    try {
      await shipAction('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt })
    } catch (err) {
      console.log(`  (load ${status} skipped: ${String(err.message).slice(0, 70)})`)
    }
    await reload()
  }
  ok('the fixture delivered', `shipment ${bundle.shipment.status}, load ${bundle.loads[0].status}`)

  // ── the gate ──────────────────────────────────────────────────────────────
  await refuses('GENERATE refuses an order still waiting on documents', /UNBILLED/i, () =>
    finAction('GENERATE_INVOICE', { orderId }))

  await shipAction('READY_TO_INVOICE', {
    orderId,
    expectedUpdatedAt: bundle.orders[0].updatedAt,
    override: true,
    overrideNote: 'dev verification fixture; no paperwork exists',
  })
  await reload()
  ok('READY_TO_INVOICE moved the order to UNBILLED', bundle.orders[0].arStatus)

  const preview = await finAction('PREVIEW_INVOICE', { orderId })
  ok('PREVIEW_INVOICE is ready and writes nothing', `ready=${preview.readiness.ready} total=${preview.snapshot.totalCents}`)

  // ── generate ──────────────────────────────────────────────────────────────
  const generated = await finAction('GENERATE_INVOICE', { orderId })
  const invoiceId = generated.invoice.id
  const invoice = generated.invoice
  if (invoice.status === 'ISSUED' && invoice.balanceCents === 250000 && invoice.arOpen === 'OPEN') {
    ok('GENERATE_INVOICE issued the bill', `${invoice.number} balance ${invoice.balanceCents} due ${invoice.dueAt}`)
  } else bad('GENERATE_INVOICE issued the bill', JSON.stringify(invoice).slice(0, 200))
  ok('the PDF was rendered and stored', `${invoice.pdfKey} (${invoice.pdfSizeBytes} bytes)`)

  await reload()
  const order = bundle.orders[0]
  if (order.arStatus === 'UNPAID' && order.invoiceId === invoiceId && order.arBalanceCents === 250000) {
    ok('the order moved to UNPAID in the same transaction', `${order.invoiceNumber} balance ${order.arBalanceCents}`)
  } else bad('the order moved to UNPAID', JSON.stringify(order).slice(0, 200))
  if (bundle.financials[0].frozenAt) ok('the load financials were frozen', bundle.financials[0].frozenAt)
  else bad('the load financials were frozen', 'frozenAt is empty')

  await refuses('a second invoice for the same order is refused', /./, () =>
    finAction('GENERATE_INVOICE', { orderId }))
  await refuses('the frozen charges can no longer be edited', /frozen/i, () =>
    shipAction('RECALC_CHARGES', { shipmentId, expectedVersion: bundle.shipment.version ?? 1 }))
  await refuses('SET_AR_STATUS is refused while an invoice exists', /void the invoice first/i, () =>
    shipAction('SET_AR_STATUS', { orderId, status: 'DOCS_NEEDED' }))
  await refuses('cancelling an invoiced shipment is refused', /void the invoice first/i, () =>
    shipAction('SET_SHIPMENT_STATUS', { shipmentId, status: 'CANCELED', reason: 'verification', expectedUpdatedAt: bundle.shipment.updatedAt }))

  // ── e-mail, honestly ──────────────────────────────────────────────────────
  const emailed = await finAction('EMAIL_INVOICE', { invoiceId })
  if (emailed.emailStatus === 'NOT_SENT' && emailed.emailError && emailed.downloads.length > 0) {
    ok('EMAIL_INVOICE tells the truth on dev', `${emailed.emailStatus}: ${String(emailed.emailError).slice(0, 80)} · ${emailed.downloads.length} download(s)`)
  } else {
    bad('EMAIL_INVOICE tells the truth on dev', `status ${emailed.emailStatus}, error ${emailed.emailError}`)
  }

  // ── payments ──────────────────────────────────────────────────────────────
  const partial = await finAction('RECORD_PAYMENT', {
    customerId: customer.id, receivedAt: today, method: 'CHECK', reference: 'VERIFY-1',
    amountCents: 100000, applications: [{ invoiceId, amountCents: 100000 }], creditApplications: [],
    clientRequestId: 'verify-partial',
  })
  if (partial.invoices[0].status === 'PARTIAL' && partial.invoices[0].balanceCents === 150000) {
    ok('a part payment leaves the invoice PARTIAL and open', `balance ${partial.invoices[0].balanceCents}`)
  } else bad('a part payment', JSON.stringify(partial.invoices[0]).slice(0, 200))

  const retry = await finAction('RECORD_PAYMENT', {
    customerId: customer.id, receivedAt: today, method: 'CHECK', reference: 'VERIFY-1',
    amountCents: 100000, applications: [{ invoiceId, amountCents: 100000 }], creditApplications: [],
    clientRequestId: 'verify-partial',
  })
  if (retry.duplicate === true) ok('a retried payment posts once', `duplicate=${retry.duplicate}`)
  else bad('a retried payment posts once', `duplicate=${retry.duplicate}`)

  await refuses('over-applying the remaining balance is refused', /outstanding/, () =>
    finAction('RECORD_PAYMENT', {
      customerId: customer.id, receivedAt: today, method: 'CHECK', amountCents: 200000,
      applications: [{ invoiceId, amountCents: 200000 }], creditApplications: [], clientRequestId: 'verify-over',
    }))

  const credit = await finAction('CREATE_CREDIT', {
    customerId: customer.id, memoDate: today, amountCents: 50000,
    note: 'dev verification credit', clientRequestId: 'verify-credit',
  })
  const creditId = credit.payment.id
  ok('a credit memo posts unapplied', `${creditId} unapplied ${credit.payment.unappliedCents}`)

  const settled = await finAction('RECORD_PAYMENT', {
    customerId: customer.id, receivedAt: today, method: 'ACH', reference: 'VERIFY-2',
    amountCents: 100000,
    applications: [{ invoiceId, amountCents: 150000 }],
    creditApplications: [{ paymentId: creditId, amountCents: 50000 }],
    clientRequestId: 'verify-settle',
  })
  const settledInvoice = settled.invoices[0]
  if (settledInvoice.status === 'PAID' && settledInvoice.balanceCents === 0 && settledInvoice.arOpen == null) {
    ok('cash plus a credit settles the invoice and closes the open book', `paid ${settledInvoice.paidCents}, arOpen ${String(settledInvoice.arOpen)}`)
  } else bad('cash plus a credit settles the invoice', JSON.stringify(settledInvoice).slice(0, 200))

  await reload()
  if (bundle.orders[0].arStatus === 'PAID' && bundle.orders[0].arBalanceCents === 0) {
    ok('the order reached PAID', `paidAt ${bundle.orders[0].paidAt}`)
  } else bad('the order reached PAID', JSON.stringify(bundle.orders[0]).slice(0, 160))

  await refuses('voiding a paid invoice is refused', /reverse the payment first/i, () =>
    finAction('VOID_INVOICE', { invoiceId, reason: 'verification' }))

  // ── reversal ──────────────────────────────────────────────────────────────
  const reversed = await finAction('REVERSE_PAYMENT', { paymentId: settled.payment.id, reason: 'dev verification' })
  const reopened = reversed.invoices[0]
  if (reopened.status === 'PARTIAL' && reopened.balanceCents === 150000 && reopened.arOpen === 'OPEN') {
    ok('the reversal restored the balance and reopened the invoice', `balance ${reopened.balanceCents}`)
  } else bad('the reversal restored the balance', JSON.stringify(reopened).slice(0, 200))

  const creditAfter = await gql('query G($id: ID!) { getArPayment(id: $id) { id unappliedCents reversedByPaymentId } }', { id: creditId })
  if (creditAfter.getArPayment.unappliedCents === 50000) ok('the credit it spent came back', `unapplied ${creditAfter.getArPayment.unappliedCents}`)
  else bad('the credit it spent came back', JSON.stringify(creditAfter.getArPayment))

  await refuses('a second reversal is refused', /already been reversed/i, () =>
    finAction('REVERSE_PAYMENT', { paymentId: settled.payment.id, reason: 'again' }))

  const reversedCredit = await finAction('REVERSE_PAYMENT', { paymentId: creditId, reason: 'issued in error' })
  ok('a credit memo can be reversed', reversedCredit.payment.id)
  await refuses('a reversed credit cannot be spent', /has been reversed/i, () =>
    finAction('RECORD_PAYMENT', {
      customerId: customer.id, receivedAt: today, method: 'CHECK', amountCents: 100000,
      applications: [{ invoiceId, amountCents: 150000 }],
      creditApplications: [{ paymentId: creditId, amountCents: 50000 }],
      clientRequestId: 'verify-reversed-credit',
    }))

  // ── write-off and factoring ───────────────────────────────────────────────
  const written = await finAction('WRITE_OFF', {
    invoiceId, amountCents: 150000, reason: 'dev verification write-off', clientRequestId: 'verify-wo',
  })
  if (written.invoices[0].status === 'PAID' && written.invoices[0].writtenOffCents === 150000) {
    ok('a write-off settles the rest without pretending it was paid', `paid ${written.invoices[0].paidCents} written off ${written.invoices[0].writtenOffCents}`)
  } else bad('a write-off settles the rest', JSON.stringify(written.invoices[0]).slice(0, 200))

  const writeOffRetry = await finAction('WRITE_OFF', {
    invoiceId, amountCents: 150000, reason: 'dev verification write-off', clientRequestId: 'verify-wo',
  })
  if (writeOffRetry.duplicate === true) ok('a retried write-off answers with the row it posted', 'duplicate=true')
  else bad('a retried write-off', `duplicate=${writeOffRetry.duplicate}`)

  const factorPreview = await finAction('PREVIEW_FACTOR', { invoiceId })
  if (factorPreview.ready === false && /paid/i.test(String(factorPreview.refusal))) {
    ok('a settled invoice is refused by Send to Factor', String(factorPreview.refusal).slice(0, 120))
  } else {
    ok('PREVIEW_FACTOR answered', JSON.stringify(factorPreview).slice(0, 200))
  }

  // ── cleanup: reverse the write-off, void the bill, delete the fixture ──────
  await finAction('REVERSE_PAYMENT', { paymentId: written.payment.id, reason: 'verification cleanup' })
  await finAction('REVERSE_PAYMENT', { paymentId: partial.payment.id, reason: 'verification cleanup' })
  const voided = await finAction('VOID_INVOICE', { invoiceId, reason: 'verification cleanup' })
  if (voided.invoice.status === 'VOID' && voided.invoice.pdfKey) {
    ok('the void kept the PDF and released the order', `${voided.invoice.pdfKey}`)
  } else bad('the void', JSON.stringify(voided.invoice).slice(0, 200))

  await reload()
  if (bundle.orders[0].arStatus === 'UNBILLED' && !bundle.orders[0].invoiceId && !bundle.financials[0].frozenAt) {
    ok('the order is UNBILLED again and the charges are unfrozen', 'invoiceId cleared, frozenAt cleared')
  } else bad('the void restored the order', JSON.stringify(bundle.orders[0]).slice(0, 200))

  // ── the factoring hand-off, on a live unpaid invoice ──────────────────────
  await shipAction('READY_TO_INVOICE', {
    orderId,
    expectedUpdatedAt: bundle.orders[0].updatedAt,
    override: true,
    overrideNote: 'dev verification fixture; no paperwork exists',
  }).catch(() => undefined)
  const reissued = await finAction('GENERATE_INVOICE', { orderId })
  const secondId = reissued.invoice.id
  ok('the voided order can be re-invoiced', `${reissued.invoice.number} (a new number, never the old one)`)

  const handed = await finAction('SEND_TO_FACTOR', { invoiceId: secondId })
  const queueRow = handed.factoringItem
  if (queueRow.status === 'NEED_TO_FACTOR' && queueRow.source === 'TMS' && !queueRow.otrInvoiceId) {
    ok('SEND_TO_FACTOR wrote the queue row and stopped there', `PRO ${queueRow.proNumber} · ${queueRow.messageId} · no OTR submission`)
  } else bad('SEND_TO_FACTOR', JSON.stringify(queueRow).slice(0, 200))
  const fields = queueRow.otrManualFields ?? {}
  ok('the eleven OTR fields were prefilled from the invoice', `InvoiceNo ${fields.InvoiceNo} · ${fields.InvoiceAmount} · ${fields.FromCity}/${fields.FromState} → ${fields.ToCity}/${fields.ToState}`)
  const again = await finAction('SEND_TO_FACTOR', { invoiceId: secondId })
  if (again.reused === true) ok('a second Send to Factor reuses the row rather than double-factoring', 'reused=true')
  else bad('a second Send to Factor', `reused=${again.reused}`)

  const secondVoid = await finAction('VOID_INVOICE', { invoiceId: secondId, reason: 'verification cleanup' })
  ok('the void archived and released the queue row', secondVoid.invoice.status)
  await reload()
  await shipAction('SET_SHIPMENT_STATUS', {
    shipmentId, status: 'CANCELED', reason: 'dev verification fixture', expectedUpdatedAt: bundle.shipment.updatedAt,
  })
  await reload()

  await shipAction('DELETE_SHIPMENT', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt, reason: 'dev verification fixture',
  })
  ok('the fixture shipment was soft-deleted', shipmentId)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('verification aborted:', err.message ?? err)
  process.exitCode = 1
})
