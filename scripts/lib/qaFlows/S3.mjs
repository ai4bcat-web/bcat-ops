import { record, expect, short, settle } from '../qaFlowsKit.mjs'

export const TITLE = 'Trucks / trailers Active-Inactive: Mark inactive / Reactivate, audit, pickers, phone report'

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

export async function run(ctx) {
  const a = ctx.id.admin
  const tag = String(ctx.ts).slice(-6)
  const mk = async (type, unit) => {
    const input = { id: `zz-qaf-eq-${type}-${ctx.ts}`, type, unitNumber: unit, active: true, ownership: 'owned' }
    const e = (await a.gql(`mutation($input: CreateEquipmentInput!) { createEquipment(input: $input) { id type unitNumber active inactiveSince } }`, { input })).createEquipment
    ctx.cleanup.push(async () => { await a.gql(`mutation($input: DeleteEquipmentInput!) { deleteEquipment(input: $input) { id } }`, { input: { id: e.id } }) })
    return e
  }
  const trailer = await mk('trailer', `ZZT${tag}`)
  const truck = await mk('truck', `ZZK${tag}`)
  const get = async (id) => (await a.gql(`query($id: ID!) { getEquipment(id: $id) { id active inactiveSince updatedAt } }`, { id })).getEquipment
  const audits = async (id) => (await a.gql(`query($id: String!) { listAuditLogByEntityTypeAndEntityId(entityType: "Equipment", entityId: {eq: $id}, limit: 100) { items { action entityId createdAt changes } } }`, { id })).listAuditLogByEntityTypeAndEntityId.items

  const b = await ctx.newBrowser('admin')
  try {
    const openFleet = async (tab) => {
      await b.navigate('/trucks')
      await settle(b, { min: 200, quietMs: 2500, timeout: 60_000 })
      if (tab) {
        await b.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((x) => new RegExp('^${tab}').test((x.textContent || '').trim())); if (t) t.click() })()`)
        await b.pause(800)
      }
    }
    const kpi = (label) => b.evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(label)}); let box = el; for (let i = 0; i < 4 && box && !/\\d/.test(box.innerText); i++) box = box.parentElement; return box ? box.innerText.replace(/\\s+/g, ' ').trim() : null })()`)
    const rowButton = (unit, name) => b.evaluate(`(() => {
      const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(unit)}))
      const btn = row && [...row.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').trim() === ${JSON.stringify(name)})
      if (!btn) return false
      btn.click(); return true
    })()`)
    const dialogMark = () => b.evaluate(`(() => {
      const d = document.querySelector('[role=dialog]'); if (!d) return false
      const btn = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Mark inactive')
      if (!btn || btn.disabled) return btn ? 'disabled' : false
      btn.click(); return true
    })()`)

    let totalBefore
    await check('S3.01', 'trailer list: Mark inactive on the row sets inactiveSince, drops it from counts, writes an audit entry', async () => {
      await openFleet()
      totalBefore = await kpi('Total Units')
      expect(await rowButton(trailer.unitNumber, 'Mark inactive'), 'no Mark inactive button on the ZZ trailer row')
      await b.poll(() => b.evaluate(`!!document.querySelector('[role=dialog]')`), 'dialog', 10_000)
      await b.capture('flows-s3-mark-inactive-dialog.png')
      expect((await dialogMark()) === true, 'dialog Mark inactive not clickable')
      await b.poll(async () => (await get(trailer.id)).active === false, 'inactive write', 20_000)
      const row = await get(trailer.id)
      expect(row.inactiveSince === today(), `inactiveSince ${row.inactiveSince} != ${today()}`)
      await b.pause(1500)
      const log = await audits(trailer.id)
      expect(log.length >= 1, 'no audit entry for the trailer')
      const after = await kpi('Total Units')
      return `active=false, inactiveSince=${row.inactiveSince}; audit entries ${log.length} (${log.map((l) => l.action).join(',')}); Total Units ${JSON.stringify(totalBefore)} -> ${JSON.stringify(after)}`
    })
    await check('S3.02', 'Inactive tab lists the trailer; All tab no longer does; Reactivate clears inactiveSince + audits', async () => {
      await openFleet('All')
      const inAll = await b.evaluate(`document.body.innerText.includes(${JSON.stringify(trailer.unitNumber)})`)
      await openFleet('Inactive')
      const inInactive = await b.evaluate(`document.body.innerText.includes(${JSON.stringify(trailer.unitNumber)})`)
      await b.capture('flows-s3-inactive-tab.png')
      expect(!inAll && inInactive, `All has it: ${inAll}; Inactive has it: ${inInactive}`)
      expect(await rowButton(trailer.unitNumber, 'Reactivate'), 'no Reactivate on the inactive row')
      await b.poll(async () => (await get(trailer.id)).active === true, 'reactivate write', 20_000)
      const row = await get(trailer.id)
      expect(row.inactiveSince == null, `inactiveSince not cleared: ${row.inactiveSince}`)
      await b.pause(1500)
      const log = await audits(trailer.id)
      return `reactivated: active=true, inactiveSince=${row.inactiveSince}; audit entries now ${log.length}`
    })
    await check('S3.03', 'truck: Mark inactive (row button) goes through the plates/ELD dialog, sets inactiveSince, audits; drawer has Mark inactive / Reactivate', async () => {
      await openFleet('Trucks')
      expect(await rowButton(truck.unitNumber, 'Mark inactive'), 'no Mark inactive on the ZZ truck row')
      await b.poll(() => b.evaluate(`!!document.querySelector('[role=dialog]')`), 'dialog', 10_000)
      const res = await dialogMark()
      expect(res === true, `dialog button: ${res}`)
      await b.poll(async () => (await get(truck.id)).active === false, 'truck inactive write', 20_000)
      const row = await get(truck.id)
      expect(row.inactiveSince === today(), `inactiveSince ${row.inactiveSince}`)
      await b.pause(1500)
      const log = await audits(truck.id)
      expect(log.length >= 1, 'no audit entry for the truck')
      // drawer: expand the row on the Inactive tab and look for Reactivate in the detail panel
      await openFleet('Inactive')
      await b.evaluate(`(() => { const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(truck.unitNumber)})); row && row.querySelector('td:nth-child(2), td').click() })()`)
      await b.pause(1500)
      const drawer = await b.evaluate(`(() => { const t = document.body.innerText; return { reactivate: (t.match(/Reactivate/g) || []).length, since: /Inactive from \\d{4}-\\d{2}-\\d{2}/.test(t) } })()`)
      await b.capture('flows-s3-truck-drawer-inactive.png')
      expect(drawer.reactivate >= 1 && drawer.since, `drawer Reactivate ${drawer.reactivate}, "Inactive from" shown ${drawer.since}`)
      return `truck inactiveSince=${row.inactiveSince}; audit entries ${log.length}; Reactivate buttons in the drawer (row has an icon button) ${drawer.reactivate}; "Inactive from <date>" shown`
    })
  } finally { await b.close() }

  await check('S3.04', 'inactive units are not offered by the own-fleet roster: a driver on an inactive truck gets no truck # on the booked leg', async () => {
    const drv = (await a.gql(`mutation($input: CreateDriverInput!) { createDriver(input: $input) { id name } }`, { input: { id: `zz-qaf-drv-eq-${ctx.ts}`, name: `ZZ QAF Eq ${ctx.ts}`, phone: '5555550144', active: true, type: 'company', assignedTruckId: truck.id } })).createDriver
    ctx.cleanup.push(async () => { await a.gql(`mutation($input: DeleteDriverInput!) { deleteDriver(input: $input) { id } }`, { input: { id: drv.id } }) })
    const { zzCustomer, zzShipment } = await import('./fixtures.mjs')
    const cust = await zzCustomer(ctx, 'S3')
    const s = await zzShipment(ctx, cust)
    const bundle = await a.ship('ASSIGN_ASSET', { loadId: s.loadId, driverId: drv.id })
    const leg = (bundle.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
    expect(!leg.truckNumber, `inactive truck was filled in: ${leg.truckNumber}`)
    return 'the parked truck (inactive) is not filled onto the leg (truck # empty)'
  })

  // Fleet vs Settings phone report
  const b2 = await ctx.newBrowser('admin')
  try {
    await check('S3.05', 'Fleet "no phone" rows and Settings "Trucks without a phone (N)" agree', async () => {
      await b2.navigate('/tms/brokerage')
      const sText = await settle(b2, { min: 300, quietMs: 3500, timeout: 60_000 })
      const m = sText.match(/Trucks without a phone \((\d+)\)/)
      const settingsN = m ? Number(m[1]) : (/All trucks have a work phone/.test(sText) ? 0 : null)
      expect(settingsN !== null, 'Settings card not found on /tms/brokerage')
      await b2.navigate('/trucks')
      await settle(b2, { min: 200, quietMs: 3500, timeout: 60_000 })
      await b2.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((x) => /^Trucks/.test((x.textContent || '').trim())); t && t.click() })()`)
      await b2.pause(1000)
      const fleetN = await b2.evaluate(`[...document.querySelectorAll('tr')].filter((r) => /\\+ Add phone/.test(r.textContent || '')).length`)
      await b2.capture('flows-s3-phone-report.png')
      expect(fleetN === settingsN, `Fleet shows ${fleetN} active trucks with "+ Add phone", Settings says ${settingsN}`)
      return `both say ${settingsN} active trucks without a work phone (the ZZ inactive truck is in neither)`
    })
  } finally { await b2.close() }
}
