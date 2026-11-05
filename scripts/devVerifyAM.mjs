#!/usr/bin/env node
/**
 * Step AM verification: the Cover flow and the carrier assignment ladder (UI half), on dev.
 *
 *   node scripts/devVerifyAM.mjs              inventory only: no network, no browser, no writes (the default)
 *   node scripts/devVerifyAM.mjs --inventory  the same, spelled out
 *   node scripts/devVerifyAM.mjs --walk       dev walk: seeds ZZ fixtures straight into the dev tables (no MyCarrierPackets
 *                                             call, no e-mail, no SMS), then screenshots the Cover dialog and every ladder
 *                                             state; everything it made is voided / deleted / archived in `finally`
 *   node scripts/devVerifyAM.mjs --walk --mcp-preview
 *                                             also opens the Cover dialog on a carrier that is NOT in the directory. That
 *                                             calls MCP PreviewCarrier (live when the integration is LIVE, a labelled STUB
 *                                             fixture otherwise), so it is opt-in. It never sends an invitation.
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAM.mjs --walk
 *
 * RUNS ONLY AFTER THE DEPLOY (the AM actions and attributes must exist on dev). Dev only: refuses any AppSync endpoint but
 * the dev one, any staff pool but the dev pool, any origin outside ALLOWED_ORIGINS and any DynamoDB table with the
 * production suffix. No SSM, no main / production, no invoice_*.json, no Aljex export. One throwaway ADMIN identity
 * (zz-am-admin-<ts>) is created and deleted (and proven gone) in `finally`; passwords and tokens are never printed.
 * The walk never clicks Send, Assign, Mark signed, Save or Confirm: dialogs are opened, photographed and closed.
 *
 * Screenshots: Docs/tms-build/screenshots/am/<name>.png, 1440x900, listed in index.txt.
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/am')
const REGION = 'us-east-1'
const PROD_SUFFIX = process.env.PROD_TABLE_SUFFIX || 'rzxdbk7k6zh6vjpcdbmzbmfk4q-NONE'
const VOID_REASON = 'ZZ AM verification fixture'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const walk = flag('walk')
const mcpPreview = flag('mcp-preview')

const report = []
const written = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)} ${name}${detail ? `: ${detail}` : ''}`)
}
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const tid = (id) => `[data-testid="${id}"]`
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const nowIso = () => new Date().toISOString()
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const exists = (file) => access(resolve(file)).then(() => true, () => false)

// ───────────────────────────── the ladder, as the walk seeds it ─────────────────────────────
/** One ZZ shipment per rung (the last twice: before and after the shipment is moving). */
export const STATES = [
  { key: 'pending', rung: 'ASSIGNED_SETUP_PENDING', shot: 'AM03-ladder-setup-pending', carrier: 'PENDING', shipment: 'BOOKED' },
  { key: 'setup', rung: 'ASSIGNED_SETUP_COMPLETE', shot: 'AM04-ladder-setup-complete', carrier: 'ACTIVE', shipment: 'BOOKED' },
  { key: 'sent', rung: 'RATE_CON_SENT', shot: 'AM05-ladder-rate-con-sent', carrier: 'ACTIVE', shipment: 'BOOKED', rateCon: 'SENT' },
  { key: 'signed', rung: 'RATE_CON_SIGNED', shot: 'AM06-ladder-rate-con-signed', carrier: 'ACTIVE', shipment: 'BOOKED', rateCon: 'SIGNED' },
  { key: 'driver', rung: 'DRIVER_INFO_ENTERED', shot: 'AM07-ladder-driver-info', carrier: 'ACTIVE', shipment: 'BOOKED', rateCon: 'SIGNED', driver: true },
  { key: 'moving', rung: 'DRIVER_INFO_ENTERED', shot: 'AM08-ladder-shipment-status-takes-over', carrier: 'ACTIVE', shipment: 'IN_TRANSIT', rateCon: 'SIGNED', driver: true },
]

const RUNGS = ['ASSIGNED_SETUP_PENDING', 'ASSIGNED_SETUP_COMPLETE', 'RATE_CON_SENT', 'RATE_CON_SIGNED', 'DRIVER_INFO_ENTERED']

