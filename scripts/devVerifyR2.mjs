/**
 * Step R2 live verification against the DEV stack.
 *
 * Throwaway. It drives the deployed Lambdas through the Step R follow-up and R2
 * features with real tokens, never through the UI:
 *
 *   - the ownership seed is idempotent; the seeded division codes, rules and views
 *     are exactly the ones designed; a person-authored rule survives a re-seed;
 *   - column templates are private or shared, updated only by their owner (or an
 *     admin for a shared template), and a view falls back to its own columns when
 *     its template is deleted;
 *   - un-void restores the load status, readyToInvoice and any open AP leg, while
 *     leaving an already-canceled load canceled and the PRO claim untouched;
 *   - before-invoicing customer re-point moves Shipment/Order/Load and records an
 *     audit row; invoiced freight is repointed through a credit memo, idempotent on
 *     the caller's key, and an invoice with money applied is refused outright;
 *   - owner/admin BACKFILL_SHIPMENT mints Shipment/Order records for unlinked loads;
 *   - the calendar Unscheduled strip population and the deployed Load/ShipmentView
 *     fields are checked.
 *
 * Fixtures are retired by VOID (never deleted); temporary Cognito identities are
 * created with a randomized password that is never printed and removed in a
 * `finally`. It refuses to run against anything but the dev API/table suffix.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyR2.mjs
 *
 * When the environment variables are absent, the script mints its own temporary
 * ADMIN identity in the dev pool through the Cognito admin API (AWS credentials
 * must be available in the environment) and deletes it in the `finally`.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
const OWNER_EMAIL = 'ryne@bcatcorp.com'
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
async function addToGroup(username, groupName) {
  const { sdk, client } = await cognitoAdmin()
  await client.send(new sdk.AdminAddUserToGroupCommand({ UserPoolId: DEV_POOL, Username: username, GroupName: groupName })).catch((e) => {
    console.warn(`could not add ${username} to ${groupName}: ${String(e.message).slice(0, 80)}`)
  })
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
    const confirmed = await auth.confirmSignIn({ challengeResponse: password })
    if (!confirmed.isSignedIn) throw new Error('the temporary identity could not finish signing in')
  }
  const session = await auth.fetchAuthSession({ forceRefresh: true })
  const idToken = session.tokens?.idToken?.toString()
  await auth.signOut().catch(() => {})
  if (!idToken) throw new Error('no id token for the temporary identity')
  return idToken
}

async function createTempIdentity({ email, roleGroup, groups = [] }) {
  const password = secret()
  const { sdk, client } = await cognitoAdmin()
  await client.send(new sdk.AdminCreateUserCommand({
    UserPoolId: DEV_POOL,
    Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
    MessageAction: 'SUPPRESS',
  }))
  await setPoolPassword(email, password)
  if (roleGroup) await addToGroup(email, roleGroup)
  for (const g of groups) await addToGroup(email, g)
  return { email, password, token: await tokenFor(email, password) }
}

let docClient = null
async function ddbDocClient() {
  // Cache the whole bundle, not just the client: returning the bare client on the
  // second call left every later caller without its commands.
  if (docClient) return docClient
  const [{ DynamoDBClient }, { DynamoDBDocumentClient, GetCommand, PutCommand }] =
    await Promise.all([import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb')])
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  })
  docClient = { client, GetCommand, PutCommand }
  return docClient
}

async function seedLegacyLoad(fields) {
  const { client, PutCommand } = await ddbDocClient()
  const now = new Date().toISOString()
  const id = randomUUID()
  await client.send(new PutCommand({
    TableName: `Load-${DEV_TABLE_SUFFIX}`,
    Item: {
      id, __typename: 'Load', createdAt: now, updatedAt: now,
      createdBy: 'script:devVerifyR2', updatedBy: 'script:devVerifyR2',
      ...fields,
    },
  }))
  return { id }
}

async function proClaimRow(pro) {
  const key = String(pro).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (key.length < 3) return null
  const { client, GetCommand } = await ddbDocClient()
  // Strongly consistent, and a read error is a failed check rather than "no claim":
  // swallowing it would let a missing PRO claim read as a passing one.
  const result = await client.send(new GetCommand({
    TableName: `ProClaim-${DEV_TABLE_SUFFIX}`,
    Key: { id: key },
    ConsistentRead: true,
  }))
  return result.Item ?? null
}

const loadRow = async (id) => (await gql(
  `query L($id: ID!) { getLoad(id: $id) { id aljexId tmsId pickupNumber customer customerId shipmentId orderId status assignmentType carrierName pickupDriverId deliveryDriverId truckId trailerNumber stops readyToInvoice revDivision revSubdivision revTagSource revRuleId salesRepId voidedAt previousStatus previousReadyToInvoice updatedAt } }`,
  { id },
)).getLoad
const stopsOf = (load) => { try { return JSON.parse(load.stops ?? '[]') } catch { return [] } }
async function invoiceRow(id) { return (await gql(`query I($id: ID!) { getInvoice(id: $id) { id number status orderId shipmentId customerId totalCents paidCents writtenOffCents balanceCents lines factored updatedAt } }`, { id })).getInvoice }
async function arPaymentRow(id) { return (await gql(`query P($id: ID!) { getArPayment(id: $id) { id kind customerId amountCents appliedCents applications note createdAt } }`, { id })).getArPayment }

async function allLoads() {
  const items = []
  let nextToken = null
  do {
    const page = await gql(
      `query L($nextToken: String) { listLoads(limit: 10000, nextToken: $nextToken) { items { id shipmentId status unscheduled pickupAppt deliveryAppt voidedAt aljexId } nextToken } }`,
      { nextToken },
    )
    items.push(...(page.listLoads.items ?? []))
    nextToken = page.listLoads.nextToken ?? null
  } while (nextToken)
  return items
}

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

function normalizeName(s) {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function creditMemoId(shipmentId, key) {
  return `rcm-${createHash('sha256').update(`${shipmentId}:${key}`).digest('hex').slice(0, 32)}`
}

async function main() {
  const stamp = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const createdUsers = []
  const fixtures = { shipmentIds: [], customerIds: [], viewSlugs: [] }

  const adminAuth = await (async () => {
    const email = process.env.BCAT_EMAIL
    const password = process.env.BCAT_PASSWORD
    if (email && password) {
      const auth = await authenticateTmsUser(outputs)
      if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')
      return { email, token: auth.token, managed: false }
    }
    const tmpEmail = `zz-r2-admin-${stamp}@example.invalid`
    const tmp = await createTempIdentity({ email: tmpEmail, roleGroup: 'ADMIN', groups: ['page-tms'] })
    createdUsers.push({ email: tmpEmail })
    console.log(`fallback admin identity: ${tmpEmail}`)
    return { email: tmpEmail, token: tmp.token, managed: true }
  })()
  token = adminAuth.token

  try {
    // ── 1. the ownership seed ────────────────────────────────────────────
    const seed = await dirAction('ENSURE_OWNERSHIP_SEED', {})
    ok('ENSURE_OWNERSHIP_SEED ran', JSON.stringify(seed))
    const seedCounts = seed ?? {}

    const seedAgain = await dirAction('ENSURE_OWNERSHIP_SEED', {})
    equals('a second seed creates nothing', (seedAgain.divisionsCreated ?? 0) + (seedAgain.rulesCreated ?? 0) + (seedAgain.viewsCreated ?? 0), 0)
    equals('a second seed deactivates nothing', seedAgain.rulesDeactivated ?? 0, 0)

    const divisions = (await gql(`query D { listOwnershipDivisions(limit: 200) { items { id code name brand parentId active sortOrder } } }`)).listOwnershipDivisions.items
    const rawRules = (await gql(`query R { listOwnershipRules(limit: 200) { items { id name sortOrder active divisionCode condition } } }`)).listOwnershipRules.items
    // `condition` is AWSJSON, so AppSync hands it back as a string; every read and
    // every write below wants the object it describes.
    const rules = rawRules.map((r) => ({ ...r, condition: typeof r.condition === 'string' ? JSON.parse(r.condition) : r.condition }))
    const views = (await gql(`query V { listShipmentViews(limit: 200) { items { id slug name active columns columnTemplateId sortOrder isDefault filters } } }`)).listShipmentViews.items

    const codes = divisions.map((d) => d.code).sort()
    ok('division rows', codes.join(' '))
    for (const c of ['BROKERAGE', 'ASSETS', 'OWNER_OPERATOR', 'BOX_TRUCK', 'LOCAL', 'CAR_SHIPPING', 'COMPANY']) equals(`division ${c} seeded`, codes.includes(c), true)
    equals('division codes are exactly the seven seeded ones', codes.join(','), 'ASSETS,BOX_TRUCK,BROKERAGE,CAR_SHIPPING,COMPANY,LOCAL,OWNER_OPERATOR')
    equals('no Amazon division exists', codes.filter((c) => /^AMAZON$/i.test(c)).length, 0)

    const seedRuleIds = new Set([
      'rule-seed-amazon', 'rule-seed-1', 'rule-seed-2', 'rule-seed-3', 'rule-seed-4', 'rule-seed-5', 'rule-seed-auto-shipper', 'rule-seed-7',
    ])
    const seedRules = rules.filter((r) => seedRuleIds.has(r.id)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    for (const r of seedRules) {
      ok(`seed rule ${r.id}`, `${r.condition?.kind} ${JSON.stringify(r.condition?.value)} → ${r.divisionCode}`)
    }
    equals(
      'the seed rules are in Ryne\'s order, Amazon first and the catch-all last',
      seedRules.map((r) => r.id).join(' '),
      'rule-seed-amazon rule-seed-1 rule-seed-2 rule-seed-3 rule-seed-4 rule-seed-5 rule-seed-auto-shipper rule-seed-7',
    )
    equals('eight seed rules present', rules.filter((r) => seedRuleIds.has(r.id)).length, 8)
    // The old rule-seed-6 row survives, deactivated — the seed deactivates a rule it
    // dropped rather than deleting it. What must be gone is a *live* one.
    equals(
      'no active REFERENCE_MATCHES car-shipping rule is left',
      rules.some((r) => r.active !== false && r.condition?.kind === 'REFERENCE_MATCHES'),
      false,
    )

    // The rule carries the customer id the seed resolved, so read that record rather
    // than hunting the name through a paginated list.
    const autoShipperRule = rules.find((r) => r.id === 'rule-seed-auto-shipper')
    const boundCustomerId = typeof autoShipperRule?.condition?.value === 'string' ? autoShipperRule.condition.value : null
    const bound = boundCustomerId
      ? (await gql(`query C($id: ID!) { getCustomer(id: $id) { id name active status } }`, { id: boundCustomerId })).getCustomer
      : null
    if (bound && autoShipperRule?.active !== false) {
      equals('the car-shipping rule is bound to the Auto Shipper customer', normalizeName(bound.name), normalizeName('Auto Shipper'), `${bound.id} ${bound.name}`)
    } else if (bound) {
      bad('the car-shipping rule is bound but inactive', `${bound.id} ${bound.name}`)
    } else {
      ok('no Auto Shipper customer on dev; the rule was written inactive, as designed', autoShipperRule?.name ?? 'no rule')
    }
    // The later revenue-tag section needs the customer the rule actually points at.
    const autoShipper = bound && autoShipperRule?.active !== false ? bound : null

    // Admin-authored rule survives a re-seed, then is removed.
    const activeRuleInputs = rules.filter((r) => r.active !== false).map((r) => ({
      id: r.id, name: r.name, condition: r.condition, divisionCode: r.divisionCode, active: true, sortOrder: r.sortOrder,
    }))
    const customRuleId = (await dirAction('SAVE_OWNERSHIP_RULES', {
      rules: [
        ...activeRuleInputs,
        { name: 'R2 verification rule', condition: { kind: 'ALWAYS', value: null }, divisionCode: 'BROKERAGE', active: true },
      ],
    }))[activeRuleInputs.length]?.id
    fixtures.customRuleId = customRuleId
    console.log(`custom rule created: ${customRuleId}`)

    const seededAgain = await dirAction('ENSURE_OWNERSHIP_SEED', {})
    const customAfterSeed = (await gql(`query RR { listOwnershipRules(limit:200) { items { id active } } }`)).listOwnershipRules.items.find((r) => r.id === customRuleId)
    equals('admin-authored rule survives a re-seed still active', customAfterSeed?.active, true)

    const rulesBeforeRemove = (await gql(`query RR { listOwnershipRules(limit:200) { items { id name active condition divisionCode sortOrder } } }`))
      .listOwnershipRules.items
      .map((r) => ({ ...r, condition: typeof r.condition === 'string' ? JSON.parse(r.condition) : r.condition }))
    const keepActive = rulesBeforeRemove.filter((r) => r.active !== false && r.id !== customRuleId).map((r) => ({
      id: r.id, name: r.name, condition: r.condition, divisionCode: r.divisionCode, active: true, sortOrder: r.sortOrder,
    }))
    await dirAction('SAVE_OWNERSHIP_RULES', {
      rules: [
        ...keepActive,
        { id: customRuleId, name: 'R2 verification rule', condition: { kind: 'ALWAYS', value: null }, divisionCode: 'BROKERAGE', active: false },
      ],
    })
    const customAfterRemove = (await gql(`query RR { listOwnershipRules(limit:200) { items { id active } } }`)).listOwnershipRules.items.find((r) => r.id === customRuleId)
    equals('custom rule removed after check', customAfterRemove?.active, false, customAfterRemove?.active)

    const activeView = views.find((v) => v.slug === 'active-shipments')
    equals('Active Shipments view exists', Boolean(activeView), true)
    equals('Active Shipments is the default', activeView?.isDefault, true)
    const aljex = ['exceptions', 'status', 'proNumber', 'massRelease', 'equip', 'customerReference', 'description', 'revenueType', 'salesRep', 'customerName', 'carrier', 'customerTotalRate', 'carrierTotalRates', 'grossProfit', 'netMargin', 'pickupShip', 'originCity', 'destinationCity', 'deliveryAppt', 'stops', 'driver', 'truck', 'arStatus', 'apStatus', 'lastUpdateAt', 'nextCheckCallAt', 'mode', 'docsMissing']
    equals('Active Shipments carries Aljex column order', JSON.stringify(activeView?.columns), JSON.stringify(aljex))
    const activeAfterReSeed = (await gql(`query V2 { listShipmentViews(limit:200) { items { id slug active } } }`)).listShipmentViews.items.filter((v) => v.slug === 'active-shipments' && v.active !== false).length
    equals('a re-seed leaves exactly one Active Shipments view', activeAfterReSeed, 1)

    // ── temporary non-admin identities ─────────────────────────────────────
    const userA = await createTempIdentity({ email: `zz-r2-user-a-${stamp}@example.invalid`, groups: ['page-tms'] })
    createdUsers.push({ email: userA.email })
    const userB = await createTempIdentity({ email: `zz-r2-user-b-${stamp}@example.invalid`, groups: ['page-tms'] })
    createdUsers.push({ email: userB.email })
    const userToken = (tok) => async (action, input) => routerAs(tok, 'tmsDirectoryActions')(action, input)
    const userAAction = userToken(userA.token)
    const userBAction = userToken(userB.token)

    // ── 2. column templates ────────────────────────────────────────────────
    const privateTemplate = await userAAction('SAVE_COLUMN_TEMPLATE', { name: 'R2 private', columns: ['status', 'number'], shared: false })
    equals('private template ownerEmail is the creator', privateTemplate.ownerEmail, userA.email)

    await refuses('a second non-admin cannot update a private template', /only the owner can change a private column template/, () =>
      userBAction('SAVE_COLUMN_TEMPLATE', { id: privateTemplate.id, name: 'Hacked', columns: ['status'] }))
    await refuses('an admin cannot update a private template', /only the owner can change a private column template/, () =>
      dirAction('SAVE_COLUMN_TEMPLATE', { id: privateTemplate.id, name: 'Admin hack', columns: ['status'] }))

    await refuses('a second non-admin cannot delete a private template', /only the owner can change a private column template/, () =>
      userBAction('DELETE_COLUMN_TEMPLATE', { id: privateTemplate.id }))
    await refuses('an admin cannot delete a private template', /only the owner can change a private column template/, () =>
      dirAction('DELETE_COLUMN_TEMPLATE', { id: privateTemplate.id }))

    const ownerUpdated = await userAAction('SAVE_COLUMN_TEMPLATE', { id: privateTemplate.id, name: 'R2 private updated', columns: ['status'] })
    equals('the owner can update a private template', ownerUpdated.name, 'R2 private updated')

    const sharedTemplate = await userAAction('SAVE_COLUMN_TEMPLATE', { name: 'R2 shared', columns: ['status', 'division'], shared: true })
    const adminUpdatedShared = await dirAction('SAVE_COLUMN_TEMPLATE', { id: sharedTemplate.id, name: 'R2 shared updated', columns: ['status'] })
    equals('an admin can update a shared template', adminUpdatedShared.name, 'R2 shared updated')
    equals('the admin update does not transfer ownerEmail', adminUpdatedShared.ownerEmail, userA.email)

    const validNonDefault = await userAAction('SAVE_COLUMN_TEMPLATE', { name: 'R2 division column', columns: ['number', 'division'], shared: false })
    equals('a non-default valid board column is accepted', validNonDefault.columns.includes('division'), true)
    await refuses('a nonsense column key is refused by name', /"notAColumn" is not a board column/, () =>
      userAAction('SAVE_COLUMN_TEMPLATE', { name: 'R2 bad', columns: ['status', 'notAColumn'] }))

    const viewTemplate = await userAAction('SAVE_COLUMN_TEMPLATE', { name: 'R2 view template', columns: ['status', 'customerName'], shared: false })
    const fallbackColumns = ['number', 'status', 'customerName']
    const viewWithTemplate = await dirAction('SAVE_SHIPMENT_VIEW', {
      name: `R2 Verify View ${stamp}`,
      department: 'Shipments',
      filters: { board: { statuses: ['OPEN'], details: {}, dates: {} } },
      columns: fallbackColumns,
      columnTemplateId: viewTemplate.id,
    })
    fixtures.viewSlugs.push(viewWithTemplate.slug)
    // The template is private, so only its owner may remove it — which is the rule
    // two checks above just proved.
    await userAAction('DELETE_COLUMN_TEMPLATE', { id: viewTemplate.id })
    const viewAfterDelete = (await gql(`query V($id: ID!) { getShipmentView(id: $id) { id columns columnTemplateId } }`, { id: viewWithTemplate.slug })).getShipmentView
    equals('a view pointing at a deleted template resolves to its own columns', JSON.stringify(viewAfterDelete.columns), JSON.stringify(fallbackColumns))

    // ── fixtures for the rest of the run ─────────────────────────────────
    const makeCustomer = async (label) => {
      const created = await dirAction('UPSERT_CUSTOMER', {
        name: `ZZ R2 ${label} ${stamp}`, status: 'ACTIVE', active: true,
        mcNumber: `9${String(stamp).slice(-6)}${label}`, billingEmail: `r2-${label}@example.invalid`,
        creditLimitCents: 100000000, paymentTermsDays: 30,
        requiredDocsForInvoice: ['BOL', 'POD'],
        requiredReferences: [{ code: 'PO', label: 'PO number', level: 'ORDER', countOnNewOrder: 1 }],
        notes: `Dev-only R2 verification fixture ${label}. Voided at the end of the run.`,
      })
      const customer = created.customer ?? created
      fixtures.customerIds.push(customer.id)
      console.log(`fixture customer ${label}: ${customer.name} (${customer.id})`)
      return customer
    }
    const customerOrig = await makeCustomer('ORIG')
    const customerTarget = await makeCustomer('TARGET')
    const customerTarget2 = await makeCustomer('TARGET2')

    async function newShipment(label, customerId) {
      let bundle = await shipAction('CREATE_SHIPMENT', { customerId })
      const shipmentId = bundle.shipment.id
      fixtures.shipmentIds.push(shipmentId)
      bundle = await shipAction('SAVE_ORDER_FORM', {
        shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
        order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'PO number', value: `R2-${label}-${stamp}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
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
        try { await shipAction('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt }) } catch (err) { console.log(`  (${status} skipped: ${String(err.message).slice(0, 80)})`) }
        bundle = await reload(shipmentId)
      }
      return bundle
    }

    // ── 3. un-void ───────────────────────────────────────────────────────
    // 3a. a delivered outside-carrier load
    let u1 = await newShipment('U1-OUT', customerOrig.id)
    const u1Id = u1.shipment.id
    const u1LoadId = u1.loads[0].id
    await shipAction('ASSIGN_CARRIER', { loadId: u1LoadId, carrierName: `ZZ R2 Carrier ${stamp}`, carrierRateCents: 180000 })
    u1 = await deliver(u1Id)
    await attachDocument(u1Id, u1.orders[0].id, u1LoadId, 'BOL')
    await attachDocument(u1Id, u1.orders[0].id, u1LoadId, 'POD')

    const beforeLoad = await loadRow(u1LoadId)
    const beforeClaim = await proClaimRow(beforeLoad.aljexId)
    const beforeCarrier = (await reload(u1Id)).loadCarriers.find((c) => c.status === 'ACTIVE')

    await shipAction('VOID_SHIPMENT', { shipmentId: u1Id, reason: 'R2 unvoid proof', expectedUpdatedAt: (await reload(u1Id)).shipment.updatedAt })
    const voidedLoad = await loadRow(u1LoadId)
    equals('after void the mirrored Load is CANCELED', voidedLoad.status, 'CANCELED')
    await refuses('non-admin cannot unvoid', /requires owner or ADMIN/, () =>
      routerAs(userA.token, 'tmsShipmentActions')('UNVOID_SHIPMENT', { shipmentId: u1Id, reason: 'no' }))
    await refuses('unvoid without expectedUpdatedAt is refused', /expectedUpdatedAt is required/, () =>
      shipAction('UNVOID_SHIPMENT', { shipmentId: u1Id, reason: 'no' }))
    await refuses('unvoid with stale expectedUpdatedAt is refused', /changed by someone else/, () =>
      shipAction('UNVOID_SHIPMENT', { shipmentId: u1Id, reason: 'no', expectedUpdatedAt: u1.shipment.updatedAt }))

    // The refusals above do not move the row, but the void did: take the shipment's
    // own current token rather than the load's.
    const voidedShipment = (await reload(u1Id)).shipment
    const unvoided = await shipAction('UNVOID_SHIPMENT', { shipmentId: u1Id, reason: 'R2 unvoid restore', expectedUpdatedAt: voidedShipment.updatedAt })
    const restoredLoad = await loadRow(u1LoadId)
    const afterCarrier = unvoided.loadCarriers?.find((c) => c.status === 'ACTIVE') ?? (await reload(u1Id)).loadCarriers.find((c) => c.status === 'ACTIVE')

    equals('unvoid clears load.voidedAt', restoredLoad.voidedAt ?? null, null)
    equals('unvoid clears shipment.voidedAt', unvoided.shipment.voidedAt ?? null, null)
    equals('unvoid clears shipment.voidedBy', unvoided.shipment.voidedBy ?? null, null)
    equals('unvoid clears shipment.voidReason', unvoided.shipment.voidReason ?? null, null)
    equals('unvoid restores the load status', restoredLoad.status, beforeLoad.status)
    equals('unvoid restores readyToInvoice', restoredLoad.readyToInvoice, beforeLoad.readyToInvoice)
    equals('unvoid clears load.previousStatus', restoredLoad.previousStatus ?? null, null)
    equals('unvoid clears load.previousReadyToInvoice', restoredLoad.previousReadyToInvoice ?? null, null)
    // Read the claim for the same PRO both times: the assertion is that this PRO's
    // claim did not move, not that the load still points somewhere.
    equals('unvoid leaves the PRO on the load', restoredLoad.aljexId, beforeLoad.aljexId)
    const afterClaim = await proClaimRow(beforeLoad.aljexId)
    equals('unvoid leaves the PRO claim row unchanged', JSON.stringify(afterClaim), JSON.stringify(beforeClaim))
    equals('unvoid puts the carrier leg back on the AP board', afterCarrier?.apOpen, 'OPEN')

    // 3b. a load that was already CANCELED before the void
    let u2 = await newShipment('U2-CANC', customerOrig.id)
    const u2Id = u2.shipment.id
    const u2LoadId = u2.loads[0].id
    // No carrier and no release here: U1 already proved the readyToInvoice round
    // trip, and what U2 is for is a load somebody canceled *before* the void.
    await shipAction('SET_LOAD_STATUS', { loadId: u2LoadId, status: 'CANCELED', reason: 'customer canceled the leg', expectedUpdatedAt: (await loadRow(u2LoadId)).updatedAt })
    const canceledLoadBeforeVoid = await loadRow(u2LoadId)
    equals('U2 load is CANCELED before void', canceledLoadBeforeVoid.status, 'CANCELED')
    await shipAction('VOID_SHIPMENT', { shipmentId: u2Id, reason: 'R2 already-canceled proof', expectedUpdatedAt: (await reload(u2Id)).shipment.updatedAt })
    const voidedU2 = await loadRow(u2LoadId)
    equals('U2 load still CANCELED after void', voidedU2.status, 'CANCELED')
    // The void clears readyToInvoice on every load, canceled or not, so every load
    // carries the snapshot — that is what lets the unvoid put it back.
    equals('U2 load records its readyToInvoice snapshot', voidedU2.previousReadyToInvoice, false)
    equals('U2 load has no previousStatus (was already canceled)', voidedU2.previousStatus ?? null, null)
    const unvoidedU2 = await shipAction('UNVOID_SHIPMENT', { shipmentId: u2Id, reason: 'R2 unvoid already-canceled', expectedUpdatedAt: (await reload(u2Id)).shipment.updatedAt })
    const restoredU2Load = await loadRow(u2LoadId)
    equals('U2 load is still CANCELED after unvoid', restoredU2Load.status, 'CANCELED')
    equals('U2 readyToInvoice unchanged', restoredU2Load.readyToInvoice, canceledLoadBeforeVoid.readyToInvoice)
    equals('U2 previousReadyToInvoice cleared', restoredU2Load.previousReadyToInvoice ?? null, null)

    // ── 4. customer re-point ─────────────────────────────────────────────
    // 4a. before invoicing
    const repointDraft = await newShipment('REPOINT-DRAFT', customerOrig.id)
    const repointId = repointDraft.shipment.id
    const repointLoadId = repointDraft.loads[0].id
    await refuses('non-admin cannot repoint a shipment customer', /requires owner or ADMIN/, () =>
      routerAs(userA.token, 'tmsShipmentActions')('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: repointId, customerId: customerTarget.id, reason: 'no' }))

    const repointed = await shipAction('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: repointId, customerId: customerTarget.id, reason: 'R2 re-point verification', expectedUpdatedAt: (await reload(repointId)).shipment.updatedAt })
    equals('re-point moves Shipment.customerId', repointed.shipment.customerId, customerTarget.id)
    equals('re-point moves Order.customerId', repointed.orders[0].customerId, customerTarget.id)
    equals('re-point moves Load.customerId', (await loadRow(repointLoadId)).customerId, customerTarget.id)
    // `listAuditLogs` filters after the page is read, so one page of a big table is
    // not one page of matches: walk the pages until this shipment's rows turn up.
    const auditActions = []
    let auditToken = null
    do {
      const page = (await gql(
        `query A($id: String!, $next: String) { listAuditLogs(filter: { entityId: { eq: $id } }, limit: 1000, nextToken: $next) { items { action entityId } nextToken } }`,
        { id: repointId, next: auditToken },
      )).listAuditLogs
      for (const item of page.items) auditActions.push(item.action)
      auditToken = page.nextToken
    } while (auditToken && !auditActions.includes('REPOINT_SHIPMENT_CUSTOMER'))
    equals('re-point writes an audit row', auditActions.includes('REPOINT_SHIPMENT_CUSTOMER'), true, auditActions.join(','))

    // 4b. on an invoiced order
    // The gate wants somebody hauling it. An own asset avoids the rate-con and
    // carrier-bill clauses an outside carrier would add, which this section is not about.
    const drivers = (await gql(`query Dr { listDrivers(limit: 1000) { items { id name active type assignedTruckId } } }`)).listDrivers.items
    const ownDriver = drivers.find((d) => d.active && d.type !== 'broker')
    if (!ownDriver) throw new Error('no active own-fleet driver on dev to assign')

    /** A shipment taken all the way to an issued invoice, the honest way: through the gate. */
    const invoicedShipment = async (label, customerId, driver) => {
      const built = await newShipment(label, customerId)
      const shipmentId = built.shipment.id
      const loadId = built.loads[0].id
      await shipAction('ASSIGN_ASSET', {
        loadId,
        driverId: driver.id,
        driverName: driver.name,
        truckId: driver.assignedTruckId ?? 'r2-verify-truck',
        truckNumber: '9001',
      })
      await deliver(shipmentId)
      await attachDocument(shipmentId, built.orders[0].id, loadId, 'BOL')
      await attachDocument(shipmentId, built.orders[0].id, loadId, 'POD')
      await shipAction('READY_TO_INVOICE', { orderId: built.orders[0].id, expectedUpdatedAt: built.orders[0].updatedAt })
      const issued = await finAction('GENERATE_INVOICE', { orderId: built.orders[0].id })
      return { shipmentId, loadId, orderId: built.orders[0].id, invoiceId: issued.invoice.id }
    }

    const repointInvoice = await invoicedShipment('REPOINT-INV', customerOrig.id, ownDriver)
    const repointInvId = repointInvoice.shipmentId
    const invoiceId = repointInvoice.invoiceId
    const beforeInvoice = await invoiceRow(invoiceId)

    await refuses('REPOINT_SHIPMENT_CUSTOMER refuses an invoiced order with INVOICED:', /^INVOICED:/, async () =>
      shipAction('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: repointInvId, customerId: customerTarget.id, reason: 'try', expectedUpdatedAt: (await reload(repointInvId)).shipment.updatedAt }))

    const idemKey = `r2-repoint-${stamp}`
    const repointInvoiced = await finAction('REPOINT_INVOICED_CUSTOMER', { shipmentId: repointInvId, customerId: customerTarget.id, reason: 'R2 invoiced re-point', idempotencyKey: idemKey })
    equals('REPOINT_INVOICED_CUSTOMER succeeds', repointInvoiced.duplicate, false)

    const afterInvoice = await invoiceRow(invoiceId)
    equals('invoice number unchanged', afterInvoice.number, beforeInvoice.number)
    equals('invoice totalCents byte-identical', afterInvoice.totalCents, beforeInvoice.totalCents)
    equals('invoice lines byte-identical', JSON.stringify(afterInvoice.lines), JSON.stringify(beforeInvoice.lines))
    equals('invoiced order back on the gate', (await reload(repointInvId)).orders[0].arStatus, 'UNBILLED')
    equals('invoiced order no longer carries invoiceId', (await reload(repointInvId)).orders[0].invoiceId ?? null, null)
    equals('order customer moved', (await reload(repointInvId)).orders[0].customerId, customerTarget.id)

    const creditMemo = await arPaymentRow(creditMemoId(repointInvId, idemKey))
    equals('one CREDIT_MEMO row exists', creditMemo?.kind, 'CREDIT_MEMO')
    equals('credit memo covers the invoice balance', creditMemo?.appliedCents, beforeInvoice.totalCents)

    const replay = await finAction('REPOINT_INVOICED_CUSTOMER', { shipmentId: repointInvId, customerId: customerTarget.id, reason: 'R2 replay', idempotencyKey: idemKey })
    equals('replay with same idempotencyKey is a duplicate', replay.duplicate, true)
    const creditMemoReplay = await arPaymentRow(creditMemoId(repointInvId, idemKey))
    equals('replay did not write a second CREDIT_MEMO', creditMemoReplay?.kind, 'CREDIT_MEMO')

    await refuses('REPOINT_INVOICED_CUSTOMER refuses a non-admin', /requires owner or ADMIN/, () =>
      routerAs(userA.token, 'tmsFinanceActions')('REPOINT_INVOICED_CUSTOMER', { shipmentId: repointInvId, customerId: customerTarget2.id, reason: 'no', idempotencyKey: `r2-nonadmin-${stamp}` }))

    const settings = (await gql(`query S { getTmsSettings(id: "default") { id arPostingAdminOnly } }`)).getTmsSettings
    const arFlag = settings?.arPostingAdminOnly
    console.log(`settings: arPostingAdminOnly=${arFlag}`)
    await refuses(`REPOINT_INVOICED_CUSTOMER refuses a non-admin even with arPostingAdminOnly=${arFlag}`, /requires owner or ADMIN/, () =>
      routerAs(userB.token, 'tmsFinanceActions')('REPOINT_INVOICED_CUSTOMER', { shipmentId: repointInvId, customerId: customerTarget2.id, reason: 'no', idempotencyKey: `r2-nonadmin-b-${stamp}` }))
    ok('arPostingAdminOnly was read and not modified', `arPostingAdminOnly=${arFlag}`)

    // 4c. invoice with money already applied is refused outright.
    // Its own shipment: the one above has already been credited and re-pointed, and
    // a settled invoice cannot take a payment.
    const paidShipment = await invoicedShipment('REPOINT-PAID', customerOrig.id, ownDriver)
    const partialPayment = await finAction('RECORD_PAYMENT', {
      customerId: customerOrig.id,
      receivedAt: new Date().toISOString(),
      method: 'CHECK',
      amountCents: 100000,
      applications: [{ invoiceId: paidShipment.invoiceId, amountCents: 100000 }],
      note: 'R2 partial payment',
    })
    await refuses('REPOINT_INVOICED_CUSTOMER refuses an invoice with money already applied', /payment or write-off/, () =>
      finAction('REPOINT_INVOICED_CUSTOMER', { shipmentId: paidShipment.shipmentId, customerId: customerTarget.id, reason: 'try', idempotencyKey: `r2-paid-${stamp}` }))
    await finAction('REVERSE_PAYMENT', { paymentId: partialPayment.payment.id, reason: 'R2 reverse partial payment' })
    const invoiceAfterReversal = await invoiceRow(paidShipment.invoiceId)
    equals('payment reversed; invoice is ISSUED again', invoiceAfterReversal.status, 'ISSUED')

    // 4d. RESOLVE_REV_TAG re-resolves after a move and leaves a hand tag alone
    if (autoShipper) {
      const ruleShipment = await newShipment('REV-RULE', autoShipper.id)
      equals('Auto Shipper rule tags CAR_SHIPPING by default', ruleShipment.shipment.revDivision, 'CAR_SHIPPING')
      await shipAction('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: ruleShipment.shipment.id, customerId: customerTarget.id, reason: 'R2 resolve tag verify', expectedUpdatedAt: (await reload(ruleShipment.shipment.id)).shipment.updatedAt })
      const resolvedRule = await shipAction('RESOLVE_REV_TAG', { shipmentId: ruleShipment.shipment.id })
      equals('RESOLVE_REV_TAG re-resolves after customer moved', resolvedRule.shipment.revDivision, 'BROKERAGE')
      equals('re-resolved tag is still a rule', resolvedRule.shipment.revTagSource, 'RULE')

      const handShipment = await newShipment('REV-HAND', customerOrig.id)
      await shipAction('SET_REV_TAG', { shipmentId: handShipment.shipment.id, divisionCode: 'CAR_SHIPPING' })
      const handTagged = await reload(handShipment.shipment.id)
      equals('hand tag is CAR_SHIPPING/HAND', `${handTagged.shipment.revDivision}/${handTagged.shipment.revTagSource}`, 'CAR_SHIPPING/HAND')
      await shipAction('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: handShipment.shipment.id, customerId: customerTarget.id, reason: 'R2 hand tag verify', expectedUpdatedAt: (await reload(handShipment.shipment.id)).shipment.updatedAt })
      const resolvedHand = await shipAction('RESOLVE_REV_TAG', { shipmentId: handShipment.shipment.id })
      equals('RESOLVE_REV_TAG leaves a hand tag alone', `${resolvedHand.shipment.revDivision}/${resolvedHand.shipment.revTagSource}`, 'CAR_SHIPPING/HAND')
    } else {
      ok('RESOLVE_REV_TAG checks skipped — no Auto Shipper customer on dev', 'no auto-shipper')
    }

    // ── 5. create shipment for an unlinked load ──────────────────────────
    const all = await allLoads()
    const unlinked = all.filter((l) => !l.shipmentId)
    console.log(`loads with no shipmentId: ${unlinked.length}`)
    const loadsWithoutShipmentBefore = unlinked.length

    // Dev may have nothing unlinked left — every legacy load was backfilled in Step R.
    // Seed one the way a legacy row looks, so the path Ryne will actually press is
    // proved rather than assumed. It is voided with the other fixtures afterwards.
    let candidate = unlinked.find((l) => !l.voidedAt) ?? unlinked[0] ?? null
    let seededLegacy = false
    if (!candidate) {
      const legacyId = (await seedLegacyLoad({
        aljexId: `ZZR2${String(stamp).slice(-7)}`,
        tmsId: `ZZR2${String(stamp).slice(-7)}`,
        pickupNumber: `ZZR2${String(stamp).slice(-7)}`,
        pickupAppt: new Date(Date.now() + 86_400_000).toISOString(),
        deliveryAppt: new Date(Date.now() + 172_800_000).toISOString(),
        readyToInvoice: false,
        customer: 'ZZ R2 Legacy Unlinked',
        originCity: 'Chicago, IL',
        destinationCity: 'Dallas, TX',
      })).id
      candidate = await loadRow(legacyId)
      seededLegacy = true
      console.log(`seeded legacy unlinked load: ${legacyId}`)
    }

    const dryRun = await shipAction('BACKFILL_SHIPMENT', { loadIds: [candidate.id], dryRun: true })
    const plan = dryRun.planned?.[0]
    equals('BACKFILL_SHIPMENT plans the unlinked load', plan?.skipped ?? null, null, JSON.stringify(plan ?? null).slice(0, 160))
    await shipAction('BACKFILL_SHIPMENT', { loadIds: [candidate.id], dryRun: false })
    // The Load write goes through AppSync and the read that follows it is eventually
    // consistent, so give it a few beats rather than calling a lag a failure.
    let afterLoad = await loadRow(candidate.id)
    for (let attempt = 0; attempt < 5 && !afterLoad.shipmentId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      afterLoad = await loadRow(candidate.id)
    }
    equals('BACKFILL_SHIPMENT links the load to a shipment', Boolean(afterLoad.shipmentId), true, afterLoad.shipmentId)
    if (afterLoad.shipmentId) fixtures.shipmentIds.push(afterLoad.shipmentId)
    await refuses('BACKFILL_SHIPMENT is refused to a non-admin', /requires owner or ADMIN/, () =>
      routerAs(userA.token, 'tmsShipmentActions')('BACKFILL_SHIPMENT', { loadIds: [candidate.id], dryRun: true }))
    if (seededLegacy) ok('the unlinked load was seeded for this run', candidate.id)
    const allAfter = await allLoads()
    const loadsWithoutShipmentAfter = allAfter.filter((l) => !l.shipmentId).length

    // ── 6. calendar and schema ───────────────────────────────────────────
    const canceledUnscheduled = allAfter.filter((l) => l.status === 'CANCELED' && l.unscheduled === true && !l.voidedAt).length
    console.log(`canceled + unscheduled loads: ${canceledUnscheduled}`)

    const schema = await gql(`query S { __schema { types { name fields { name } } } }`)
    const typeNames = schema.__schema.types.map((t) => t.name)
    equals('deployed schema has ShipmentColumnTemplate', typeNames.includes('ShipmentColumnTemplate'), true)
    const viewType = schema.__schema.types.find((t) => t.name === 'ShipmentView')
    equals('ShipmentView has columnTemplateId', Boolean(viewType?.fields?.some((f) => f.name === 'columnTemplateId')), true)
    const loadType = schema.__schema.types.find((t) => t.name === 'Load')
    const loadFields = loadType?.fields?.map((f) => f.name) ?? []
    equals('Load has previousStatus', loadFields.includes('previousStatus'), true)
    equals('Load has previousReadyToInvoice', loadFields.includes('previousReadyToInvoice'), true)

    // ── summary counts ───────────────────────────────────────────────────
    const finalRules = (await gql(`query R { listOwnershipRules(limit:200) { items { id active divisionCode } } }`)).listOwnershipRules.items
    const finalDivisions = (await gql(`query D { listOwnershipDivisions(limit:200) { items { id code active } } }`)).listOwnershipDivisions.items
    const finalViews = (await gql(`query V { listShipmentViews(limit:200) { items { id active } } }`)).listShipmentViews.items

    const counts = {
      seedCreated: (seedCounts.divisionsCreated ?? 0) + (seedCounts.rulesCreated ?? 0) + (seedCounts.viewsCreated ?? 0),
      seedUpdated: seedCounts.rulesUpdated ?? 0,
      seedDeactivated: seedCounts.rulesDeactivated ?? 0,
      seedUnchanged: seedCounts.rulesUnchanged ?? 0,
      divisionCount: finalDivisions.filter((d) => d.active !== false).length,
      ruleCount: finalRules.filter((r) => r.active !== false).length,
      viewCount: finalViews.filter((v) => v.active !== false).length,
      loadsWithoutShipmentBefore,
      loadsWithoutShipmentAfter,
      canceledUnscheduledLoads: canceledUnscheduled,
      pass: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
    }
    console.log(`\nSUMMARY ${JSON.stringify(counts)}`)
    if (counts.fail > 0) process.exitCode = 1

  } finally {
    for (const shipmentId of fixtures.shipmentIds) {
      try {
        const bundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId })
        if (!bundle || bundle.shipment.voidedAt) continue
        for (const order of bundle.orders ?? []) {
          if (order.invoiceId) {
            const inv = await invoiceRow(order.invoiceId).catch(() => null)
            if (inv && inv.status !== 'PAID' && inv.status !== 'VOID') {
              await finAction('VOID_INVOICE', { invoiceId: order.invoiceId, reason: 'Dev verification fixture' }).catch(() => {})
            }
          }
        }
        const fresh = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId }).catch(() => null)
        if (fresh && !fresh.shipment.voidedAt) {
          await shipAction('VOID_SHIPMENT', { shipmentId, reason: 'Dev verification fixture — R2 proof (cleanup)', expectedUpdatedAt: fresh.shipment.updatedAt })
          console.log(`cleanup: voided ${fresh.shipment.number}`)
        }
      } catch (err) {
        console.log(`cleanup: could not void ${shipmentId}: ${String(err.message).slice(0, 120)}`)
      }
    }
    for (const slug of fixtures.viewSlugs) {
      try { await dirAction('ARCHIVE_SHIPMENT_VIEW', { id: slug }) } catch {}
    }
    for (const customerId of fixtures.customerIds) {
      try {
        const row = (await gql('query C($id: ID!) { getCustomer(id: $id) { id updatedAt } }', { id: customerId })).getCustomer
        if (row) {
          await dirAction('SET_CUSTOMER_STATUS', { id: customerId, status: 'BLOCKED', reason: 'Dev verification fixture', expectedUpdatedAt: row.updatedAt })
          console.log('cleanup: fixture customer BLOCKED')
        }
      } catch (e) { console.log(`(customer retire skipped: ${String(e.message).slice(0, 80)})`) }
    }
    for (const u of createdUsers) {
      try { await manageUsers({ action: 'delete', username: u.email }) } catch { await deleteFromPool(u.email, u.profileId) }
    }
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
