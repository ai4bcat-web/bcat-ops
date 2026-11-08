import { randomUUID } from 'node:crypto'
import { record, expect, short, settle } from '../qaFlowsKit.mjs'
import { zzCustomer, zzShipment } from './fixtures.mjs'

export const TITLE = 'Ivan Cartage drivers come from Driver records; brokered carriers keep free text; dispatch gate'

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}
const refused = async (promise, re, what) => {
  let msg = null
  await promise.then(() => {}, (e) => { msg = short(e) })
  expect(msg !== null, `${what}: accepted`)
  expect(re.test(msg), `${what}: refused with unexpected text: ${msg.slice(0, 200)}`)
  return msg
}

export async function run(ctx) {
  const a = ctx.id.admin
  const cust = await zzCustomer(ctx, 'S2')
  const own = await zzShipment(ctx, cust)
  const brk1 = await zzShipment(ctx, cust)
  const brk2 = await zzShipment(ctx, cust)

  const mkDriver = async (label, active, extra = {}) => {
    const input = { id: `zz-qaf-drv-${label}-${ctx.ts}`, name: `ZZ QAF ${label} ${ctx.ts}`, phone: '5555550142', active, type: 'company', ...extra }
    const d = (await a.gql(`mutation($input: CreateDriverInput!) { createDriver(input: $input) { id name active } }`, { input })).createDriver
    ctx.cleanup.push(async () => { await a.gql(`mutation($input: DeleteDriverInput!) { deleteDriver(input: $input) { id } }`, { input: { id: d.id } }) })
    return d
  }
  const live = await mkDriver('Active', true)
  const parked = await mkDriver('Inactive', false)
  const broker = await mkDriver('Broker', true, { type: 'broker' })

  await check('S2.01', 'ASSIGN_ASSET refuses unknown / inactive / broker-placeholder / typed second driver (nothing written)', async () => {
    await refused(a.ship('ASSIGN_ASSET', { loadId: own.loadId, driverId: `zz-none-${ctx.ts}` }), /Driver not found/, 'unknown')
    await refused(a.ship('ASSIGN_ASSET', { loadId: own.loadId, driverId: parked.id }), /inactive/i, 'inactive')
    await refused(a.ship('ASSIGN_ASSET', { loadId: own.loadId, driverId: broker.id }), /placeholder for brokered/, 'broker')
    await refused(a.ship('ASSIGN_ASSET', { loadId: own.loadId, driverId: live.id, driver2: { name: 'ZZ Typed', phone: '5550100' } }), /typed driver name is not accepted/, 'typed driver2')
    const load = (await a.gql('query($id: ID!) { getLoad(id: $id) { assignmentType activeLoadCarrierId } }', { id: own.loadId })).getLoad
    expect(!load.activeLoadCarrierId, 'a refused call left a leg')
    return 'unknown, inactive, broker placeholder and typed driver2 all refused before any write'
  })
  await check('S2.02', 'Ivan Cartage cannot be typed as a carrier name (ASSIGN_CARRIER) and a typed driver on an Ivan Cartage name is refused', async () => {
    const msg = await refused(a.ship('ASSIGN_CARRIER', { loadId: own.loadId, carrierName: 'Ivan Cartage', driverName: 'ZZ Typed Driver' }), /own fleet/i, 'typed Ivan Cartage')
    return `refused: "${msg.slice(-120)}"`
  })
  await check('S2.03', 'dispatch of an own-fleet load with no driver is blocked with the driver sentence', async () => {
    await refused(a.ship('DISPATCH_LOAD', { loadId: own.loadId, dispatchedAt: new Date().toISOString() }), /driver|booked/i, 'dispatch without driver')
    return 'refused'
  })
  let ownLeg = null
  await check('S2.04', 'ASSIGN_ASSET with an active roster driver books the leg; name/phone are taken from the record', async () => {
    const bundle = await a.ship('ASSIGN_ASSET', { loadId: own.loadId, driverId: live.id })
    const leg = (bundle.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
    expect(leg && leg.kind === 'OWN_ASSET', `no OWN_ASSET leg: ${JSON.stringify(Object.keys(bundle))}`)
    expect(leg.driverId === live.id && leg.driverName === live.name, 'leg driver is not the record')
    ownLeg = leg
    return `leg kind ${leg.kind}; driver from record: name ${Boolean(leg.driverName)}, phone ${Boolean(leg.driverPhone)}, truck ${Boolean(leg.truckNumber)}, trailer ${Boolean(leg.trailerNumber)}`
  })
  await check('S2.05', 'own-fleet leg cannot be edited with typed driver fields (UPDATE_LOAD_CARRIER_DETAILS refuses OWN_ASSET)', async () => {
    await refused(a.ship('UPDATE_LOAD_CARRIER_DETAILS', { loadCarrierId: ownLeg.id, expectedUpdatedAt: ownLeg.updatedAt, driverName: 'ZZ Typed' }), /ASSIGN_ASSET/, 'edit own leg')
  })
  await check('S2.06', 'brokered carrier (ASSIGN_CARRIER by name): free-text driver accepted; dispatch blocked until all four fields', async () => {
    const b1 = await a.ship('ASSIGN_CARRIER', { loadId: brk1.loadId, carrierName: `ZZ QAF Brokered ${ctx.ts}`, driverName: 'ZZ Typed Driver', driverPhone: '5555550143', truckNumber: 'ZT1' })
    const leg = (b1.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
    expect(leg && leg.driverName === 'ZZ Typed Driver', 'typed driver not kept on a brokered leg')
    const msg = await refused(a.ship('DISPATCH_LOAD', { loadId: brk1.loadId, dispatchedAt: new Date().toISOString() }), /Driver info is required before dispatch: enter the .*trailer/i, 'dispatch with 3 of 4 fields')
    const b2 = await a.ship('UPDATE_LOAD_CARRIER_DETAILS', { loadCarrierId: leg.id, expectedUpdatedAt: leg.updatedAt, trailerNumber: 'ZTR1' })
    const ok = await a.ship('DISPATCH_LOAD', { loadId: brk1.loadId, dispatchedAt: new Date().toISOString() })
    return `typed driver kept; dispatch refused with "${msg.slice(-70)}"; after the fourth field dispatch ${ok ? 'went through' : '?'}`
  })
  await check('S2.07', 'own-fleet dispatch: what the server requires of a roster driver with no truck/trailer on the record', async () => {
    let msg = ''
    await a.ship('DISPATCH_LOAD', { loadId: own.loadId, dispatchedAt: new Date().toISOString() }).then(() => { msg = 'DISPATCHED' }, (e) => { msg = short(e) })
    if (msg === 'DISPATCHED') {
      record('PARTIAL', 'S2.07', 'own-fleet dispatch is allowed with a roster driver that has no truck # / trailer # on the record', 'brokered legs require all four fields; OWN_ASSET legs require only the driver (assertOwnAssetDriver); truck/trailer are filled from the record when it has them')
      return 'recorded PARTIAL above'
    }
    return `blocked: ${msg.slice(0, 160)}`
  })

  // ── Browser: pickers list only active drivers with name / phone / truck / trailer ─────────
  const b = await ctx.newBrowser('admin')
  try {
    await check('S2.08', 'Book Ivan Cartage dialog: select of active drivers, no free text, ZZ active listed with phone, inactive/broker absent', async () => {
      await b.navigate(`/tms/shipments/${brk2.shipmentId}`)
      await settle(b, { min: 300, quietMs: 2500 })
      await b.waitFor('button[aria-label="Load actions"]', 40_000)
      await b.click({ selector: 'button[aria-label="Load actions"]', real: true })
      await b.pause(500)
      await b.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find((e) => /Book Ivan Cartage/i.test(e.textContent)).click()`)
      await b.waitFor('[data-testid="assign-driver-select"]', 20_000)
      await b.poll(() => b.evaluate(`document.querySelector('[data-testid="assign-driver-select"]').options.length > 3`), 'roster', 30_000)
      const facts = await b.evaluate(`(() => {
        const s = document.querySelector('[data-testid="assign-driver-select"]')
        const labels = [...s.options].map((o) => o.textContent)
        return { tag: s.tagName, n: labels.length - 1, active: labels.filter((l) => l.includes('ZZ QAF Active')).length, inactive: labels.filter((l) => l.includes('ZZ QAF Inactive')).length, broker: labels.filter((l) => l.includes('ZZ QAF Broker')).length,
          activeLabel: labels.find((l) => l.includes('ZZ QAF Active')) || '', typed: !!document.querySelector('input[aria-label="Driver"]'),
          withPhone: labels.filter((l) => /\\(\\d{3}\\)|\\d{3}[-. ]\\d{4}/.test(l)).length, withTruck: labels.filter((l) => /Truck /.test(l)).length, withTrailer: labels.filter((l) => /Trailer /.test(l)).length }
      })()`)
      await b.capture('flows-s2-assign-driver-dialog.png')
      expect(facts.tag === 'SELECT' && !facts.typed, 'typable driver control')
      expect(facts.active === 1 && facts.inactive === 0 && facts.broker === 0, `active ${facts.active} inactive ${facts.inactive} broker ${facts.broker}`)
      expect(/\(\d{3}\)|\d{3}[-. ]\d{4}/.test(facts.activeLabel), `ZZ active label lacks the phone: ${facts.activeLabel}`)
      await b.evaluate(`document.querySelector('.tms-dialog-close')?.click()`)
      return `select with ${facts.n} options; ZZ active listed with phone, inactive 0, broker placeholder 0; ${facts.withTruck} options show a truck, ${facts.withTrailer} a trailer, ${facts.withPhone} a phone`
    })
    await check('S2.09', 'Carrier tab of the shipment (own-fleet leg) shows the driver as a record, not an input', async () => {
      await b.navigate(`/tms/shipments/${own.shipmentId}?tab=carrier`)
      const text = await settle(b, { min: 300, quietMs: 2500 })
      const typedInputs = await b.evaluate(`[...document.querySelectorAll('input')].filter((i) => /driver/i.test(i.getAttribute('aria-label') || '')).length`)
      await b.capture('flows-s2-carrier-tab.png')
      expect(typedInputs === 0, `${typedInputs} typable driver inputs on an own-fleet leg`)
      return `typable driver inputs: 0; page mentions the ZZ driver: ${text.includes('ZZ QAF Active')}`
    })
    await check('S2.10', 'Create-shipment form: own-fleet Driver 1/2 are selects limited to active drivers', async () => {
      await b.navigate('/tms/shipments/new')
      // Step AR: the Carrier card starts collapsed; Assign opens the picker that offers Ivan Cartage.
      await b.waitFor('[data-testid="carrier-assign"]', 90_000)
      await b.evaluate(`document.querySelector('[data-testid="carrier-assign"]').click()`)
      await b.waitFor('[data-testid="carrier-own-fleet"]', 15_000)
      await b.evaluate(`document.querySelector('[data-testid="carrier-own-fleet"]').click()`)
      await b.waitFor('[data-testid="f-carrier-driver1"]', 15_000)
      await b.poll(() => b.evaluate(`document.querySelector('[data-testid="f-carrier-driver1"]').options.length > 3`), 'roster', 30_000)
      const f = await b.evaluate(`(() => {
        const sels = [document.querySelector('[data-testid="f-carrier-driver1"]')]
        const s = document.querySelector('[data-testid="f-carrier-driver1"]')
        const labels = [...s.options].map((o) => o.textContent)
        return { tags: sels.map((x) => x.tagName), inactive: labels.filter((l) => l.includes('ZZ QAF Inactive')).length, active: labels.filter((l) => l.includes('ZZ QAF Active')).length,
          typed: [...document.querySelectorAll('input')].filter((i) => /^Driver [12]$/.test(i.getAttribute('aria-label') || '')).length, driver2Fields: [...document.querySelectorAll('input')].filter((i) => /^Driver 2/.test(i.getAttribute('aria-label') || '')).length }
      })()`)
      await b.capture('flows-s2-form-own-fleet.png')
      expect(f.tags.every((t) => t === 'SELECT') && f.typed === 0 && f.driver2Fields === 0 && f.inactive === 0 && f.active === 1, JSON.stringify(f))
      return `driver controls ${f.tags.join(',')}; typable Driver inputs 0; Driver 2 fields not offered for own fleet; ZZ active listed once, ZZ inactive 0`
    })
  } finally { await b.close() }
}
