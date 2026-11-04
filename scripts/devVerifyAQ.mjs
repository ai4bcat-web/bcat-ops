#!/usr/bin/env node
/**
 * Step AQ verification: an Ivan Cartage (own fleet) driver is always one of our Driver records, on dev.
 *
 *   node scripts/devVerifyAQ.mjs              inventory only: no network, no browser, no writes (the default)
 *   node scripts/devVerifyAQ.mjs --inventory  the same, spelled out
 *   node scripts/devVerifyAQ.mjs --walk       dev walk, against the real driver roster of the prod refresh:
 *                                             1. counts the active roster (counts and field presence only),
 *                                             2. the shipment form's own-fleet driver is a select with exactly that many
 *                                                options, nothing typable, truck / trailer / phone read-only and filled by a pick,
 *                                             3. the Book Ivan Cartage dialog on a ZZ shipment lists the same roster,
 *                                             4. the server refuses a typed second driver, an unknown driver and an inactive
 *                                                driver on ASSIGN_ASSET (all refused BEFORE any write: nothing is assigned).
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAQ.mjs --walk
 *
 * RUNS ONLY AFTER THE DEPLOY. Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool and any
 * origin outside ALLOWED_ORIGINS. No SSM, no main / production, no invoice_*.json, no Aljex export. NO PII is printed or
 * photographed: names, phones and unit numbers never reach the log (counts and yes/no only) and no screenshots are taken.
 * One throwaway ADMIN identity (zz-aq-admin-<ts>) and one ZZ customer/shipment are created and removed (voided / archived /
 * deleted, and proven gone) in `finally`. Nothing is ever assigned, saved or confirmed on a real driver.
 */
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const VOID_REASON = 'ZZ AQ verification fixture'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const walk = flag('walk')

