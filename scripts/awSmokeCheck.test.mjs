import { describe, expect, it } from 'vitest'
import { matchesKey, normalizeKey, parseCli, parseSince, run, summarizeTest, verdicts } from './awSmokeCheck.mjs'

const SINCE = '2026-11-09T13:00:00.000Z'
const empty = () => ({
  Shipment: [], Order: [], Load: [], LoadCarrier: [], LoadCharge: [], LoadFinancials: [], ProClaim: [], AuditLog: [],
  ShipmentNotice: [], FactoringItem: [], Invoice: [], CarrierBill: [], Customer: [], Location: [],
})

/** One built shipment: its rows, plus one assignment; `voided` applies the void the way the app does. */
function built({ voided = false, legs = 1 } = {}) {
  const t = empty()
  t.Shipment.push({ id: 'shp-1', number: '99002', status: 'DRAFT', customerName: 'TEST - DELETE ME', createdAt: '2026-11-09T13:05:00.000Z', ...(voided ? { voidedAt: '2026-11-09T13:20:00.000Z' } : {}) })
  t.Order.push({ id: 'ord-1', shipmentId: 'shp-1', arStatus: 'DOCS_NEEDED' })
  t.Load.push({ id: 'lod-1', shipmentId: 'shp-1', status: voided ? 'CANCELED' : 'BOOKED' })
  for (let i = 0; i < legs; i += 1) t.LoadCarrier.push({ id: `lcr-${i}`, shipmentId: 'shp-1', kind: 'OWN_ASSET', status: 'ACTIVE' })
  t.LoadCharge.push({ id: 'chg-1', shipmentId: 'shp-1' })
  t.LoadFinancials.push({ id: 'lod-1', shipmentId: 'shp-1' })
  t.ProClaim.push({ id: '99002', shipmentId: 'shp-1' })
  t.AuditLog.push({ entityId: 'shp-1', action: 'CREATE_SHIPMENT' }, { entityId: 'lcr-0', action: 'ASSIGN_ASSET' })
  if (voided) t.AuditLog.push({ entityId: 'shp-1', action: 'VOID_SHIPMENT' })
  return t
}

const verdictOf = (tables, expectation) => {
  const shipments = tables.Shipment.filter((s) => matchesKey(s, 'TEST - DELETE ME'))
  return verdicts(summarizeTest({ shipments, tables, since: SINCE }), expectation)
}
const failed = (rows) => rows.filter((r) => !r.ok && r.level === 'fail').map((r) => r.name)
const warned = (rows) => rows.filter((r) => !r.ok && r.level === 'warn').map((r) => r.name)

describe('key matching', () => {
  it('reads a retyped test name as the same key but never a real customer', () => {
    expect(normalizeKey(' test \u2013  delete me ')).toBe('test - delete me')
    expect(matchesKey({ customerName: 'Test - Delete Me' }, 'TEST - DELETE ME')).toBe(true)
    expect(matchesKey({ customerName: 'TEST - DELETE ME 2' }, 'TEST - DELETE ME')).toBe(false)
    expect(matchesKey({ customerName: 'ACME' }, '')).toBe(false)
  })
})

describe('arguments', () => {
  it('refuses a missing or unreadable --since and an unknown --expect', () => {
    expect(() => parseCli([])).toThrow(/--since/)
    expect(() => parseSince('yesterday')).toThrow(/not a time/)
    expect(() => parseCli(['--since', SINCE, '--expect', 'gone'])).toThrow(/live or voided/)
  })
  it('reads a bare date as UTC midnight', () => {
    expect(parseSince('2026-11-09')).toBe('2026-11-09T00:00:00.000Z')
  })
})

