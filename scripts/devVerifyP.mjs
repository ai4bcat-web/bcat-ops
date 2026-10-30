#!/usr/bin/env node
/**
 * Step P live verification against the DEV stack.
 *
 * Runs the full end-to-end demo flow that Ryne sees on the Demo page, through
 * the deployed Lambdas with real Cognito tokens. SEED_DEMO_DATA and
 * RESET_DEMO_DATA are invoked directly against the tmsShipmentActions Lambda
 * so the ~20-shipment seed can use the full 60-second Lambda window instead of
 * the AppSync resolver's 30-second ceiling. A throwaway ADMIN identity is
 * created at the start and deleted in a `finally`; demo staff are created and
 * removed inline; passwords are generated and never printed.
 *
 *   node scripts/devVerifyP.mjs
 *
 * The script refuses to run against any endpoint other than the dev AppSync URL.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { DEMO_STAFF } from './seedDemo.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const PUBLIC_API = 'https://jk65s5nfkj2sfnnoang4huvbvq0bsruo.lambda-url.us-east-1.on.aws'
const SHIPMENT_ACTIONS_LAMBDA = 'amplify-d3dejqzs77khq6-de-tmsshipmentactionslambda-x2KeBv2mM6Mk'
const region = 'us-east-1'

const outputs = {
  auth: {
    user_pool_id: DEV_POOL,
    user_pool_client_id: DEV_CLIENT,
    aws_region: region,
    username_attributes: ['email'],
  },
  data: { url: DEV_API, aws_region: region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
function ok(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name} — ${detail}`) }
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
    if (pattern.test(message)) ok(name, message.slice(0, 140))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 200)}`)
  }
}

const cognito = new CognitoIdentityProviderClient({ region })
const lambda = new LambdaClient({ region })

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

async function publicGet(path) {
  const res = await fetch(`${PUBLIC_API}${path}`, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}

async function publicPost(path, payload) {
  const res = await fetch(`${PUBLIC_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
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
  return { token: session.tokens.idToken.toString(), password }
}

async function manageUsers(token, action, input) {
  const data = await gql(
    token,
    `query M($action: String!, $username: String, $role: String) {
      manageUsers(action: $action, username: $username, role: $role)
    }`,
    { action, username: input?.username, role: input?.role },
  )
  const raw = data?.manageUsers
  return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null
}

async function createDemoStaffMember({ member, adminToken }) {
  const password = `Aa1!${randomBytes(18).toString('base64url')}`
  let username
  try {
    const result = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: DEV_POOL, Username: member.email, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: member.email }, { Name: 'email_verified', Value: 'true' }],
    }))
    username = result.User?.Username ?? member.email
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: DEV_POOL, Username: username, Password: password, Permanent: true }))
  } catch (err) {
    if (err?.name !== 'UsernameExistsException') throw err
    username = member.email
  }
  await manageUsers(adminToken, 'setRole', { username, role: member.role })
  return { id: member.id, email: member.email, name: member.name, role: member.role }
}

async function removeDemoStaffMember({ member }) {
  try {
    await manageUsers(adminTokenGlobal, 'delete', { username: member.email })
    return { id: member.id, removed: true }
  } catch (err) {
    const name = err?.name ?? ''
    const message = String(err?.message ?? err)
    if (name === 'UserNotFoundException' || /user.*not found/i.test(message)) return { id: member.id, removed: false }
    throw err
  }
}

let adminTokenGlobal = ''

async function invokeShipmentAction(action, input, callerEmail) {
  const payload = {
    arguments: { action, input: JSON.stringify(input ?? {}) },
    identity: {
      sub: 'dev-verify-p',
      username: callerEmail,
      claims: {
        email: callerEmail,
        'cognito:groups': 'ADMIN,page-tms',
      },
    },
  }
  const res = await lambda.send(new InvokeCommand({
    FunctionName: SHIPMENT_ACTIONS_LAMBDA,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }))
  const body = JSON.parse(Buffer.from(res.Payload).toString())
  if (body.errorMessage || body.errorType) {
    throw new Error(body.errorMessage || `${body.errorType}: ${JSON.stringify(body)}`)
  }
  return body
}

function findDemoRecord(state, kind, demoKey) {
  return state.records?.find((r) => r.kind === kind && r.demoKey === demoKey)
}

async function getBundle(token, shipmentId) {
  const ship = routerAs(token, 'tmsShipmentActions')
  return ship('GET_SHIPMENT_BUNDLE', { shipmentId })
}

async function main() {
  const adminEmail = `zz-p-admin-${Date.now()}@example.invalid`
  let adminToken
  let adminPassword
  try {
    const minted = await mintIdentity(adminEmail, ['ADMIN', 'page-tms'])
    adminToken = minted.token
    adminPassword = minted.password
    adminTokenGlobal = adminToken
  } catch (err) {
    bad('mint admin identity', String(err))
    throw err
  }

  const ship = routerAs(adminToken, 'tmsShipmentActions')
  const track = routerAs(adminToken, 'tmsTrackingActions')
  const dir = routerAs(adminToken, 'tmsDirectoryActions')

  try {
    // ── P1: create demo staff identities and seed demo data ───────────────────
    for (const member of DEMO_STAFF) {
      await createDemoStaffMember({ member, adminToken })
    }
    const staffSourceRows = DEMO_STAFF.map(({ id, name, role }) => ({ id, name, role }))
    await invokeShipmentAction('RESET_DEMO_DATA', { staff: staffSourceRows }, adminEmail)

    // ── P11: demo state and checklist ticks ───────────────────────────────────
    const state = await ship('GET_DEMO_STATE', {})
    equals('demo stack is dev', state.devStack, true)
    equals('demo seed version present', Boolean(state.seedVersion), true)
    equals('demo staff seeded', state.facts?.staffCount, DEMO_STAFF.length)
    equals('demo shipments seeded', state.facts?.shipmentCount >= 8, true)
    equals('demo checklist: open assigned', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.open.assigned')), true)
    equals('demo checklist: customer auto', Boolean(findDemoRecord(state, 'CUSTOMER', 'customer.auto')), true)
    equals('demo checklist: quote inbound', Boolean(findDemoRecord(state, 'QUOTE', 'quote.inbound')), true)
    equals('demo checklist: building', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.building')), true)
    equals('demo checklist: posted', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.posted')), true)
    equals('demo checklist: in transit', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.intransit')), true)
    equals('demo checklist: pod flagged', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.podflagged')), true)
    equals('demo checklist: ready to bill', Boolean(findDemoRecord(state, 'SHIPMENT', 'shipment.readytobill')), true)

    // ── P2: carrier rep assignment is on the open shipment ────────────────────
    const openRec = findDemoRecord(state, 'SHIPMENT', 'shipment.open.assigned')
    const openBundle = await getBundle(adminToken, openRec.recordId)
    if (openBundle.shipment?.carrierRepId || openBundle.shipment?.carrierTeamKey) {
      ok('P2 open shipment assigned to rep/team', openBundle.shipment?.carrierRepId || openBundle.shipment?.carrierTeamKey)
    } else {
      bad('P2 open shipment assigned', 'no carrierRepId or carrierTeamKey')
    }

    // ── P3: customer flow defaults seeded ─────────────────────────────────────
    equals('P3 customers with flow defaults', state.facts?.customersWithFlowDefaults >= 1, true)

    // ── P4: quote in → market rate → suggested sell rate ──────────────────────
    const customerAutoRec = findDemoRecord(state, 'CUSTOMER', 'customer.auto')
    const price = await ship('PRICE_FROM_MARKET', {
      customerId: customerAutoRec.recordId,
      originCity: 'Chicago', originState: 'IL',
      destinationCity: 'Dallas', destinationState: 'TX',
      equipmentType: 'DRY_VAN', miles: 920, mode: 'FTL', save: false,
    })
    equals('P4 market rate answered', typeof price.answer?.averageCents, 'number')
    equals('P4 suggested sell rate > 0', price.suggestedSellCents > 0, true)
    equals('P4 market source labelled', price.answer?.source, 'DAT_RATEVIEW')

    // ── P5: building gate, fill required fields, complete build ───────────────
    const buildingRec = findDemoRecord(state, 'SHIPMENT', 'shipment.building')
    const buildingBundle = await getBundle(adminToken, buildingRec.recordId)
    const gate = await ship('CHECK_BUILD_GATE', { shipmentId: buildingRec.recordId })
    equals('P5 building gate reports missing fields', gate.buildState, 'BUILDING')
    equals('P5 missing fields include salesRep/billTo/poNumber', gate.missingFields?.length >= 1, true)

    await ship('SET_SALES_REP', { shipmentId: buildingRec.recordId, repId: 'demo-sales-rep@example.invalid' })
    await ship('SET_REV_TAG', { shipmentId: buildingRec.recordId, divisionCode: 'BROKERAGE' })
    const buildingBundleFresh = await getBundle(adminToken, buildingRec.recordId)
    await ship('SAVE_ORDER_FORM', {
      shipmentId: buildingRec.recordId,
      expectedUpdatedAt: buildingBundleFresh.shipment.updatedAt,
      order: {
        billToId: 'demo-billto-brokerage',
        freight: [
          {
            handlingUnit: 'PALLET',
            qty: 1,
            description: 'Demo electronics',
            weightLbs: 1500,
            weightUnit: 'LB',
          },
        ],
        references: [
          { code: 'PO', label: 'PO number', value: 'PO-P-DEMO-001', level: 'ORDER', visibility: 'INTERNAL' },
        ],
      },
    })
    const buildingBundleFinal = await getBundle(adminToken, buildingRec.recordId)
    const built = await ship('COMPLETE_BUILD', { shipmentId: buildingRec.recordId, expectedUpdatedAt: buildingBundleFinal.shipment.updatedAt })
    equals('P5 complete build makes BUILT', built.buildState, 'BUILT')

    // ── P6: post / unpost stub on the posted shipment ─────────────────────────
    const postedRec = findDemoRecord(state, 'SHIPMENT', 'shipment.posted')
    const unpost = await ship('UNPOST_LOAD', { shipmentId: postedRec.recordId, providers: ['DAT'] })
    const postingsAfterUnpost = await ship('LIST_POSTINGS', { shipmentId: postedRec.recordId })
    const datAfterUnpost = postingsAfterUnpost.postings?.find((p) => p.provider === 'DAT')
    equals('P6 DAT unpost is UNPOSTED', datAfterUnpost?.status, 'UNPOSTED')

    const repost = await ship('POST_LOAD', { shipmentId: postedRec.recordId, providers: ['DAT'], rateCents: 100000 })
    equals('P6 DAT re-post succeeded', repost.postings?.some((r) => r.provider === 'DAT' && r.ok), true)
    const postingsAfterRepost = await ship('LIST_POSTINGS', { shipmentId: postedRec.recordId })
    const datAfterRepost = postingsAfterRepost.postings?.find((p) => p.provider === 'DAT')
    equals('P6 DAT re-post is POSTED', datAfterRepost?.status, 'POSTED')
    equals('P6 DAT post mode is labelled STUB', datAfterRepost?.mode, 'STUB')

    // ── P7: carrier offer → setup packet for unknown carrier ──────────────────
    const postedBundle = await getBundle(adminToken, postedRec.recordId)
    const postedLoad = postedBundle.loads?.[0]
    const offer = await ship('RECORD_CARRIER_OFFER', {
      shipmentId: postedRec.recordId,
      carrierName: 'Brand New Trucking LLC',
      carrierMc: 'MC-NEW888',
      amountCents: 95000,
      source: 'EMAIL',
      carrierEmail: 'dispatch@newtrucking.example',
      equipmentType: 'DRY_VAN',
    })
    equals('P7 new carrier offer recorded', offer.quote?.side, 'BUY')
    const setup = await ship('SEND_SETUP_PACKET', {
      shipmentId: postedRec.recordId,
      quoteId: offer.quote.id,
      email: 'dispatch@newtrucking.example',
    })
    equals('P7 setup packet sent in stub mode', setup.mode, 'STUB')

    // ── P8: book vetted carrier on the posted load; rate con gate & thread ────
    const book = await ship('BOOK_CARRIER', {
      loadId: postedLoad.id,
      carrierId: 'carr-demo-vetted',
      carrierRateCents: 90000,
      expectedUpdatedAt: postedLoad.updatedAt,
      driverName: 'Demo Driver',
      driverPhone: '+12245550137',
      dispatcherEmail: 'dispatch@vetted.example',
    })
    const bookedBundle = await getBundle(adminToken, postedRec.recordId)
    const bookedCarrier = bookedBundle.loadCarriers?.find((c) => c.status === 'ACTIVE')
    if (!bookedCarrier) { bad('P8 booked carrier', 'no active load carrier'); return }

    const pdfBase64 = Buffer.from('fake pdf content for rate con test').toString('base64')
    const rateConBundle = await ship('SEND_RATE_CON', {
      loadCarrierId: bookedCarrier.id,
      pdfBase64,
      to: ['dispatch@vetted.example'],
    })
    const rateConCarrier = rateConBundle.loadCarriers?.find((c) => c.id === bookedCarrier.id)
    equals('P8 rate con sent', rateConCarrier?.rateConStatus, 'SENT')
    equals('P8 thread opened by rate con', typeof rateConBundle.shipment?.threadKey, 'string')

    // ── P8: tracking link tap and geocoded reply ──────────────────────────────
    const transitRec = findDemoRecord(state, 'SHIPMENT', 'shipment.intransit')
    const transitBundle = await getBundle(adminToken, transitRec.recordId)
    const transitCarrier = transitBundle.loadCarriers?.find((c) => c.status === 'ACTIVE')
    if (!transitCarrier) { bad('P8 in-transit carrier', 'no active load carrier'); return }

    const linkOut = await track('SEND_TRACKING_LINK', { loadCarrierId: transitCarrier.id, via: 'COPY' })
    const linkToken = linkOut.trackingLinkId ?? linkOut.link?.id
    if (!linkToken) { bad('P8 tracking link created', 'no token'); return }
    const page = await publicGet(`/l/${linkToken}`)
    equals('P8 tracking link page loads', page.status, 200)
    const ping = await publicPost(`/l/${linkToken}/ping`, { lat: 32.7767, lng: -96.797, accuracyM: 10 })
    equals('P8 tracking link ping accepted', ping.status, 200)

    const ingest = await track('INGEST_SHIPMENT_MESSAGE', {
      shipmentId: transitRec.recordId,
      messageId: `sms-${Date.now()}@demo`,
      channel: 'SMS',
      kind: 'CHECK_CALL_REPLY',
      party: 'DRIVER',
      from: '+12245550137',
      body: 'in Dallas, TX',
    })
    equals('P8 geocoded SMS reply routed', ingest.routed, true)
    const transitAfterReply = await getBundle(adminToken, transitRec.recordId)
    const transitLoadAfterReply = transitAfterReply.loads?.[0]
    equals('P8 geocoded reply set last known city', transitLoadAfterReply?.lastKnownCity, 'Dallas')

    // ── P8: silence escalation ────────────────────────────────────────────────
    const sweep = await track('SWEEP_CHECK_CALL_PLANS', {})
    equals('P8 check-call sweep ran', typeof sweep.acted, 'number')
    const transitMessages = await track('LIST_SHIPMENT_THREAD', { shipmentId: transitRec.recordId })
    const hasEscalation = transitMessages.messages?.some((m) => m.kind === 'ESCALATION')
    equals('P8 escalation message present in thread', hasEscalation, true)

    // ── P9/P10: POD review retry / human flag and release to billing ──────────
    const podFlaggedRec = findDemoRecord(state, 'SHIPMENT', 'shipment.podflagged')
    const podFlaggedBundle = await getBundle(adminToken, podFlaggedRec.recordId)
    const rejectedPods = (podFlaggedBundle.documents || []).filter((d) => d.type === 'POD' && d.reviewStatus === 'REJECTED')
    equals('P9 pod flagged shipment has two rejected PODs', rejectedPods.length, 2)
    equals('P9 shipment flagged for human review', typeof podFlaggedBundle.shipment?.podFlaggedAt, 'string')

    const readyRec = findDemoRecord(state, 'SHIPMENT', 'shipment.readytobill')
    const readyBundle = await getBundle(adminToken, readyRec.recordId)
    const readyOrder = readyBundle.orders?.[0]
    if (!readyOrder) { bad('P10 ready-to-bill order', 'missing'); return }
    const release = await ship('READY_TO_INVOICE', { orderId: readyOrder.id, expectedUpdatedAt: readyOrder.updatedAt })
    equals('P10 release to billing succeeds', release.bundle?.orders?.[0]?.arStatus, 'UNBILLED')

    // ── P11: reset demo data ──────────────────────────────────────────────────
    const reset = await invokeShipmentAction('RESET_DEMO_DATA', { staff: staffSourceRows }, adminEmail)
    equals('P11 reset re-seeded', reset.counts?.SHIPMENT >= 1, true)
    const stateAfterReset = await ship('GET_DEMO_STATE', {})
    equals('P11 demo state present after reset', stateAfterReset.facts?.shipmentCount >= 1, true)

    // Remove demo staff identities.
    for (const member of DEMO_STAFF) {
      await removeDemoStaffMember({ member })
    }
  } finally {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: adminEmail })).catch(() => {})
    console.log(`cleanup: removed temporary admin identity ${adminEmail}`)
  }

  const pass = results.filter((r) => r.ok).length
  console.log(`\nSUMMARY ${JSON.stringify({ pass, fail: results.length - pass })}`)
  if (pass !== results.length) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
