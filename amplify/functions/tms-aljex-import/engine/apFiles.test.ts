import { describe, expect, it } from 'vitest'
import { apAgingCsv, activeCsv, apExpectedCsv, FIXTURE_AP_BILLS, FIXTURE_AP_TOTAL_CENTS, FIXTURE_VENDORS, fixtureBills } from '../../../../src/lib/aljex/layouts/apFilesFixture'
import { parseApAgingCsv } from '../../../../src/lib/aljex/layouts/apAging'
import { runApFiles } from './apFiles'
import type { MemoryStore } from './memoryStore'
import { reconcileAp } from './reconcile'
import { makeStore } from './testKit'

const CUTOFF = '2026-11-07'

/** A target holding the 67 fixture loads, each with a CARRIER leg, plus the five vendors' carriers. */
function seeded(opts: { skipPros?: string[]; legStatus?: Record<string, string> } = {}): MemoryStore {
  const store = makeStore()
  store.seed(
    'carrier',
    Array.from({ length: FIXTURE_VENDORS }, (_, v) => ({ id: `car-${v}`, name: `ZZ Vendor ${v}`, aljexCode: String(900000001 + v), factorPaymentMethodId: v === 0 ? 'pm-factor-0' : undefined })),
  )
  for (const b of fixtureBills()) {
    if (opts.skipPros?.includes(b.pro)) continue
    const v = Number(b.vendorId) - 900000001
    store.seed('load', [{ id: `lod-${b.pro}`, aljexId: b.pro, shipmentId: `shp-${b.pro}`, activeLoadCarrierId: `lcr-${b.pro}`, customer: 'ZZ CUSTOMER', carrierName: `ZZ VENDOR ${v}`, originName: 'ZZ SHIPPER', originCity: 'ZZTOWN, WI', destinationName: 'ZZ CONSIGNEE', destinationCity: 'ZZVILLE, NY' }])
    store.seed('loadCarrier', [{ id: `lcr-${b.pro}`, loadId: `lod-${b.pro}`, shipmentId: `shp-${b.pro}`, carrierId: `car-${v}`, kind: 'CARRIER', apStatus: opts.legStatus?.[b.pro] }])
    store.seed('loadFinancials', [{ id: `lod-${b.pro}`, customerRateCents: 175_000, carrierRateCents: 130_000 }])
  }
  return store
}

const openBills = (store: MemoryStore) => store.own('carrierBill').filter((b) => b.apOpen === 'OPEN')
const sumCents = (rows: Array<Record<string, unknown>>, k: string) => rows.reduce((n, r) => n + (r[k] as number), 0)

describe('AP aging import and reconciliation', () => {
  it('writes the 67 bills as open, unpaid and carried over; the reconciliation ties to $83,407.20 to the cent', async () => {
    const store = seeded()
    const { report } = await runApFiles(store, { runId: 'run1', cutoff: CUTOFF, files: { apAging: apAgingCsv() } })
    expect(report.apAging).toMatchObject({ bills: FIXTURE_AP_BILLS, totalCents: FIXTURE_AP_TOTAL_CENTS, created: FIXTURE_AP_BILLS, unresolved: [] })

    const bills = store.own('carrierBill')
    expect(bills).toHaveLength(FIXTURE_AP_BILLS)
    expect(sumCents(bills, 'balanceCents')).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(bills.every((b) => b.paidCents === 0 && b.status === 'TO_BE_PAID' && b.apOpen === 'OPEN')).toBe(true)
    expect(bills.every((b) => (b.approvalWarnings as string[]).includes('LEGACY_IMPORT') && String(b.note).startsWith('Carried over from Aljex'))).toBe(true)

    const first = bills.find((b) => b.billNumber === '900001-900000001')!
    expect(first).toMatchObject({ aljexVendorInvoiceRef: 'LINE', aljexPayMethod: 'CHECK', payeeKind: 'FACTOR', paymentMethodId: 'pm-factor-0', carrierId: 'car-0' })
    expect(bills.find((b) => b.billNumber === '900002-900000002')).toMatchObject({ aljexPayMethod: 'DIRECT_DEPOSIT', aljexVendorInvoiceRef: '900002' })
    expect(bills.find((b) => b.billNumber === '900051-900000001')).toMatchObject({ payeeKind: 'CARRIER' })
    expect(store.own('loadCarrier').filter((l) => l.apOpen === 'OPEN')).toHaveLength(FIXTURE_AP_BILLS)

    const rec = await reconcileAp(store, 'run1', parseApAgingCsv(apAgingCsv()), { asOf: CUTOFF })
    expect(rec.fileCents).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(rec.bcatMatchedCents).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(rec.bcatOpenAllCents).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(rec.counts).toEqual({ MATCHED: FIXTURE_AP_BILLS, MISMATCH: 0, ALJEX_ONLY: 0, BCAT_ONLY: 0 })
    expect(rec.allMatched).toBe(true)
    expect(rec.bridge.every((l) => l.diffCents === 0)).toBe(true)
    expect(Object.fromEntries(rec.byBucket.map((g) => [g.key, [g.fileCents, g.bcatCents]]))).toEqual({ D0_30: [6_480_000, 6_480_000], D31_60: [1_860_720, 1_860_720], D61_90: [0, 0], D91_120: [0, 0], D121_PLUS: [0, 0] })
    expect(rec.byPayTo.reduce((n, g) => n + g.fileCents, 0)).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(rec.byCarrier).toHaveLength(FIXTURE_VENDORS)
  })

  it('is idempotent: a second run writes nothing new', async () => {
    const store = seeded()
    const files = { apAging: apAgingCsv() }
    await runApFiles(store, { runId: 'r1', cutoff: CUTOFF, files })
    const again = await runApFiles(store, { runId: 'r2', cutoff: CUTOFF, files })
    expect(again.report.apAging).toMatchObject({ created: 0, matchedExisting: FIXTURE_AP_BILLS })
    expect(openBills(store)).toHaveLength(FIXTURE_AP_BILLS)
  })

  it('does not write a bill whose PRO is not in BCAT: it is listed and shows as Aljex-only, with the gap in cents', async () => {
    const store = seeded({ skipPros: ['900005'] })
    const { report, files } = await runApFiles(store, { runId: 'r1', cutoff: CUTOFF, files: { apAging: apAgingCsv() } })
    expect(report.apAging!.unresolved).toEqual([{ proKey: '900005', vendorId: '900000005', amountCents: 120_000, reason: 'PRO_NOT_IN_BCAT' }])
    expect(files['ap-aging-unresolved.csv']).toContain('900005,900000005,1200.00,PRO_NOT_IN_BCAT')
    const rec = await reconcileAp(store, 'r1', parseApAgingCsv(apAgingCsv()), { asOf: CUTOFF })
    expect(rec.counts.ALJEX_ONLY).toBe(1)
    expect(rec.bridge.find((l) => l.key === 'apAgingTotal')!.diffCents).toBe(-120_000)
    expect(rec.allMatched).toBe(false)
  })

  it('shows an open BCAT bill that is not in the file as BCAT-only and an amount difference as a mismatch', async () => {
    const store = seeded()
    await runApFiles(store, { runId: 'r1', cutoff: CUTOFF, files: { apAging: apAgingCsv() } })
    store.seed('carrierBill', [{ id: 'cb:other', shipmentNumber: '777001', carrierId: 'car-1', carrierName: 'ZZ Vendor 1', balanceCents: 5_000, apOpen: 'OPEN', dueAt: '2026-11-20', billDate: '2026-10-21' }])
    await store.update('carrierBill', 'cbap:900003:900000003', { balanceCents: 100_000 })
    const rec = await reconcileAp(store, 'r1', parseApAgingCsv(apAgingCsv()), { asOf: CUTOFF })
    expect(rec.counts).toMatchObject({ MISMATCH: 1, BCAT_ONLY: 1, MATCHED: FIXTURE_AP_BILLS - 1 })
    expect(rec.rows.find((r) => r.key === '900003-900000003')).toMatchObject({ outcome: 'MISMATCH', diffCents: -20_000, notes: ['amount'] })
    expect(rec.bcatOpenAllCents - rec.bcatMatchedCents).toBe(5_000)
  })

  it('refuses a file that still carries a sensitive column', async () => {
    const csv = apAgingCsv().replace('"Vendor",', '"Fed/SS #","Vendor",')
    await expect(runApFiles(seeded(), { runId: 'r1', cutoff: CUTOFF, files: { apAging: csv } })).rejects.toThrow(/sensitive/)
  })
})

