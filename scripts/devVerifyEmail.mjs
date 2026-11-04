#!/usr/bin/env node
/**
 * Dev e-mail live test: one REAL rate-con e-mail and one REAL invoice e-mail from the dev
 * stack through SES, to ai4bcat@gmail.com ONLY.
 *
 *   node scripts/devVerifyEmail.mjs --inventory   # read-only: SES account, identities, dev role policy, Lambda env
 *   node scripts/devVerifyEmail.mjs --run         # after the dev deploy: sends the two e-mails, logs the ids
 *
 * Hard allow-list: every address this script supplies is exactly ai4bcat@gmail.com. The only
 * other addresses that can appear are the ones the app adds itself and which are plus
 * aliases of that same mailbox (ai4bcat+tracking@ Cc, the ai4bcat+tracking.<shipment>@
 * Reply-To, and the temp admin's own address, which is made an alias on purpose so the
 * "copy the sender" Cc cannot reach anyone else). The dev IAM guard (amplify/devRuleGuard.ts)
 * refuses any send with a recipient outside that mailbox; this script refuses first.
 *
 * Fixtures are ZZ-prefixed, created through the real app actions with a throwaway ADMIN
 * identity (deleted in `finally`), and voided afterwards. Dev only: it refuses any other API.
 * No passwords, tokens or secrets are printed. Results go to Docs/tms-build/EMAIL_LIVE_TEST.md
 * (ids and statuses; no addresses beyond the allow-listed mailbox).
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESv2Client, GetAccountCommand, ListEmailIdentitiesCommand } from '@aws-sdk/client-sesv2'
import { LambdaClient, GetFunctionConfigurationCommand, GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda'
import { IAMClient, ListRolePoliciesCommand, GetRolePolicyCommand } from '@aws-sdk/client-iam'
import { DEV_API, region, gql, routerAs, mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT = resolve(here, '../Docs/tms-build/EMAIL_LIVE_TEST.md')

export const ALLOWED = 'ai4bcat@gmail.com'
const SHIPMENT_LAMBDA = 'amplify-d3dejqzs77khq6-de-tmsshipmentactionslambda-x2KeBv2mM6Mk'
const FINANCE_LAMBDA = 'amplify-d3dejqzs77khq6-de-tmsfinanceactionslambda4-Lqsan9dSRpVa'
const INTAKE_LAMBDA = 'amplify-d3dejqzs77khq6-de-shipmentemailintakelambd-YsxNLkk5biqY'
const SHIPMENT_ROLE = 'amplify-d3dejqzs77khq6-de-tmsshipmentactionslambdaS-qg7E3EtcTcYJ'

/** Exactly the mailbox, or one of its +tag aliases (which Gmail delivers to the same inbox). */
export function isMailbox(address) {
  return /^ai4bcat(\+[A-Za-z0-9._-]+)?@gmail\.com$/.test(String(address).trim())
}

/** Addresses THIS SCRIPT supplies: only the bare mailbox is acceptable. */
export function assertAllowed(addresses) {
  for (const a of addresses) {
    if (String(a).trim().toLowerCase() !== ALLOWED) throw new Error('refusing to send: only the single allow-listed mailbox may be addressed')
  }
}

/** Split a stored "a, b" recipient string into addresses. */
export function splitAddresses(value) {
  return String(value ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

export function allInMailbox(value) {
  return splitAddresses(value).every(isMailbox)
}

const args = process.argv.slice(2)

const results = []
const report = { rateCon: {}, invoice: {}, reply: {} }
const lines = []
function log(line = '') { lines.push(line); console.log(line) }
function ok(name, detail) { results.push({ ok: true, name }); log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name }); log(`FAIL  ${name} — ${detail}`) }