describe('verdicts', () => {
  it('a built and assigned test shipment passes the live check', () => {
    expect(failed(verdictOf(built(), 'live'))).toEqual([])
  })

  it('the live check fails when nothing was created', () => {
    expect(failed(verdictOf(empty(), 'live'))).toContain('test shipment found')
  })

  it('a second run on top of an uncleaned first one is caught', () => {
    const t = built()
    t.Shipment.push({ id: 'shp-2', number: '99003', status: 'DRAFT', customerName: 'test - delete me', createdAt: SINCE })
    expect(failed(verdictOf(t, 'live'))).toContain('one shipment per test run')
  })

  it('the voided check passes only once the void landed on the shipment, its load and the AP board', () => {
    expect(failed(verdictOf(built(), 'voided'))).toEqual(expect.arrayContaining(['shipment voided', 'every load CANCELED', 'a VOID_SHIPMENT audit row exists']))
    expect(failed(verdictOf(built({ voided: true }), 'voided'))).toEqual([])
  })

  it('a voided shipment still has its rows: cleanup is not a delete, so the row counts stay', () => {
    const shipments = built({ voided: true }).Shipment
    const s = summarizeTest({ shipments, tables: built({ voided: true }), since: SINCE })
    expect(s.rows).toMatchObject({ Shipment: 1, Order: 1, Load: 1, LoadCarrier: 1, ProClaim: 1 })
  })

  it('a leg still open on the AP board after the void fails the voided check', () => {
    const t = built({ voided: true })
    t.LoadCarrier[0].apOpen = 'OPEN'
    expect(failed(verdictOf(t, 'voided'))).toContain('no leg left on the AP board')
  })

  it('a notice on the test shipment or any ShipmentNotice / FactoringItem since the start fails', () => {
    const t = built()
    t.ShipmentNotice.push({ id: 'n1', shipmentId: 'shp-1', createdAt: '2026-11-09T13:06:00.000Z' })
    expect(failed(verdictOf(t, 'live'))).toEqual(expect.arrayContaining([
      'no ShipmentNotice (e-mail/notice) on the test shipment', 'no ShipmentNotice created since the start',
    ]))
    const f = built()
    f.FactoringItem.push({ id: 'f1', createdAt: '2026-11-09T13:30:00.000Z' })
    expect(failed(verdictOf(f, 'live'))).toEqual(['no FactoringItem created since the start'])
    const before = built()
    before.FactoringItem.push({ id: 'f0', createdAt: '2026-11-09T12:59:59.000Z' })
    expect(failed(verdictOf(before, 'live'))).toEqual([])
  })

  it('a Customer, Location or Invoice created since the start is a warning, not a failure: other staff work too', () => {
    const t = built()
    t.Customer.push({ id: 'c1', createdAt: '2026-11-09T13:01:00.000Z' })
    t.Location.push({ id: 'l1', createdAt: '2026-11-09T13:02:00.000Z' })
    t.Invoice.push({ id: 'i1', createdAt: '2026-11-09T13:03:00.000Z' })
    const rows = verdictOf(t, 'live')
    expect(failed(rows)).toEqual([])
    expect(warned(rows)).toEqual(expect.arrayContaining(['no Customer created since the start', 'no Location created since the start', 'no Invoice or CarrierBill created since the start']))
  })

  it('billing on the test shipment fails the check', () => {
    const t = built()
    t.Order[0].arStatus = 'UNPAID'
    expect(failed(verdictOf(t, 'live'))).toContain('nothing billed on the test shipment')
  })
})

describe('run', () => {
  const read = (tables, counter = 99002) => async () => ({ tables, settings: { nextShipmentNumber: counter, proScheme: 'NUMERIC' } })

  it('exits 0 and prints the counters for a clean voided run, naming no customer but the test key', async () => {
    const t = built({ voided: true })
    t.Shipment.push({ id: 'shp-real', number: '14000', status: 'DELIVERED', customerName: 'ACME FREIGHT', createdAt: '2026-01-01T00:00:00.000Z' })
    const lines = []
    const code = await run(['--since', SINCE, '--expect', 'voided'], { read: read(t), log: (l) => lines.push(l) })
    const out = lines.join('\n')
    expect(code).toBe(0)
    expect(out).toContain('nextShipmentNumber=99002')
    expect(out).toContain('99002')
    expect(out).not.toContain('ACME')
  })

  it('exits 1 when a check fails', async () => {
    const code = await run(['--since', SINCE], { read: read(empty()), log: () => {} })
    expect(code).toBe(1)
  })
})
