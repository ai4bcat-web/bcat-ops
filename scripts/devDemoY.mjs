#!/usr/bin/env node
/**
 * Step Y — the end-to-end demo shipment drive against the DEV site and the real imported dev data.
 *
 *   node scripts/devDemoY.mjs <stage> [...]    stages: reset, fixtures, tender, intake, carrier, tracking, delivered, billing, own, cleanup
 *
 * Dev only (devIdentity refuses any other pool / endpoint; the browser refuses any origin but dev). Every record it
 * creates is labelled ZZ DEMO and is never a real imported PRO. One temporary ADMIN identity (plus single-grant
 * personas where the step is a role's own work) is minted per run and deleted at the end. State lives in
 * /tmp/demoY-state.json so a stage can be re-run. Passwords and tokens are never printed.
 */
import { mkdir } from 'node:fs/promises'
import { LambdaClient, GetFunctionConfigurationCommand, GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchBrowser, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { withDemoAdmin, demoStaff, sleep, short } from './lib/demoY.mjs'
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { deliver, getRow, tenderBody, INTAKE_SELECTION, resolveIntakeSecret, doc, devTable, discoverDevSuffix } from './devVerifyU.mjs'

export const SHOTS = resolve('Docs/tms-build/screenshots/demo')
const stamp = () => Date.now()
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const say = (msg) => console.log(msg)

/** A headless browser signed in as `ident`, 1440×900. */
async function openBrowser(ident, { width = 1440, height = 900 } = {}) {
  const b = await launchBrowser({ origin: process.env.DEMO_ORIGIN ?? DEV_ORIGIN, storage: ident.storage, profilePrefix: 'bcat-demoy-', purpose: 'Step Y demo', viewport: { width, height, deviceScaleFactor: 1 } })
  return b
}
const waitSettled = async (b) => {
  await pause(1200)
  await b.poll(async () => b.evaluate(`!document.querySelector('.tms-main [aria-busy="true"], .tms-main .animate-pulse')`), 'page settled', 20_000).catch(() => {})
  await pause(600)
}
/** Scroll every scroller to the top, then save a content-height screenshot. */
async function snap(b, file) {
  await b.evaluate(`(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0 } })()`)
  await pause(400)
  await b.screenshot(`${SHOTS}/${file}.png`, { clipToContent: true })
  say(`  shot ${file}.png`)
}
/** Scroll the first element whose text matches `pattern` to the top of the viewport and save a viewport screenshot. */
async function snapAt(b, file, pattern) {
  const found = await b.evaluate(`(() => { const re = new RegExp(${JSON.stringify(pattern)}, 'i'); const el = [...document.querySelectorAll('h1,h2,h3,h4,legend,[class*="title"],strong')].find((n) => re.test(n.textContent.trim())); if (!el) return false; el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); return true })()`)
  if (!found) say(`  (no heading matching ${pattern} for ${file})`)
  await pause(700)
  await b.screenshot(`${SHOTS}/${file}.png`)
  say(`  shot ${file}.png (viewport at "${pattern}")`)
}
/** Navigate and save Docs/tms-build/screenshots/demo/<file>.png; returns the pathname actually shown. */
async function shot(b, path, file, { wait } = {}) {
  await b.navigate(path)
  await waitSettled(b)
  if (wait) await b.poll(wait, `content for ${file}`, 30_000).catch(() => say(`  (wait for ${file} timed out)`))
  await snap(b, file)
  return b.evaluate('location.pathname + location.search')
}
const mainText = (b) => b.evaluate(`(document.querySelector('.tms-main')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ')`)

export const STAGES = {}

// ───────────────────────────── reset ─────────────────────────────
STAGES.reset = async (ctx) => {
  const staff = await demoStaff(ctx)
  const t0 = Date.now()
  try { await ctx.ship('RESET_DEMO_DATA', { staff }) } catch (e) { say(`reset: ${short(e)} (the Lambda keeps running; polling)`) }
  for (let i = 0; i < 60; i++) {
    const st = await ctx.ship('GET_DEMO_STATE', {})
    const keys = (st.records ?? []).filter((r) => r.kind === 'SHIPMENT').map((r) => r.demoKey)
    say(`${Math.round((Date.now() - t0) / 1000)}s demo shipments ${keys.length}`)
    if (keys.includes('shipment.readytobill') && keys.includes('shipment.podflagged')) break
    await sleep(5000)
  }
}

// ───────────────────────────── fixtures ─────────────────────────────
STAGES.fixtures = async (ctx) => {
  const S = ctx.state
  if (S.divisionCode) { say(`fixtures exist: ${S.divisionCode}`); return }
  const ts = stamp()
  const profiles = (await ctx.gql('query { listUserProfiles(limit: 1000) { items { id status role } } }', {})).listUserProfiles.items
  const rep = profiles.find((p) => p.status === 'ACTIVE' && p.role === 'CUSTOMER_REP') ?? profiles.find((p) => p.status === 'ACTIVE')
  S.ts = ts
  S.repId = rep.id
  S.senderEmail = `ai4bcat+zzdemosender${ts}@gmail.com`
  S.intakeAddress = `zz-demo-tenders-${ts}@example.invalid`
  S.billToId = `zz-demo-bt-${ts}`
  const code = `ZZ_DEMO_${ts}`
  const division = await ctx.dir('SAVE_OWNERSHIP_DIVISION', { parentId: null, active: true, brand: null, sortOrder: 901, code, name: `ZZ DEMO Brokerage ${ts}`, intakeEmail: S.intakeAddress })
  S.divisionCode = code
  S.divisionId = String(division.id ?? code)
  S.divisionName = `ZZ DEMO Brokerage ${ts}`
  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ DEMO Customer ${ts}`, creditLimitCents: 100_000_000, paymentTermsDays: 30, mcNumber: `8${String(ts).slice(-6)}`,
    billingEmail: 'ai4bcat@gmail.com',
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ DEMO Shipper Contact', email: S.senderEmail, types: [] }],
    billToParties: [{ id: S.billToId, name: 'ZZ DEMO Bill To', isDefault: false }],
  })
  S.customerId = String((customer.customer ?? customer).id)
  S.customerName = `ZZ DEMO Customer ${ts}`
  say(`fixtures: division ${code}, customer ${S.customerId}, no default sales rep or default bill-to on the customer, so the tender arrives with both missing`)
}

// ───────────────────────────── tender ─────────────────────────────
STAGES.tender = async (ctx) => {
  const S = ctx.state
  if (S.intakeId) { say(`tender exists: ${S.intakeId}`); return }
  await resolveIntakeSecret()
  const ref = String(stamp()).slice(-10)
  const sent = await deliver({
    role: 'TENDER', messageId: `zzdemo-${S.ts}-${randomUUID()}`, receivedAt: new Date().toISOString(), fromName: 'ZZ DEMO Shipper Contact',
    subject: `Tender TMS ID ${ref}: Lubbock, TX to Shreveport, LA`, fromEmail: S.senderEmail, bodyText: tenderBody(ref).replace('Dallas TX', 'Lubbock TX').replace('Atlanta GA', 'Shreveport LA').replace('ZZ U Sender', 'ZZ DEMO Shipper Contact'), toAddresses: [S.intakeAddress],
  })
  S.tenderRunId = sent.runId
  S.tenderPrefix = sent.prefix
  S.intakeId = `il:${sent.runId}`
  for (let i = 0; i < 40; i++) {
    const row = await getRow(ctx.token, 'IntakeLoad', S.intakeId, INTAKE_SELECTION)
    if (row) { say(`intake row ${row.id} status ${row.status} division ${row.divisionCode} missing ${JSON.stringify(row.missingFields)}`); return }
    await sleep(3000)
  }
  throw new Error('the tender never became an intake row')
}

// ───────────────────────────── intake: review, then move ─────────────────────────────
const INTAKE_KEYS = [
  'customerId', 'customerName', 'billToId', 'salesRepId', 'divisionCode', 'reference', 'pickupNumber', 'deliveryNumber',
  'equipmentType', 'commodity', 'weightLb', 'customerRateCents',
  ...[0, 1].flatMap((i) => ['name', 'street', 'city', 'state', 'zip', 'date', 'time', 'instructions'].map((k) => `stops.${i}.${k}`)),
]
const versionOf = (row) => Number(row.version ?? 1)
const completeFields = (S) => {
  const day = chicagoToday()
  return {
    customerId: S.customerId, customerName: S.customerName, billToId: S.billToId, salesRepId: S.repId, divisionCode: S.divisionCode,
    reference: `ZZDEMO-${String(S.ts).slice(-6)}`, pickupNumber: 'ZZ-P1', deliveryNumber: 'ZZ-D1',
    equipmentType: 'Dry Van', commodity: 'ZZ DEMO paper goods', weightLb: 38000, customerRateCents: 250000,
    stops: [
      { type: 'pickup', name: 'ZZ DEMO Shipper', street: '1 Demo Way', city: 'Lubbock', state: 'TX', zip: '79401', date: addDays(day, 1), time: '08:00', instructions: 'ZZ DEMO' },
      { type: 'delivery', name: 'ZZ DEMO Receiver', street: '2 Demo Way', city: 'Shreveport', state: 'LA', zip: '71101', date: addDays(day, 3), time: '14:00', instructions: 'ZZ DEMO' },
    ],
  }
}
const refusal = async (fn) => { try { await fn() } catch (e) { return short(e) } return null }
const buttonState = (b, pattern) => b.evaluate(`(() => { const el = [...document.querySelectorAll('.tms-main button')].find((n) => new RegExp(${JSON.stringify(pattern)}, 'i').test(n.textContent.trim())); return el ? (el.disabled ? 'disabled' : 'enabled') : 'absent' })()`)

STAGES.intake = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  const intakeUrl = `/tms/shipments/intake/${encodeURIComponent(S.intakeId)}`
  let row = await getRow(ctx.token, 'IntakeLoad', S.intakeId, INTAKE_SELECTION)
  if (row.status === 'MOVED') { S.shipmentId = row.shipmentId; S.shipmentNumber = row.shipmentNumber; S.log.createdStatus = (await bundleOf(ctx)).shipment.status; say(`already created: ${S.shipmentNumber}`); return }
  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, `/tms/shipments/intake?division=${encodeURIComponent(S.divisionCode)}`, '01-intake-tab-new-tender', { wait: () => b.evaluate(`document.body.innerText.includes('Tender TMS ID')`) })
    await shot(b, intakeUrl, '02-intake-review-fields-missing', { wait: () => b.evaluate(`document.body.innerText.includes('Customer & billing')`) })
    S.log.moveWhileMissing = await buttonState(b, '^Move to active$')
    // Create shipment (prefilled from the e-mail) with required fields missing: the form names every blocker
    await b.navigate(`/tms/shipments/new?intake=${encodeURIComponent(S.intakeId)}`); await waitSettled(b); await pause(4000)
    await b.click({ selector: '[data-testid="ship-form-create"]' }); await pause(2500)
    S.log.formIssues = await b.evaluate(`[...document.querySelectorAll('[data-testid^="issue-link"]')].map((e) => e.textContent.trim())`)
    say(`  create with fields missing is blocked: ${JSON.stringify(S.log.formIssues)}`)
    await snap(b, '03-create-form-prefilled-blocked')
  } finally { await b.close() }
  // the missing fields are filled (what the Save on the review page sends), so the prefill is whole
  await ctx.ship('INTAKE_SAVE_DRAFT', { intakeId: row.id, expectedVersion: versionOf(row), fields: completeFields(S), confirm: { add: INTAKE_KEYS, remove: [] } })
  const b2 = await openBrowser(ctx.id)
  try {
    await b2.navigate('/tms/dashboard'); await pause(3500)
    await b2.navigate(`/tms/shipments/new?intake=${encodeURIComponent(S.intakeId)}`); await waitSettled(b2); await pause(4000)
    await snap(b2, '04-create-form-prefilled-complete')
    await b2.click({ selector: '[data-testid="ship-form-create"]' })
    await b2.poll(async () => /\/tms\/shipments\/shp-/.test(await b2.evaluate('location.pathname')), 'navigate to the new shipment', 60_000).catch(async () => {
      S.log.formIssuesAfter = await b2.evaluate(`[...document.querySelectorAll('[data-testid^="issue-link"]')].map((e) => e.textContent.trim())`)
      await snap(b2, '_form-still-blocked'); throw new Error(`form did not create: ${JSON.stringify(S.log.formIssuesAfter)}`)
    })
    await waitSettled(b2)
    S.shipmentId = (await b2.evaluate('location.pathname')).match(/shipments\/(shp-[^/]+)/)[1]
    await snap(b2, '05-shipment-created-from-form')
  } finally { await b2.close() }
  const bundle = await bundleOf(ctx)
  S.shipmentNumber = bundle.shipment.number
  S.log.createdStatus = bundle.shipment.status
  row = await getRow(ctx.token, 'IntakeLoad', S.intakeId, INTAKE_SELECTION)
  S.log.intakeAfter = { status: row.status, shipmentNumber: row.shipmentNumber }
  say(`  shipment ${S.shipmentNumber} created from the form, status ${bundle.shipment.status}; intake row ${row.status}; PO codes ${JSON.stringify((bundle.orders[0].references ?? []).map((r) => r.code))}`)
}


/** The seeded in-transit demo shipment: the Tracking drawer is shot on it while job 171's drawer cannot render a thread with an inbound reply (messageAttachments fix pending deploy). */
async function seedTrackId(ctx) {
  if (ctx.state.seedTrackId) return ctx.state.seedTrackId
  const st = await ctx.ship('GET_DEMO_STATE', {})
  ctx.state.seedTrackId = (st.records ?? []).find((r) => r.kind === 'SHIPMENT' && r.demoKey === 'shipment.intransit')?.recordId
  return ctx.state.seedTrackId
}

const INTAKE_LAMBDA = 'amplify-d3dejqzs77khq6-de-shipmentemailintakelambd-YsxNLkk5biqY'
async function messagesOf(ctx, shipmentId) {
  const rows = []; let next = null
  do {
    const r = await ctx.gql('query($s: String!, $n: String) { listShipmentMessageByShipmentIdAndAt(shipmentId: $s, limit: 200, nextToken: $n) { items { id messageId providerRef inReplyTo direction channel kind status error to cc } nextToken } }', { s: shipmentId, n: next })
    rows.push(...r.listShipmentMessageByShipmentIdAndAt.items); next = r.listShipmentMessageByShipmentIdAndAt.nextToken
  } while (next)
  return rows
}
/** A carrier's reply routed by the thread's plus-address through the real intake Function URL (secret read from SSM, never printed). */
async function postThreadReply(shipmentId, text) {
  const lambda = new LambdaClient({ region: 'us-east-1' })
  const env = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: INTAKE_LAMBDA }))).Environment?.Variables ?? {}
  const cfg = JSON.parse(env.AMPLIFY_SSM_ENV_CONFIG ?? '{}').SHIPMENT_EMAIL_INTAKE_SECRET ?? {}
  const ssm = new SSMClient({ region: 'us-east-1' })
  let secret
  for (const name of [cfg.path, cfg.sharedPath].filter(Boolean)) { try { secret = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value; if (secret) break } catch { /* next */ } }
  if (!secret) throw new Error('intake secret unreadable')
  const url = (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: INTAKE_LAMBDA }))).FunctionUrl
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, messageId: `<zz.demo.reply.${Date.now()}@gmail.com>`, to: `ai4bcat+tracking.${shipmentId}@gmail.com`, from: 'ai4bcat@gmail.com', subject: 'Re: Rate confirmation', body: text }) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// ───────────────────────────── carrier: packet (MCP), cover, rate con ─────────────────────────────
const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const shipUrl = (S, tab) => `/tms/shipments/${encodeURIComponent(S.shipmentId)}${tab ? `?tab=${tab}` : ''}`
const bundleOf = (ctx) => ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: ctx.state.shipmentId })
const activeLeg = (b) => (b.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')

/** Type into the first input matching `selector` (real key events are not needed: insertText fires `input`). */
async function typeInto(b, selector, text) {
  const ok = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true })()`)
  if (!ok) throw new Error(`no input for ${selector}`)
  await b.command('Input.insertText', { text })
  await pause(300)
}