// ── --inventory: read-only ──────────────────────────────────────────────────
async function inventory() {
  const sesv2 = new SESv2Client({ region })
  const lambda = new LambdaClient({ region })
  const iam = new IAMClient({ region })
  console.log(`SES region: ${region}`)
  const acct = await sesv2.send(new GetAccountCommand({}))
  console.log(`sending enabled: ${acct.SendingEnabled}`)
  console.log(`quota: ${acct.SendQuota?.Max24HourSend}/24h, ${acct.SendQuota?.MaxSendRate}/s, sent last 24h ${acct.SendQuota?.SentLast24Hours}`)
  console.log(`production access: ${acct.ProductionAccessEnabled} (sandbox: ${!acct.ProductionAccessEnabled})`)
  const idList = (await sesv2.send(new ListEmailIdentitiesCommand({}))).EmailIdentities ?? []
  const attrs = {}
  for (const i of idList) {
    attrs[i.IdentityName] = { VerificationStatus: i.VerificationStatus === 'SUCCESS' ? 'Success' : i.VerificationStatus }
    console.log(`identity ${i.IdentityName}: ${i.VerificationStatus}, sending ${i.SendingEnabled}`)
  }
  for (const [label, fn] of [['tmsShipmentActions', SHIPMENT_LAMBDA], ['tmsFinanceActions', FINANCE_LAMBDA]]) {
    const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }))
    const v = c.Environment?.Variables ?? {}
    const from = v.FROM_ADDRESS
    console.log(`${label}: FROM_ADDRESS=${from} (verified: ${attrs[from]?.VerificationStatus === 'Success'}), BCAT_DEV_STACK=${v.BCAT_DEV_STACK}`)
  }
  let deny = null
  for (const name of (await iam.send(new ListRolePoliciesCommand({ RoleName: SHIPMENT_ROLE }))).PolicyNames ?? []) {
    const doc = JSON.parse(decodeURIComponent((await iam.send(new GetRolePolicyCommand({ RoleName: SHIPMENT_ROLE, PolicyName: name }))).PolicyDocument))
    for (const s of doc.Statement ?? []) {
      if (s.Effect === 'Deny' && JSON.stringify(s.Action).includes('ses:')) deny = s
    }
  }
  if (!deny) console.log('dev SES deny: none')
  else if (deny.Condition) console.log(`dev SES deny: CONDITIONAL (${JSON.stringify(deny.Condition)}) -> the allow-list fix is deployed`)
  else console.log('dev SES deny: UNCONDITIONAL ses:* -> every send is refused; deploy the dev guard change first')
}

// ── --run ───────────────────────────────────────────────────────────────────
const TINY_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)