const report = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)} ${name}${detail ? `: ${detail}` : ''}`)
}
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const tid = (id) => `[data-testid="${id}"]`
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const exists = (file) => access(resolve(file)).then(() => true, () => false)

// ───────────────────────────── inventory (no network, no browser, no writes) ─────────────────────────────
const FILES = [
  'src/lib/ownFleetDrivers.ts', 'src/lib/ownFleetDrivers.test.ts',
  'src/hooks/useOwnFleetRoster.ts', 'src/components/OwnFleetDriverPicker.tsx',
  'src/features/shipments/components/AssignDriverDialog.tsx', 'src/features/shipments/components/DriverInfoDialog.tsx',
  'src/features/shipments/form/sections/CarrierInformationSection.tsx', 'src/features/carriers/components/BookCarrierDialog.tsx',
]
/** Every surface that names an own-fleet driver, and what makes it the shared picker. */
const PICKER_USERS = [
  'src/features/shipments/components/AssignDriverDialog.tsx', 'src/features/shipments/components/DriverInfoDialog.tsx',
  'src/features/shipments/form/sections/CarrierInformationSection.tsx', 'src/features/carriers/components/BookCarrierDialog.tsx',
]
const TEST_IDS = [
  ['carrier-own-fleet', 'src/features/shipments/form/sections/CarrierInformationSection.tsx'],
  ['assign-driver-select', 'src/features/shipments/components/AssignDriverDialog.tsx'],
  ['driver-info-picker', 'src/features/shipments/components/DriverInfoDialog.tsx'],
  ['book-own-fleet-driver', 'src/features/carriers/components/BookCarrierDialog.tsx'],
  ['own-fleet-driver-summary', 'src/components/OwnFleetDriverPicker.tsx'],
]

async function inventory() {
  let ok = true
  const check = (cond, name, detail) => { line(cond ? 'PASS' : 'FAIL', name, detail); if (!cond) ok = false }
  for (const file of FILES) check(await exists(file), `file ${file}`)

  const cache = new Map()
  const read = async (file) => { if (!cache.has(file)) cache.set(file, await readFile(file, 'utf8').catch(() => '')); return cache.get(file) }
  for (const file of PICKER_USERS) {
    const text = await read(file)
    check(/useOwnFleetRoster|OwnFleetDriverPicker/.test(text), `${file.split('/').pop()} uses the shared roster / picker`)
  }
  check(!/selectableDrivers|FLEET_GROUPS/.test(await read('src/features/shipments/components/AssignDriverDialog.tsx')), 'AssignDriverDialog: the duplicated roster select is gone')
  check(!/selectableDrivers/.test(await read('src/features/shipments/form/sections/CarrierInformationSection.tsx')), 'CarrierInformationSection: the duplicated roster select is gone')
  for (const [id, file] of TEST_IDS) check((await read(file)).includes(id), `test id ${id} in ${file.split('/').pop()}`)

  const handler = await read('amplify/functions/tms-shipment-actions/handler.ts')
  for (const needle of ['isIvanCartageName', 'ownFleetDriverPatch', 'resolveOwnFleetDriver', 'OWN_ASSET_MESSAGES.freeTextDriver']) {
    check(handler.includes(needle), `handler uses ${needle}`)
  }
  const lib = await read('src/lib/ownFleetDrivers.ts')
  check(/workPhoneFor/.test(lib), 'roster phone resolves through workPhoneFor (truck work phone preferred, Step AK)')

  console.log(ok ? '\ninventory: ok' : '\ninventory: FAILED')
  return ok
}

// ───────────────────────────── the walk ─────────────────────────────
async function loadRoster(token) {
  const rows = []
  let nextToken = null
  do {
    const data = await gql(token, `query($nextToken: String) { listDrivers(limit: 1000, nextToken: $nextToken) { items { id active type assignedTruckId assignedTrailerId phone } nextToken } }`, { nextToken })
    rows.push(...data.listDrivers.items)
    nextToken = data.listDrivers.nextToken
  } while (nextToken)
  const usable = rows.filter((d) => d.active !== false && String(d.type ?? '').toLowerCase() !== 'broker')
  return {
    total: rows.length,
    usable: usable.length,
    inactive: rows.filter((d) => d.active === false).length,
    withTruck: usable.filter((d) => d.assignedTruckId).length,
    withTrailer: usable.filter((d) => d.assignedTrailerId).length,
    withPhone: usable.filter((d) => d.phone).length,
    inactiveId: rows.find((d) => d.active === false)?.id ?? null,
  }
}

async function runWalk(ctx, b) {
  const has = (selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
  const click = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const step = async (name, fn) => {
    try { line('PASS', name, await fn()) } catch (err) { line('FAIL', name, short(err).slice(0, 220)); process.exitCode = 1 }
  }
  const change = (selector, value) => b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  /** Click the first visible button / menu item whose text matches. */
  const clickText = (source) => b.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(source)}, 'i')
    const el = [...document.querySelectorAll('button, [role="menuitem"]')].find((e) => re.test(e.textContent ?? ''))
    if (!el) return false
    el.click(); return true
  })()`)

  await step('AQ01 the active roster of the prod refresh (counts only)', async () => {
    expect(ctx.roster.usable > 0, 'no active, non-broker driver on dev: the prod refresh is missing')
    return `drivers ${ctx.roster.total}, usable ${ctx.roster.usable}, inactive ${ctx.roster.inactive}, with truck ${ctx.roster.withTruck}, with trailer ${ctx.roster.withTrailer}, with phone ${ctx.roster.withPhone}`
  })

  await step('AQ02 shipment form: own-fleet Driver 1 is a select of the whole roster; nothing about the driver can be typed', async () => {
    await b.navigate('/tms/shipments/new')
    await b.poll(() => has(tid('carrier-own-fleet')), 'the Carrier Information section', 90_000)
    await click(tid('carrier-own-fleet'))
    await b.poll(() => has(tid('f-carrier-driver1')), 'the own-fleet Driver 1 picker', 15_000)
    await b.poll(() => b.evaluate(`document.querySelector('[data-testid="f-carrier-driver1"]').options.length > 1`), 'the driver roster to load', 30_000)
    const facts = await b.evaluate(`(() => {
      const picker = document.querySelector('[data-testid="f-carrier-driver1"]')
      const readOnly = (label) => document.querySelector('[aria-label=' + JSON.stringify(label) + ']')?.readOnly === true
      return {
        tag: picker.tagName,
        options: picker.options.length - 1,
        typedDriverInputs: [...document.querySelectorAll('input')].filter((i) => i.getAttribute('aria-label') === 'Driver 1').length,
        locked: ['Driver 1 Cell', 'Truck #', 'Trailer #'].every(readOnly),
      }
    })()`)
    expect(facts.tag === 'SELECT', `Driver 1 is a ${facts.tag}, not a select`)
    expect(facts.typedDriverInputs === 0, 'a typable Driver 1 input exists on an own-fleet load')
    expect(facts.options === ctx.roster.usable, `${facts.options} options, the active roster has ${ctx.roster.usable}`)
    expect(facts.locked, 'phone / truck / trailer can still be typed')
    // A pick fills phone / truck / trailer from the record: presence only.
    await change(tid('f-carrier-driver1'), await b.evaluate(`document.querySelector('[data-testid="f-carrier-driver1"]').options[1].value`))
    await pause(300)
    const filled = await b.evaluate(`({
      phone: !!document.querySelector('[aria-label="Driver 1 Cell"]').value,
      truck: !!document.querySelector('[aria-label="Truck #"]').value,
      trailer: !!document.querySelector('[aria-label="Trailer #"]').value,
    })`)
    return `select with ${facts.options} options (= active roster); typed driver inputs 0; phone/truck/trailer read-only; after a pick filled: phone ${filled.phone}, truck ${filled.truck}, trailer ${filled.trailer}`
  })

  await step('AQ03 Book Ivan Cartage dialog on a ZZ shipment lists the same roster', async () => {
    await b.navigate(`/tms/shipments/${ctx.shipmentId}`)
    await b.poll(() => b.evaluate(`document.body.innerText.length > 200`), 'the shipment page', 90_000)
    await pause(800)
    // The Load actions menu is a Radix dropdown: it opens on a real pointer press, not el.click().
    await b.poll(() => has('.tms-main button[aria-label="Load actions"]'), 'the Load actions button', 30_000)
    await b.click({ selector: '.tms-main button[aria-label="Load actions"]', real: true })
    await b.poll(() => has('[role="menu"]'), 'the Load actions menu', 10_000)
    expect(await clickText('Book Ivan Cartage'), 'there is no "Book Ivan Cartage (own fleet)" action')
    await b.poll(() => has(tid('assign-driver-select')), 'the Book Ivan Cartage dialog', 20_000)
    await b.poll(() => b.evaluate(`document.querySelector('[data-testid="assign-driver-select"]').options.length > 1`), 'the driver roster to load', 30_000)
    const facts = await b.evaluate(`(() => {
      const select = document.querySelector('[data-testid="assign-driver-select"]')
      return { tag: select.tagName, options: select.options.length - 1, typed: !!document.querySelector('input[aria-label="Driver"]') }
    })()`)
    expect(facts.tag === 'SELECT' && !facts.typed, 'the driver control is typable')
    expect(facts.options === ctx.roster.usable, `${facts.options} options, the active roster has ${ctx.roster.usable}`)
    await b.evaluate(`document.querySelector('.tms-dialog-close')?.click()`)
    return `select with ${facts.options} options (= active roster); dialog closed without booking`
  })

  await step('AQ04 server: a typed second driver, an unknown driver and an inactive driver are refused before any write', async () => {
    const load = ctx.loadId
    const refuse = async (input, pattern, what) => {
      let message = ''
      await ctx.ship('ASSIGN_ASSET', { loadId: load, ...input }).then(() => { throw new Error(`${what}: the server accepted it`) }, (err) => { message = short(err) })
      expect(pattern.test(message), `${what}: refused, but not with the expected sentence`)
    }
    await refuse({ driverId: `zz-no-such-driver-${ctx.ts}` }, /Driver not found/, 'unknown driver')
    if (ctx.roster.inactiveId) await refuse({ driverId: ctx.roster.inactiveId }, /inactive/, 'inactive driver')
    else line('SKIPPED', 'AQ04b inactive driver', 'no inactive driver on dev')
    const usable = await gql(ctx.token, `query { listDrivers(limit: 1000) { items { id active type } } }`)
    const some = usable.listDrivers.items.find((d) => d.active !== false && String(d.type ?? '').toLowerCase() !== 'broker')
    await refuse({ driverId: some.id, driver2: { name: 'ZZ Typed Driver', phone: '5550100' } }, /typed driver name is not accepted/, 'typed second driver')
    const after = (await gql(ctx.token, `query($id: ID!) { getLoad(id: $id) { activeLoadCarrierId assignmentType } }`, { id: load })).getLoad
    expect(!after?.activeLoadCarrierId && after?.assignmentType !== 'OWN_ASSET', 'a refused call left an own-fleet leg behind')
    return 'unknown / inactive / typed second driver all refused; no leg written'
  })
}