STAGES.carrier = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const carrierMail = 'ai4bcat@gmail.com'
  if (!S.carrierId) {
    const n = String(S.ts).slice(-6)
    const carrier = await ctx.car('UPSERT_CARRIER', {
      name: `ZZ DEMO Carrier ${n}`, type: 'TL', status: 'ACTIVE', mcNumber: `9${n}`, dotNumber: `9${n}`,
      mcpStatus: 'NOT_INVITED', accountingEmail: 'ai4bcat@gmail.com', dispatcherEmail: 'ai4bcat@gmail.com',
      insurancePolicies: [
        { type: 'AUTO_LIABILITY', company: 'ZZ DEMO Mutual', policyNumber: `ZZAL-${S.ts}`, limitCents: 100000000, expiresAt: nextYear },
        { type: 'CARGO', company: 'ZZ DEMO Mutual', policyNumber: `ZZCG-${S.ts}`, limitCents: 10000000, expiresAt: nextYear },
      ],
      notes: 'ZZ DEMO — Step Y demonstration carrier. Not a real carrier; safe to archive.',
    }).then((r) => r.carrier ?? r)
    S.carrierId = carrier.id; S.carrierName = carrier.name
    await ctx.car('UPSERT_PAYMENT_METHOD', { carrierId: carrier.id, method: 'ACH', recipientType: 'CARRIER', isPreferred: true, accountName: carrier.name, payeeEmail: 'ai4bcat@gmail.com' }).catch((e) => say(`  (payment method: ${short(e)})`))
    say(`  carrier ${carrier.name} (${carrier.id}), MCP status NOT_INVITED`)
  }

  // the tender arrives TENDER_PENDING: accepting it is undertaking to bill it, and the owner of the cover is whoever accepts
  let bundle = await bundleOf(ctx)
  if (bundle.shipment.status === 'DRAFT') {
    await ctx.ship('SUBMIT_ORDER', { shipmentId: S.shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
    bundle = await bundleOf(ctx)
    say(`  order submitted -> ${bundle.shipment.status}`)
  }
  if (bundle.shipment.status === 'TENDER_PENDING') {
    bundle = await ctx.ship('TENDER_RESPOND', { shipmentId: S.shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt, decision: 'ACCEPT' })
    say(`  tender accepted -> ${bundle.shipment.status}`)
  }
  // the intake move writes the PO under the code 'po'; the release gate asks for 'PO' (defect, fix pending deploy): re-key it so the demo can reach release
  const refs = bundle.orders[0].references ?? []
  if (refs.some((r) => r.code === 'po') && !refs.some((r) => r.code === 'PO')) {
    // Data patch on this run's own ZZ order only: the order form is closed once an order is submitted, and nothing else rewrites a reference.
    const suffix = await discoverDevSuffix()
    const table = devTable('Order', suffix)
    const orderId = bundle.orders[0].id
    const row = (await doc.send(new GetCommand({ TableName: table, Key: { id: orderId } }))).Item
    if (String(row.shipmentId) !== S.shipmentId) throw new Error('refusing to patch an order that is not this run\'s ZZ shipment')
    const next = refs.map((r) => (r.code === 'po' ? { ...r, code: 'PO', label: 'Purchase order' } : r))
    await doc.send(new UpdateCommand({ TableName: table, Key: { id: orderId }, UpdateExpression: 'SET #r = :r', ExpressionAttributeNames: { '#r': 'references' }, ExpressionAttributeValues: { ':r': typeof row.references === 'string' ? JSON.stringify(next) : next } }))
    S.log.poWorkaround = true
    say('  PO reference re-keyed po -> PO on the ZZ order (data patch; the intake fix is pending deploy)')
    bundle = await bundleOf(ctx)
  }

  // MCP: Validate first — LIVE only if it passes
  const validated = await ctx.dir('VALIDATE_INTEGRATION', { provider: 'MYCARRIERPACKETS' })
  S.log.mcpValidate = { status: validated.status, mode: validated.mode, health: validated.health, reason: validated.healthReason }
  say(`  MCP Validate: ${JSON.stringify(S.log.mcpValidate)}`)

  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, shipUrl(S), '05-shipment-accepted-need-to-cover', { wait: waitText(b, S.shipmentNumber) })
    await shot(b, `/tms/carriers/${encodeURIComponent(S.carrierId)}`, '06-carrier-profile-mcp-not-invited', { wait: waitText(b, 'ZZ DEMO Carrier') })
    await shot(b, '/tms/brokerage/integrations/MYCARRIERPACKETS', '07-mcp-integration-validated', { wait: () => b.evaluate(`document.body.innerText.length > 400`) })

    // Find & Invite: a READ-ONLY MyCarrierPackets lookup of MC 274623. No invitation is ever sent by this script.
    await b.navigate('/tms/carriers/find'); await waitSettled(b); await pause(1500)
    await b.evaluate(`document.querySelector('.tms-main input').focus()`)
    await b.command('Input.insertText', { text: '274623' }); await pause(300)
    await b.click({ selector: 'button', text: 'Look up' })
    await b.poll(() => b.evaluate(`/Risk assessment/.test(document.body.innerText)`), 'MCP lookup result', 60_000).catch(() => say('  (lookup result did not render)'))
    S.log.findLookup = (await b.evaluate(`(document.querySelector('.tms-main').innerText.match(/[A-Z ]+\\n?MC 274623[^\\n]*/) ?? [null])[0]`))
    await snap(b, '08a-find-and-invite-lookup-read-only')
    S.packet = { sent: false, note: 'no invitation sent (read-only lookup only)' }

    // Carrier Sales: the load is waiting for cover (search narrows the 49-row queue to ours)
    await b.navigate('/tms/carrier-sales'); await waitSettled(b)
    await b.poll(() => b.evaluate(`!!document.querySelector('input[placeholder^="Search shipment"]')`), 'search box', 30_000)
    await typeInto(b, 'input[placeholder^="Search shipment"]', S.shipmentNumber)
    await b.poll(waitText(b, S.shipmentNumber), 'our load in Needs cover', 60_000).catch(() => say('  (our load did not show in Needs cover)'))
    await snap(b, '08-carrier-sales-needs-cover')
    for (const [tab, file] of [['Offers', '08c-carrier-sales-offers-hub'], ['Unmatched', '08d-carrier-sales-unmatched']]) {
      await b.click({ selector: '[role=tab]', pattern: `^${tab}` }).catch(() => {}); await pause(2500); await snap(b, file)
    }

    // Cover dialog (read-only lookup of the same MC; nothing is assigned from it)
    await b.navigate(shipUrl(S, 'carrier')); await waitSettled(b); await pause(2000)
    await b.click({ selector: 'button', text: 'Cover' }); await pause(1200)
    await b.evaluate(`document.querySelector('[role=dialog] input').focus()`)
    await b.command('Input.insertText', { text: '274623' }); await pause(300)
    await b.click({ selector: '[role=dialog] button', text: 'Look up' }); await pause(8000)
    await snap(b, '08b-cover-dialog-lookup')
    S.log.coverDialog = (await b.evaluate(`([...document.querySelectorAll('[role=dialog]')].pop()?.innerText ?? '').replace(/\\s+/g,' ').slice(0,300)`))
    await b.press('Escape'); await pause(500)
    // cover: the ZZ carrier (not in MCP) is assigned through the same action the dialog calls
    const load = bundle.loads[0]
    if (!activeLeg(bundle)) {
      await ctx.ship('BOOK_CARRIER', {
        loadId: load.id, expectedUpdatedAt: load.updatedAt, carrierId: S.carrierId, carrierRateCents: 180000,
        driverName: 'ZZ DEMO Driver', driverPhone: '+15555550123', dispatcherEmail: 'ai4bcat@gmail.com', truckNumber: 'ZZ-T1', trailerNumber: 'ZZ-TR1',
        acknowledgeWarnings: ['MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT', 'INSURANCE_UNVERIFIED'],
      })
      bundle = await bundleOf(ctx)
    }
    const leg = activeLeg(bundle)
    S.legId = leg.id; S.loadId = load.id
    say(`  covered: leg ${leg.id} ${leg.carrierName} rate ${leg.carrierRateCents}; shipment ${bundle.shipment.status}`)
    const rateConPdf = textPdf(['RATE CONFIRMATION', `Load ${S.shipmentNumber}`, 'Carrier: ZZ DEMO Carrier', 'Pickup: ZZ DEMO Shipper, Lubbock TX', 'Delivery: ZZ DEMO Receiver, Shreveport LA', 'Carrier rate: $1,800.00 all-in', 'ZZ DEMO - not a real rate confirmation'])
    S.log.rateConBeforePacket = await refusal(() => ctx.ship('SEND_RATE_CON', { loadCarrierId: leg.id, pdfBase64: rateConPdf.toString('base64'), to: [carrierMail] }))
    say(`  rate con before the packet is complete: ${S.log.rateConBeforePacket}`)
    await shot(b, shipUrl(S, 'carrier'), '09-shipment-carrier-covered', { wait: waitText(b, 'ZZ DEMO Carrier') })

    // MCP reports the packet complete: the nightly MCP sync writes this status. It is stood in here because a ZZ carrier on a made-up DOT cannot fill in a packet.
    const cur = (await ctx.gql(`query { getCarrier(id: ${JSON.stringify(S.carrierId)}) { id updatedAt mcpStatus } }`)).getCarrier
    if (cur.mcpStatus !== 'ACCEPTABLE') await ctx.car('UPSERT_CARRIER', { id: S.carrierId, expectedUpdatedAt: cur.updatedAt, name: S.carrierName, type: 'TL', status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', mcNumber: `9${String(S.ts).slice(-6)}`, dotNumber: `9${String(S.ts).slice(-6)}`, accountingEmail: 'ai4bcat@gmail.com', dispatcherEmail: 'ai4bcat@gmail.com', insurancePolicies: [{ type: 'AUTO_LIABILITY', company: 'ZZ DEMO Mutual', policyNumber: `ZZAL-${S.ts}`, limitCents: 100000000, expiresAt: new Date(Date.now() + 365 * 864e5).toISOString() }, { type: 'CARGO', company: 'ZZ DEMO Mutual', policyNumber: `ZZCG-${S.ts}`, limitCents: 10000000, expiresAt: new Date(Date.now() + 365 * 864e5).toISOString() }] })
    await shot(b, `/tms/carriers/${encodeURIComponent(S.carrierId)}`, '10-carrier-profile-mcp-packet-complete', { wait: waitText(b, 'ZZ DEMO Carrier') })

    // rate con
    const sent = await ctx.ship('SEND_RATE_CON', { loadCarrierId: leg.id, pdfBase64: rateConPdf.toString('base64'), to: [carrierMail] })
    const after = activeLeg(sent) ?? activeLeg(await bundleOf(ctx))
    S.log.rateCon = { status: after.rateConStatus, version: after.rateConVersion }
    S.rateConToken = after.rateConToken
    say(`  rate con: ${JSON.stringify(S.log.rateCon)}`)
    await shot(b, shipUrl(S, 'carrier'), '11-rate-con-sent', { wait: () => b.evaluate(`/Rate confirmation/i.test(document.body.innerText)`) })
  } finally { await b.close() }

  // the carrier signs at the link in the e-mail: a public page, no login
  if (S.rateConToken && S.log.rateCon.status !== 'SIGNED') {
    const pub = await launchBrowser({ origin: DEV_ORIGIN, profilePrefix: 'bcat-demoy-pub-', purpose: 'Step Y demo (carrier signing)', viewport: { width: 1100, height: 900, deviceScaleFactor: 1 } })
    try {
      await pub.navigate(`/sign/rate-con/${S.rateConToken}`); await waitSettled(pub)
      await pub.poll(() => pub.evaluate(`/sign rate confirmation/i.test(document.body.innerText)`), 'sign page', 60_000)
      await snap(pub, '12-carrier-signs-rate-con-link')
      for (const input of await pub.evaluate(`[...document.querySelectorAll('input[id^="rate-con-"]:not(#rate-con-signer)')].map((e) => e.id)`)) await typeInto(pub, `#${input}`, /phone/i.test(input) ? '+15555550123' : /truck/i.test(input) ? 'ZZ-T1' : 'ZZ DEMO Driver')
      await typeInto(pub, '#rate-con-signer', 'ZZ DEMO Carrier Dispatcher')
      await pub.evaluate(`document.querySelector('.tms-public-agree input[type=checkbox]').click()`)
      await pause(400)
      await pub.click({ selector: 'button', pattern: 'Sign rate confirmation' })
      await pub.poll(() => pub.evaluate(`/signed|thank you/i.test(document.body.innerText)`), 'signed confirmation', 60_000)
      await snap(pub, '13-rate-con-signed-confirmation')
    } finally { await pub.close() }
    const signed = activeLeg(await bundleOf(ctx))
    S.log.rateCon = { status: signed.rateConStatus, version: signed.rateConVersion }
    say(`  after the carrier signed: rate con ${signed.rateConStatus}`)
  }
  // the e-mail evidence and the carrier's reply on the per-load thread
  const out = (await messagesOf(ctx, S.shipmentId)).find((m) => m.direction === 'OUT' && m.kind === 'RATE_CON')
  S.log.rateConEmail = out ? { status: out.status, ses: Boolean(out.providerRef), toAll: String(out.to).split(/[,;]/).every((x) => /^ai4bcat(\+[^@]*)?@gmail\.com$/.test(x.trim())) } : null
  say(`  rate con e-mail row: ${JSON.stringify(S.log.rateConEmail)}`)
  if (!S.replyPosted) {
    const r = await postThreadReply(S.shipmentId, 'ZZ DEMO reply: driver is assigned and on the way.')
    S.replyPosted = r.status === 200 && r.body.shipmentId === S.shipmentId
    S.log.reply = { status: r.status, routed: S.replyPosted }
    say(`  carrier reply routed to the thread: ${JSON.stringify(S.log.reply)}`)
  }
  const b3 = await openBrowser(ctx.id)
  try {
    await b3.navigate('/tms/dashboard'); await pause(3500)
    await shot(b3, shipUrl(S, 'carrier'), '13a-carrier-assignment-ladder-signed', { wait: waitText(b3, 'ZZ DEMO Carrier') })
    await shot(b3, `/tms/tracking?shipment=${encodeURIComponent(await seedTrackId(ctx))}`, '13b-load-tracking-drawer-sms-email-panes', { wait: () => b3.evaluate(`document.body.innerText.length > 800`) })
  } finally { await b3.close() }
}

// ───────────────────────────── tracking, dispatch, delivery, POD ─────────────────────────────
/** A valid one-page text PDF (real xref offsets) so the POD reviewer has something legible to read. */
function textPdf(lines) {
  const esc = (t) => t.replace(/[\\()]/g, '\\$&')
  const content = ['BT', '/F1 14 Tf', '50 740 Td', '18 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n')
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}
async function uploadDoc(ctx, S, type, name, pdf, loadCarrierId = null) {
  const prepared = await ctx.ship('PREPARE_DOCUMENT_UPLOAD', { shipmentId: S.shipmentId, type, name, contentType: 'application/pdf', sizeBytes: pdf.length })
  const put = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf })
  if (!put.ok) throw new Error(`document upload answered ${put.status}`)
  const b = await bundleOf(ctx)
  return ctx.ship('COMMIT_DOCUMENT', { shipmentId: S.shipmentId, documentId: prepared.documentId, s3Key: prepared.s3Key, type, name, contentType: 'application/pdf', sizeBytes: pdf.length, loadId: b.loads[0].id, ...(loadCarrierId ? { loadCarrierId } : {}) })
}
const waitText = (b, text) => () => b.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)

