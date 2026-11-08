import { describe, it, expect } from 'vitest'
import { findDuplicates, analyze, exitCodeFor, loadOrigin, assertReadableSuffix, PROD_SUFFIX, DEV_SUFFIX } from './checkDevDuplicates.mjs'

const empty = { loads: [], shipments: [], proClaims: [], invoices: [], carrierBills: [], orders: [] }

describe('findDuplicates', () => {
  it('groups shared keys, ignores blank and missing keys, and sorts ids', () => {
    const rows = [
      { id: 'b', k: 'X1' }, { id: 'a', k: 'X1' }, { id: 'c', k: 'Y' },
      { id: 'd', k: '' }, { id: 'e', k: '   ' }, { id: 'f' }, { id: 'g', k: null },
    ]
    expect(findDuplicates(rows, (r) => r.k)).toEqual([{ key: 'X1', ids: ['a', 'b'] }])
  })
})

describe('analyze', () => {
  it('sees one PRO under two spellings as a duplicate (the way the app compares PROs)', () => {
    const r = analyze({
      ...empty,
      loads: [
        { id: 'l1', aljexId: '14547  ' },
        { id: 'l2', aljexId: 'PRO 14547' },
        { id: 'l3', aljexId: '99999' },
        { id: 'l4', aljexId: '' },
        { id: 'l5', aljexId: 'N/A' },
      ],
    })
    expect(r.duplicateGroups.loadAljexId).toBe(1)
    expect(r.counts.loadsWithPro).toBe(3)
    expect(r.counts.loadsBlankPro).toBe(2)
    expect(exitCodeFor(r)).toBe(1)
  })

  it('flags duplicate shipment numbers, load numbers, invoice numbers and per-carrier bill numbers', () => {
    const r = analyze({
      ...empty,
      shipments: [{ id: 's1', number: 'L100' }, { id: 's2', number: 'l100' }, { id: 's3', number: 'L101' }],
      loads: [{ id: 'a', aljexId: '1001', loadNumber: 'L100-1' }, { id: 'b', aljexId: '1002', loadNumber: 'L100-1' }],
      invoices: [{ id: 'INV-1', number: 'INV-1' }, { id: 'INV-1b', number: 'INV-1' }],
      carrierBills: [
        { id: 'x', carrierId: 'c1', billNumber: '77' },
        { id: 'y', carrierId: 'c1', billNumber: '77' },
        { id: 'z', carrierId: 'c2', billNumber: '77' },
      ],
    })
    expect(r.duplicateGroups).toEqual({ loadAljexId: 0, shipmentNumber: 1, loadNumber: 1, invoiceNumber: 1, carrierBill: 1 })
    expect(r.duplicates).toBe(4)
  })

  it('a clean, fully linked dataset is exit 0, even --strict', () => {
    const r = analyze({
      loads: [{ id: 'l1', aljexId: '1001', loadNumber: 'L1001-1', shipmentId: 's1', statusSource: 'BACKFILL' }],
      shipments: [{ id: 's1', number: 'L1001', source: 'BACKFILL' }],
      orders: [{ id: 'o1', shipmentId: 's1' }],
      proClaims: [{ id: '1001', loadId: 'l1', origin: 'LEGACY' }],
      invoices: [],
      carrierBills: [],
    })
    expect(r.duplicates).toBe(0)
    expect(Object.values(r.warnings)).toEqual([0, 0, 0, 0, 0])
    expect(exitCodeFor(r, { strict: true })).toBe(0)
  })

  it('counts orphans, claims with no load, claims keyed off a different PRO and unclaimed loads; only --strict fails on them', () => {
    const r = analyze({
      loads: [
        { id: 'l1', aljexId: '1001', shipmentId: 'gone' },
        { id: 'l2', aljexId: '1002', shipmentId: 's2' },
        { id: 'l3', aljexId: '1003' },
      ],
      shipments: [{ id: 's2', number: 'L1002' }],
      orders: [{ id: 'o1', shipmentId: 'gone' }, { id: 'o2' }, { id: 'o3', shipmentId: 's2' }],
      proClaims: [
        { id: '1001', loadId: 'l1' },
        { id: '1002', loadId: 'l2' },
        { id: 'OLDPRO', loadId: 'l3' },
        { id: 'ZZZ', loadId: 'missing' },
      ],
      invoices: [],
      carrierBills: [],
    })
    expect(r.warnings).toEqual({
      orphanOrders: 2,
      orphanLoads: 1,
      proClaimWithoutLoad: 1,
      proClaimKeyMismatch: 1,
      loadsWithProButNoClaim: 1,
    })
    expect(r.duplicates).toBe(0)
    expect(exitCodeFor(r)).toBe(0)
    expect(exitCodeFor(r, { strict: true })).toBe(3)
  })

  it('never puts ids or PROs in the aggregate fields (they live under detail only)', () => {
    const r = analyze({ ...empty, loads: [{ id: 'secret-id', aljexId: '4242' }, { id: 'secret-id-2', aljexId: '4242' }] })
    const { detail, ...aggregate } = r
    expect(JSON.stringify(aggregate)).not.toMatch(/secret-id|4242/)
    expect(detail.loadAljexId[0].ids).toEqual(['secret-id', 'secret-id-2'])
  })
})

describe('loadOrigin', () => {
  it('classifies a load by how it arrived, most specific first', () => {
    expect(loadOrigin({ legacyImported: true, shipmentId: 's', statusSource: 'BACKFILL' })).toBe('ALJEX_IMPORT')
    expect(loadOrigin({})).toBe('LEGACY_UNLINKED')
    expect(loadOrigin({ shipmentId: 's', statusSource: 'BACKFILL' })).toBe('BACKFILLED_LEGACY')
    expect(loadOrigin({ shipmentId: 's', statusSource: 'USER' })).toBe('TMS_CREATED')
  })
})

describe('assertReadableSuffix', () => {
  it('reads dev, refuses production and anything that is not an Amplify suffix', () => {
    expect(() => assertReadableSuffix(DEV_SUFFIX)).not.toThrow()
    expect(() => assertReadableSuffix(PROD_SUFFIX)).toThrow(/production/)
    expect(() => assertReadableSuffix('')).toThrow()
    expect(() => assertReadableSuffix('dev')).toThrow(/suffix/)
  })
})
