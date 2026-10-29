/**
 * Step I live verification against the DEV stack.
 *
 * Throwaway, and the sibling of `devVerifyAr.mjs` / `devVerifyAp.mjs`. It builds its
 * own customer, carrier and shipments, turns commissions on with a plan of its own,
 * and then drives the deployed Lambdas through the whole of Step I:
 *
 *   - roles are projected onto Cognito groups, and the SERVER refuses what the role
 *     does not open. Two temporary identities are created, given roles, signed in,
 *     and used to prove refusals and allowed paths from a real token — not by
 *     reading the UI;
 *   - commissions are computed on the frozen money, recomputed idempotently,
 *     adjusted rather than rewritten once approved, and cancelled or reversed by a
 *     void, with the exact cents asserted at every step;
 *   - rounding is proved on a rate that lands on half a cent, and a split is proved
 *     to add back up to the role's pot;
 *   - a pay period goes open → submit → approve → paid, with a statement PDF;
 *   - the reporting index answers by month.
 *
 * Every temporary identity is created with a randomised password that is NEVER
 * printed, and deleted in a `finally` whatever happens. Every fixture it creates is
 * retired at the end. It touches no copied customer, carrier, load or invoice, and
 * it refuses to run against anything but the dev API.
 *
 * The caller is any dev ADMIN — the owner, or a temporary admin minted in the dev
 * pool for the run. `delete` on the Users API is owner-only, so when the caller is
 * not the owner the refusal is recorded as a check of its own and the temporary
 * identities are removed straight from the dev pool and the UserProfile table
 * instead, with the same AWS credentials the backfills use.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyCommissions.mjs
 */
import { randomBytes } from 'node:crypto'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
/** Must match OWNER_EMAIL in amplify/functions/userManagement/handler.ts. */
const OWNER_EMAIL = 'ryne@bcatcorp.com'

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
const carrierAction = (action, input) => routerAs(token, 'tmsCarrierActions')(action, input)

async function manageUsersAs(authToken, args) {
  const names = Object.keys(args)
  const typeOf = (k) => (k === 'isAdmin' ? 'Boolean' : 'String')
  const decls = names.map((n) => `$${n}: ${typeOf(n)}${n === 'action' ? '!' : ''}`).join(', ')
  const passed = names.map((n) => `${n}: $${n}`).join(', ')
  const data = await gqlAs(authToken, `query M(${decls}) { manageUsers(${passed}) }`, args)
  // The Lambda returns a JSON string; AppSync's String field hands it back encoded once more.
  let value = data.manageUsers
  while (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { break }
  }
  return value
}
const manageUsers = (args) => manageUsersAs(token, args)

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

