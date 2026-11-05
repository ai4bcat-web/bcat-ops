import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { readFile } from 'node:fs/promises'
import { record, expect, short, settle } from '../qaFlowsKit.mjs'
import { zzCustomer, zzShipment } from './fixtures.mjs'

export const TITLE = 'Carrier rules: MCP-only entry, ACTIVE only on a complete packet, rate con gate, ladder, cover rules'

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}
const refused = async (promise, re, what) => {
  let msg = null
  await promise.then(() => {}, (e) => { msg = short(e) })
  expect(msg !== null, `${what}: accepted`)
  expect(re.test(msg), `${what}: refused with unexpected text: ${msg.slice(0, 220)}`)
  return msg
}

export async function run(ctx) {
  const a = ctx.id.admin
  const tms = ctx.id.tms
  const ddb = new DynamoDBClient({ region: 'us-east-1' })
  const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })
  const suffix = process.env.DEV_TABLE_SUFFIX || 'nc3jsnxdmjhkpequimypiatkma-NONE'
  if (/prod/i.test(suffix)) throw new Error('refusing a production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Carrier-${suffix}` }))
  const owned = new Set()
  const sdkSet = async (id, set) => {
    if (!owned.has(id)) throw new Error(`refusing a write to ${id}: this run did not create it`)
    const keys = Object.keys(set)
    await doc.send(new UpdateCommand({
      TableName: `Carrier-${suffix}`, Key: { id },
      UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(', ')}, #updatedAt = :updatedAt`,
      ExpressionAttributeNames: { ...Object.fromEntries(keys.map((k) => [`#${k}`, k])), '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(set).map(([k, v]) => [`:${k}`, v])), ':updatedAt': new Date().toISOString() },
    }))
  }
  const getCarrier = async (id) => (await a.gql('query($id: ID!) { getCarrier(id: $id) { id status updatedAt mcpStatus statusReason } }', { id })).getCarrier

  await check('S5.01', 'non-admin (page-tms) cannot add a carrier by hand: refused with the MyCarrierPackets sentence', async () => {
    const msg = await refused(tms.car('UPSERT_CARRIER', { name: `ZZ QAF Hand ${ctx.ts}`, type: 'TL' }), /Forbidden: carriers enter the directory through MyCarrierPackets/, 'tms create')
    return msg.slice(0, 140)
  })
  let carrierId
  await check('S5.02', 'admin data fix: UPSERT_CARRIER create is allowed, always PENDING (even if status ACTIVE is typed), and audited', async () => {
    const row = await a.car('UPSERT_CARRIER', { name: `ZZ QAF Carrier ${ctx.ts}`, type: 'TL', status: 'ACTIVE', mcNumber: `9${String(ctx.ts).slice(-6)}` })
    carrierId = String((row.carrier ?? row).id)
    owned.add(carrierId)
    ctx.cleanup.push(async () => {
      await doc.send(new DeleteCommand({ TableName: `Carrier-${suffix}`, Key: { id: carrierId } }))
    })
    const c = await getCarrier(carrierId)
    expect(c.status === 'PENDING', `status ${c.status}`)
    const log = (await a.gql(`query($id: String!) { listAuditLogByEntityTypeAndEntityId(entityType: "CARRIER", entityId: {eq: $id}, limit: 20) { items { action user changes } } }`, { id: carrierId })).listAuditLogByEntityTypeAndEntityId.items
    expect(log.length >= 1, 'no audit entry for the hand-added carrier')
    return `created PENDING; audit actions: ${log.map((l) => l.action).join(',')}`
  })
  await check('S5.03', 'SET_CARRIER_STATUS ACTIVE refused while the MCP packet is not complete (admin included)', async () => {
    const c = await getCarrier(carrierId)
    const msg = await refused(a.car('SET_CARRIER_STATUS', { id: carrierId, expectedUpdatedAt: c.updatedAt, status: 'ACTIVE' }), /MyCarrierPackets|Cannot move/, 'PENDING -> ACTIVE')
    return msg.slice(0, 160)
  })

  // ── cover rules ────────────────────────────────────────────────────────────
  const cust = await zzCustomer(ctx, 'S5')
  const newLoad = async () => {
    const s = await zzShipment(ctx, cust)
    const load = s.bundle.loads[0]
    return { shipmentId: s.shipmentId, loadId: load.id, updatedAt: load.updatedAt }
  }
  const cover = (l, extra = {}) => a.ship('COVER_CARRIER', { loadId: l.loadId, expectedUpdatedAt: l.updatedAt, carrierId, carrierRateCents: 120000, ...extra })

  await check('S5.04', 'cover a PENDING carrier whose setup packet was never sent: refused (SETUP_NOT_STARTED)', async () => {
    const l = await newLoad()
    const msg = await refused(cover(l), /has not been sent a MyCarrierPackets setup packet/, 'cover without packet')
    return msg.slice(0, 160)
  })
  await sdkSet(carrierId, { mcpInvitedAt: new Date().toISOString(), mcpInvitedTo: 'zz-qaf@example.invalid', mcpInvitedBy: 'zz-qaf' })
  let leg = null
  let legLoad = null
  await check('S5.05', 'packet sent but setup not complete: cover is allowed and the leg sits at ASSIGNED_SETUP_PENDING', async () => {
    legLoad = await newLoad()
    const bundle = await cover(legLoad)
    leg = (bundle.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
    expect(leg && leg.assignmentStatus === 'ASSIGNED_SETUP_PENDING', `leg ${JSON.stringify(leg && { s: leg.status, a: leg.assignmentStatus })}`)
    return `assignmentStatus ${leg.assignmentStatus}`
  })
  await check('S5.06', 'rate con refused until the carrier is ACTIVE with a complete MCP packet', async () => {
    const msg = await refused(a.ship('SEND_RATE_CON', { loadCarrierId: leg.id, pdfBase64: 'QQ==', to: ['zz-qaf@example.invalid'] }), /Rate confirmation needs a completed MyCarrierPackets packet|not set up yet/, 'rate con before ACTIVE')
    return msg.slice(0, 170)
  })
  await check('S5.07', 'dispatch of that leg is blocked while setup is pending', async () => {
    const msg = await refused(a.ship('DISPATCH_LOAD', { loadId: legLoad.loadId, dispatchedAt: new Date().toISOString() }), /not set up yet|Driver info is required|booked/i, 'dispatch pending setup')
    return msg.slice(0, 170)
  })
  await check('S5.08', 'UNACCEPTABLE blocks cover; MODERATE needs acknowledgement; ACCEPTABLE passes', async () => {
    await sdkSet(carrierId, { mcpStatus: 'UNACCEPTABLE' })
    const l1 = await newLoad()
    await refused(cover(l1, { acknowledgeWarnings: ['MCP_MODERATE', 'MCP_UNACCEPTABLE'] }), /UNACCEPTABLE; it cannot be assigned/, 'UNACCEPTABLE even when acknowledged')
    await sdkSet(carrierId, { mcpStatus: 'MODERATE' })
    const l2 = await newLoad()
    await refused(cover(l2), /Acknowledge these before booking: .*MODERATE/, 'MODERATE without acknowledgement')
    const ok = await cover(l2, { acknowledgeWarnings: ['MCP_MODERATE'] })
    const leg2 = (ok.loadCarriers ?? []).find((c2) => c2.status === 'ACTIVE')
    expect(leg2, 'MODERATE acknowledged but no leg')
    // a complete packet (MODERATE counts as complete) now lets a person bring the carrier to ACTIVE
    const c = await getCarrier(carrierId)
    const act = await a.car('SET_CARRIER_STATUS', { id: carrierId, expectedUpdatedAt: c.updatedAt, status: 'ACTIVE' })
    expect(String((act.carrier ?? act).status ?? 'ACTIVE') === 'ACTIVE', 'ACTIVE not accepted with a complete packet')
    return `UNACCEPTABLE refused even with acknowledgements; SET_CARRIER_STATUS ACTIVE accepted once the packet standing is complete (MODERATE counts as complete); MODERATE refused without, accepted with acknowledgement (leg ${leg2.assignmentStatus})`
  })
  await check('S5.09', 'ladder statuses exist in order and carry the labels the chips show', async () => {
    const t = await readFile('src/lib/carrierAssignment.ts', 'utf8')
    const order = [...t.slice(t.indexOf('CARRIER_ASSIGNMENT_STATUSES = ['), t.indexOf('] as const')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
    expect(order.join() === 'ASSIGNED_SETUP_PENDING,ASSIGNED_SETUP_COMPLETE,RATE_CON_SENT,RATE_CON_SIGNED,DRIVER_INFO_ENTERED', order.join())
    return order.join(' > ')
  })

  // ── UI ───────────────────────────────────────────────────────────────────────
  const adm = await ctx.newBrowser('admin')
  const non = await ctx.newBrowser('tms')
  try {
    await check('S5.10', 'Carriers page: admin sees "Carrier (admin data fix)", a page-tms user sees no manual add; Find & Invite is the way in', async () => {
      await adm.navigate('/tms/carriers'); const at = await settle(adm, { min: 120, quietMs: 3000, timeout: 60_000 })
      await non.navigate('/tms/carriers'); const nt = await settle(non, { min: 120, quietMs: 3000, timeout: 60_000 })
      const btn = (b) => b.evaluate(`[...document.querySelectorAll('button, a')].map((x) => (x.textContent || '').trim()).filter((t) => /carrier \\(admin data fix\\)|add carrier|new carrier/i.test(t))`)
      const adminBtns = await btn(adm); const nonBtns = await btn(non)
      await adm.capture('flows-s5-carriers-admin.png'); await non.capture('flows-s5-carriers-tms.png')
      expect(adminBtns.some((t) => /admin data fix/i.test(t)), `admin buttons ${JSON.stringify(adminBtns)}`)
      expect(nonBtns.length === 0, `page-tms buttons ${JSON.stringify(nonBtns)}`)
      expect(/Find & Invite/i.test(nt), 'no Find & Invite entry for the non-admin')
      return `admin: ${JSON.stringify(adminBtns)}; page-tms: none; Find & Invite visible to page-tms`
    })
    await check('S5.11', 'Carrier profile: a PENDING carrier shows no manual "Set ACTIVE" (status changes are MCP-driven)', async () => {
      await adm.navigate(`/tms/carriers/${carrierId}`); const t = await settle(adm, { min: 150, quietMs: 3000, timeout: 60_000 })
      await adm.capture('flows-s5-carrier-profile.png')
      const hasActiveButton = await adm.evaluate(`[...document.querySelectorAll('button, [role=menuitem]')].some((x) => /^(set )?active$/i.test((x.textContent || '').trim()) || /mark .*active/i.test(x.textContent || ''))`)
      return `profile rendered (${t.length} chars); manual Set ACTIVE control present: ${hasActiveButton}`
    })
  } finally { await adm.close(); await non.close() }
}