// ───────────────────────────── inventory (no network, no browser, no writes) ─────────────────────────────
const FILES = [
  'src/lib/carrierAssignment.ts',
  'src/features/shipments/carrierLadder.ts', 'src/features/shipments/carrierLadder.test.ts',
  'src/features/shipments/CarrierLadder.test.tsx', 'src/features/shipments/carrierAssignmentColumns.test.ts',
  'src/features/shipments/components/CarrierAssignmentChip.tsx', 'src/features/shipments/components/CarrierLadderCard.tsx',
  'src/features/shipments/components/DriverInfoDialog.tsx', 'src/features/shipments/components/MarkSignedDialog.tsx',
  'src/features/carriers/cover/CoverCarrierDialog.tsx', 'src/features/carriers/cover/coverModel.ts',
  'src/features/carriers/cover/coverModel.test.ts', 'src/features/carriers/cover/CoverCarrierDialog.render.test.tsx',
  'Docs/tms-build/AM-notes.md',
]
const ACTIONS = ['COVER_CARRIER', 'MARK_RATE_CON_SIGNED', 'ENTER_DRIVER_INFO', 'REMOVE_LOAD_CARRIER', 'SEND_RATE_CON', 'DISPATCH_LOAD']
/** Every test id the walk waits on, and the file that renders it. */
const TEST_IDS = [
  ['cover-row', 'src/features/tms/carrierSales/CarrierSalesPage.tsx'],
  ['cover-open', 'src/features/shipments/components/CarrierSection.tsx'],
  ['row-cover', 'src/features/shipments/components/StatusActions.tsx'],
  ['cover-lookup', 'src/features/carriers/cover/CoverCarrierDialog.tsx'],
  ['cover-directory', 'src/features/carriers/cover/CoverCarrierDialog.tsx'],
  ['cover-mcp-card', 'src/features/carriers/cover/CoverCarrierDialog.tsx'],
  ['cover-send-packet', 'src/features/carriers/cover/CoverCarrierDialog.tsx'],
  ['carrier-ladder', 'src/features/shipments/components/CarrierLadderCard.tsx'],
  ['ladder-${b.key}', 'src/features/shipments/components/CarrierLadderCard.tsx'],
  ['ladder-REMOVE', 'src/features/shipments/components/CarrierLadderCard.tsx'],
  ['driver-info-save', 'src/features/shipments/components/DriverInfoDialog.tsx'],
  ['mark-signed-confirm', 'src/features/shipments/components/MarkSignedDialog.tsx'],
  ['remove-carrier-effect', 'src/features/shipments/components/StatusActions.tsx'],
  ['assignment-chip', 'src/features/shipments/components/CarrierAssignmentChip.tsx'],
]