async function cleanup(ctx) {
  const say = (message, good = true) => { line(good ? 'PASS' : 'FAIL', `cleanup: ${message}`); if (!good) process.exitCode = 1 }
  if (ctx.shipmentId) {
    try {
      const row = (await gql(ctx.token, `query($id: ID!) { getShipment(id: $id) { id voidedAt updatedAt } }`, { id: ctx.shipmentId })).getShipment
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: ctx.shipmentId, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = (await gql(ctx.token, `query($id: ID!) { getShipment(id: $id) { voidedAt } }`, { id: ctx.shipmentId })).getShipment
      say(`shipment ${ctx.shipmentId} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.customerId) {
    const row = (await gql(ctx.token, `query($id: ID!) { getCustomer(id: $id) { id updatedAt } }`, { id: ctx.customerId }).catch(() => ({}))).getCustomer
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${ctx.customerId} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function main() {
  if (!walk) { if (!(await inventory())) process.exitCode = 1; if (!flag('inventory')) console.log('(no --walk: nothing was called)'); return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAQ refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAQ refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAQ only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  const ts = Date.now()
  const email = `zz-aq-admin-${ts}@example.invalid`
  let made = false
  const ctx = { ts, shipmentId: null, loadId: null, customerId: null, roster: null }
  try {
    const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary ADMIN identity created')
    ctx.token = identity.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')
    ctx.roster = await loadRoster(ctx.token)

    const cust = await ctx.dir('UPSERT_CUSTOMER', {
      name: `ZZ AQ Customer ${ts}`, creditLimitCents: 100_000_000,
      contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AQ Contact', email: `zz-aq-${ts}@example.invalid`, types: [] }],
      billToParties: [{ id: `zz-aq-bt-${ts}`, name: 'ZZ AQ Bill To', isDefault: false }],
    })
    ctx.customerId = String((cust.customer ?? cust).id)
    const day = today()
    // A buildable, submitted shipment: only then does the shipment page carry the Load actions menu.
    let bundle = await ctx.ship('CREATE_SHIPMENT', { customerId: ctx.customerId })
    ctx.shipmentId = bundle.shipment.id
    bundle = await ctx.ship('SAVE_ORDER_FORM', {
      shipmentId: ctx.shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
      order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'Purchase order', value: `ZZAQ-${ts}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
      stops: [
        { type: 'pickup', name: 'ZZ AQ Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
        { type: 'delivery', name: 'ZZ AQ Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
      ],
      charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 150000, count: 1 }],
    })
    await ctx.ship('SUBMIT_ORDER', { shipmentId: ctx.shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
    bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: ctx.shipmentId })
    ctx.loadId = bundle.loads[0].id
    console.log('fixtures: 1 ZZ customer and 1 ZZ shipment (removed in cleanup); nothing is assigned to any driver')

    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-aq-', purpose: 'AQ verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
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
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAQ failed: ${err?.message ?? err}`); process.exit(1) })
}