STAGES.tracking = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  const profiles = (await ctx.gql('query { listUserProfiles(limit: 1000) { items { id name role status } } }')).listUserProfiles.items.filter((p) => p.status === 'ACTIVE')
  const tracker = profiles.find((p) => p.role === 'CUSTOMER_REP') ?? profiles[0]
  S.trackerId = tracker.id
  await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [S.shipmentId], trackerId: tracker.id })
  say(`  tracker assigned (a real active profile): ${tracker.role}`)
  let bundle = await bundleOf(ctx)
  const load = bundle.loads[0]
  // this load's own check-call plan: every 2 hours, SMS + e-mail, escalate after 20 minutes of silence
  await ctx.trk('SAVE_CHECK_CALL_PLAN', {
    loadId: load.id, expectedUpdatedAt: load.updatedAt,
    plan: { channels: ['SMS', 'EMAIL'], intervalHours: 2, escalateAfterMinutes: 20, emailDispatcher: true, milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'] },
  })
  say('  per-load check-call plan saved: every 2 h, escalate after 20 min')
  bundle = await bundleOf(ctx)
  if (bundle.loads[0].status === 'BOOKED') {
    await ctx.ship('DISPATCH_LOAD', { loadId: load.id, dispatchedAt: new Date().toISOString(), pickupEtaAt: new Date(Date.now() + 3600e3).toISOString(), note: 'ZZ DEMO dispatch' })
    say('  dispatched')
  }
  const run = await ctx.trk('RUN_CHECK_CALL_PLAN', { shipmentId: S.shipmentId }).catch((e) => ({ error: short(e) }))
  S.log.checkCallRun = run.error ?? { checked: run.checked, acted: run.acted, escalated: run.escalated, skipped: run.skipped, reasons: (run.reasons ?? []).slice(0, 3) }
  say(`  Run check call now: ${JSON.stringify(S.log.checkCallRun)}`)

  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, `/tms/tracking?assignee=${encodeURIComponent(S.trackerId)}`, '14-tracking-board-by-assignee', { wait: waitText(b, S.shipmentNumber) })
    await shot(b, `/tms/tracking?shipment=${encodeURIComponent(await seedTrackId(ctx))}`, '15-load-tracking-drawer-summary-map', { wait: () => b.evaluate(`document.body.innerText.length > 800`) })
    await b.navigate('/tms/brokerage'); await waitSettled(b)
    await b.poll(waitText(b, 'Tracking automation'), 'the tracking automation card', 60_000).catch(() => say('  (tracking automation card not found)'))
    await snapAt(b, '16-settings-tracking-automation', 'Tracking automation')
    await snapAt(b, '16b-settings-documents-pod-request', '^Documents')
    await shot(b, '/tms/tracking?assignee=all&focus=checkcalls', '17-check-calls-focus', { wait: waitText(b, 'Tracking') })
  } finally { await b.close() }
}