describe('AP expected import', () => {
  it('never creates payables: it marks AWAITING_INVOICE on legs without an AP status, drops stale rows and keeps one repeated PRO', async () => {
    const store = seeded({ legStatus: { '900011': 'TO_BE_PAID' } })
    const csv = apExpectedCsv([
      { pro: '900010', cents: 40_000, ship: '10/26/26', carrierId: '900000005' },
      { pro: '900011', cents: 40_000, ship: '10/26/26' },
      { pro: '900012', cents: 40_000, ship: '10/27/26' },
      { pro: '900012', cents: 40_000, ship: '10/27/26' },
      { pro: '900013', cents: 99_900, ship: '01/22/24' },
      { pro: '999999', cents: 1_000, ship: '10/01/26' },
    ])
    const { report, files } = await runApFiles(store, { runId: 'r1', cutoff: CUTOFF, files: { apExpected: csv } })
    expect(report.apExpected).toMatchObject({ rows: 6, expected: 4, droppedStale: 1, droppedStaleCents: 99_900, duplicatesReported: 1, awaitingInvoiceMarked: 2, noShipmentMatch: 1 })
    expect(store.own('carrierBill')).toHaveLength(0)
    const legs = new Map(store.own('loadCarrier').map((l) => [l.id as string, l]))
    expect(legs.get('lcr-900010')).toMatchObject({ apStatus: 'AWAITING_INVOICE' })
    expect(legs.get('lcr-900010')!.apOpen).toBeUndefined()
    expect(legs.get('lcr-900011')!.apStatus).toBe('TO_BE_PAID')
    expect(legs.get('lcr-900013')!.apStatus).toBeUndefined()
    expect(files['ap-expected-review.csv']).not.toContain('900013')
  })
})

describe('active shipments check', () => {
  it('writes nothing and reports OK / DIFFERS / MISSING per PRO', async () => {
    const store = seeded()
    const csv = activeCsv([
      { pro: '900001', carrier: 'ZZ VENDOR 0' },
      { pro: '900002', carrier: 'ZZ OTHER', carrierRate: '1250.0' },
      { pro: '555555' },
    ])
    const before = store.own('load').length
    const { report } = await runApFiles(store, { runId: 'r1', cutoff: CUTOFF, files: { activeShipments: csv } })
    expect(report.activeShipments).toMatchObject({ rows: 3, ok: 1, differs: 1, missing: 1 })
    expect(report.activeShipments!.checks[1].diffs.map((d) => d.field)).toEqual(['carrier', 'carrierRate'])
    expect(store.own('load')).toHaveLength(before)
    expect(store.own('carrierBill')).toHaveLength(0)
  })
})
