/**
 * Step R live verification against the DEV stack.
 *
 * Throwaway, the sibling of `devVerifyCommissions.mjs`. It drives the deployed Lambdas
 * through Ryne's Step R hard rules with real tokens, never through the UI:
 *
 *   - PRO permanence: the generated `deleteLoad` mutation is gone from the schema,
 *     `DELETE_SHIPMENT` / `RESTORE_SHIPMENT` no longer resolve, a non-admin token
 *     cannot void, an admin void keeps the PRO, the legs and the documents, and a
 *     voided shipment refuses every write, cannot be invoiced, and leaves the driver's
 *     calendar and settlement;
 *   - the ownership taxonomy: the seed rows exist, booking Ivan Cartage (own fleet)
 *     tags ASSETS + the driver's subsidiary on BOTH the Shipment and the mirrored Load,
 *     an outside carrier tags BROKERAGE and clears the own-fleet marks, a hand tag
 *     survives a carrier change, RETAG dry-runs without writing;
 *   - the own-fleet mirror: the Load carries pickupDriverId / deliveryDriverId /
 *     stops[].driverId / truckId exactly as a load booked on the calendar would;
 *   - the release-to-accounting gate: READY_TO_INVOICE, SET_AR_STATUS, GENERATE_INVOICE,
 *     BATCH_GENERATE, PREVIEW_INVOICE and SEND_TO_FACTOR all refuse with the exact
 *     missing list (documents, references, open exceptions, unsettled carrier charges),
 *     `override` no longer exists, and two concurrent GENERATE_INVOICE calls issue one
 *     invoice.
 *
 * Fixtures are retired by VOID (never deleted); the temporary identity is created with
 * a randomised password that is never printed and removed in a `finally`. It refuses
 * to run against anything but the dev API.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyStepR.mjs
 */
import { randomBytes } from 'node:crypto'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
const region = 'us-east-1'