STAGES.delivered = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  let bundle = await bundleOf(ctx)
  let load = bundle.loads[0]
  const stops = JSON.parse(typeof load.stops === 'string' ? load.stops : JSON.stringify(load.stops))
  const pickup = stops.find((x) => x.type === 'pickup'); const drop = stops.find((x) => x.type === 'delivery')
  const log = async (type, extra) => {
    load = (await bundleOf(ctx)).loads[0]
    await ctx.ship('LOG_CHECK_CALL', { loadId: load.id, expectedUpdatedAt: load.updatedAt, type, at: new Date().toISOString(), source: 'MANUAL', ...extra })
  }
  if (!['DELIVERED'].includes(load.status)) {
    await log('ARRIVED', { stopId: pickup.id, note: 'ZZ DEMO arrived at pickup' })
    await log('DEPARTED', { stopId: pickup.id, note: 'ZZ DEMO loaded and departed' })
    await log('LOCATION_UPDATE', { city: 'Dallas', state: 'TX', note: 'ZZ DEMO on schedule, in Dallas' })
    await log('ARRIVED', { stopId: drop.id, note: 'ZZ DEMO arrived at delivery' })
    await log('DEPARTED', { stopId: drop.id, note: 'ZZ DEMO unloaded' })
    bundle = await bundleOf(ctx)
    say(`  after the check calls: load ${bundle.loads[0].status}, shipment ${bundle.shipment.status}`)
    if (bundle.loads[0].status !== 'DELIVERED') {
      for (const status of ['IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
        const l = (await bundleOf(ctx)).loads[0]
        if (l.status === 'DELIVERED') break
        await ctx.ship('SET_LOAD_STATUS', { loadId: l.id, status, expectedUpdatedAt: l.updatedAt }).catch((e) => say(`  (${status}: ${short(e)})`))
      }
      bundle = await bundleOf(ctx)
      say(`  load ${bundle.loads[0].status}, shipment ${bundle.shipment.status}`)
    }
  }
  let asked = { error: 'not attempted' }
  for (let i = 0; i < 4 && asked.error; i++) {
    asked = await ctx.trk('REQUEST_POD', { shipmentId: S.shipmentId }).catch((e) => ({ error: short(e) }))
    if (asked.error) await sleep(4000)
  }
  S.log.podRequest = asked.error ?? { requested: asked.requested ?? asked.messages?.length ?? 0 }
  say(`  POD requested: ${JSON.stringify(S.log.podRequest)}`)

  if (!S.podDocId) {
    await uploadDoc(ctx, S, 'BOL', 'zz-demo-bol.pdf', textPdf(['BILL OF LADING', `Shipment ${S.shipmentNumber}`, 'Shipper: ZZ DEMO Shipper, Lubbock TX', 'Consignee: ZZ DEMO Receiver, Shreveport LA', 'Commodity: ZZ DEMO paper goods, 38000 lb', 'Shipper signature: ZZ DEMO Shipper Contact', 'Page 1 of 1']), S.legId)
    const d = await uploadDoc(ctx, S, 'POD', 'zz-demo-pod.pdf', textPdf(['PROOF OF DELIVERY', `Shipment ${S.shipmentNumber}`, 'Delivered to: ZZ DEMO Receiver, Shreveport LA', `Delivery date: ${chicagoToday()}`, 'Received in good order, no damage, no shortage.', 'Receiver signature: ZZ DEMO Receiver Clerk', `Signed ${chicagoToday()}`, 'Page 1 of 1']), S.legId)
    bundle = await bundleOf(ctx)
    const pod = (bundle.documents ?? []).filter((x) => x.type === 'POD' && x.status !== 'VOID').sort((a, c) => String(c.createdAt).localeCompare(String(a.createdAt)))[0]
    S.podDocId = pod.id
    say(`  BOL + POD uploaded (POD document ${pod.id}, status ${pod.status})`)
  }
  const review = await ctx.trk('REVIEW_SHIPMENT_POD', { shipmentId: S.shipmentId, documentId: S.podDocId }).catch((e) => ({ error: short(e) }))
  S.log.podReview = review.error ?? { pass: review.pass, reason: review.reason, status: review.status ?? review.document?.status }
  say(`  POD review by the app: ${JSON.stringify(S.log.podReview)}`)

  bundle = await bundleOf(ctx)
  const order = bundle.orders[0]
  say(`  order ${order.arStatus} readyToInvoiceAt ${order.readyToInvoiceAt ?? 'null'}`)
  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, `/tms/tracking?assignee=all`, '18-load-tracking-board-all', { wait: waitText(b, S.shipmentNumber) })
    await shot(b, shipUrl(S, 'documents'), '19-shipment-documents-pod', { wait: waitText(b, 'POD') })
    await shot(b, '/tms/tracking?assignee=all&focus=docs', '20-document-review-workstation', { wait: waitText(b, 'Document') })
  } finally { await b.close() }
}