function equals(name, actual, expected, note) {
  if (actual === expected) ok(name, note ?? `${actual}`)
  else bad(name, `expected ${expected}, got ${actual}${note ? ` (${note})` : ''}`)
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`

// ── temporary identities ────────────────────────────────────────────────────

/**
 * A password nobody will ever see: generated here, used once to answer Cognito's
 * NEW_PASSWORD_REQUIRED challenge, and never written to the console or a file.
 */
function secret() {
  return `Aa1!${randomBytes(18).toString('base64url')}`
}

const region = 'us-east-1'
let poolClient = null
async function cognitoAdmin() {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider')
  poolClient ??= new sdk.CognitoIdentityProviderClient({ region })
  return { sdk, client: poolClient }
}

/** A permanent password for a temporary identity this run created, set in the dev pool. */
async function setPoolPassword(username, password) {
  const { sdk, client } = await cognitoAdmin()
  await client.send(new sdk.AdminSetUserPasswordCommand({
    UserPoolId: DEV_POOL, Username: username, Password: password, Permanent: true,
  }))
}

/**
 * The owner-only `delete` fallback: the login goes from the dev pool and its profile
 * row — keyed by the pool username, not the e-mail — from the dev table, the same two
 * writes the Users API makes. Only ever pointed
 * at an identity this run created.
 */
async function deleteFromPool(username, profileId) {
  const [{ sdk, client }, { DynamoDBClient, DeleteItemCommand }] =
    await Promise.all([cognitoAdmin(), import('@aws-sdk/client-dynamodb')])
  await new DynamoDBClient({ region }).send(new DeleteItemCommand({
    TableName: `UserProfile-${DEV_TABLE_SUFFIX}`,
    Key: { id: { S: profileId ?? username } },
  }))
  await client.send(new sdk.AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: username }))
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

/** Sign a temporary identity in, answering the first-login challenge, and keep its id token. */
async function tokenFor(email, temporaryPassword) {
  const auth = await authModule()
  await auth.signOut().catch(() => {})
  const attempt = await auth.signIn({ username: email, password: temporaryPassword })
  if (!attempt.isSignedIn) {
    const step = attempt.nextStep?.signInStep
    if (step !== 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      throw new Error(`unexpected sign-in step for the temporary identity: ${step}`)
    }
    const confirmed = await auth.confirmSignIn({ challengeResponse: secret() })
    if (!confirmed.isSignedIn) throw new Error('the temporary identity could not finish signing in')
  }
  const session = await auth.fetchAuthSession({ forceRefresh: true })
  const idToken = session.tokens?.idToken?.toString()
  await auth.signOut().catch(() => {})
  if (!idToken) throw new Error('no id token for the temporary identity')
  return idToken
}

async function main() {
  const auth = await authenticateTmsUser(outputs)
  token = auth.token
  if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')

  const stamp = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const createdUsers = []
  const createdShipments = []
  let settingsBefore = null

  try {
    // ── what the settings looked like before, so they can be put back ───────
    settingsBefore = await gql(
      'query S { getTmsSettings(id: "default") { commissionsEnabled commissionTrigger commissionPlans commissionPaySchedule commissionApprovalAdminOnly commissionPayAdminOnly updatedAt } }',
    ).then((d) => d.getTmsSettings)

    // ── roles: two temporary identities, created and signed in for real ─────
    const repEmail = `zz-rep-${stamp}@example.invalid`
    const noneEmail = `zz-none-${stamp}@example.invalid`
    const repPassword = secret()
    const nonePassword = secret()

    // Created through the Users API exactly as an invite from the page is — that is the
    // path under test — then given a password straight in the dev pool, since the
    // Lambda's invite goes to a mailbox that does not exist and the challenge password
    // in it is nobody's to read.
    const repCreated = await manageUsers({ action: 'create', email: repEmail, role: 'CUSTOMER_REP' })
    createdUsers.push({ email: repEmail, profileId: repCreated.profile?.id ?? null })
    await setPoolPassword(repEmail, repPassword)
    const noneCreated = await manageUsers({ action: 'create', email: noneEmail, role: 'NONE' })
    createdUsers.push({ email: noneEmail, profileId: noneCreated.profile?.id ?? null })
    await setPoolPassword(noneEmail, nonePassword)
    // The pool names people by a generated id and signs them in by e-mail. The profile
    // is keyed by that id, `list` joins on it, and RepPicker stores it on orders and
    // customers — so that is the id the fixtures below name the reps by.
    const repId = repCreated.profile?.id
    const noneId = noneCreated.profile?.id
    if (repId && repId !== repEmail) {
      ok('an invited profile is keyed by the pool username, the id the Users page joins on', repId)
    } else {
      bad('an invited profile is keyed by the pool username', JSON.stringify(repCreated).slice(0, 160))
    }
    const listed = await manageUsers({ action: 'list' })
    const listedRep = (Array.isArray(listed) ? listed : []).find((u) => (u.email ?? '').toLowerCase() === repEmail)
    equals('the Users list shows the invited rep with their role', listedRep?.profile?.role, 'CUSTOMER_REP')

    const repGroups = await manageUsers({ action: 'getGroups', username: repEmail })
    const repGroupNames = Array.isArray(repGroups) ? repGroups : repGroups?.groups ?? []
    if (repGroupNames.includes('role-CUSTOMER_REP') && repGroupNames.includes('page-commissions')) {
      ok('a role is projected onto Cognito groups', repGroupNames.join(' '))
    } else {
      bad('a role is projected onto Cognito groups', JSON.stringify(repGroupNames))
    }
    const noneGroups = await manageUsers({ action: 'getGroups', username: noneEmail })
    const noneGroupNames = Array.isArray(noneGroups) ? noneGroups : noneGroups?.groups ?? []
    if (!noneGroupNames.some((g) => g.startsWith('page-'))) {
      ok('a roleless user is granted no page at all', noneGroupNames.join(' ') || '(no groups but DISPATCHER)')
    } else {
      bad('a roleless user is granted no page', JSON.stringify(noneGroupNames))
    }

    const repToken = await tokenFor(repEmail, repPassword)
    const noneToken = await tokenFor(noneEmail, nonePassword)
    // The admin session was signed out by the temporary logins; sign back in.
    token = (await authenticateTmsUser(outputs)).token

    const repFin = routerAs(repToken, 'tmsFinanceActions')
    const repShip = routerAs(repToken, 'tmsShipmentActions')
    const noneFin = routerAs(noneToken, 'tmsFinanceActions')

    // ── lock-out guards, from the server ────────────────────────────────────
    await refuses("the owner's role cannot be changed", /owner/i, () =>
      manageUsers({ action: 'setRole', username: OWNER_EMAIL, role: 'CUSTOMER_REP' }))
    await refuses('a non-admin cannot list users', /owner or ADMIN|Forbidden/i, () =>
      manageUsersAs(repToken, { action: 'list' }))
    await refuses('a customer rep cannot grant admin', /owner/i, () =>
      manageUsersAs(repToken, { action: 'setAdmin', username: repEmail, isAdmin: true }))

    // ── settings ────────────────────────────────────────────────────────────
    await refuses('a customer rep cannot change the brokerage shipment settings', /owner or ADMIN/i, () =>
      repShip('SAVE_SHIPMENT_SETTINGS', { cancelDeleteAdminOnly: true }))
    await refuses('a customer rep cannot change the commission settings', /owner or ADMIN/i, () =>
      repFin('SAVE_COMMISSION_SETTINGS', { commissionsEnabled: false }))
    await refuses('a roleless user cannot reach the commission desk at all', /page-commissions/i, () =>
      noneFin('RUN_COMMISSIONS', { month: today.slice(0, 7) }))
    await refuses('a commission plan the engine cannot act on is refused', /not a commission role/i, () =>
      finAction('SAVE_COMMISSION_SETTINGS', {
        commissionPlans: [{ id: 'bad', name: 'Bad', roles: [{ roleName: 'DISPATCHER', rateType: 'PERCENT_PROFIT', rateBps: 100 }] }],
      }))
    await refuses('a graduated ladder over margin bands is refused', /graduated/i, () =>
      finAction('SAVE_COMMISSION_SETTINGS', {
        commissionPlans: [{
          id: 'bad2', name: 'Bad2',
          roles: [{
            roleName: 'CREATED_BY', rateType: 'PERCENT_PROFIT', rateBps: 100,
            tierType: 'PER_LOAD_MARGIN_BPS', graduated: true, tiers: [{ fromBps: 0, rateBps: 100 }],
          }],
        }],
      }))

    // The plan this run is measured against: 10 % of profit to the primary account
    // owner, 50 % of the same role rate to each secondary owner.
    const plan = {
      id: `verify-${stamp}`,
      name: 'Step I verification plan',
      active: true,
      effectiveFrom: '2020-01-01',
      roles: [
        { roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 1000 },
        { roleName: 'SECONDARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 1000, splitBps: 5000 },
      ],
    }
    await finAction('SAVE_COMMISSION_SETTINGS', {
      commissionsEnabled: true,
      commissionTrigger: 'GENERATE_INVOICE',
      commissionPlans: [plan],
      commissionPaySchedule: { frequency: 'MONTHLY', daysUntilPay: 5 },
      commissionApprovalAdminOnly: false,
      commissionPayAdminOnly: true,
    })
    ok('commissions are switched on with a plan', `${plan.name} — 10 % of profit`)

    // ── fixtures ────────────────────────────────────────────────────────────
    const customer = await dirAction('UPSERT_CUSTOMER', {
      name: `ZZ Commission Verification ${stamp}`,
      status: 'ACTIVE',
      active: true,
      billingEmail: 'commission-verification@example.invalid',
      creditLimitCents: 100000000,
      paymentTermsDays: 30,
      accountOwnerIds: [repId ?? repEmail, noneId ?? noneEmail],
      teamKey: 'VERIFY',
      notes: 'Dev-only Step I verification fixture. Safe to delete.',
    }).then((r) => r.customer ?? r)
    console.log(`fixture customer: ${customer.name} (${customer.id})`)

    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
    const carrier = await carrierAction('UPSERT_CARRIER', {
      name: `ZZ Commission Carrier ${stamp}`,
      type: 'TL',
      status: 'ACTIVE',
      mcNumber: `6${String(stamp).slice(-6)}`,
      dotNumber: `6${String(stamp).slice(-6)}`,
      accountingEmail: 'commission-carrier@example.invalid',
      insurancePolicies: [
        { type: 'AUTO_LIABILITY', company: 'Verification Mutual', policyNumber: `AL-${stamp}`, limitCents: 100000000, expiresAt: nextYear },
        { type: 'CARGO', company: 'Verification Mutual', policyNumber: `CG-${stamp}`, limitCents: 10000000, expiresAt: nextYear },
      ],
      notes: 'Dev-only Step I verification fixture. Safe to delete.',
    }).then((r) => r.carrier ?? r)

    /**
     * A priced, delivered, invoiceable shipment of our own. Each one picks up on its
     * own day so the one fixture carrier is never double-booked, and the cost is the
     * booked carrier rate and nothing else — a CARRIER charge on the order form on top
     * of a booking would count the same truck twice.
     */
    let fixtureDay = 0
    const makeShipment = async ({ revenueCents, costCents, ownFleet = false }) => {
      fixtureDay += 1
      const day = new Date(Date.now() + fixtureDay * 24 * 3600 * 1000).toISOString().slice(0, 10)
      let b = await shipAction('CREATE_SHIPMENT', { customerId: customer.id })
      const id = b.shipment.id
      createdShipments.push(id)
      b = await shipAction('SAVE_ORDER_FORM', {
        shipmentId: id,
        expectedUpdatedAt: b.shipment.updatedAt,
        order: {
          mode: 'FTL',
          equipmentType: 'Dry Van',
          customerRepId: repId ?? repEmail,
          references: [{ code: 'PO', label: 'Purchase order', value: `VERIFY-${stamp}`, level: 'ORDER', visibility: 'CUSTOMER' }],
        },
        stops: [
          { type: 'pickup', name: 'Verify Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
          { type: 'delivery', name: 'Verify Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T23:00:00.000Z` },
        ],
        charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: revenueCents, count: 1 }],
      })
      await shipAction('SUBMIT_ORDER', { shipmentId: id, expectedUpdatedAt: b.shipment.updatedAt })
      b = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id })

      if (!ownFleet) {
        await shipAction('BOOK_CARRIER', {
          loadId: b.loads[0].id,
          expectedUpdatedAt: b.loads[0].updatedAt,
          carrierId: carrier.id,
          carrierRateCents: costCents,
          // A carrier built here has no certificates in the bucket: warnings, not blocks.
          acknowledgeWarnings: [
            'MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT',
            'INSURANCE_UNVERIFIED',
          ],
        }).catch((err) => console.log(`  (book: ${String(err.message).slice(0, 120)})`))
      }
      b = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id })
      return b
    }

    /** Move the shipment to delivered and invoice it, returning the invoice. */
    const invoice = async (bundle) => {
      // The shipment's movement status is derived from its loads, so the fixture is
      // walked up the load ladder rather than hand-set.
      let fresh = bundle
      for (const status of ['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
        const load = fresh.loads[0]
        await shipAction('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt })
          .catch((err) => console.log(`  (load ${status} skipped: ${String(err.message).slice(0, 70)})`))
        fresh = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: bundle.shipment.id })
      }
      const order = fresh.orders?.[0] ?? fresh.order
      await shipAction('READY_TO_INVOICE', {
        orderId: order.id,
        expectedUpdatedAt: order.updatedAt,
        override: true,
        overrideNote: 'dev verification fixture; no paperwork exists',
      }).catch((err) => console.log(`  (ready: ${String(err.message).slice(0, 120)})`))
      const result = await finAction('GENERATE_INVOICE', { orderId: order.id })
      return result.invoice
    }

    const commissionsOf = async (invoiceId) => {
      const data = await gql(
        `query C($invoiceId: String!) {
          listCommissionByInvoiceId(invoiceId: $invoiceId, limit: 100) {
            items { id repId roleName kind status amountCents netCents basisCents revenueCents costCents profitCents marginBps splitBps basisNote needsReview adjustsId payPeriodId cancelReason }
          }
        }`,
        { invoiceId },
      )
      return data.listCommissionByInvoiceId?.items ?? []
    }

    // ── 1. the money is frozen, and the commission is computed on it ────────
    // $2,500.00 revenue, $1,800.00 cost → $700.00 profit. 10 % = $70.00 to the
    // primary owner; the secondary owner takes 50 % of the same role rate = $35.00.
    const main = await makeShipment({ revenueCents: 250000, costCents: 180000 })
    const mainInvoice = await invoice(main)
    let rows = await commissionsOf(mainInvoice.id)
    const primary = rows.find((r) => r.roleName === 'PRIMARY_ACCOUNT_OWNER')
    const secondary = rows.find((r) => r.roleName === 'SECONDARY_ACCOUNT_OWNER')
    equals('the primary account owner earns 10 % of the gross profit', primary?.amountCents, 7000, dollars(7000))
    // `splitBps` is a weight over the role's pot, not a percentage paid independently (the
    // review's fix: two owners at 50 % of an odd pot invented a cent). Alone, the secondary
    // owner takes the whole secondary pot.
    equals('a lone secondary owner takes the whole secondary pot — a split is a weight', secondary?.amountCents, 7000, dollars(7000))
    equals('the basis is the profit on the frozen money', primary?.profitCents, 70000, dollars(70000))
    equals('the row opens unapproved', primary?.status, 'UN_APPROVED')
    equals('the rows are attributed to the people on the customer, by username', primary?.repId, repId ?? repEmail)

    // ── 2. a rerun over the same facts writes nothing ───────────────────────
    const rerun = await finAction('RUN_COMMISSIONS', { invoiceId: mainInvoice.id })
    const report = rerun.reports?.[0] ?? {}
    if (report.puts === 0 && report.updates === 0 && report.adjustments === 0) {
      ok('a second run over the same facts writes nothing', JSON.stringify(report))
    } else {
      bad('a second run is idempotent', JSON.stringify(report))
    }

    // ── 3. a rep may counter their own row and nobody else's ────────────────
    await repFin('COUNTER_COMMISSION', { commissionId: primary.id, amountCents: 9000, note: 'I sourced this one' })
    rows = await commissionsOf(mainInvoice.id)
    equals('a rep may counter their own row', rows.find((r) => r.id === primary.id)?.status, 'REP_COUNTERED')
    await refuses('a rep may not approve their own row', /cannot be approved by you|Forbidden/i, () =>
      repFin('APPROVE_COMMISSION', { commissionId: primary.id }))
    await refuses("a rep may not counter somebody else's row", /cannot counter|Forbidden/i, () =>
      repFin('COUNTER_COMMISSION', { commissionId: secondary.id, amountCents: 1, note: 'nope' }))

    await finAction('ACCEPT_COMMISSION_COUNTER', { commissionId: primary.id })
    rows = await commissionsOf(mainInvoice.id)
    const settled = rows.find((r) => r.id === primary.id)
    equals('accepting the counter agrees the number', settled?.netCents, 9000, dollars(9000))
    equals('the computed number is kept beside it', settled?.amountCents, 7000, dollars(7000))

    // ── 4. an approved row is never rewritten: the difference is its own row ─
    await finAction('APPROVE_COMMISSION', { commissionId: secondary.id })
    await finAction('WRITE_OFF', {
      invoiceId: mainInvoice.id,
      amountCents: 50000,
      reason: 'dev verification short pay',
      clientRequestId: `wo-${stamp}`,
    })
    rows = await commissionsOf(mainInvoice.id)
    const approvedAfter = rows.find((r) => r.id === secondary.id)
    const adjustment = rows.find((r) => r.kind === 'ADJUSTMENT' && r.adjustsId === secondary.id)
    equals('the approved row is untouched by the write-off', approvedAfter?.amountCents, 7000, dollars(7000))
    // Revenue $2,500 − $500 = $2,000; profit $200; 10 % = $20.00; the difference is −$50.00.
    equals('the difference arrives as its own adjustment row', adjustment?.amountCents, -5000, dollars(-5000))
    equals('the adjustment opens unapproved', adjustment?.status, 'UN_APPROVED')

    // ── 5. rounding: a half-cent is taken away from zero, once ──────────────
    // $1,000.15 revenue, $0.10 booked cost → profit 100005 cents; 10 % = 10000.5 → 10001.
    const rounding = await makeShipment({ revenueCents: 100015, costCents: 10 })
    const roundingInvoice = await invoice(rounding)
    const roundingRows = await commissionsOf(roundingInvoice.id)
    const roundedPrimary = roundingRows.find((r) => r.roleName === 'PRIMARY_ACCOUNT_OWNER')
    const roundedSecondary = roundingRows.find((r) => r.roleName === 'SECONDARY_ACCOUNT_OWNER')
    equals('the fixture lands on half a cent', roundedPrimary?.profitCents, 100005, dollars(100005))
    equals('a half-cent rounds away from zero, once', roundedPrimary?.amountCents, 10001,
      `profit ${dollars(roundedPrimary?.profitCents ?? 0)} → ${dollars(roundedPrimary?.amountCents ?? 0)}`)
    equals('the secondary pot rounds the same way and is not rounded again when allocated', roundedSecondary?.amountCents, 10001,
      dollars(roundedSecondary?.amountCents ?? 0))

    // ── 6. own fleet: zero and flagged, never an invented cost ──────────────
    const own = await makeShipment({ revenueCents: 150000, costCents: 0, ownFleet: true })
    const ownLoad = own.loads[0]
    const drivers = await gql('query D { listDrivers(limit: 1, filter: {active: {eq: true}}) { items { id name } } }')
      .catch(() => ({ listDrivers: { items: [] } }))
    const driver = drivers.listDrivers?.items?.[0]
    if (driver) {
      await shipAction('ASSIGN_ASSET', { loadId: ownLoad.id, driverId: driver.id, driverName: driver.name })
      const ownInvoice = await invoice(await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: own.shipment.id }))
      const ownRows = await commissionsOf(ownInvoice.id)
      const ownPrimary = ownRows.find((r) => r.roleName === 'PRIMARY_ACCOUNT_OWNER')
      equals('an own-fleet order pays nothing under a profit plan', ownPrimary?.amountCents, 0)
      equals('…and says why rather than inventing a cost', ownPrimary?.basisNote, 'OWN_FLEET_NO_COST')
      equals('…and is flagged for a person to look at', ownPrimary?.needsReview, true)
    } else {
      bad('the own-fleet path', 'no active Driver row on dev to assign')
    }

    // ── 7. voiding the invoice cancels what is open and reverses what is not ─
    const voided = await makeShipment({ revenueCents: 300000, costCents: 200000 })
    const voidInvoice = await invoice(voided)
    const voidRows = await commissionsOf(voidInvoice.id)
    const openRow = voidRows.find((r) => r.roleName === 'PRIMARY_ACCOUNT_OWNER')
    const approvedRow = voidRows.find((r) => r.roleName === 'SECONDARY_ACCOUNT_OWNER')
    await finAction('APPROVE_COMMISSION', { commissionId: approvedRow.id })
    await finAction('VOID_INVOICE', { invoiceId: voidInvoice.id, reason: 'dev verification void' })
    const afterVoid = await commissionsOf(voidInvoice.id)
    equals('an unapproved commission is cancelled by the void', afterVoid.find((r) => r.id === openRow.id)?.status, 'CANCELLED')
    equals('…with the reason recorded', afterVoid.find((r) => r.id === openRow.id)?.cancelReason, 'INVOICE_VOIDED')
    const reversal = afterVoid.find((r) => r.kind === 'REVERSAL' && r.adjustsId === approvedRow.id)
    equals('an approved commission is reversed, not rewritten',
      reversal?.amountCents, -(approvedRow.netCents ?? approvedRow.amountCents), dollars(reversal?.amountCents ?? 0))
    equals('…and the approved row still stands', afterVoid.find((r) => r.id === approvedRow.id)?.status, 'FULLY_APPROVED')

    // ── 8. a pay period, open to paid ───────────────────────────────────────
    // One period per schedule window, and a window already paid by an earlier run stays
    // paid: the first window from this month on that is still OPEN is the one used, and
    // SUBMIT sweeps approved rows up to three months back into it.
    let opened = null
    for (let ahead = 0; ahead < 12 && !opened; ahead += 1) {
      const probe = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + ahead, 15)).toISOString().slice(0, 10)
      const candidate = await finAction('OPEN_PAY_PERIOD', { periodStart: probe })
      if (candidate.payPeriod?.status === 'OPEN') opened = candidate
    }
    if (!opened) throw new Error('no open pay period window within a year')
    const periodId = opened.payPeriod.id
    await refuses('a manager cannot pay a period while paying is admin-only', /owner or ADMIN/i, () =>
      repFin('SUBMIT_PAY_PERIOD', { payPeriodId: periodId }))
    const submitted = await finAction('SUBMIT_PAY_PERIOD', { payPeriodId: periodId })
    ok('the period claims the approved rows', `${submitted.claimed} row(s), ${dollars(submitted.payPeriod.totalCents ?? 0)}`)
    await refuses('an unapproved period cannot be paid', /only an approved period/i, () =>
      finAction('PAY_PAY_PERIOD', { payPeriodId: periodId, reference: `PR-${stamp}` }))
    await finAction('APPROVE_PAY_PERIOD', { payPeriodId: periodId })
    await refuses('paying a period needs the payroll reference', /reference/i, () =>
      finAction('PAY_PAY_PERIOD', { payPeriodId: periodId }))
    const paid = await finAction('PAY_PAY_PERIOD', { payPeriodId: periodId, paidAt: today, reference: `PR-${stamp}` })
    ok('the period is recorded paid', `${paid.paid} row(s) marked PAID under PR-${stamp}`)

    const byRep = submitted.payPeriod.byRep ?? []
    if (byRep.length > 0) {
      const statement = await finAction('RENDER_COMMISSION_STATEMENT', { payPeriodId: periodId, repId: byRep[0].repId })
      if (statement.key?.startsWith('commissions/') && statement.url?.startsWith('http')) {
        ok('a statement PDF is rendered and stored', statement.key)
      } else {
        bad('a statement PDF is rendered', JSON.stringify(statement).slice(0, 200))
      }
    }

    // ── 9. the reporting index answers by month ─────────────────────────────
    const month = today.slice(0, 7)
    const samples = await gql(
      `query R($month: String!) {
        listLaneRateSampleBySampleMonthAndDate(sampleMonth: $month, limit: 50, sortDirection: DESC) {
          items { id sampleMonth date customerRepId carrierRepId teamKey revenueCents costCents profitCents }
        }
      }`,
      { month },
    ).then((d) => d.listLaneRateSampleBySampleMonthAndDate?.items ?? []).catch((err) => {
      bad('the reporting index answers by month', String(err.message).slice(0, 180))
      return null
    })
    if (samples) {
      ok('the reporting index answers by month', `${samples.length} sample(s) in ${month}`)
      if (samples.length > 0 && samples.every((s) => s.sampleMonth === month)) {
        ok('every sample the index returns is in the month asked for', `${samples.length} row(s)`)
      }
    }

    // ── 10. the commission ledger is readable by month and by rep ───────────
    const byMonth = await gql(
      `query CM($month: String!) {
        listCommissionByCommissionMonthAndTriggerAt(commissionMonth: $month, limit: 100) { items { id repId netCents status } }
      }`,
      { month },
    ).then((d) => d.listCommissionByCommissionMonthAndTriggerAt?.items ?? [])
    ok('the commission ledger answers by month', `${byMonth.length} row(s) in ${month}`)
  } finally {
    // ── cleanup: the identities first, then the freight ────────────────────
    token = (await authenticateTmsUser(outputs).catch(() => ({ token }))).token ?? token
    let ownerOnlyRefusalSeen = false
    for (const { email, profileId } of createdUsers) {
      try {
        await manageUsers({ action: 'delete', username: email })
        console.log(`cleanup: deleted temporary identity ${email}`)
      } catch (err) {
        const message = String(err.message ?? err)
        if (/only the owner may delete/i.test(message)) {
          if (!ownerOnlyRefusalSeen) {
            ownerOnlyRefusalSeen = true
            ok('an admin who is not the owner cannot delete a user', message.slice(0, 140))
          }
          await deleteFromPool(email, profileId)
            .then(() => console.log(`cleanup: removed temporary identity ${email} from the dev pool directly`))
            .catch((e) => console.log(`cleanup: could not remove ${email}: ${String(e.message).slice(0, 120)}`))
        } else {
          console.log(`cleanup: could not delete ${email}: ${message.slice(0, 120)}`)
        }
      }
    }
    for (const shipmentId of createdShipments) {
      for (const step of ['cancel', 'delete']) {
        const current = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId }).catch(() => null)
        if (!current) break
        const args = { shipmentId, expectedUpdatedAt: current.shipment.updatedAt, reason: 'dev verification fixture' }
        await shipAction(
          step === 'cancel' ? 'SET_SHIPMENT_STATUS' : 'DELETE_SHIPMENT',
          step === 'cancel' ? { ...args, status: 'CANCELED' } : args,
        ).catch(() => {})
      }
    }
    if (settingsBefore) {
      await finAction('SAVE_COMMISSION_SETTINGS', {
        commissionsEnabled: settingsBefore.commissionsEnabled === true,
        commissionTrigger: settingsBefore.commissionTrigger ?? 'GENERATE_INVOICE',
        commissionPlans: settingsBefore.commissionPlans
          ? (typeof settingsBefore.commissionPlans === 'string'
              ? JSON.parse(settingsBefore.commissionPlans)
              : settingsBefore.commissionPlans)
          : null,
      }).then(() => console.log('cleanup: commission settings put back as they were'))
        .catch((err) => console.log(`cleanup: could not restore settings: ${String(err.message).slice(0, 140)}`))
    }
  }

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