async function inventory() {
  let ok = true
  const check = (cond, name, detail) => { line(cond ? 'PASS' : 'FAIL', name, detail); if (!cond) ok = false }
  for (const file of FILES) check(await exists(file), `file ${file}`)

  const router = await readFile('amplify/functions/tms-shipment-actions/handler.ts', 'utf8').catch(() => '')
  const api = await readFile('src/lib/apiClient.ts', 'utf8').catch(() => '')
  for (const action of ACTIONS) {
    check(new RegExp(`case '${action}'`).test(router), `action ${action} has a handler case`)
    check(api.includes(`'${action}'`), `action ${action} is called from apiClient.ts`)
  }

  const ladder = await readFile('src/lib/carrierAssignment.ts', 'utf8').catch(() => '')
  for (const rung of RUNGS) check(ladder.includes(`'${rung}'`), `ladder rung ${rung}`)
  check(STATES.every((s) => RUNGS.includes(s.rung)) && RUNGS.every((r) => STATES.some((s) => s.rung === r)), 'the walk covers every rung')

  const haystack = new Map()
  for (const [id, file] of TEST_IDS) {
    if (!haystack.has(file)) haystack.set(file, await readFile(file, 'utf8').catch(() => ''))
    check(haystack.get(file).includes(id), `test id ${id} in ${file.split('/').pop()}`)
  }

  const resource = await readFile('amplify/data/resource.ts', 'utf8').catch(() => '')
  check(/assignmentStatus:\s+a\.string\(\)/.test(resource) && /assignmentTimes:\s+a\.json\(\)/.test(resource), 'LoadCarrier.assignmentStatus / assignmentTimes (additive attributes, no new table)')
  check((resource.match(/carrierAssignmentStatus/g) ?? []).length >= 2, 'Shipment and Load carry the mirrored carrierAssignmentStatus')

  // Rule (g): no manual add-carrier entry point outside the admin-only data fix.
  const carriersPage = await readFile('src/features/carriers/CarriersPage.tsx', 'utf8').catch(() => '')
  check(/isAdmin \? <TmsButton[\s\S]*?>Carrier \(admin data fix\)/.test(carriersPage), 'Carriers page: manual add is admin-only')
  const find = await readFile('src/features/carriers/find/FindInvitePage.tsx', 'utf8').catch(() => '')
  check(!/mcpAddCarrier|mcp-add-carrier/.test(find), 'Find & Invite: no "Add to carriers"')

  console.log(ok ? '\ninventory: ok' : '\ninventory: FAILED')
  return ok
}

// ───────────────────────────── dev access: guarded DynamoDB (the ZZ fixtures only) ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || 'nc3jsnxdmjhkpequimypiatkma-NONE'
  if (suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}
function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (name.includes(PROD_SUFFIX)) throw new Error(`refusing non-dev table ${name}`)
  return name
}
const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

/** Ids this run created: the only ones the SDK writers will touch. */
function makeOwned() {
  const ids = new Set()
  return { add: (id) => { ids.add(String(id)); return String(id) }, assert: (model, id) => { if (!ids.has(String(id))) throw new Error(`refusing SDK write to ${model} ${id}: this run did not create it`) } }
}
async function sdkPut(ctx, model, item) {
  ctx.owned.assert(model, item.id)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, ...item } }))
}
async function sdkUpdate(ctx, model, id, set) {
  ctx.owned.assert(model, id)
  const keys = Object.keys(set)
  await doc.send(new UpdateCommand({
    TableName: devTable(model, ctx.suffix), Key: { id },
    UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(', ')}, #updatedAt = :updatedAt`,
    ExpressionAttributeNames: { ...Object.fromEntries(keys.map((k) => [`#${k}`, k])), '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(set).map(([k, v]) => [`:${k}`, v])), ':updatedAt': nowIso() },
  }))
}