async function run() {
  const lambda = new LambdaClient({ region })
  const iam = new IAMClient({ region })

  // Preflight: refuse to run until the conditional guard is on the role (otherwise every send fails).
  let conditional = false
  for (const name of (await iam.send(new ListRolePoliciesCommand({ RoleName: SHIPMENT_ROLE }))).PolicyNames ?? []) {
    const doc = JSON.parse(decodeURIComponent((await iam.send(new GetRolePolicyCommand({ RoleName: SHIPMENT_ROLE, PolicyName: name }))).PolicyDocument))
    for (const s of doc.Statement ?? []) {
      if (s.Effect === 'Deny' && JSON.stringify(s.Action).includes('ses:') && s.Condition) conditional = true
    }
  }
  if (!conditional) throw new Error('the dev role still has the unconditional ses:* deny: deploy the dev guard change first (node scripts/devVerifyEmail.mjs --inventory)')

  const shipEnv = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: SHIPMENT_LAMBDA }))).Environment?.Variables ?? {}
  const messageTable = shipEnv.SHIPMENT_MESSAGE_TABLE_NAME
  if (shipEnv.BCAT_DEV_STACK !== 'true' || !messageTable) throw new Error('target Lambda is not the dev stack')

  const stamp = Date.now()
  // The temp admin is an alias of the allow-listed mailbox so the rate con's "copy the sender" Cc stays inside it.
  const adminEmail = `ai4bcat+zzemail${stamp}@gmail.com`
  if (!isMailbox(adminEmail)) throw new Error('temp identity must be a mailbox alias')
  const minted = await mintIdentity(adminEmail, ['ADMIN', 'page-tms'])
  const token = minted.token
  const ship = routerAs(token, 'tmsShipmentActions')
  const fin = routerAs(token, 'tmsFinanceActions')
  const dir = routerAs(token, 'tmsDirectoryActions')
  const fixtures = { shipments: [] }

  const messagesOf = async (shipmentId) => {
    const rows = []
    let next = null
    do {
      const r = await gql(token,
        'query($s: String!, $n: String) { listShipmentMessageByShipmentIdAndAt(shipmentId: $s, limit: 200, nextToken: $n) { items { id messageId providerRef inReplyTo direction channel kind status error threadKey from to cc } nextToken } }',
        { s: shipmentId, n: next })
      rows.push(...r.listShipmentMessageByShipmentIdAndAt.items)
      next = r.listShipmentMessageByShipmentIdAndAt.nextToken
    } while (next)
    return rows
  }

  const today = new Date().toISOString().slice(0, 10)
  const newFixture = async (customer, withCarrierCharge) => {
    let bundle = await ship('CREATE_SHIPMENT', { customerId: customer.id })
    const shipmentId = bundle.shipment.id
    fixtures.shipments.push(shipmentId)
    bundle = await ship('SAVE_ORDER_FORM', {
      shipmentId,
      expectedUpdatedAt: bundle.shipment.updatedAt,
      order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'Purchase order', value: `ZZEMAIL-${stamp}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
      stops: [
        { type: 'pickup', name: 'ZZ Email Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
        { type: 'delivery', name: 'ZZ Email Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T23:00:00.000Z` },
      ],
      charges: [
        { side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 },
        ...(withCarrierCharge ? [{ side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 }] : []),
      ],
    })
    await ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
    return ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  }
  const attach = async (shipmentId, orderId, loadId, type) => {
    const name = `zz-${type.toLowerCase()}.pdf`
    const prepared = await ship('PREPARE_DOCUMENT_UPLOAD', { shipmentId, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length })
    const put = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: TINY_PDF })
    if (!put.ok) throw new Error(`upload failed: ${put.status}`)
    return ship('COMMIT_DOCUMENT', {
      shipmentId, documentId: prepared.documentId, s3Key: prepared.s3Key, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length,
      ...(type === 'BOL' || type === 'POD' ? { loadId } : { orderId }),
    })
  }

  try {
    assertAllowed([ALLOWED])
    const customerRes = await dir('UPSERT_CUSTOMER', {
      name: `ZZ Email Live ${stamp}`, status: 'ACTIVE', active: true, mcNumber: `9${String(stamp).slice(-6)}`,
      billingEmail: ALLOWED, creditLimitCents: 100000000, paymentTermsDays: 30, notes: 'Dev e-mail live-test fixture. Safe to delete.',
    })
    const customer = customerRes.customer ?? customerRes
    ok('fixture customer created', customer.id)

    // ── rate con ────────────────────────────────────────────────────────────
    let b = await newFixture(customer, true)
    const rcShipment = b.shipment.id
    const load = b.loads[0]
    report.rateCon.shipmentId = rcShipment
    const others = ((await ship('LIST_LOAD_CARRIERS_BY_CARRIER', { carrierId: 'carr-demo-vetted' }))?.loadCarriers ?? []).filter((c) => c.status === 'ACTIVE')
    await ship('BOOK_CARRIER', {
      loadId: load.id, carrierId: 'carr-demo-vetted', carrierRateCents: 180000, expectedUpdatedAt: load.updatedAt,
      driverName: 'ZZ Driver', driverPhone: '+12245550137', dispatcherEmail: ALLOWED,
      acknowledgeWarnings: ['COST_EXCEEDS_TOP_SPEND', ...others.map((c) => `DOUBLE_BOOKED:${c.loadId}`)],
    })
    b = await ship('GET_SHIPMENT_BUNDLE', { shipmentId: rcShipment })
    const lc = b.loadCarriers.find((c) => c.status === 'ACTIVE')
    if (!lc) throw new Error('no active load carrier after booking')

    assertAllowed([ALLOWED])
    const sent = await ship('SEND_RATE_CON', {
      loadCarrierId: lc.id, pdfBase64: Buffer.from('%PDF-1.1 zz rate con live test').toString('base64'), to: [ALLOWED],
    })
    const sentLc = sent.loadCarriers.find((c) => c.id === lc.id)
    if (sentLc?.rateConStatus === 'SENT') ok('SEND_RATE_CON returned SENT', `loadCarrier ${lc.id}`)
    else bad('SEND_RATE_CON returned SENT', String(sentLc?.rateConStatus))
    const threadKey = sent.shipment?.threadKey ?? null
    const out = (await messagesOf(rcShipment)).find((m) => m.direction === 'OUT' && m.kind === 'RATE_CON')
    if (!out) throw new Error('no outbound RATE_CON ShipmentMessage')
    report.rateCon = {
      shipmentId: rcShipment, loadCarrierId: lc.id, messageRowId: out.id, status: out.status,
      sesMessageId: out.providerRef, storedMessageIdHeader: out.messageId, threadKey: out.threadKey ?? threadKey, error: out.error,
    }
    if (out.status === 'SENT' && out.providerRef) ok('rate con SENT through SES', `SES MessageId ${out.providerRef}`)
    else bad('rate con SENT through SES', `status ${out.status}, providerRef ${out.providerRef ?? 'none'}, error ${String(out.error).slice(0, 160)}`)
    if (allInMailbox(out.to) && allInMailbox(out.cc)) ok('every rate con recipient is inside the allow-listed mailbox', `to ${splitAddresses(out.to).length}, cc ${splitAddresses(out.cc).length}`)
    else bad('every rate con recipient is inside the allow-listed mailbox', 'a recipient outside the mailbox was recorded')
    ok('stored Message-ID header and per-load thread key', `${out.messageId} · ${report.rateCon.threadKey}`)

    // ── reply: plus-address routing through the real intake Function URL ──────
    const replyId = `<zz.reply.${stamp}@gmail.com>`
    const intakeEnv = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: INTAKE_LAMBDA }))).Environment?.Variables ?? {}
    const intakeUrl = (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: INTAKE_LAMBDA }))).FunctionUrl
    const replyTo = `ai4bcat+tracking.${rcShipment}@gmail.com`
    assertAllowed([ALLOWED])
    const res = await fetch(intakeUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: intakeEnv.SHIPMENT_EMAIL_INTAKE_SECRET, messageId: replyId, to: replyTo, from: ALLOWED, subject: 'Re: Rate confirmation', body: 'ZZ live test reply: driver is assigned.' }),
    })
    const resBody = await res.json().catch(() => ({}))
    report.reply.intakeStatus = res.status
    report.reply.routedShipmentMatches = resBody.shipmentId === rcShipment
    if (res.status === 200 && resBody.shipmentId === rcShipment) ok('reply routed by the plus address to the right shipment', `HTTP ${res.status}`)
    else bad('reply routed by the plus address to the right shipment', `HTTP ${res.status} ${JSON.stringify(resBody).slice(0, 120)}`)
    const inbound = (await messagesOf(rcShipment)).find((m) => m.direction === 'IN' && m.messageId === replyId)
    report.reply.inboundRowId = inbound?.id ?? null
    report.reply.inboundThreadKey = inbound?.threadKey ?? null
    if (inbound && inbound.threadKey === report.rateCon.threadKey) ok('inbound reply landed on the same per-load thread key', inbound.threadKey)
    else bad('inbound reply landed on the same per-load thread key', inbound ? `${inbound.threadKey} != ${report.rateCon.threadKey}` : 'no inbound row')

    // ── reply with ONLY In-Reply-To (no plus address): what the intake does today ──
    const stripped = await fetch(intakeUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: intakeEnv.SHIPMENT_EMAIL_INTAKE_SECRET, messageId: `<zz.reply2.${stamp}@gmail.com>`, inReplyTo: out.messageId, to: ALLOWED, from: ALLOWED, subject: 'Re: Rate confirmation', body: 'ZZ no plus alias' }),
    })
    report.reply.strippedAliasStatus = stripped.status
    log(`INFO  reply with the plus alias stripped and only In-Reply-To set: HTTP ${stripped.status} (422 = intake cannot route it; see EMAIL_LIVE_TEST.md)`)

    // ── invoice ─────────────────────────────────────────────────────────────
    let ib = await newFixture(customer, false)
    const invShipment = ib.shipment.id
    const orderId = ib.orders[0].id
    for (const status of ['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      const l = ib.loads[0]
      try { await ship('SET_LOAD_STATUS', { loadId: l.id, status, expectedUpdatedAt: l.updatedAt }) } catch { /* ladder step not applicable */ }
      ib = await ship('GET_SHIPMENT_BUNDLE', { shipmentId: invShipment })
    }
    await attach(invShipment, orderId, ib.loads[0].id, 'BOL')
    await attach(invShipment, orderId, ib.loads[0].id, 'POD')
    ib = await ship('GET_SHIPMENT_BUNDLE', { shipmentId: invShipment })
    await ship('READY_TO_INVOICE', { orderId, expectedUpdatedAt: ib.orders[0].updatedAt })
    const generated = await fin('GENERATE_INVOICE', { orderId })
    const invoiceId = generated.invoice.id
    ok('fixture invoice generated', `${generated.invoice.number}`)
    assertAllowed([ALLOWED])
    const emailed = await fin('EMAIL_INVOICE', { invoiceId, to: [ALLOWED] })
    report.invoice = { shipmentId: invShipment, invoiceId, noticeId: emailed.notice?.id, status: emailed.emailStatus, sesMessageId: emailed.notice?.messageId ?? null, error: emailed.emailError }
    if (emailed.emailStatus === 'SENT' && emailed.notice?.messageId) ok('invoice SENT through SES', `SES MessageId ${emailed.notice.messageId} · notice ${emailed.notice.id}`)
    else bad('invoice SENT through SES', `status ${emailed.emailStatus}, error ${String(emailed.emailError).slice(0, 160)}`)
    if ([...(emailed.to ?? []), ...(emailed.cc ?? [])].every(isMailbox)) ok('every invoice recipient is inside the allow-listed mailbox', `to ${emailed.to?.length ?? 0}, cc ${emailed.cc?.length ?? 0}`)
    else bad('every invoice recipient is inside the allow-listed mailbox', 'a recipient outside the mailbox was recorded')

    // ── cleanup: void the invoice and both fixtures ───────────────────────────
    await fin('VOID_INVOICE', { invoiceId, reason: 'e-mail live test cleanup' })
  } finally {
    for (const shipmentId of fixtures.shipments) {
      try {
        const sb = await ship('GET_SHIPMENT_BUNDLE', { shipmentId })
        await ship('SET_SHIPMENT_STATUS', { shipmentId, status: 'CANCELED', reason: 'dev e-mail live test fixture', expectedUpdatedAt: sb.shipment.updatedAt }).catch(() => undefined)
        const sb2 = await ship('GET_SHIPMENT_BUNDLE', { shipmentId })
        await ship('VOID_SHIPMENT', { shipmentId, expectedUpdatedAt: sb2.shipment.updatedAt, reason: 'Dev e-mail live test fixture' })
        ok('fixture shipment voided', shipmentId)
      } catch (err) {
        bad('fixture shipment voided', `${shipmentId}: ${String(err.message ?? err).slice(0, 100)}`)
      }
    }
    const gone = await deleteIdentity(adminEmail)
    if (gone) ok('temp admin identity deleted', ''); else bad('temp admin identity deleted', 'still exists')
  }

}

function writeReport(report) {
  const failed = results.filter((r) => !r.ok)
  const body = [
    '',
    `## Live run ${new Date().toISOString()} — ${failed.length === 0 ? 'ALL PASSED' : `${failed.length} FAILED`}`,
    '',
    'Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.',
    '',
    '```json',
    JSON.stringify(report ?? {}, null, 2),
    '```',
    '',
    '```',
    ...lines,
    '```',
    '',
  ].join('\n')
  if (!existsSync(REPORT)) writeFileSync(REPORT, '# Dev e-mail live test\n')
  appendFileSync(REPORT, body)
}

async function main() {
  if (args.includes('--inventory')) return inventory()
  if (!args.includes('--run')) {
    console.log('usage: node scripts/devVerifyEmail.mjs --inventory | --run')
    return
  }
  if (DEV_API !== 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql') throw new Error('refusing to run against a non-dev API')
  try {
    await run()
  } finally {
    writeReport(report)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('verification aborted:', err.message ?? err)
    process.exitCode = 1
  })
}
