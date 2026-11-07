import { describe, expect, it } from 'vitest'
import { CARRIER_COLUMNS, parseCarrierRows, type CarrierColumnKey } from '../../../../src/lib/aljex/layouts/carriers'
import { CUSTOMER_COLUMNS, parseCustomerRows, type CustomerColumnKey } from '../../../../src/lib/aljex/layouts/customers'
import { runCarriersMaster, runCustomersMaster, type MasterRunEnv } from './directory'
import { MemoryStore } from './memoryStore'
import { makeStore } from './testKit'

// Synthetic rows only.
const CUST_HEADERS = Object.values(CUSTOMER_COLUMNS)
function cust(over: Partial<Record<CustomerColumnKey, string>>): string[] {
  const base: Record<CustomerColumnKey, string> = {
    name: 'Northwind Foods', address: '1 Main St', address2: '', city: 'Springfield', state: 'IL', zip: '62701', zip4: '', phone: '555-0100', fax: '', contact: 'Pat',
    contactExt: '', contactEmail: 'pat@example.com', contact2: '', contact2Ext: '', contact2Email: '', account: '900001', status: 'Y', customerType: '', termsDays: '',
    revType: 'B', creditLimit: '100.00', balanceDue: '0', invoiceBy: '1', eBillingEmail: 'ap@example.com', firstShipment: '01/05/26', lastShipment: '10/01/26', totalShipments: '3', ...over,
  }
  return (Object.keys(CUSTOMER_COLUMNS) as CustomerColumnKey[]).map((k) => base[k])
}
const CAR_HEADERS = Object.values(CARRIER_COLUMNS)
function car(over: Partial<Record<CarrierColumnKey, string>>): string[] {
  const base: Record<CarrierColumnKey, string> = {
    name: 'Blue Line Trucking', address: '9 Road', address2: '', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0111', fax: '', contact: 'Sam', payableTo: '',
    remitAddress: '', remitAddress2: '', remitCity: '', remitState: '', remitZip: '', remitZip4: '', phoneAccounting: '', isCarrier: 'Y', active: 'Y', mc: '700001',
    dot: '3000001', safetyRating: 'NONE', terms: '', quickPay: '', quickPayDays: '', quickPayPct: '', lastUpdate: '06/01/26', id: '900000001', factorId: '', ...over,
  }
  return (Object.keys(CARRIER_COLUMNS) as CarrierColumnKey[]).map((k) => base[k])
}

function env(store: MemoryStore): MasterRunEnv {
  return { store, runId: 'r1', counts: {}, findings: [], asOf: '2026-11-07' }
}
const dump = (store: MemoryStore, t: Parameters<MemoryStore['own']>[0]) => store.own(t)

describe('customers master apply', () => {
  const parsed = () => parseCustomerRows(CUST_HEADERS, [
    cust({ account: '900001' }),
    cust({ account: '900002', name: 'Fox Logistics', eBillingEmail: 'ivanfactoring@bcatcorp.com', lastShipment: '01/01/24' }),
    cust({ account: '900003', name: 'Old Dock Co', status: 'N' }),
    cust({ account: '100003', name: 'TEST CUSTOMER' }),
    cust({ account: '900004', name: 'Internal Billed', eBillingEmail: 'invoices@bcatcorp.com' }),
  ])

  it('creates customers by account, a Location for Status N, nothing for excluded; seeds billing; a second run changes nothing', async () => {
    const store = makeStore()
    const first = env(store)
    const rep = await runCustomersMaster(first, parsed())
    const customers = dump(store, 'customer')
    expect(customers.map((c) => c.aljexCode).sort()).toEqual(['900001', '900002', '900004'])
    const by = Object.fromEntries(customers.map((c) => [c.aljexCode, c]))
    expect(by['900001']).toMatchObject({ billingMethod: 'MANUAL', apEmail: 'ap@example.com', defaultDivisionKey: 'BROKERAGE', creditLimitCents: 10000, status: 'ACTIVE', legacyImported: true })
    expect(by['900001'].paymentTermsDays).toBeUndefined()
    expect(by['900002']).toMatchObject({ billingMethod: 'FACTOR', status: 'DORMANT' })
    expect(by['900002'].apEmail).toBeUndefined()
    expect(by['900004']).toMatchObject({ billingMethod: 'MANUAL' })
    expect(by['900004'].billingNeedsReview).toBeTruthy()
    expect(JSON.stringify(customers)).not.toContain('balance')
    expect(dump(store, 'location')).toHaveLength(1)
    expect(dump(store, 'location')[0]).toMatchObject({ aljexCode: '900003', name: 'Old Dock Co' })
    expect(rep.summary).toMatchObject({ customersCreated: 3, locationsCreated: 1, excluded: 1 })
    expect(first.counts.CUSTOMER).toMatchObject({ staged: 3, created: 3 })

    const second = env(store)
    const again = await runCustomersMaster(second, parsed())
    expect(again.summary).toMatchObject({ customersCreated: 0, customersMatched: 3, locationsCreated: 0, locationsMatched: 1 })
    expect(dump(store, 'customer')).toHaveLength(3)
  })

  it('a human-edited billing method is never overwritten by a later import', async () => {
    const store = makeStore()
    await runCustomersMaster(env(store), parsed())
    const id = dump(store, 'customer').find((c) => c.aljexCode === '900001')!.id as string
    await store.update('customer', id, { billingMethod: 'FACTOR', apEmail: '' })
    await runCustomersMaster(env(store), parsed())
    const row = dump(store, 'customer').find((c) => c.id === id)!
    expect(row.billingMethod).toBe('FACTOR')
    expect(row.apEmail).toBe('ap@example.com') // blank is filled, set values are not touched
  })

  it('the dry run over an overlay writes nothing to the base', async () => {
    const base = makeStore()
    const overlay = new MemoryStore({ tables: base.tables, now: () => base.now(), base })
    const rep = await runCustomersMaster(env(overlay), parsed())
    expect(rep.summary.customersCreated).toBe(3)
    expect(dump(base, 'customer')).toHaveLength(0)
    expect(dump(base, 'location')).toHaveLength(0)
  })

  it('a same-name customer without an Aljex account is reported, not merged and not matched on name', async () => {
    const store = makeStore()
    store.seed('customer', [{ id: 'cus-hand', name: 'Northwind Foods LLC', normalizedName: 'northwind foods', active: true }])
    const rep = await runCustomersMaster(env(store), parsed())
    expect(rep.summary.nameMatchesNotLinked).toBe(1)
    expect(dump(store, 'customer')).toHaveLength(4)
  })
})