// ───────────────────────────── billing: carrier bill, release, invoice, factoring ─────────────────────────────
async function openDrawerFor(b, S, tabName) {
  await b.navigate(`/tms/load-review?shipment=${encodeURIComponent(S.shipmentId)}`); await waitSettled(b)
  await b.poll(() => b.evaluate(`!!document.querySelector('[role="dialog"], [data-state="open"][class*="drawer"], aside[class*="drawer"]') || document.body.innerText.includes(${JSON.stringify(S.shipmentNumber)})`), 'drawer', 40_000).catch(() => {})
  await pause(1500)
}
const drawerText = (b) => b.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].pop(); return (d ? d.innerText : '').replace(/\\s+/g, ' ') })()`)

STAGES.billing = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  const lr = await ctx.mint('lr', ['page-loadReview'])
  let bundle = await bundleOf(ctx)
  const order = bundle.orders[0]
  const leg = activeLeg(bundle)
  say(`  shipment ${bundle.shipment.status}, load ${bundle.loads[0].status}, order ${order.arStatus}`)

  // 0. Push to Load Review from the Shipments board (the Demo chip isolates the ZZ rows)
  if (!S.pushed) {
    const bp = await openBrowser(ctx.id)
    try {
      await bp.navigate('/tms/dashboard'); await pause(3500)
      await bp.navigate('/tms/shipments?demo=1'); await waitSettled(bp)
      await bp.poll(waitText(bp, S.shipmentNumber), 'our delivered row on the board', 60_000).catch(() => say('  (row not on the board)'))
      await pause(1500)
      await bp.evaluate(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(S.shipmentNumber)})); row?.querySelector('input[type=checkbox]')?.click() })()`)
      await pause(800)
      await snap(bp, '21a-shipments-board-row-selected-demo-chip')
      await bp.click({ selector: 'button', pattern: 'Push to Load Review' }).catch((e) => say(`  (push button: ${short(e)})`))
      await pause(5000)
      S.log.pushText = await bp.evaluate(`(document.body.innerText.match(/[^\\n]*(Load Review|refused|pushed)[^\\n]*/gi) ?? []).slice(0, 4)`)
      await snap(bp, '21b-pushed-to-load-review-outcome')
      S.pushed = true
    } finally { await bp.close() }
    say(`  push outcome: ${JSON.stringify(S.log.pushText)}`)
  }
  // 1. Load Review says what is still wrong
  let review = await lr.ship('REVIEW_LOAD', { shipmentId: S.shipmentId })
  S.log.reviewBefore = review.releaseGate.missing.map((m) => m.message)
  say(`  Load Review before the carrier bill: ${JSON.stringify(S.log.reviewBefore)}`)
  const rb = await openBrowser(lr)
  try {
    await rb.navigate('/tms/load-review'); await pause(3500)
    await openDrawerFor(rb, S)
    await snap(rb, '21-load-review-blocked')
    S.log.drawerBlocked = (await drawerText(rb)).slice(0, 400)
  } finally { await rb.close() }

  // 2. the carrier bill: recorded first, because the release gate refuses "Carrier charges not settled"
  if (!S.billId) {
    const today = chicagoToday()
    const rec = await ctx.fin('RECORD_BILL', { loadCarrierId: leg.id, billNumber: `ZZ-DEMO-${String(S.ts).slice(-6)}`, billDate: today, billedCents: 180000 })
    S.billId = rec.bill.id
    say(`  carrier bill ${rec.bill.billNumber} ${rec.bill.status} gross ${rec.bill.grossCents}`)
  }

  // 3. release: the Load Review reviewer, in the browser
  review = await lr.ship('REVIEW_LOAD', { shipmentId: S.shipmentId })
  const alreadyReleased = bundle.orders[0].arStatus !== 'DOCS_NEEDED'
  S.log.reviewAfter = review.releaseGate.missing.map((m) => m.message)
  say(`  Load Review after the bill: ${JSON.stringify(S.log.reviewAfter)} (ok ${review.releaseGate.ok})`)
  if (review.releaseGate.ok && !alreadyReleased) {
    const rb2 = await openBrowser(lr)
    try {
      await rb2.navigate('/tms/load-review'); await pause(3500)
      await openDrawerFor(rb2, S)
      await snap(rb2, '22-load-review-ready')
      await rb2.click({ selector: '[role="dialog"] button', pattern: 'Move to billing' })
      await pause(900)
      if ((await rb2.evaluate(`document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`)) > 1) await rb2.click({ selector: '[role="alertdialog"] button, [role="dialog"]:last-of-type button', pattern: '^(Confirm|Move to billing|Yes)' }).catch(() => {})
      await rb2.poll(async () => (await bundleOf(ctx)).orders[0].arStatus === 'UNBILLED', 'order UNBILLED', 60_000)
      await shot(rb2, '/tms/load-review?tab=released', '23-load-review-released', { wait: waitText(rb2, S.shipmentNumber) }).catch(() => {})
    } finally { await rb2.close() }
    bundle = await bundleOf(ctx)
    S.log.releasedStatus = bundle.orders[0].arStatus
    say(`  released: order ${bundle.orders[0].arStatus}`)
  }

  // 4. invoice (the 20000 series), then the carrier bill is approved, then the factoring row
  if (!S.invoiceId) {
    const gen = await ctx.fin('GENERATE_INVOICE', { orderId: bundle.orders[0].id })
    S.invoiceId = gen.invoice.id; S.invoiceNumber = gen.invoice.number
    say(`  invoice ${gen.invoice.number} ${gen.invoice.status} total ${gen.invoice.totalCents}`)
  }
  if (!S.invoiceEmailed) {
    const em = await ctx.fin('EMAIL_INVOICE', { invoiceId: S.invoiceId, to: ['ai4bcat@gmail.com'] }).catch((e) => ({ emailStatus: 'ERROR', emailError: short(e) }))
    S.invoiceEmailed = em.emailStatus === 'SENT'
    S.log.invoiceEmail = { status: em.emailStatus, ses: Boolean(em.notice?.messageId), recipientsInMailbox: [...(em.to ?? []), ...(em.cc ?? [])].every((x) => /^ai4bcat(\+[^@]*)?@gmail\.com$/.test(x)), error: em.emailError ?? null }
    say(`  invoice e-mail: ${JSON.stringify(S.log.invoiceEmail)}`)
  }
  if (!S.carrierInvoiceDoc) {
    // the carrier's own invoice, attached to its assignment (the carrier-scope paperwork gate reads documents placed on the leg)
    await uploadDoc(ctx, S, 'CARRIER_INVOICE', 'zz-demo-carrier-invoice.pdf', textPdf(['CARRIER INVOICE', `Load ${S.shipmentNumber}`, 'ZZ DEMO Carrier', 'Amount due: $1,800.00', 'ZZ DEMO - not a real invoice']), leg.id)
    S.carrierInvoiceDoc = true
  }
  try {
    const ap = await ctx.fin('APPROVE_BILL', { billId: S.billId })
    S.log.billStatus = ap.bill.status
    say(`  carrier bill approved: ${ap.bill.status}`)
  } catch (e) { S.log.billApprove = short(e); say(`  approve bill: ${short(e)}`) }
  if (!S.factorItemId) {
    const fac = await ctx.fin('SEND_TO_FACTOR', { invoiceId: S.invoiceId }).catch((e) => ({ error: short(e) }))
    if (fac.error) { S.log.factorError = fac.error; say(`  send to factor: ${fac.error}`) } else { S.factorItemId = fac.factoringItem.id; S.log.factor = { status: fac.factoringItem.status, source: fac.factoringItem.source, otr: fac.factoringItem.otrInvoiceId ?? null } ; say(`  factoring row ${fac.factoringItem.status}`) }
  }

  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, `/tms/invoicing/invoices/${encodeURIComponent(S.invoiceId)}`, '24-invoice', { wait: waitText(b, S.invoiceNumber) })
    await shot(b, `/tms/invoicing/payable/bills/${encodeURIComponent(S.billId)}`, '25-carrier-bill', { wait: waitText(b, 'ZZ DEMO') })
    await shot(b, '/tms/factors', '26-factoring-queue', { wait: waitText(b, 'Factor') })
    await shot(b, shipUrl(S, 'invoicing'), '27-shipment-invoicing-tab', { wait: waitText(b, S.invoiceNumber) })
  } finally { await b.close() }
}

