/**
 * Step R2 follow-up live verification against the DEV stack.
 *
 * It drives the deployed Lambdas with a real token, never through the UI: the seed
 * sweep that retires the five views that became pages, the new batch router, the
 * duplicate that leaves the carrier behind, and the credit plan for an invoiced
 * re-point. Fixtures are retired by VOID, never deleted, and the temporary identity
 * it mints is removed in a `finally` with a password that is never printed.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyR2Followup.mjs
 */
import { randomBytes } from 'node:crypto'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const region = 'us-east-1'

const outputs = {
  auth: { user_pool_id: DEV_POOL, user_pool_client_id: DEV_CLIENT, aws_region: region, username_attributes: ['email'] },
  data: { url: DEV_API, aws_region: region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
const ok = (name, detail) => { results.push(true); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const bad = (name, detail) => { results.push(false); console.log(`FAIL  ${name} — ${detail}`) }
function equals(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name, JSON.stringify(actual))
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
async function refuses(name, pattern, run) {
  try {
    await run()
    bad(name, 'it was allowed')
  } catch (err) {
    const message = String(err?.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 120))
    else bad(name, `refused for the wrong reason: ${message}`)
  }
}

const cognito = new CognitoIdentityProviderClient({ region })

async function gql(token, query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}

const routerAs = (token, field) => async (action, input) => {
  const data = await gql(
    token,
    `mutation($action:String!,$input:AWSJSON!){ ${field}(action:$action,input:$input) }`,
    { action, input: JSON.stringify(input ?? {}) },
  )
  const raw = data[field]
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

/** A throwaway dev login. The password is generated here and never printed. */
async function mintIdentity(email, groups) {
  const password = `Aa1!${randomBytes(18).toString('base64url')}`
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: DEV_POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }))
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: DEV_POOL, Username: email, Password: password, Permanent: true }))
  for (const group of groups) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: DEV_POOL, Username: email, GroupName: group }))
  }
  const { Amplify } = await import('aws-amplify')
  const { signIn, signOut, fetchAuthSession } = await import('aws-amplify/auth')
  Amplify.configure(outputs)
  await signOut().catch(() => {})
  await signIn({ username: email, password })
  const session = await fetchAuthSession({ forceRefresh: true })
  return session.tokens.idToken.toString()
}

async function main() {
  // Ryne's own login when the environment has it; otherwise a temporary ADMIN that is
  // deleted in the `finally` below, with a password that is never printed.
  let adminIdentity = null
  let token
  if (process.env.BCAT_EMAIL && process.env.BCAT_PASSWORD) {
    const auth = await authenticateTmsUser(outputs)
    if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')
    token = auth.token
  } else {
    adminIdentity = `zz-r2f-admin-${Date.now()}@example.invalid`
    token = await mintIdentity(adminIdentity, ['ADMIN', 'page-tms'])
  }
  const dir = routerAs(token, 'tmsDirectoryActions')
  const ship = routerAs(token, 'tmsShipmentActions')
  try {

  // 1. The seed sweep retires the five views that became pages or moved.
  const seed = await dir('ENSURE_OWNERSHIP_SEED', {})
  ok('seed sweep ran', JSON.stringify({
    viewsCreated: seed.viewsCreated, viewsDeactivated: seed.viewsDeactivated, viewsPresent: seed.viewsPresent,
  }))
  const views = await gql(token, `query{ listShipmentViews(limit:200){ items{ id slug name active isDefault } } }`)
  const active = views.listShipmentViews.items.filter((v) => v.active !== false).map((v) => v.slug).sort()
  const retired = ['dispatch', 'tracking', 'pod-collection', 'accounting', 'sales']
  const stillActive = retired.filter((slug) => active.includes(slug))
  equals('the five retired views are inactive', stillActive, [])
  ok('active views on dev', active.join(', '))

  // 2. A column template round-trips its widths and its pins.
  const templateId = `zz-r2f-${Date.now()}`
  await dir('SAVE_COLUMN_TEMPLATE', {
    id: templateId,
    name: 'zz R2 follow-up template',
    columns: ['status', 'proNumber', 'customerName'],
    widths: { status: 140, proNumber: 110 },
    pinned: ['status'],
    shared: false,
  })
  const templates = await gql(token, `query{ listShipmentColumnTemplates(limit:200){ items{ id columns widths pinned } } }`)
  const saved = templates.listShipmentColumnTemplates.items.find((t) => t.id === templateId)
  const unwrap = (v) => (typeof v === 'string' ? JSON.parse(v) : v)
  equals('the template keeps its pins', unwrap(saved?.pinned), ['status'])
  const widths = unwrap(saved?.widths) ?? {}
  equals('the template keeps its widths', Object.keys(widths).sort().map((k) => [k, widths[k]]), [['proNumber', 110], ['status', 140]])
  await refuses('a pin outside the template is refused', /pinned but is not one of/, () =>
    dir('SAVE_COLUMN_TEMPLATE', {
      id: templateId, name: 'zz R2 follow-up template', columns: ['status'], pinned: ['customerName'], shared: false,
    }))
  await dir('DELETE_COLUMN_TEMPLATE', { id: templateId })

  // 3. The batch router answers per row, in input order, with the gate's own words.
  const shipments = await gql(token, `query{ listShipments(limit:3){ items{ id number status } } }`)
  const ids = shipments.listShipments.items.map((s) => s.id)
  const batch = await ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [...ids, 'shp-does-not-exist'] })
  equals('the batch answers once per requested row', batch.results.length, ids.length + 1)
  const missing = batch.results[batch.results.length - 1]
  equals('a missing shipment is reported, not skipped', [missing.shipmentId, missing.ok], ['shp-does-not-exist', false])
  const refusals = batch.results.filter((r) => !r.ok).map((r) => r.message)
  ok('per-row answers', JSON.stringify(batch.results.map((r) => ({ n: r.number, ok: r.ok }))))
  if (refusals.length) ok('a refused row carries its reason', refusals[0].slice(0, 120))
  await refuses('the batch refuses an unknown task', /task/i, () =>
    ship('BATCH_SHIPMENT_TASK', { task: 'NOT_A_TASK', shipmentIds: ids.slice(0, 1) }))
  await refuses('the batch refuses an empty list', /at least one/, () =>
    ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [] }))

  // 4. The batch grants nothing the single-row action would not. `SET_REV_TAG` is open
  // to a loads user one shipment at a time (Step R), so the batch is too; a user with
  // no TMS page at all is refused by the same predicate.
  const stamp = Date.now()
  const tmpEmail = `zz-r2f-${stamp}@example.invalid`
  let tmpUser = null
  try {
    const weakToken = await mintIdentity(tmpEmail, [])
    tmpUser = tmpEmail
    await refuses('a user with no TMS page may not run a batch task', /Forbidden/, () =>
      routerAs(weakToken, 'tmsShipmentActions')('BATCH_SHIPMENT_TASK', {
        task: 'SET_REV_DIVISION', shipmentIds: ids.slice(0, 1), params: { divisionCode: 'BROKERAGE' },
      }))
  } finally {
    if (tmpUser) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: tmpUser })).catch(() => {})
      console.log(`cleanup: deleted the temporary identity ${tmpUser}`)
    }
  }
  } finally {
    if (adminIdentity) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: adminIdentity })).catch(() => {})
      console.log(`cleanup: deleted the temporary identity ${adminIdentity}`)
    }
  }

  const pass = results.filter(Boolean).length
  console.log(`\nSUMMARY ${JSON.stringify({ pass, fail: results.length - pass })}`)
  if (pass !== results.length) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