describe('carriers master apply', () => {
  it('creates new carriers (inactive stays INACTIVE) and records merged ids as aliases', async () => {
    const store = makeStore()
    const parsed = parseCarrierRows(CAR_HEADERS, [
      car({ id: '900000001', mc: '700001', dot: '3000001', name: 'Blue Line', factorId: '123456789', quickPay: 'Y', quickPayDays: '10', quickPayPct: '2.00' }),
      car({ id: '900000002', mc: '700001', dot: '', name: 'Blue Line 2', lastUpdate: '01/01/20' }),
      car({ id: '900000003', mc: '700003', dot: '3000003', name: 'Red Co', active: 'N' }),
    ])
    const rep = await runCarriersMaster(env(store), parsed)
    const rows = dump(store, 'carrier')
    expect(rows).toHaveLength(2)
    const blue = rows.find((r) => r.mcNumber === '700001')!
    expect(blue).toMatchObject({ aljexCode: '900000001', aljexAliases: ['900000002'], status: 'PENDING', quickPayEligible: true, defaultQuickPayDays: 10 })
    expect(blue.internalNotes).toContain('factor 123456789')
    expect(rows.find((r) => r.mcNumber === '700003')).toMatchObject({ status: 'INACTIVE' })
    expect(rep.summary).toMatchObject({ created: 2, mergeGroups: 1, inactive: 1, withFactorId: 1 })
  })

  it('matches an existing carrier by MC/DOT first, then by Aljex id; never by name', async () => {
    const store = makeStore()
    store.seed('carrier', [
      { id: 'car-a', name: 'Totally Different Name', mcNumber: '700010', status: 'ACTIVE' },
      { id: 'car-b', name: 'Green Haul', aljexCode: '900000020', status: 'ACTIVE' },
      { id: 'car-c', name: 'Purple Lines', status: 'ACTIVE' },
    ])
    const parsed = parseCarrierRows(CAR_HEADERS, [
      car({ id: '900000010', mc: '0700010', dot: '3000010', name: 'Another Name' }),
      car({ id: '900000020', mc: '', dot: '', name: 'Green Haul Renamed' }),
      car({ id: '900000030', mc: '700030', dot: '3000030', name: 'Purple Lines' }),
    ])
    const run = env(store)
    const rep = await runCarriersMaster(run, parsed)
    const rows = Object.fromEntries(dump(store, 'carrier').map((r) => [r.id, r]))
    expect(rows['car-a']).toMatchObject({ aljexCode: '900000010', dotNumber: '3000010', name: 'Totally Different Name' })
    expect(rows['car-b'].name).toBe('Green Haul')
    expect(rows['car-c'].aljexCode).toBeUndefined() // same name, no MC/DOT/id link: a new carrier is created instead
    expect(dump(store, 'carrier')).toHaveLength(4)
    expect(rep.summary).toMatchObject({ matchedByMcDot: 1, matchedByAljexId: 1, created: 1, nameConflicts: 1 })
    expect(rep.review).toEqual([{ key: '900000010', reason: 'same MC/DOT as an existing carrier with a different name' }])
  })

  it('an MC and DOT that point at two different carriers is a conflict and writes nothing', async () => {
    const store = makeStore()
    store.seed('carrier', [{ id: 'car-a', name: 'A', mcNumber: '700040', status: 'ACTIVE' }, { id: 'car-b', name: 'B', dotNumber: '3000040', status: 'ACTIVE' }])
    const run = env(store)
    const rep = await runCarriersMaster(run, parseCarrierRows(CAR_HEADERS, [car({ id: '900000040', mc: '700040', dot: '3000040' })]))
    expect(rep.summary.conflicts).toBe(1)
    expect(run.counts.CARRIER).toMatchObject({ staged: 1, conflicts: 1 })
    expect(dump(store, 'carrier')).toHaveLength(2)
    expect(dump(store, 'carrier').every((c) => c.aljexCode === undefined)).toBe(true)
  })

  it('is idempotent: a second run matches everything and writes nothing', async () => {
    const store = makeStore()
    const parsed = () => parseCarrierRows(CAR_HEADERS, [car({ id: '900000001', mc: '700001', dot: '3000001' }), car({ id: '900000002', mc: '700001', dot: '', name: 'x', lastUpdate: '01/01/20' })])
    await runCarriersMaster(env(store), parsed())
    const before = JSON.stringify(dump(store, 'carrier'))
    const run = env(store)
    const rep = await runCarriersMaster(run, parsed())
    expect(rep.summary).toMatchObject({ created: 0, enriched: 0 })
    expect(run.counts.CARRIER).toMatchObject({ staged: 1, matched: 1 })
    expect(JSON.stringify(dump(store, 'carrier'))).toBe(before)
  })
})