// ───────────────────────────── own-asset: Ivan Cartage load with a driver ─────────────────────────────
const ownUrl = (S, tab) => `/tms/shipments/${encodeURIComponent(S.ownShipmentId)}${tab ? `?tab=${tab}` : ''}`

STAGES.own = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  S.own ??= {}
  const suffix = await discoverDevSuffix()
  const nowIso = new Date().toISOString()
  const today = chicagoToday()
  // a ZZ owner-operator on a ZZ pay setting (the only pay-bearing rows this demo writes; every key is zz-demo-…)
  if (!S.own.driverId) {
    const id = `zz-demo-drv-${S.ts}`
    const put = (model, item) => { if (!String(item.id).startsWith('zz-demo-')) throw new Error('refusing a non-ZZ pay row'); return doc.send(new PutCommand({ TableName: devTable(model, suffix), Item: { __typename: model, createdAt: nowIso, updatedAt: nowIso, ...item } })) }
    await put('Driver', { id, name: `ZZ DEMO Driver ${String(S.ts).slice(-6)}`, phone: '+15555550100', active: true, fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR', colorKey: 'driver-3' })
    await put('DriverPaySetting', { id: `zz-demo-ps-${S.ts}`, driverId: id, payGroup: 'OWNER_OPERATOR', payPercent: 0.25, expensesBeforePercent: false, active: true })
    S.own.driverId = id; S.own.driverName = `ZZ DEMO Driver ${String(S.ts).slice(-6)}`; S.own.paySettingId = `zz-demo-ps-${S.ts}`
    say(`  ZZ driver ${S.own.driverName}, owner-operator pay 25% (payPercent 0.25)`)
  }
  if (!S.ownShipmentId) {
    let bundle = await ctx.ship('CREATE_SHIPMENT', { customerId: S.customerId })
    S.ownShipmentId = bundle.shipment.id
    bundle = await ctx.ship('SAVE_ORDER_FORM', {
      shipmentId: S.ownShipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
      order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'Purchase order', value: `ZZDEMO-OWN-${String(S.ts).slice(-6)}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
      stops: [
        { type: 'pickup', name: 'ZZ DEMO Shipper', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T15:00:00.000Z` },
        { type: 'delivery', name: 'ZZ DEMO Receiver', city: 'Houston, TX', address: { city: 'Houston', state: 'TX', zip: '77001' }, appt: `${today}T20:00:00.000Z` },
      ],
      charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 150000, count: 1 }],
    })
    await ctx.ship('SUBMIT_ORDER', { shipmentId: S.ownShipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
    await ctx.ship('SET_REV_TAG', { shipmentId: S.ownShipmentId, divisionCode: 'ASSETS' })
    await ctx.ship('SET_SALES_REP', { shipmentId: S.ownShipmentId, repId: S.repId })
    bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })
    S.ownShipmentNumber = bundle.shipment.number
    S.ownLoadId = bundle.loads[0].id
    say(`  Ivan Cartage shipment ${bundle.shipment.number}, revDivision ${bundle.shipment.revDivision}, load ${bundle.loads[0].status}`)
  }
  let bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })
  let load = bundle.loads[0]

  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    if (!(bundle.loadCarriers ?? []).some((c) => c.status === 'ACTIVE')) {
      await shot(b, ownUrl(S), '30-own-asset-no-driver-yet', { wait: waitText(b, 'Actions') })
      S.log.ownDispatchNoDriver = await refusal(() => ctx.ship('DISPATCH_LOAD', { loadId: load.id, dispatchedAt: new Date().toISOString() }))
      S.log.ownAssignNoDriver = await refusal(() => ctx.ship('ASSIGN_ASSET', { loadId: load.id }))
      say(`  dispatch without a driver: ${S.log.ownDispatchNoDriver}`)
      say(`  assign without a driver: ${S.log.ownAssignNoDriver}`)
      // the dialog, in the browser: Actions -> Book Ivan Cartage (own fleet); the button stays off until a driver is picked
      await b.click({ selector: 'button', label: 'Load actions', real: true })
      await pause(600)
      await b.click({ selector: '[role="menuitem"]', pattern: 'Book Ivan Cartage', real: true })
      await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid="assign-driver-select"]')`), 'driver dialog', 20_000)
      S.log.bookButtonWithoutDriver = await b.evaluate(`(() => { const el = [...document.querySelectorAll('[role="dialog"] button')].find((n) => /Book own fleet/.test(n.textContent)); return el ? (el.disabled ? 'disabled' : 'enabled') : 'absent' })()`)
      say(`  "Book own fleet" with no driver picked: ${S.log.bookButtonWithoutDriver}`)
      await snap(b, '31-own-asset-book-dialog-driver-required')
      await b.evaluate(`(() => { const sel = document.querySelector('[data-testid="assign-driver-select"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(sel, ${JSON.stringify(S.own.driverId)}); sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await pause(500)
      await snap(b, '32-own-asset-book-dialog-driver-picked')
      await b.click({ selector: '[role="dialog"] button', pattern: 'Book own fleet' })
      await b.poll(async () => ((await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })).loadCarriers ?? []).some((c) => c.status === 'ACTIVE'), 'own-fleet leg', 40_000)
      bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })
      load = bundle.loads[0]
      say(`  driver booked in the UI; load ${load.status}, assignmentType ${load.assignmentType}`)
    }
    await shot(b, ownUrl(S, 'carrier'), '33-own-asset-driver-assigned', { wait: waitText(b, S.own.driverName) })
    // Schedule (the dispatcher's view of the driver's day)
    await b.navigate('/schedule'); await waitSettled(b)
    await b.poll(waitText(b, S.ownShipmentNumber), 'the load on /schedule', 60_000).catch(() => say('  (load not found on /schedule)'))
    await snap(b, '34-schedule-driver-day')
    await shot(b, '/calendar', '35-calendar-own-fleet', { wait: waitText(b, S.ownShipmentNumber) }).catch(() => {})
    // dispatch
    if (load.status === 'BOOKED') {
      await ctx.ship('DISPATCH_LOAD', { loadId: load.id, dispatchedAt: new Date().toISOString(), note: 'ZZ DEMO own-asset dispatch' })
      say('  dispatched')
    }
    await shot(b, ownUrl(S, 'carrier'), '36-own-asset-dispatched', { wait: waitText(b, S.own.driverName) })
  } finally { await b.close() }

  // run it: pickup, delivery, paperwork
  bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })
  load = bundle.loads[0]
  if (load.status !== 'DELIVERED') {
    const stops = JSON.parse(typeof load.stops === 'string' ? load.stops : JSON.stringify(load.stops))
    const pickup = stops.find((x) => x.type === 'pickup'); const drop = stops.find((x) => x.type === 'delivery')
    for (const [type, stopId, note] of [['ARRIVED', pickup.id, 'ZZ DEMO arrived'], ['DEPARTED', pickup.id, 'ZZ DEMO loaded'], ['ARRIVED', drop.id, 'ZZ DEMO at the receiver'], ['DEPARTED', drop.id, 'ZZ DEMO unloaded']]) {
      const l = (await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })).loads[0]
      await ctx.ship('LOG_CHECK_CALL', { loadId: l.id, expectedUpdatedAt: l.updatedAt, type, stopId, at: new Date().toISOString(), source: 'MANUAL', note })
    }
    bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: S.ownShipmentId })
    say(`  after the check calls: load ${bundle.loads[0].status}, shipment ${bundle.shipment.status}`)
  }

  const b2 = await openBrowser(ctx.id)
  try {
    await b2.navigate('/tms/dashboard'); await pause(3500)
    await shot(b2, ownUrl(S, 'carrierPay'), '37-own-asset-carrier-pay-is-settlement', { wait: () => b2.evaluate(`document.body.innerText.length > 300`) })
    // the settlement: owner-operator pay, Wednesday payroll
    await b2.navigate('/owner-operator-pay'); await waitSettled(b2)
    // the chip carries the week's amount once the pay settings and loads have loaded; clicking earlier opens the empty "pay settings" dialog
    await b2.poll(() => b2.evaluate(`[...document.querySelectorAll('button')].some((n) => n.textContent.includes(${JSON.stringify(S.own.driverName)}) && /\\$\\d/.test(n.textContent))`), 'the ZZ driver chip with its amount', 90_000).catch(() => {})
    await pause(1500)
    await b2.evaluate(`[...document.querySelectorAll('button')].find((n) => n.textContent.includes(${JSON.stringify(S.own.driverName)}))?.click()`)
    await b2.poll(waitText(b2, S.ownShipmentNumber), 'the load on the owner-operator settlement', 60_000).catch(() => say('  (load not on the owner-operator settlement)'))
    S.log.settlementText = await b2.evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
    S.log.settlementHasLoad = S.log.settlementText.includes(S.ownShipmentNumber)
    S.log.settlementBanner = (S.log.settlementText.match(/[^.]*Wednesday[^.]*\./i) ?? [null])[0]
    say(`  settlement lists the load: ${S.log.settlementHasLoad}; banner: ${S.log.settlementBanner}`)
    delete S.log.settlementText
    await snap(b2, '38-owner-operator-settlement')
    await shot(b2, '/driver-pay', '39-amazon-settlements-payroll-banner', { wait: () => b2.evaluate(`document.body.innerText.length > 300`) }).catch(() => {})
    await shot(b2, '/tms/vendors', '40-accounting-vendors-not-driver-pay', { wait: () => b2.evaluate(`document.body.innerText.length > 300`) }).catch(() => {})
  } finally { await b2.close() }
}

// ───────────────────────────── verify146: the five fixes, live ─────────────────────────────
STAGES.verify146 = async (ctx) => {
  const S = ctx.state
  const V = (S.log.verify146 = {})
  const bundle = await bundleOf(ctx)
  V.poCodes = (bundle.orders[0].references ?? []).map((r) => r.code)
  V.poWorkaroundUsed = Boolean(S.log.poWorkaround)
  V.releaseAfterBill = S.log.reviewAfter?.length === 0 && S.log.releasedStatus === 'UNBILLED'
  V.podReview = S.log.podReview
  const thread = await ctx.trk('LIST_SHIPMENT_THREAD', { shipmentId: S.shipmentId }).catch((e) => ({ error: short(e) }))
  V.thread = thread.error ?? { messages: (thread.messages ?? []).length }
  const run = await ctx.trk('RUN_CHECK_CALL_PLAN', { shipmentId: S.shipmentId }).catch((e) => ({ error: short(e) }))
  V.runOnDelivered = run.error ?? { checked: run.checked, skipped: run.skipped, reasons: (run.reasons ?? []).slice(0, 2) }
  const load = bundle.loads[0]
  V.loadPlanStored = load.checkCallPlan
  const c = (await ctx.gql(`query { getCustomer(id: ${JSON.stringify(S.customerId)}) { id name updatedAt mcNumber } }`)).getCustomer
  const up = await ctx.dir('UPSERT_CUSTOMER', { id: c.id, expectedUpdatedAt: c.updatedAt, name: c.name, mcNumber: c.mcNumber, billingEmail: 'ai4bcat@gmail.com', creditLimitCents: 100000000 }).then((r) => ({ ok: true, billingEmail: !!(r.customer ?? r).billingEmail })).catch((e) => ({ ok: false, error: short(e) }))
  V.upsertCustomer = up
  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, shipUrl(S, 'tracking'), '41-verify-tracking-tab-per-load-plan', { wait: waitText(b, 'Tracking') })
    V.trackingTabPlanText = (await b.evaluate(`(() => { const t = document.body.innerText.replace(/\\s+/g,' '); const i = t.search(/every|Every/); return i < 0 ? null : t.slice(Math.max(0,i-80), i+160) })()`))
    V.trackingTabInterval = await b.evaluate(`(() => { const el = [...document.querySelectorAll('input[type="number"]')][0]; return el ? el.value : null })()`)
    await shot(b, shipUrl(S, 'documents'), '42-verify-pod-reviewed', { wait: waitText(b, 'POD') })
  } finally { await b.close() }
  say(JSON.stringify(V, null, 1))
}

STAGES.verify147 = async (ctx) => {
  const S = ctx.state
  const V = (S.log.verify147 = {})
  const run = await ctx.trk('RUN_CHECK_CALL_PLAN', { shipmentId: S.shipmentId }).catch((e) => ({ error: short(e) }))
  V.runOnDelivered = run.error ?? { checked: run.checked, acted: run.acted, skipped: run.skipped, reasons: (run.reasons ?? []).slice(0, 2) }
  const b = await openBrowser(ctx.id)
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await shot(b, shipUrl(S, 'tracking'), '41-verify-tracking-tab-per-load-plan', { wait: waitText(b, 'Check-call plan') })
    V.interval = await b.evaluate(`[...document.querySelectorAll('input[type="number"]')].slice(0,2).map((e) => e.value)`)
    V.source = await b.evaluate(`(document.body.innerText.match(/(Inherited from [^\\n]*|Overridden for this shipment)/) ?? [null])[0]`)
    await b.navigate('/tms/shipments?demo=1'); await waitSettled(b); await pause(6000)
    V.demoRows = await b.evaluate(`(() => { const t = document.body.innerText; return { has99279: t.includes('99279'), zz: (t.match(/ZZ DEMO/g) ?? []).length, rows: document.querySelectorAll('tbody tr').length } })()`)
    await snap(b, '43-shipments-board-demo-chip')
  } finally { await b.close() }
  say(JSON.stringify(V))
}

// ───────────────────────────── tour: the rest of the structure ─────────────────────────────
STAGES.tour = async (ctx) => {
  const S = ctx.state
  S.log ??= {}
  S.log.tour ??= {}
  // a quote request in the SIMULATED inbox (Google OAuth is not connected on dev): added the way "Add request" does
  if (false) {
    const r = await ctx.spot('SPOT_ADD_MANUAL', { text: `Hi, can you quote a dry van from Lubbock, TX to Shreveport, LA picking up ${addDays(chicagoToday(), 3)}? 38,000 lbs paper goods. ZZ DEMO request. Thanks, ZZ DEMO Shipper Contact`, subject: 'ZZ DEMO quote request: Lubbock TX to Shreveport LA', fromEmail: S.senderEmail, fromName: 'ZZ DEMO Shipper Contact' }).catch((e) => ({ error: short(e) }))
    if (r.error) { S.log.tour.spotAdd = r.error; say(`  spot add: ${r.error}`) } else { S.spotId = r.request.id; say(`  spot request ${S.spotId}`) }
  }
  const b = await openBrowser(ctx.id)
  const t = S.log.tour
  const page = async (url, file, text, extra) => {
    try {
      await shot(b, url, file, { wait: text ? waitText(b, text) : () => b.evaluate('document.body.innerText.length > 400') })
      if (extra) await extra()
    } catch (e) { t[file] = short(e); say(`  (${file}: ${short(e)})`) }
  }
  try {
    await b.navigate('/tms/dashboard'); await pause(3500)
    await page('/tms/dashboard', '50-company-dashboard-kpis', 'Dashboard')
    await page('/tms/dashboard/new', '51-new-dashboard-chat-builder', null)
    const search = async (text) => {
      await b.evaluate(`(() => { const el = [...document.querySelectorAll('input')].find((e) => /search/i.test(e.placeholder || '') && e.offsetParent); el?.focus() })()`)
      await b.command('Input.insertText', { text }); await pause(2500)
    }
    await page('/tms/customers', '52-customers-dense-grid', 'Customer', async () => { await search('ZZ DEMO Customer'); await snap(b, '52-customers-dense-grid') })
    await page('/tms/carriers', '53-carriers-dense-grid', 'Carrier', async () => { await search('ZZ DEMO Carrier'); await snap(b, '53-carriers-dense-grid') })
    await page('/tms/brokerage/users', '54-settings-users-and-claims', 'Users')
    await page('/tms/rates/spot', '55-spot-inbox', 'Spot', async () => {
      await pause(2000)
      // "Add a request" in the simulated inbox (Google OAuth is not connected on dev), owned by this session's user
      await b.click({ selector: 'button', pattern: 'Add (a )?request' }).catch((e) => { t.spotAddBtn = short(e) })
      await pause(1200)
      await b.evaluate(`document.querySelector('[role=dialog] textarea')?.focus()`)
      await b.command('Input.insertText', { text: `Hi, can you quote a dry van from Lubbock, TX to Shreveport, LA picking up ${addDays(chicagoToday(), 3)}? 38,000 lbs paper goods. ZZ DEMO request. Thanks` }); await pause(500)
      await b.click({ selector: '[data-testid="spot-add-submit"]' }).catch((e) => { t.spotSubmit = short(e) })
      await pause(6000)
      await snap(b, '55-spot-inbox')
      await b.evaluate(`(() => { const row = [...document.querySelectorAll('tbody tr, [role=row], [data-testid*=spot-row]')].find((r) => /Lubbock|ZZ DEMO/.test(r.textContent)); row?.click() })()`)
      await pause(5000)
      await snap(b, '56-spot-request-drawer-suggested-response')
      t.spotDrawer = (await b.evaluate(`document.body.innerText.replace(/\\s+/g,' ').match(/Suggested[^]{0,300}/)?.[0] ?? null`))
    })
    await page('/tms/invoicing/payable', '57-accounts-payable-and-ap-inbox', 'Accounts Payable')
    await page('/tms/invoicing', '58-accounts-receivable', 'Accounts Receivable')
    await page('/feedback', '59-feedback-page', null)
    await page('/tms/load-review', '60-load-review-queue', 'Review · Load review')
    await page('/tms/rates', '61-quotes', 'Quote · Spot quotes')
  } finally { await b.close() }
  say(JSON.stringify(t))
}

// ───────────────────────────── retire: tidy an earlier attempt ─────────────────────────────
/** Void the ZZ shipments, archive the ZZ customer / carrier / division, and forget the state (nothing is deleted; a PRO is permanent). */
STAGES.retire = async (ctx) => {
  const S = ctx.state
  if (S.invoiceId) await ctx.fin('VOID_INVOICE', { invoiceId: S.invoiceId, reason: 'ZZ DEMO attempt retired' }).then(() => say('  invoice voided')).catch((e) => say(`  (void invoice: ${short(e)})`))
  if (S.billId) await ctx.fin('VOID_BILL', { billId: S.billId, reason: 'ZZ DEMO attempt retired' }).then(() => say('  carrier bill voided')).catch((e) => say(`  (void bill: ${short(e)})`))
  for (const id of [S.shipmentId, S.ownShipmentId].filter(Boolean)) {
    const cur = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: id }).catch(() => null)
    if (cur && !cur.shipment.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, expectedUpdatedAt: cur.shipment.updatedAt, reason: 'ZZ DEMO Step Y attempt retired' }).then(() => say(`  voided ${cur.shipment.number}`)).catch((e) => say(`  (void ${id}: ${short(e)})`))
  }
  if (S.own?.driverId) {
    const suffix = await discoverDevSuffix()
    if (String(S.own.driverId).startsWith('zz-demo-')) await doc.send(new UpdateCommand({ TableName: devTable('Driver', suffix), Key: { id: S.own.driverId }, UpdateExpression: 'SET active = :f', ExpressionAttributeValues: { ':f': false } }))
  }
  if (S.customerId) {
    const c = (await ctx.gql(`query { getCustomer(id: ${JSON.stringify(S.customerId)}) { id updatedAt } }`)).getCustomer
    if (c) await ctx.dir('ARCHIVE_CUSTOMER', { id: c.id, customerId: c.id, expectedUpdatedAt: c.updatedAt }).catch((e) => say(`  (archive customer: ${short(e)})`))
  }
  if (S.carrierId) {
    const c = (await ctx.gql(`query { getCarrier(id: ${JSON.stringify(S.carrierId)}) { id updatedAt status } }`)).getCarrier
    if (c && c.status !== 'INACTIVE') await ctx.car('SET_CARRIER_STATUS', { id: c.id, expectedUpdatedAt: c.updatedAt, status: 'INACTIVE', reason: 'ZZ DEMO attempt retired' }).catch((e) => say(`  (carrier status: ${short(e)})`))
  }
  if (S.divisionCode) await ctx.dir('ARCHIVE_OWNERSHIP_DIVISION', { code: S.divisionCode, id: S.divisionId }).catch((e) => say(`  (archive division: ${short(e)})`))
  if (S.intakeId) {
    const row = await getRow(ctx.token, 'IntakeLoad', S.intakeId, INTAKE_SELECTION)
    if (row?.status === 'OPEN') await ctx.ship('INTAKE_DISMISS', { intakeId: row.id, expectedVersion: Number(row.version ?? 1), reason: 'ZZ DEMO attempt retired' }).catch((e) => say(`  (dismiss: ${short(e)})`))
  }
  ctx.state = {}
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  await mkdir(SHOTS, { recursive: true })
  const stages = process.argv.slice(2)
  if (!stages.length) throw new Error(`name a stage: ${Object.keys(STAGES).join(', ')}`)
  await withDemoAdmin(async (ctx) => {
    for (const name of stages) {
      if (!STAGES[name]) throw new Error(`unknown stage ${name}`)
      say(`── stage ${name}`)
      await STAGES[name](ctx)
      await ctx.save()
    }
  })
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('FAILED:', short(e)); process.exitCode = 1 })

export { openBrowser, shot, snap, snapAt, waitSettled, mainText, chicagoToday, addDays, say, pause }
