/**
 * Step G live verification against the DEV stack.
 *
 * Throwaway, and the sibling of `devVerifyAr.mjs`: it builds its own shipment and its
 * own carrier, drives the whole AP lifecycle through the deployed `tmsFinanceActions`
 * — record → approve → pay → remittance → reverse → void — walks the own-driver path
 * that must stay OUT of AP, exercises the refusals and the idempotency guards, then
 * soft-deletes the fixture it made. It touches no copied carrier, load or bill, and it
 * refuses to run against anything but the dev API.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyAp.mjs
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

const router = (field) => async (action, input) => {
  const data = await gql(
    `mutation A($action: String!, $input: AWSJSON!) { ${field}(action: $action, input: $input) }`,
    { action, input: JSON.stringify(input) },
  )
  return JSON.parse(data[field])
}
const shipAction = router('tmsShipmentActions')
const finAction = router('tmsFinanceActions')
const dirAction = router('tmsDirectoryActions')
const carrierAction = router('tmsCarrierActions')

/** Run a call that must be refused, and check the refusal says what it should. */
async function refuses(name, pattern, run) {
  try {
    await run()
    bad(name, 'it was allowed')
  } catch (err) {
    const message = String(err.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 140))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 200)}`)
  }
}

async function main() {
  const auth = await authenticateTmsUser(outputs)
  token = auth.token
  if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')

  const stamp = Date.now()
  const today = new Date().toISOString().slice(0, 10)

  // ── fixtures: our own customer, our own carrier, our own shipment ─────────
  const customer = (await dirAction('UPSERT_CUSTOMER', {
    name: `ZZ AP Verification ${stamp}`,
    status: 'ACTIVE',
    active: true,
    mcNumber: `8${String(stamp).slice(-6)}`,
    billingEmail: 'ap-verification@example.invalid',
    creditLimitCents: 100000000,
    paymentTermsDays: 30,
    notes: 'Dev-only Step G verification fixture. Safe to delete.',
  }).then((r) => r.customer ?? r))
  console.log(`fixture customer: ${customer.name} (${customer.id})`)
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const carrier = (await carrierAction('UPSERT_CARRIER', {
    name: `ZZ AP Carrier ${stamp}`,
    type: 'TL',
    status: 'ACTIVE',
    mcNumber: `7${String(stamp).slice(-6)}`,
    dotNumber: `7${String(stamp).slice(-6)}`,
    accountingEmail: 'ap-carrier@example.invalid',
    // Auto liability and cargo covering the pickup are hard blocks on BOOK_CARRIER, and
    // rightly so: the fixture carries real cover rather than booking past the gate.
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'Verification Mutual', policyNumber: `AL-${stamp}`, limitCents: 100000000, expiresAt: nextYear },
      { type: 'CARGO', company: 'Verification Mutual', policyNumber: `CG-${stamp}`, limitCents: 10000000, expiresAt: nextYear },
    ],
    notes: 'Dev-only Step G verification fixture. Safe to delete.',
  }).then((r) => r.carrier ?? r))
  console.log(`fixture carrier: ${carrier.name} (${carrier.id}) status ${carrier.status}`)

  const method = await carrierAction('UPSERT_PAYMENT_METHOD', {
    carrierId: carrier.id,
    method: 'ACH',
    recipientType: 'CARRIER',
    isPreferred: true,
    accountName: carrier.name,
    payeeEmail: 'ap-carrier@example.invalid',
  }).catch((err) => ({ error: String(err.message ?? err) }))
  if (method.error) console.log(`  (payment method: ${method.error.slice(0, 140)})`)
  else ok('the carrier has a remit-to', `${method.method ?? method.paymentMethod?.method} preferred=${method.isPreferred ?? method.paymentMethod?.isPreferred}`)

  /** A priced, submitted FTL fixture of our own. Each path gets one: an own-fleet leg
   *  takes its load out of sourcing, and an outside carrier can only be booked onto a
   *  load that is still sourcing. */
  const makeShipment = async (label) => {
    let b = await shipAction('CREATE_SHIPMENT', { customerId: customer.id })
    const id = b.shipment.id
    b = await shipAction('SAVE_ORDER_FORM', {
      shipmentId: id,
      expectedUpdatedAt: b.shipment.updatedAt,
      order: { mode: 'FTL', equipmentType: 'Dry Van' },
      stops: [
        { type: 'pickup', name: 'Verify Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
        { type: 'delivery', name: 'Verify Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T23:00:00.000Z` },
      ],
      charges: [
        { side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 },
        { side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 },
      ],
    })
    await shipAction('SUBMIT_ORDER', { shipmentId: id, expectedUpdatedAt: b.shipment.updatedAt })
    b = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id })
    console.log(`fixture shipment ${b.shipment.number} (${id}) — ${label}`)
    return b
  }
  const legsOf = (b) => b.loadCarriers ?? b.carriers ?? []

  /** Cancel, then soft-delete: a BOOKED shipment refuses the delete outright. */
  const retireShipment = async (id, label) => {
    for (const step of ['cancel', 'delete']) {
      const current = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id })
      const args = { shipmentId: id, expectedUpdatedAt: current.shipment.updatedAt, reason: 'dev verification fixture' }
      await shipAction(step === 'cancel' ? 'SET_SHIPMENT_STATUS' : 'DELETE_SHIPMENT',
        step === 'cancel' ? { ...args, status: 'CANCELED' } : args)
        .catch((err) => console.log(`  (${label} ${step} skipped: ${String(err.message).slice(0, 90)})`))
    }
  }

  // ── the own-driver path: it must never reach AP ───────────────────────────
  const ownBundleStart = await makeShipment('own-driver path')
  const ownShipmentId = ownBundleStart.shipment.id
  const drivers = await gql('query D { listDrivers(limit: 1, filter: {active: {eq: true}}) { items { id name } } }')
    .catch(() => ({ listDrivers: { items: [] } }))
  const ownDriver = drivers.listDrivers?.items?.[0]
  if (ownDriver) {
    await shipAction('ASSIGN_ASSET', {
      loadId: ownBundleStart.loads[0].id, driverId: ownDriver.id, driverName: ownDriver.name,
    })
    const ownBundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: ownShipmentId })
    const ownLeg = legsOf(ownBundle).find((l) => l.kind === 'OWN_ASSET')
    if (ownLeg) {
      if (!ownLeg.apOpen && !ownLeg.apStatus) ok('an own-fleet leg is created with no AP rung and no board marker', `${ownLeg.id} kind=${ownLeg.kind}`)
      else bad('an own-fleet leg carries no AP state', JSON.stringify({ apStatus: ownLeg.apStatus, apOpen: ownLeg.apOpen }))

      const ownPreview = await finAction('PREVIEW_BILL', { loadCarrierId: ownLeg.id })
      if (ownPreview.readiness?.ready === false && /own-fleet leg/i.test(String(ownPreview.readiness.reasons?.join(' ')))) {
        ok('PREVIEW_BILL refuses an own-fleet leg in readiness, without throwing', String(ownPreview.readiness.reasons[0]).slice(0, 120))
      } else bad('PREVIEW_BILL on an own-fleet leg', JSON.stringify(ownPreview.readiness).slice(0, 200))

      await refuses('RECORD_BILL refuses an own-fleet leg', /own-fleet leg/i, () =>
        finAction('RECORD_BILL', { loadCarrierId: ownLeg.id }))
      await refuses('UPDATE_CARRIER_CHARGES refuses an own-fleet leg', /own-fleet leg is paid through a driver settlement/i, () =>
        shipAction('UPDATE_CARRIER_CHARGES', { loadCarrierId: ownLeg.id, expectedVersion: ownBundle.shipment.version ?? 1, charges: [] }))

      await retireShipment(ownShipmentId, 'own-path cleanup')
    } else {
      bad('an own-fleet leg was created', 'no OWN_ASSET LoadCarrier came back on the bundle')
    }
  } else {
    bad('the own-driver path', 'no active Driver row on dev to assign')
  }

  // ── the outside-carrier path, on its own fixture ──────────────────────────
  let bundle = await makeShipment('carrier AP lifecycle')
  const shipmentId = bundle.shipment.id
  const reload = async () => { bundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId }) }

  // ── book the outside carrier ──────────────────────────────────────────────
  const load = bundle.loads[0]
  const booked = await shipAction('BOOK_CARRIER', {
    loadId: load.id,
    expectedUpdatedAt: load.updatedAt,
    carrierId: carrier.id,
    carrierRateCents: 180000,
    // A carrier built here has no certificates, W-9 or signed agreement in the bucket.
    // Those are warnings, not blocks, and acknowledging them is the booker's real path.
    acknowledgeWarnings: [
      'MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT',
      'INSURANCE_UNVERIFIED',
    ],
  })
  await reload()
  const leg = (bundle.loadCarriers ?? bundle.carriers ?? []).find((l) => l.kind === 'CARRIER' && l.status === 'ACTIVE')
  if (!leg) throw new Error(`no CARRIER assignment on the bundle after BOOK_CARRIER: ${JSON.stringify(booked).slice(0, 200)}`)
  if (leg.apStatus === 'AWAITING_INVOICE' && leg.apOpen === 'OPEN') {
    ok('BOOK_CARRIER opens the leg on the AP board', `${leg.id} ${leg.apStatus}/${leg.apOpen} at ${leg.apStatusChangedAt}`)
  } else bad('BOOK_CARRIER opens the leg on the AP board', JSON.stringify({ apStatus: leg.apStatus, apOpen: leg.apOpen }))

  // ── the gate before the money ─────────────────────────────────────────────
  const preview = await finAction('PREVIEW_BILL', { loadCarrierId: leg.id })
  if (preview.readiness?.ready === true) {
    ok('PREVIEW_BILL is ready and writes nothing', `gross ${preview.snapshot?.grossCents} net ${preview.snapshot?.netCents} payee ${preview.payee?.kind ?? 'none'}`)
  } else bad('PREVIEW_BILL is ready', JSON.stringify(preview.readiness).slice(0, 220))

  // Undelivered freight cannot be approved — the block lives at approval, not at record.
  const recorded = await finAction('RECORD_BILL', {
    loadCarrierId: leg.id,
    billNumber: `AP-${stamp}`,
    billDate: today,
    billedCents: 180000,
    note: 'dev verification bill',
  })
  const billId = recorded.bill.id
  if (recorded.bill.status === 'IN_REVIEW' && recorded.bill.grossCents === 180000 && recorded.bill.varianceCents === 0) {
    ok('RECORD_BILL lands the bill in review', `${recorded.bill.billNumber} gross ${recorded.bill.grossCents} net ${recorded.bill.netCents} due ${recorded.bill.dueAt}`)
  } else bad('RECORD_BILL lands the bill in review', JSON.stringify(recorded.bill).slice(0, 240))

  await reload()
  const afterRecord = (bundle.loadCarriers ?? bundle.carriers ?? []).find((l) => l.id === leg.id)
  if (afterRecord.apStatus === 'IN_REVIEW' && afterRecord.invoiceId === billId) {
    ok('the assignment moved to IN_REVIEW in the same transaction', `invoiceId ${afterRecord.invoiceId}`)
  } else bad('the assignment moved to IN_REVIEW', JSON.stringify({ apStatus: afterRecord.apStatus, invoiceId: afterRecord.invoiceId }))

  await refuses('a second bill on the same assignment is refused', /already billed/i, () =>
    finAction('RECORD_BILL', { loadCarrierId: leg.id, billedCents: 180000 }))
  await refuses('the carrier charges are frozen once a bill exists', /void it first/i, () =>
    shipAction('UPDATE_CARRIER_CHARGES', {
      loadCarrierId: leg.id,
      expectedVersion: bundle.shipment.version ?? 1,
      charges: [{ side: 'CARRIER', code: 'LINEHAUL', rateCents: 190000, count: 1 }],
    }))
  // Recording before the freight moves is allowed and is marked as such: the undelivered
  // check then becomes the RECORDED_EARLY warning rather than a block (src/lib/carrierBill.ts
  // approvalReadiness). What still stops the approval here is the paperwork gate.
  if (recorded.bill.recordedEarly === true) ok('a bill recorded before delivery is marked recordedEarly', 'recordedEarly=true')
  else bad('a bill recorded before delivery is marked recordedEarly', `recordedEarly=${recorded.bill.recordedEarly}`)
  await refuses('a bill cannot be approved while the carrier paperwork is missing', /paperwork is missing/i, () =>
    finAction('APPROVE_BILL', { billId }))

  // Walk the load to delivered so approval is legitimate.
  for (const status of ['PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
    const current = bundle.loads[0]
    await shipAction('SET_LOAD_STATUS', { loadId: current.id, status, expectedUpdatedAt: current.updatedAt })
      .catch((err) => console.log(`  (load ${status} skipped: ${String(err.message).slice(0, 70)})`))
    await reload()
  }
  ok('the fixture delivered', `load ${bundle.loads[0].status}`)

  // ── approval ──────────────────────────────────────────────────────────────
  let approved
  try {
    approved = await finAction('APPROVE_BILL', { billId })
  } catch (err) {
    const message = String(err.message ?? err)
    // The rate confirmation on a hand-built fixture is unsigned, and the paperwork gate
    // has nothing to find: both are acknowledgeable by an admin, which is the path a
    // real approver takes on a bill with an override note.
    approved = await finAction('APPROVE_BILL', {
      billId,
      acknowledgeWarnings: ['RATE_CON_UNSIGNED', 'CARRIER_DO_NOT_USE', 'RECORDED_EARLY'],
      docsOverrideNote: `dev verification fixture; no paperwork exists (${message.slice(0, 80)})`,
    })
  }
  if (approved.bill.status === 'TO_BE_PAID' && approved.bill.approvedAt) {
    ok('APPROVE_BILL moves the bill to to-be-paid', `${approved.bill.status} by ${approved.bill.approvedBy} at ${approved.bill.approvedAt}`)
  } else bad('APPROVE_BILL', JSON.stringify(approved.bill).slice(0, 240))

  // ── payment ───────────────────────────────────────────────────────────────
  await refuses('an AP payment must be allocated in full', /allocated in full/i, () =>
    finAction('RECORD_AP_PAYMENT', {
      carrierId: carrier.id, paidAt: today, method: 'ACH', amountCents: 50000,
      applications: [], clientRequestId: `ap-unallocated-${stamp}`,
    }))

  const partial = await finAction('RECORD_AP_PAYMENT', {
    carrierId: carrier.id, paidAt: today, method: 'ACH', reference: `VERIFY-${stamp}-1`,
    amountCents: 80000, applications: [{ billId, amountCents: 80000 }],
    clientRequestId: `ap-partial-${stamp}`,
  })
  const partialBill = partial.bills[0]
  if (partialBill.status === 'PARTIAL' && partialBill.balanceCents === partialBill.netCents - 80000) {
    ok('a part payment leaves the bill PARTIAL and open', `paid ${partialBill.paidCents} balance ${partialBill.balanceCents}`)
  } else bad('a part payment', JSON.stringify(partialBill).slice(0, 240))

  const retry = await finAction('RECORD_AP_PAYMENT', {
    carrierId: carrier.id, paidAt: today, method: 'ACH', reference: `VERIFY-${stamp}-1`,
    amountCents: 80000, applications: [{ billId, amountCents: 80000 }],
    clientRequestId: `ap-partial-${stamp}`,
  })
  if (retry.duplicate === true) ok('a retried AP payment posts once', 'duplicate=true')
  else bad('a retried AP payment posts once', `duplicate=${retry.duplicate}`)

  await refuses('over-applying the remaining balance is refused', /outstanding/i, () =>
    finAction('RECORD_AP_PAYMENT', {
      carrierId: carrier.id, paidAt: today, method: 'ACH', amountCents: 900000,
      applications: [{ billId, amountCents: 900000 }], clientRequestId: `ap-over-${stamp}`,
    }))

  const credit = await finAction('CREATE_AP_CREDIT', {
    carrierId: carrier.id, memoDate: today, amountCents: 20000,
    reason: 'dev verification credit', clientRequestId: `ap-credit-${stamp}`,
  })
  const creditId = credit.payment.id
  ok('an AP credit memo posts unapplied', `${creditId} unapplied ${credit.payment.unappliedCents}`)

  const rest = partialBill.balanceCents
  const settled = await finAction('RECORD_AP_PAYMENT', {
    carrierId: carrier.id, paidAt: today, method: 'CHECK', reference: `VERIFY-${stamp}-2`,
    amountCents: Math.max(rest - 20000, 0),
    applications: [{ billId, amountCents: rest }],
    creditApplications: [{ paymentId: creditId, amountCents: Math.min(20000, rest) }],
    clientRequestId: `ap-settle-${stamp}`,
  })
  const settledBill = settled.bills[0]
  if (settledBill.status === 'PAID' && settledBill.balanceCents === 0 && !settledBill.apOpen) {
    ok('cash plus a credit settles the bill and closes the board', `paid ${settledBill.paidCents} credited ${settledBill.creditedCents} apOpen ${String(settledBill.apOpen)}`)
  } else bad('cash plus a credit settles the bill', JSON.stringify(settledBill).slice(0, 240))

  await reload()
  const paidLeg = (bundle.loadCarriers ?? bundle.carriers ?? []).find((l) => l.id === leg.id)
  if (paidLeg.apStatus === 'PAID' && !paidLeg.apOpen) {
    ok('the assignment reached PAID and left the AP board', `apOpen ${String(paidLeg.apOpen)}`)
  } else bad('the assignment reached PAID', JSON.stringify({ apStatus: paidLeg.apStatus, apOpen: paidLeg.apOpen }))

  await refuses('voiding a paid bill is refused', /reverse the payment first/i, () =>
    finAction('VOID_BILL', { billId, reason: 'verification' }))

  // ── remittance ────────────────────────────────────────────────────────────
  const remit = await finAction('SEND_REMITTANCE', { paymentId: settled.payment.id })
  if (remit.emailStatus === 'NOT_SENT' && remit.emailError && remit.downloads?.length) {
    ok('SEND_REMITTANCE tells the truth on dev', `${remit.emailStatus}: ${String(remit.emailError).slice(0, 70)} · ${remit.downloads.length} download(s)`)
  } else bad('SEND_REMITTANCE on dev', JSON.stringify({ emailStatus: remit.emailStatus, emailError: remit.emailError }).slice(0, 220))
  if (remit.notice?.id) ok('the remittance notice row was written', `${remit.notice.id} ${remit.notice.status ?? ''}`)

  const remitAgain = await finAction('SEND_REMITTANCE', { paymentId: settled.payment.id })
  if (remitAgain.notice?.id && remitAgain.notice.id !== remit.notice?.id) {
    ok('a second attempt is its own notice, not a silent no-op', `${remit.notice.id} → ${remitAgain.notice.id}`)
  } else ok('a second remittance attempt answered', JSON.stringify(remitAgain.notice ?? {}).slice(0, 160))

  const marked = await finAction('MARK_REMITTANCE_SENT', { paymentId: settled.payment.id, note: 'dev verification: sent by hand' })
  if (marked.payment.markedSentAt) ok('MARK_REMITTANCE_SENT records who said so and when', `${marked.payment.markedSentBy} ${marked.payment.markedSentAt}`)
  else bad('MARK_REMITTANCE_SENT', JSON.stringify(marked.payment).slice(0, 200))

  // ── reversal ──────────────────────────────────────────────────────────────
  const reversed = await finAction('REVERSE_AP_PAYMENT', { paymentId: settled.payment.id, reason: 'dev verification' })
  const reopened = reversed.bills[0]
  if (reopened.status === 'PARTIAL' && reopened.balanceCents === rest && reopened.apOpen === 'OPEN') {
    ok('the reversal restored the balance and reopened the bill', `balance ${reopened.balanceCents} apOpen ${reopened.apOpen}`)
  } else bad('the reversal restored the balance', JSON.stringify(reopened).slice(0, 240))

  const creditAfter = await gql('query G($id: ID!) { getApPayment(id: $id) { id unappliedCents reversedByPaymentId } }', { id: creditId })
  if (creditAfter.getApPayment.unappliedCents === Math.min(20000, rest)) {
    ok('the credit it spent came back', `unapplied ${creditAfter.getApPayment.unappliedCents}`)
  } else bad('the credit it spent came back', JSON.stringify(creditAfter.getApPayment))

  await refuses('a second reversal is refused', /already been reversed/i, () =>
    finAction('REVERSE_AP_PAYMENT', { paymentId: settled.payment.id, reason: 'again' }))

  // ── void, and what it releases ────────────────────────────────────────────
  await finAction('REVERSE_AP_PAYMENT', { paymentId: partial.payment.id, reason: 'verification cleanup' })
  await refuses('a void needs a reason', /needs a reason/i, () => finAction('VOID_BILL', { billId }))
  const voided = await finAction('VOID_BILL', { billId, reason: 'verification cleanup' })
  if (voided.bill.status === 'VOID') ok('VOID_BILL is the only undo', `${voided.bill.status} by ${voided.bill.voidedBy}`)
  else bad('VOID_BILL', JSON.stringify(voided.bill).slice(0, 220))

  await reload()
  const releasedLeg = (bundle.loadCarriers ?? bundle.carriers ?? []).find((l) => l.id === leg.id)
  if (releasedLeg.apStatus === 'AWAITING_INVOICE' && !releasedLeg.invoiceId && releasedLeg.apOpen === 'OPEN') {
    ok('the void put the assignment back on the board, unbilled', `apStatus ${releasedLeg.apStatus} apOpen ${releasedLeg.apOpen}`)
  } else bad('the void released the assignment', JSON.stringify({ apStatus: releasedLeg.apStatus, invoiceId: releasedLeg.invoiceId, apOpen: releasedLeg.apOpen }))

  // UPDATE_CARRIER_CHARGES takes the SHIPMENT's version as its CAS token, not the leg's.
  const recharged = await shipAction('UPDATE_CARRIER_CHARGES', {
    loadCarrierId: leg.id,
    expectedVersion: bundle.shipment.version ?? 1,
    charges: [{ side: 'CARRIER', code: 'LINEHAUL', rateCents: 175000, count: 1 }],
  }).catch((err) => ({ error: String(err.message ?? err) }))
  if (recharged.error) bad('the charges can be edited again after a void', recharged.error.slice(0, 180))
  else ok('the charges can be edited again after a void', 'UPDATE_CARRIER_CHARGES accepted')

  // ── cleanup ───────────────────────────────────────────────────────────────
  await retireShipment(shipmentId, 'carrier-path cleanup')
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