const outputs = {
  auth: { user_pool_id: DEV_POOL, user_pool_client_id: DEV_CLIENT, aws_region: region, username_attributes: ['email'] },
  data: { url: DEV_API, aws_region: region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
function ok(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name} — ${detail}`) }
function equals(name, actual, expected, note) {
  if (actual === expected) ok(name, note ?? String(actual))
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${note ? ` (${note})` : ''}`)
}
async function refuses(name, pattern, run) {
  try {
    await run()
    bad(name, 'it was allowed')
  } catch (err) {
    const message = String(err.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 160))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 220)}`)
  }
}

let token = ''
async function gqlAs(authToken, query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authToken },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}
const gql = (query, variables) => gqlAs(token, query, variables)
const routerAs = (authToken, field) => async (action, input) => {
  const data = await gqlAs(
    authToken,
    `mutation A($action: String!, $input: AWSJSON!) { ${field}(action: $action, input: $input) }`,
    { action, input: JSON.stringify(input) },
  )
  return JSON.parse(data[field])
}
const shipAction = (action, input) => routerAs(token, 'tmsShipmentActions')(action, input)
const finAction = (action, input) => routerAs(token, 'tmsFinanceActions')(action, input)
const dirAction = (action, input) => routerAs(token, 'tmsDirectoryActions')(action, input)

async function manageUsers(args) {
  const names = Object.keys(args)
  const typeOf = (k) => (k === 'isAdmin' ? 'Boolean' : 'String')
  const decls = names.map((n) => `$${n}: ${typeOf(n)}${n === 'action' ? '!' : ''}`).join(', ')
  const passed = names.map((n) => `${n}: $${n}`).join(', ')
  const data = await gql(`query M(${decls}) { manageUsers(${passed}) }`, args)
  let value = data.manageUsers
  while (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { break }
  }
  return value
}

// ── temporary identity ───────────────────────────────────────────────────────
function secret() { return `Aa1!${randomBytes(18).toString('base64url')}` }
let poolClient = null
async function cognitoAdmin() {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider')
  poolClient ??= new sdk.CognitoIdentityProviderClient({ region })
  return { sdk, client: poolClient }
}
async function setPoolPassword(username, password) {
  const { sdk, client } = await cognitoAdmin()
  await client.send(new sdk.AdminSetUserPasswordCommand({ UserPoolId: DEV_POOL, Username: username, Password: password, Permanent: true }))
}
async function deleteFromPool(username, profileId) {
  const [{ sdk, client }, { DynamoDBClient, DeleteItemCommand }] =
    await Promise.all([cognitoAdmin(), import('@aws-sdk/client-dynamodb')])
  await new DynamoDBClient({ region }).send(new DeleteItemCommand({
    TableName: `UserProfile-${DEV_TABLE_SUFFIX}`, Key: { id: { S: profileId ?? username } },
  })).catch(() => {})
  await client.send(new sdk.AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: username })).catch(() => {})
}
let amplifyAuth = null
async function authModule() {
  if (!amplifyAuth) {
    const { Amplify } = await import('aws-amplify')
    Amplify.configure(outputs)
    amplifyAuth = await import('aws-amplify/auth')
  }
  return amplifyAuth
}
async function tokenFor(email, password) {
  const auth = await authModule()
  await auth.signOut().catch(() => {})
  const attempt = await auth.signIn({ username: email, password })
  if (!attempt.isSignedIn) {
    const confirmed = await auth.confirmSignIn({ challengeResponse: secret() })
    if (!confirmed.isSignedIn) throw new Error('the temporary identity could not finish signing in')
  }
  const session = await auth.fetchAuthSession({ forceRefresh: true })
  const idToken = session.tokens?.idToken?.toString()
  await auth.signOut().catch(() => {})
  if (!idToken) throw new Error('no id token for the temporary identity')
  return idToken
}

// ── documents: a tiny real PDF through PREPARE → PUT → COMMIT ───────────────
const TINY_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
async function attachDocument(shipmentId, orderId, loadId, type) {
  const name = `verify-${type.toLowerCase()}.pdf`
  const prepared = await shipAction('PREPARE_DOCUMENT_UPLOAD', {
    shipmentId, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length,
  })
  const put = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: TINY_PDF })
  if (!put.ok) throw new Error(`upload failed: ${put.status}`)
  return shipAction('COMMIT_DOCUMENT', {
    shipmentId, documentId: prepared.documentId, s3Key: prepared.s3Key, type, name,
    contentType: 'application/pdf', sizeBytes: TINY_PDF.length,
    ...(type === 'BOL' || type === 'POD' ? { loadId } : { orderId }),
  })
}
const loadRow = async (id) => (await gql(
  `query L($id: ID!) { getLoad(id: $id) { id status assignmentType carrierName pickupDriverId deliveryDriverId truckId trailerNumber stops readyToInvoice revDivision revSubdivision revTagSource salesRepId voidedAt updatedAt } }`,
  { id },
)).getLoad
const stopsOf = (load) => { try { return JSON.parse(load.stops ?? '[]') } catch { return [] } }

async function main() {
  const auth = await authenticateTmsUser(outputs)
  token = auth.token
  if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')
  const stamp = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const createdUsers = []
  const fixtures = { shipmentIds: [], customerId: null }

  try {
    // ── 1. the schema no longer offers a delete ───────────────────────────
    const schema = await gql(`query S { __schema { mutationType { fields { name } } subscriptionType { fields { name } } types { name } } }`)
    const mutations = schema.__schema.mutationType.fields.map((f) => f.name)
    const subs = schema.__schema.subscriptionType.fields.map((f) => f.name)
    const types = schema.__schema.types.map((t) => t.name)
    equals('deleteLoad is gone from the deployed schema', mutations.includes('deleteLoad'), false)
    equals('onDeleteLoad is gone from the deployed schema', subs.includes('onDeleteLoad'), false)
    equals('deleteShipment is gone from the deployed schema', mutations.includes('deleteShipment'), false)
    equals('onDeleteShipment is gone from the deployed schema', subs.includes('onDeleteShipment'), false)
    equals('updateLoad still exists (additive)', mutations.includes('updateLoad'), true)
    for (const t of ['OwnershipDivision', 'OwnershipRule', 'ShipmentView']) equals(`${t} type is deployed`, types.includes(t), true)
    await refuses('DELETE_SHIPMENT no longer resolves', /Unknown action/i, () => shipAction('DELETE_SHIPMENT', { shipmentId: 'x' }))
    await refuses('RESTORE_SHIPMENT no longer resolves', /Unknown action/i, () => shipAction('RESTORE_SHIPMENT', { shipmentId: 'x' }))

    // ── 2. the taxonomy seed ──────────────────────────────────────────────
    const seed = await dirAction('ENSURE_OWNERSHIP_SEED', {})
    ok('ENSURE_OWNERSHIP_SEED ran', JSON.stringify(seed))
    const seedAgain = await dirAction('ENSURE_OWNERSHIP_SEED', {})
    equals('a second seed creates nothing', (seedAgain.divisionsCreated ?? 0) + (seedAgain.rulesCreated ?? 0) + (seedAgain.viewsCreated ?? 0), 0)
    const divisions = (await gql(`query D { listOwnershipDivisions(limit: 200) { items { id code name brand parentId active sortOrder } } }`)).listOwnershipDivisions.items
    const rules = (await gql(`query R { listOwnershipRules(limit: 200) { items { id sortOrder active divisionCode } } }`)).listOwnershipRules.items
    const views = (await gql(`query V { listShipmentViews(limit: 200) { items { id slug name active } } }`)).listShipmentViews.items
    const codes = divisions.map((d) => d.code).sort()
    ok('division rows', codes.join(' '))
    for (const c of ['BROKERAGE', 'ASSETS', 'OWNER_OPERATOR', 'BOX_TRUCK', 'LOCAL', 'CAR_SHIPPING', 'COMPANY']) equals(`division ${c} seeded`, codes.includes(c), true)
    equals('three ASSETS subsidiaries', divisions.filter((d) => d.parentId === 'ASSETS').length, 3)
    equals('seven seed rules', rules.filter((r) => r.id.startsWith('rule-seed-')).length, 7)
    equals('ten seed views', views.filter((v) => v.active !== false).length >= 10, true, `${views.length} views: ${views.map((v) => v.slug).join(' ')}`)

    // ── 3. a non-admin identity, from a real token ────────────────────────
    const repEmail = `zz-r-rep-${stamp}@example.invalid`
    const repPassword = secret()
    const repCreated = await manageUsers({ action: 'create', email: repEmail, role: 'CUSTOMER_REP' })
    createdUsers.push({ email: repEmail, profileId: repCreated.profile?.id ?? null })
    await setPoolPassword(repEmail, repPassword)
    const repToken = await tokenFor(repEmail, repPassword)
    token = (await authenticateTmsUser(outputs)).token
    const repShip = routerAs(repToken, 'tmsShipmentActions')

    // ── 4. fixtures: a customer that requires BOL + POD + a PO reference ──
    const created = await dirAction('UPSERT_CUSTOMER', {
      name: `ZZ Step R Verification ${stamp}`, status: 'ACTIVE', active: true,
      mcNumber: `8${String(stamp).slice(-6)}`, billingEmail: 'r-verification@example.invalid',
      creditLimitCents: 100000000, paymentTermsDays: 30,
      requiredDocsForInvoice: ['BOL', 'POD'],
      requiredReferences: [{ code: 'PO', label: 'PO number', level: 'ORDER', countOnNewOrder: 1 }],
      notes: 'Dev-only Step R verification fixture. Voided at the end of the run.',
    })
    const customer = created.customer ?? created
    fixtures.customerId = customer.id
    console.log(`fixture customer: ${customer.name} (${customer.id})`)

    const drivers = (await gql(`query Dr { listDrivers(limit: 1000) { items { id name active type fleetGroup driverType assignedTruckId } } }`)).listDrivers.items
    const ivanDriver = drivers.find((d) => d.active && d.type !== 'broker' && d.fleetGroup === 'BOX_TRUCK')
      ?? drivers.find((d) => d.active && d.type !== 'broker' && ['LOCAL', 'OWNER_OPERATOR'].includes(d.fleetGroup ?? ''))
    if (!ivanDriver) throw new Error('no active Ivan driver with a fleet group on dev')
    const expectedSub = ivanDriver.fleetGroup === 'BOX_TRUCK' ? 'BOX_TRUCK' : ivanDriver.fleetGroup === 'LOCAL' ? 'LOCAL' : 'OWNER_OPERATOR'
    console.log(`Ivan driver for the proof: ${ivanDriver.name} (${ivanDriver.id}, ${ivanDriver.fleetGroup})`)

    async function newShipment(label) {
      let bundle = await shipAction('CREATE_SHIPMENT', { customerId: customer.id })
      const shipmentId = bundle.shipment.id
      fixtures.shipmentIds.push(shipmentId)
      bundle = await shipAction('SAVE_ORDER_FORM', {
        shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
        order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'PO number', value: `R-${label}-${stamp}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
        stops: [
          { type: 'pickup', name: 'Verify Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
          { type: 'delivery', name: 'Verify Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T21:00:00.000Z` },
        ],
        charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }],
      })
      await shipAction('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
      bundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId })
      console.log(`fixture shipment ${label}: ${bundle.shipment.number} (${shipmentId})`)
      return bundle
    }
    const reload = (shipmentId) => shipAction('GET_SHIPMENT_BUNDLE', { shipmentId })
    async function deliver(shipmentId) {
      let bundle = await reload(shipmentId)
      for (const status of ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
        const load = bundle.loads[0]
        try { await shipAction('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt }) } catch (err) { console.log(`  (load ${status} skipped: ${String(err.message).slice(0, 80)})`) }
        bundle = await reload(shipmentId)
      }
      return bundle
    }

    // ── 5. shipment A: Ivan Cartage (own fleet) ───────────────────────────
    let a = await newShipment('A')
    const aId = a.shipment.id
    const aOrderId = a.orders[0].id
    const aLoadId = a.loads[0].id
    equals('a fresh brokerage-booked shipment resolves BROKERAGE before a carrier is chosen', a.shipment.revDivision, 'BROKERAGE')
    await shipAction('ASSIGN_ASSET', { loadId: aLoadId, driverId: ivanDriver.id, driverName: ivanDriver.name, truckId: ivanDriver.assignedTruckId ?? 'verify-truck', truckNumber: '3890' })
    a = await reload(aId)
    let aLoad = await loadRow(aLoadId)
    equals('own fleet → Shipment.revDivision ASSETS', a.shipment.revDivision, 'ASSETS')
    equals(`own fleet → Shipment.revSubdivision ${expectedSub}`, a.shipment.revSubdivision, expectedSub)
    equals('the mirrored Load carries the same division', aLoad.revDivision, 'ASSETS')
    equals('the mirrored Load carries the same subdivision', aLoad.revSubdivision, expectedSub)
    equals('Load.pickupDriverId is the Ivan driver (calendar / dashboards read it)', aLoad.pickupDriverId, ivanDriver.id)
    equals('Load.deliveryDriverId is the Ivan driver (settlements read it)', aLoad.deliveryDriverId, ivanDriver.id)
    equals('every stop carries the driver (driver app reads it)', stopsOf(aLoad).every((s) => s.driverId === ivanDriver.id), true)
    equals('Load.assignmentType OWN_ASSET', aLoad.assignmentType, 'OWN_ASSET')
    equals('Load.truckId written', Boolean(aLoad.truckId), true, aLoad.truckId)
    const test = await shipAction('TEST_OWNERSHIP_RULES', { shipmentId: aId })
    equals('TEST_OWNERSHIP_RULES sees the own-fleet carrier', test.context?.carrierId, 'OWN_FLEET')
    equals('TEST_OWNERSHIP_RULES resolves the same tag', test.resolution?.revDivision, 'ASSETS')

    a = await deliver(aId)
    equals('A delivered', a.shipment.status, 'DELIVERED')

    // ── 6. the release gate on A ──────────────────────────────────────────
    const exact = (parts) => new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
    await refuses('READY_TO_INVOICE refuses with the exact missing documents', exact(['Not ready for accounting', 'Missing document: BOL', 'Missing document: POD']), () =>
      shipAction('READY_TO_INVOICE', { orderId: aOrderId, expectedUpdatedAt: a.orders[0].updatedAt }))
    await refuses('READY_TO_INVOICE no longer accepts an override', /Not ready for accounting/, () =>
      shipAction('READY_TO_INVOICE', { orderId: aOrderId, expectedUpdatedAt: a.orders[0].updatedAt, override: true, overrideNote: 'bypass attempt' }))
    await refuses('SET_AR_STATUS UNBILLED is gated the same way', /Not ready for accounting.*Missing document: POD/, () =>
      shipAction('SET_AR_STATUS', { orderId: aOrderId, status: 'UNBILLED', expectedUpdatedAt: a.orders[0].updatedAt }))
    await refuses('GENERATE_INVOICE cannot jump the gate', /UNBILLED|Not ready for accounting/, () => finAction('GENERATE_INVOICE', { orderId: aOrderId }))
    const previewA = await finAction('PREVIEW_INVOICE', { orderId: aOrderId })
    equals('PREVIEW_INVOICE reports the gate', previewA.releaseGate?.ok, false, (previewA.releaseGate?.missing ?? []).map((m) => m.message).join(' | '))
    const batch = await finAction('BATCH_GENERATE', { orderIds: [aOrderId] })
    const batchRow = (batch.results ?? [])[0] ?? {}
    equals('BATCH_GENERATE refuses the row with the gate reasons', Boolean(batchRow.error) && !batchRow.invoiceId, true, `${batchRow.error ?? ''} | ${(batchRow.releaseGate?.missing ?? []).map((m) => m.code).join(',')}`)

    await attachDocument(aId, aOrderId, aLoadId, 'BOL')
    await attachDocument(aId, aOrderId, aLoadId, 'POD')
    a = await reload(aId)
    // an open exception blocks it even with every document present
    const incident = await shipAction('LOG_CHECK_CALL', {
      loadId: aLoadId, expectedUpdatedAt: a.loads[0].updatedAt, at: new Date().toISOString(),
      type: 'INCIDENT', incidentType: 'GENERAL_EXCEPTION', note: 'verification exception',
    })
    a = await reload(aId)
    await refuses('an open exception blocks release', /Not ready for accounting.*open exception/, () =>
      shipAction('READY_TO_INVOICE', { orderId: aOrderId, expectedUpdatedAt: a.orders[0].updatedAt }))
    const incidentId = incident.event?.id
    await shipAction('RESOLVE_INCIDENT', { checkCallId: incidentId, note: 'resolved for the proof' })
    a = await reload(aId)
    const released = await shipAction('READY_TO_INVOICE', { orderId: aOrderId, expectedUpdatedAt: a.orders[0].updatedAt })
    equals('with BOL + POD + PO + own-fleet leg + no exceptions the gate opens', released.releaseGate?.ok ?? (released.bundle?.orders?.[0]?.arStatus === 'UNBILLED'), true)
    a = await reload(aId)
    equals('order is UNBILLED', a.orders[0].arStatus, 'UNBILLED')

    // concurrency: two GENERATE_INVOICE at once → exactly one invoice
    const race = await Promise.allSettled([finAction('GENERATE_INVOICE', { orderId: aOrderId }), finAction('GENERATE_INVOICE', { orderId: aOrderId })])
    const wins = race.filter((r) => r.status === 'fulfilled').length
    equals('two concurrent GENERATE_INVOICE calls issue exactly one invoice', wins, 1, race.map((r) => r.status === 'rejected' ? String(r.reason.message).slice(0, 80) : 'ok').join(' / '))
    a = await reload(aId)
    equals('order is UNPAID with one invoice', a.orders[0].arStatus, 'UNPAID', a.orders[0].invoiceId)
    const aInvoiceId = a.orders[0].invoiceId
    await refuses('an invoiced shipment cannot be voided', /invoice/i, () =>
      shipAction('VOID_SHIPMENT', { shipmentId: aId, reason: 'attempt on an invoiced shipment', expectedUpdatedAt: a.shipment.updatedAt }))

    // ── 7. shipment B: outside carrier, hand tag, bounce, void ────────────
    let b = await newShipment('B')
    const bId = b.shipment.id
    const bOrderId = b.orders[0].id
    const bLoadId = b.loads[0].id
    await shipAction('ASSIGN_ASSET', { loadId: bLoadId, driverId: ivanDriver.id, driverName: ivanDriver.name, truckId: ivanDriver.assignedTruckId ?? 'verify-truck' })
    let bLoad = await loadRow(bLoadId)
    equals('B booked to Ivan first (driver on the Load)', bLoad.deliveryDriverId, ivanDriver.id)
    await shipAction('ASSIGN_CARRIER', { loadId: bLoadId, carrierName: `ZZ Verify Carrier ${stamp}`, carrierRateCents: 180000 })
    b = await reload(bId)
    bLoad = await loadRow(bLoadId)
    equals('switching to an outside carrier clears pickupDriverId', bLoad.pickupDriverId, null)
    equals('switching to an outside carrier clears deliveryDriverId', bLoad.deliveryDriverId, null)
    equals('switching to an outside carrier clears truckId', bLoad.truckId, null)
    equals('switching to an outside carrier clears every stop driver', stopsOf(bLoad).every((s) => !s.driverId), true)
    equals('stops keep their appointments', stopsOf(bLoad).every((s) => Boolean(s.appt)), true)
    equals('outside carrier → BROKERAGE on the Shipment', b.shipment.revDivision, 'BROKERAGE')
    equals('outside carrier → BROKERAGE on the Load', bLoad.revDivision, 'BROKERAGE')
    await refuses('a non-admin token (page-loads via CUSTOMER_REP) cannot void', /owner|ADMIN/i, () =>
      repShip('VOID_SHIPMENT', { shipmentId: bId, reason: 'rep tries to void', expectedUpdatedAt: b.shipment.updatedAt }))
    await shipAction('SET_REV_TAG', { shipmentId: bId, divisionCode: 'CAR_SHIPPING' })
    b = await reload(bId)
    equals('hand tag applied', `${b.shipment.revDivision}/${b.shipment.revTagSource}`, 'CAR_SHIPPING/HAND')
    const activeLeg = b.loadCarriers.find((c) => c.status === 'ACTIVE')
    await shipAction('REMOVE_LOAD_CARRIER', { loadCarrierId: activeLeg.id, outcome: 'BOUNCED', reason: 'OTHER', note: 'verification bounce' })
    b = await reload(bId)
    bLoad = await loadRow(bLoadId)
    equals('a hand tag survives a bounce', `${b.shipment.revDivision}/${b.shipment.revTagSource}`, 'CAR_SHIPPING/HAND')
    equals('the bounced Load is NEED_TO_COVER', bLoad.assignmentType, 'NEED_TO_COVER')
    await shipAction('CLEAR_REV_TAG', { shipmentId: bId })
    b = await reload(bId)
    equals('clearing the hand tag hands it back to the rules', `${b.shipment.revDivision}/${b.shipment.revTagSource}`, 'BROKERAGE/RULE')
    await shipAction('SET_SALES_REP', { shipmentId: bId, repId: createdUsers[0].profileId ?? repEmail })
    b = await reload(bId)
    bLoad = await loadRow(bLoadId)
    equals('SET_SALES_REP mirrors to the Load', bLoad.salesRepId, b.shipment.salesRepId)

    // the gate with an outside carrier whose bill is not recorded
    await shipAction('ASSIGN_CARRIER', { loadId: bLoadId, carrierName: `ZZ Verify Carrier ${stamp}`, carrierRateCents: 180000 })
    b = await deliver(bId)
    await attachDocument(bId, bOrderId, bLoadId, 'BOL')
    await attachDocument(bId, bOrderId, bLoadId, 'POD')
    b = await reload(bId)
    await refuses('an outside carrier without a recorded bill cannot be released', /Not ready for accounting.*(Carrier charges not settled|Missing document: RATE_CON)/, () =>
      shipAction('READY_TO_INVOICE', { orderId: bOrderId, expectedUpdatedAt: b.orders[0].updatedAt }))
    await refuses('SEND_TO_FACTOR needs an issued invoice, which only the gate produces', /Not ready for accounting|invoice/i, () =>
      finAction('SEND_TO_FACTOR', { orderId: bOrderId, shipmentId: bId }))
    const previewFactor = await finAction('PREVIEW_FACTOR', { orderId: bOrderId, shipmentId: bId })
      .catch((err) => ({ error: String(err.message) }))
    equals(
      'PREVIEW_FACTOR runs the same gate and names what is missing',
      previewFactor.error
        ? /Not ready for accounting|invoice|RATE_CON|Carrier charges/i.test(previewFactor.error)
        : (previewFactor.releaseGate?.missing ?? []).length > 0,
      true,
      previewFactor.error ?? JSON.stringify(previewFactor.releaseGate),
    )

    // void, from a real admin token
    const voided = await shipAction('VOID_SHIPMENT', { shipmentId: bId, reason: 'Dev verification fixture — Step R proof', expectedUpdatedAt: b.shipment.updatedAt })
    const vs = voided.shipment ?? voided.bundle?.shipment ?? (await reload(bId)).shipment
    equals('VOID keeps the number (PRO)', vs.number, b.shipment.number)
    equals('VOID stamps who', Boolean(vs.voidedBy), true, vs.voidedBy)
    equals('VOID stamps when', Boolean(vs.voidedAt), true, vs.voidedAt)
    equals('VOID stamps why', vs.voidReason, 'Dev verification fixture — Step R proof')
    b = await reload(bId)
    equals('the voided shipment keeps its legs', b.loadCarriers.length >= 2, true, `${b.loadCarriers.length} legs`)
    equals('the voided shipment keeps its documents', b.documents.length >= 2, true, `${b.documents.length} documents`)
    bLoad = await loadRow(bLoadId)
    equals('the mirrored Load is CANCELED', bLoad.status, 'CANCELED')
    equals('the voided Load pays nobody (deliveryDriverId cleared)', bLoad.deliveryDriverId, null)
    equals('the void is mirrored onto the Load (it leaves every fleet working set)', bLoad.voidedAt, vs.voidedAt)
    await refuses('a voided shipment refuses a second void', /voided/i, () => shipAction('VOID_SHIPMENT', { shipmentId: bId, reason: 'again', expectedUpdatedAt: b.shipment.updatedAt }))
    await refuses('no token can write the void on a Load — only VOID_SHIPMENT can', /Unauthorized|not authorized|FieldUndefined|Validation/i, () =>
      gql(`mutation U($id: ID!) { updateLoad(input: { id: $id, voidedAt: null }) { id voidedAt } }`, { id: bLoadId }))
    await refuses('a voided shipment refuses edits', /voided/i, () =>
      shipAction('SAVE_ORDER_FORM', { shipmentId: bId, expectedUpdatedAt: b.shipment.updatedAt, order: { customerNotes: 'x' } }))
    await refuses('a voided shipment refuses a document upload', /voided/i, () =>
      shipAction('PREPARE_DOCUMENT_UPLOAD', { shipmentId: bId, type: 'POD', name: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10 }))
    await refuses('a voided shipment cannot be released to accounting', /Voided|voided/, () =>
      shipAction('SET_AR_STATUS', { orderId: bOrderId, status: 'UNBILLED', expectedUpdatedAt: b.orders[0].updatedAt }))
    const previewB = await finAction('PREVIEW_INVOICE', { orderId: bOrderId }).catch((err) => ({ error: String(err.message) }))
    equals('PREVIEW_INVOICE on a voided shipment says VOIDED', previewB.error ? /void/i.test(previewB.error) : previewB.releaseGate?.missing?.[0]?.code === 'VOIDED', true, previewB.error ?? JSON.stringify(previewB.releaseGate))
    await refuses('a voided shipment cannot be invoiced', /void|UNBILLED/i, () => finAction('GENERATE_INVOICE', { orderId: bOrderId }))

    // ── 7b. the legacy import does not hand freight to AR ─────────────────
    // `BACKFILL_SHIPMENT` reads a legacy load's `readyToInvoice` as evidence that the
    // work was done — but that flag is a checkbox on the old calendar, not the
    // release gate, and Ryne's rule is that nothing reaches AR without the gate. The
    // imported order must land on DOCS_NEEDED however the flag was left.
    const legacyLoad = (await gql(
      `mutation C($input: CreateLoadInput!) { createLoad(input: $input) { id } }`,
      { input: {
        aljexId: `VR${stamp}`, tmsId: '', pickupNumber: `VR${stamp}`,
        customer: customer.name, customerId: customer.id,
        pickupAppt: `${today}T13:00:00.000Z`, deliveryAppt: `${today}T20:00:00.000Z`,
        readyToInvoice: true, rate: 125000,
        createdBy: 'script:devVerifyStepR', updatedBy: 'script:devVerifyStepR',
      } },
    )).createLoad
    const imported = await shipAction('BACKFILL_SHIPMENT', { loadIds: [legacyLoad.id], dryRun: false })
    equals('BACKFILL_SHIPMENT applied the one legacy load', imported.applied, 1)
    equals('the import reads the flag as delivered', imported.planned?.[0]?.loadStatus, 'DELIVERED')
    equals('the import never grants AR readiness — the gate owns that rung', imported.planned?.[0]?.arStatus, 'DOCS_NEEDED')
    const importedShipmentId = imported.planned[0].shipmentId
    fixtures.shipmentIds.push(importedShipmentId)
    const importedBundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: importedShipmentId })
    equals('and the written order says so', importedBundle.orders[0].arStatus, 'DOCS_NEEDED')
    await refuses('the imported order still has to pass the gate', /Not ready for accounting/i, () =>
      shipAction('READY_TO_INVOICE', { orderId: importedBundle.orders[0].id, expectedUpdatedAt: importedBundle.orders[0].updatedAt }))

    // ── 8. RETAG dry run writes nothing ───────────────────────────────────
    const before = (await reload(aId)).shipment.updatedAt
    const retag = await shipAction('RETAG_SHIPMENTS', { dryRun: true })
    ok('RETAG_SHIPMENTS dry run', `scanned ${retag.scanned} changed ${retag.changed} hand ${retag.handTagged} byDivision ${JSON.stringify(retag.byDivision)} bySubdivision ${JSON.stringify(retag.bySubdivision)}`)
    equals('the dry run wrote nothing', (await reload(aId)).shipment.updatedAt, before)

    // ── 9. retire A by void (void the invoice first, which is the rule) ───
    await finAction('VOID_INVOICE', { invoiceId: aInvoiceId, reason: 'Dev verification fixture — Step R proof' })
    a = await reload(aId)
    await shipAction('VOID_SHIPMENT', { shipmentId: aId, reason: 'Dev verification fixture — Step R proof', expectedUpdatedAt: a.shipment.updatedAt })
    aLoad = await loadRow(aLoadId)
    equals('A voided: the Ivan driver is off the Load (leaves calendar and settlement)', aLoad.deliveryDriverId, null)
    ok('fixtures retired by VOID, nothing deleted', fixtures.shipmentIds.join(' '))
  } finally {
    // Whatever happened above, no fixture may stay live: void every shipment this run
    // created that is not voided yet (PRO kept; nothing deleted).
    for (const shipmentId of fixtures.shipmentIds) {
      try {
        const bundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId })
        if (bundle.shipment.voidedAt) continue
        for (const order of bundle.orders) {
          if (order.invoiceId) await finAction('VOID_INVOICE', { invoiceId: order.invoiceId, reason: 'Dev verification fixture' }).catch(() => {})
        }
        const fresh = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId })
        await shipAction('VOID_SHIPMENT', { shipmentId, reason: 'Dev verification fixture — Step R proof (cleanup)', expectedUpdatedAt: fresh.shipment.updatedAt })
        console.log(`cleanup: voided ${bundle.shipment.number}`)
      } catch (err) {
        console.log(`cleanup: could not void ${shipmentId}: ${String(err.message).slice(0, 120)}`)
      }
    }
    for (const u of createdUsers) {
      try { await manageUsers({ action: 'delete', username: u.email }) } catch { await deleteFromPool(u.email, u.profileId) }
    }
    if (fixtures.customerId) {
      try {
        const row = (await gql('query C($id: ID!) { getCustomer(id: $id) { id updatedAt } }', { id: fixtures.customerId })).getCustomer
        await dirAction('SET_CUSTOMER_STATUS', { id: fixtures.customerId, status: 'BLOCKED', reason: 'Dev verification fixture', expectedUpdatedAt: row.updatedAt })
        console.log('cleanup: fixture customer BLOCKED')
      } catch (e) { console.log(`(customer retire skipped: ${String(e.message).slice(0, 80)})`) }
    }
    const passed = results.filter((r) => r.ok).length
    console.log(`\n${passed}/${results.length} checks passed`)
    if (passed !== results.length) process.exitCode = 1
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