const STOPS = (day) => [
  { type: 'pickup', name: 'ZZ AM Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
  { type: 'delivery', name: 'ZZ AM Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
]

async function createShipment(ctx, customerId) {
  const bundle = await ctx.ship('CREATE_SHIPMENT', { customerId, load: { stops: STOPS(today()) } })
  ctx.shipmentIds.add(bundle.shipment.id)
  ctx.owned.add(bundle.shipment.id)
  for (const load of bundle.loads ?? []) ctx.owned.add(load.id)
  return bundle
}

/** A ZZ directory carrier written straight to the table: ACTIVE with a complete packet, or PENDING and invited. No MyCarrierPackets involved. */
async function seedCarrier(ctx, key, kind) {
  const id = ctx.owned.add(`car-zzam-${ctx.ts}-${key}`)
  const at = nowIso()
  const active = kind === 'ACTIVE'
  await sdkPut(ctx, 'Carrier', {
    id, name: `ZZ AM Carrier ${key} ${ctx.ts}`, normalizedName: `zz am carrier ${key} ${ctx.ts}`, type: 'TL',
    status: kind, mcNumber: `MC99${String(ctx.ts).slice(-5)}${key === 'active' ? '1' : '2'}`,
    mcpStatus: active ? 'ACCEPTABLE' : 'INVITED', mcpInvitedAt: active ? undefined : at, mcpInvitedTo: active ? undefined : 'zz-am@example.invalid',
    createdBy: 'zz-am', updatedBy: 'zz-am', createdAt: at, updatedAt: at,
  })
  ctx.carrierIds.add(id)
  return { id, name: `ZZ AM Carrier ${key} ${ctx.ts}`, mc: `MC99${String(ctx.ts).slice(-5)}${key === 'active' ? '1' : '2'}` }
}

/** Put one ZZ shipment on a rung: the LoadCarrier row, and the mirrors the boards read. */
async function seedState(ctx, state, bundle, carrier) {
  const load = bundle.loads[0]
  const at = nowIso()
  const lcId = ctx.owned.add(`lc-zzam-${ctx.ts}-${state.key}`)
  const times = Object.fromEntries(RUNGS.slice(0, RUNGS.indexOf(state.rung) + 1).map((r) => [r, at]))
  await sdkPut(ctx, 'LoadCarrier', {
    id: lcId, loadId: load.id, shipmentId: bundle.shipment.id, kind: 'CARRIER', status: 'ACTIVE', sequence: 1,
    carrierId: carrier.id, carrierName: carrier.name, carrierMc: carrier.mc, carrierRateCents: 150_000,
    dispatcherName: 'ZZ AM Dispatcher', dispatcherEmail: 'zz-am@example.invalid',
    ...(state.driver ? { driverName: 'ZZ AM Driver', driverPhone: '+13125550188', truckNumber: 'ZZ-T1', trailerNumber: 'ZZ-R1' } : {}),
    ...(state.rateCon ? { rateConStatus: state.rateCon, rateConSentAt: at, ...(state.rateCon === 'SIGNED' ? { rateConSignedAt: at } : {}) } : { rateConStatus: 'NOT_SENT' }),
    assignmentStatus: state.rung, assignmentTimes: JSON.stringify(times),
    createdBy: 'zz-am', updatedBy: 'zz-am', createdAt: at, updatedAt: at,
  })
  ctx.legIds.add(lcId)
  await sdkUpdate(ctx, 'Load', load.id, { status: state.shipment === 'IN_TRANSIT' ? 'IN_TRANSIT' : 'BOOKED', assignmentType: 'CARRIER', activeLoadCarrierId: lcId, carrierName: carrier.name, carrierAssignmentStatus: state.rung })
  await sdkUpdate(ctx, 'Shipment', bundle.shipment.id, { status: state.shipment, carrierAssignmentStatus: state.rung })
}

async function cleanup(ctx) {
  const say = (message, good = true) => { line(good ? 'PASS' : 'FAIL', `cleanup: ${message}`); if (!good) process.exitCode = 1 }
  for (const id of ctx.shipmentIds) {
    try {
      const row = await getRow(ctx.token, 'Shipment', id, 'id voidedAt updatedAt')
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(ctx.token, 'Shipment', id, 'voidedAt')
      say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.suffix) {
    for (const [model, ids] of [['LoadCarrier', ctx.legIds], ['Carrier', ctx.carrierIds]]) {
      for (const id of ids) {
        await doc.send(new DeleteCommand({ TableName: devTable(model, ctx.suffix), Key: { id } })).catch(() => {})
        const left = (await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } })).catch(() => ({ Item: {} }))).Item
        say(`${model} ${id} ${left ? 'NOT removed' : 'removed'}`, !left)
      }
    }
  }
  for (const id of ctx.customerIds) {
    const row = await getRow(ctx.token, 'Customer', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

// ───────────────────────────── the walk ─────────────────────────────
async function runWalk(ctx, b) {
  const shot = async (name) => { const file = join(SHOTS, `${name}.png`); await b.screenshot(file, { clipToContent: true }); written.push(file) }
  const has = (selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
  const click = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const closeDialog = () => b.evaluate(`document.querySelector('.tms-dialog-close')?.click()`)
  const step = async (name, fn) => {
    try { line('PASS', name, await fn()) } catch (err) { line('FAIL', name, short(err).slice(0, 220)); process.exitCode = 1 }
  }
  const typeInto = async (label, value) => {
    await b.evaluate(`(() => {
      const el = document.querySelector('[aria-label=${JSON.stringify(label)}]')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }

  await step('AM01 Cover dialog: directory hit shows the packet status', async () => {
    await b.navigate('/tms/carrier-sales')
    await b.poll(() => has(tid('cover-row')), 'a Cover button on Carrier Sales', 90_000)
    await click(tid('cover-row'))
    await b.poll(() => has(tid('cover-lookup')), 'the Cover dialog', 15_000)
    await typeInto('Carrier MC or DOT', ctx.activeCarrier.mc)
    await b.poll(() => b.evaluate(`document.querySelector('[data-testid="cover-lookup"]')?.disabled === false`), 'the Look up button to enable', 60_000)
    await click(tid('cover-lookup'))
    await b.poll(() => has(tid('cover-directory')), 'the directory result', 30_000)
    await pause(400)
    expect(await b.evaluate(`document.querySelector('[data-testid="cover-packet-status"]')?.textContent ?? ''`), 'the packet status is not shown')
    expect(!(await has(tid('cover-mcp-card'))), 'an ACTIVE directory carrier must not call MyCarrierPackets')
    await shot('AM01-cover-dialog-directory-active')
    await closeDialog()
    return 'ACTIVE carrier found by MC, packet status shown, MyCarrierPackets not called'
  })

  if (mcpPreview) {
    await step('AM02 Cover dialog: not in the directory shows the MCP review card and Send setup packet', async () => {
      await b.navigate('/tms/carrier-sales')
      await b.poll(() => has(tid('cover-row')), 'a Cover button on Carrier Sales', 90_000)
      await click(tid('cover-row'))
      await b.poll(() => has(tid('cover-lookup')), 'the Cover dialog', 15_000)
      await typeInto('Carrier MC or DOT', ctx.unknownMc)
      await click(tid('cover-lookup'))
      await b.poll(() => has(tid('cover-mcp-card')), 'the MCP review card', 90_000)
      await pause(600)
      expect(await has(tid('cover-send-packet')), 'there is no "Send setup packet via MyCarrierPackets" button')
      expect(!(await b.evaluate(`document.body.innerText.includes('Add to carriers')`)), 'an "Add to carriers" button is still offered')
      await shot('AM02-cover-dialog-mcp-preview')
      await closeDialog()
      return 'review card + Send setup packet shown; no Add to carriers; nothing sent'
    })
  } else {
    line('SKIPPED', 'AM02 Cover dialog: MCP review card', 'opt-in (--mcp-preview): it calls MyCarrierPackets PreviewCarrier')
  }

  for (const s of STATES) {
    const id = ctx.f[s.key].shipment.id
    await step(`${s.shot}: ${s.rung}${s.shipment === 'IN_TRANSIT' ? ' (shipment moving)' : ''}`, async () => {
      await b.navigate(`/tms/shipments/${id}?tab=carrier`)
      await b.poll(() => has(tid('carrier-ladder')), 'the ladder card', 90_000)
      await pause(500)
      const facts = await b.evaluate(`(() => ({
        rung: document.querySelector('[data-testid="carrier-ladder"]')?.dataset.rung ?? '',
        reached: [...document.querySelectorAll('[data-testid^="ladder-"][data-done="true"]')].length,
        chip: document.querySelector('[data-testid="assignment-chip"]')?.textContent ?? '',
        gate: document.querySelector('[data-testid="dispatch-gate"]')?.textContent ?? '',
      }))()`)
      expect(facts.rung === s.rung, `the ladder says ${facts.rung}, expected ${s.rung}`)
      expect(facts.reached === RUNGS.indexOf(s.rung) + 1, `${facts.reached} rungs are marked reached, expected ${RUNGS.indexOf(s.rung) + 1}`)
      expect(facts.chip, 'the card has no chip')
      if (!s.driver) expect(/driver name/.test(facts.gate), 'Dispatch is not blocked on the missing driver info')
      else expect(facts.gate === '', 'Dispatch is still blocked with all four driver fields entered')
      await shot(s.shot)
      return `chip "${facts.chip}"${facts.gate ? '; dispatch blocked on driver info' : ''}`
    })
  }

  await step('AM09 dialogs: driver info, Mark signed, Remove carrier (opened, never submitted)', async () => {
    await b.navigate(`/tms/shipments/${ctx.f.pending.shipment.id}?tab=carrier`)
    await b.poll(() => has(tid('carrier-ladder')), 'the ladder card', 90_000)
    // Pending: the driver / rate-con steps are disabled until MyCarrierPackets confirms setup.
    const disabled = await b.evaluate(`['ladder-SEND_RATE_CON','ladder-MARK_SIGNED','ladder-ENTER_DRIVER_INFO'].every((id) => document.querySelector('[data-testid="' + id + '"]')?.disabled === true)`)
    expect(disabled, 'the rate con / signed / driver buttons are enabled before setup is complete')

    await b.navigate(`/tms/shipments/${ctx.f.sent.shipment.id}?tab=carrier`)
    await b.poll(() => has(tid('ladder-MARK_SIGNED')), 'the Mark signed button', 90_000)
    await click(tid('ladder-MARK_SIGNED'))
    await b.poll(() => has(tid('mark-signed-confirm')), 'the Mark signed dialog', 15_000)
    expect(await b.evaluate(`document.querySelector('[data-testid="mark-signed-confirm"]').disabled`), 'Mark signed is enabled with no PDF chosen')
    await shot('AM09-mark-signed-dialog')
    await closeDialog()

    await b.navigate(`/tms/shipments/${ctx.f.setup.shipment.id}?tab=carrier`)
    await b.poll(() => has(tid('ladder-ENTER_DRIVER_INFO')), 'the driver info button', 90_000)
    await click(tid('ladder-ENTER_DRIVER_INFO'))
    await b.poll(() => has(tid('driver-info-save')), 'the driver info dialog', 15_000)
    await click(tid('driver-info-save'))
    await pause(300)
    expect(await b.evaluate(`document.body.innerText.includes('Driver name is required.')`), 'a blank driver form was not refused')
    await shot('AM10-driver-info-dialog')
    await closeDialog()

    await click(tid('ladder-REMOVE'))
    await b.poll(() => has(tid('remove-carrier-effect')), 'the Remove carrier dialog', 15_000)
    expect(!(await b.evaluate(`document.querySelector('[aria-label="Re-post to DAT"]').checked`)), 'Re-post to DAT is ticked by default')
    await shot('AM11-remove-carrier-dialog')
    await closeDialog()
    return 'pending steps disabled; Mark signed needs a PDF; driver info needs all four; Remove has Re-post to DAT, off by default'
  })

  await step('AM12 Carrier Sales: Covered tab shows the rungs and filters by them', async () => {
    await b.navigate('/tms/carrier-sales')
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('[role="tab"]')].some((t) => /Covered/.test(t.textContent))`), 'the Covered tab', 90_000)
    await b.evaluate(`[...document.querySelectorAll('[role="tab"]')].find((t) => /Covered/.test(t.textContent)).click()`)
    await b.poll(() => has(tid('assignment-chip')), 'ladder chips on the Covered tab', 60_000)
    await pause(400)
    const chips = await b.evaluate(`document.querySelectorAll('[data-testid="assignment-chip"]').length`)
    expect(chips >= 3, `only ${chips} chips on the Covered tab`)
    expect(await has('[aria-label="Carrier status filter"]'), 'there is no Carrier status filter')
    await shot('AM12-carrier-sales-covered')
    return `${chips} chips and the status filter`
  })

  await step('AM13 Shipments board: Carrier Status column', async () => {
    await b.navigate('/tms/shipments')
    const text = (re) => b.evaluate(`/${re}/i.test(document.body?.innerText ?? '')`)
    await b.poll(() => text('Columns'), 'the shipments grid toolbar', 90_000)
    await pause(800)
    if (!(await text('Carrier Status'))) {
      // The default layout no longer carries the column: add it through the Columns dialog, as a user would.
      await b.evaluate(`[...document.querySelectorAll('button')].find((x) => /Columns/.test(x.textContent))?.click()`)
      await b.poll(() => has('#tms-cd-carrierAssignment'), 'the Columns dialog', 15_000)
      await b.evaluate(`(() => { const el = document.querySelector('#tms-cd-carrierAssignment'); if (!el.checked) el.click() })()`)
      await b.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Apply')?.click()`)
      await b.poll(() => text('Carrier Status'), 'the Carrier Status column header', 30_000)
    }
    await pause(500)
    await shot('AM13-shipments-board-column')
    return 'column present'
  })

  await step('AM14 Load Tracking grid: Carrier status column', async () => {
    await b.navigate('/tms/tracking')
    const text = (re) => b.evaluate(`/${re}/i.test(document.body?.innerText ?? '')`)
    await b.poll(() => text('Columns'), 'the tracking grid toolbar', 90_000)
    await pause(800)
    if (!(await text('Carrier status'))) {
      // Saved layouts predate the column: add it through the Columns dialog, as a user would.
      await b.evaluate(`[...document.querySelectorAll('button')].find((x) => /Columns/.test(x.textContent))?.click()`)
      await b.poll(() => has('#tms-cd-carrierAssignment'), 'the Columns dialog', 15_000)
      await b.evaluate(`(() => { const el = document.querySelector('#tms-cd-carrierAssignment'); if (!el.checked) el.click() })()`)
      await b.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Apply')?.click()`)
      await b.poll(() => text('Carrier status'), 'the Carrier status column header', 30_000)
    }
    await shot('AM14-tracking-grid-column')
    return 'column present'
  })

  await step('AM15 Carriers page: Find & invite is the entry', async () => {
    await b.navigate('/tms/carriers')
    await b.poll(() => has(tid('launch-find-invite')), 'the Carriers page', 60_000)
    await shot('AM15-carriers-page')
    return 'Find & invite launch point present (the walk identity is an admin, so the labelled data-fix button shows too)'
  })
}

async function main() {
  if (!walk) { if (!(await inventory())) process.exitCode = 1; if (!walk && !flag('inventory')) console.log('(no --walk: nothing was called)'); return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAM refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAM refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAM only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const email = `zz-am-admin-${ts}@example.invalid`
  let made = false
  const ctx = { ts, f: {}, owned: makeOwned(), shipmentIds: new Set(), customerIds: new Set(), legIds: new Set(), carrierIds: new Set(), suffix: null, unknownMc: 'MC1', activeCarrier: null }
  try {
    ctx.suffix = await discoverDevSuffix()
    const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary ADMIN identity created')
    ctx.token = identity.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')

    const custName = `ZZ AM Customer ${ts}`
    const cust = await ctx.dir('UPSERT_CUSTOMER', {
      name: custName, creditLimitCents: 100_000_000,
      contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AM Contact', email: `zz-am-${ts}@example.invalid`, types: [] }],
      billToParties: [{ id: `zz-am-bt-${ts}`, name: 'ZZ AM Bill To', isDefault: false }],
    })
    const customerId = String((cust.customer ?? cust).id)
    ctx.owned.add(customerId)
    ctx.customerIds.add(customerId)

    ctx.activeCarrier = await seedCarrier(ctx, 'active', 'ACTIVE')
    const pendingCarrier = await seedCarrier(ctx, 'pending', 'PENDING')
    for (const s of STATES) {
      const bundle = await createShipment(ctx, customerId)
      await seedState(ctx, s, bundle, s.carrier === 'PENDING' ? pendingCarrier : ctx.activeCarrier)
      ctx.f[s.key] = bundle
    }
    // One more open shipment so Carrier Sales has a Needs cover row to click Cover on.
    await createShipment(ctx, customerId)
    console.log(`fixtures: ${STATES.length} ZZ shipments on the ladder, 1 open, 2 ZZ carriers (all removed in cleanup)`)

    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-am-', purpose: 'AM verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
    try { await runWalk(ctx, b) } finally { await b.close() }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    if (made) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary identity ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed, skipped })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAM failed: ${err?.message ?? err}`); process.exit(1) })
}
