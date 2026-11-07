/**
 * Router-level tests of the per-file imports (Step AW E1/E3): upload -> stage -> PLAN (dry run) -> APPLY for the customers,
 * carriers, AP (aging + expected), AR and active-shipments files, over the engine's MemoryStore with synthetic data.
 * Pinned: a dry run writes nothing, apply needs a dry run and the confirmation tag, apply twice changes nothing,
 * every run is audited, a file with a sensitive column is refused and blanked, production tables are refused,
 * and only ADMIN may run any of it.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AljexImportJob, TableSet } from '../../../src/types/tms'
import { FILE_KIND_LAYOUT_ID, stripRefusedColumns, type FileKind } from '../../../src/lib/aljex/fileKinds'
import { activeCsv, apAgingCsv, apExpectedCsv, csvOf, FIXTURE_AP_BILLS, FIXTURE_AP_TOTAL_CENTS, FIXTURE_VENDORS, fixtureBills } from '../../../src/lib/aljex/layouts/apFilesFixture'
import { arCsv, FIXTURE_AR_ACCOUNTS, FIXTURE_AR_FACTORED_ACCOUNT, FIXTURE_AR_INVOICES, FIXTURE_AR_TOTAL_CENTS, fixtureArInvoices } from '../../../src/lib/aljex/layouts/arReportFixture'
import { CARRIER_COLUMNS } from '../../../src/lib/aljex/layouts/carriers'
import { CUSTOMER_COLUMNS } from '../../../src/lib/aljex/layouts/customers'
import { MemoryStore } from './engine/memoryStore'
import { PROD_SUFFIX } from './engine/tables'
import { createRouter, type RouterDeps } from './router'

const TABLE_KEYS = [
  'shipment', 'order', 'load', 'loadCarrier', 'loadFinancials', 'loadCharge', 'customer', 'location', 'carrier',
  'invoice', 'arPayment', 'carrierBill', 'apPayment', 'proClaim', 'settings', 'auditLog', 'legacyAljexRow',
  'aljexImportJob', 'aljexMappingProfile', 'factoringItem', 'driver', 'userProfile', 'ownershipDivision',
  'ownershipRule', 'division', 'integration',
]
const tablesNamed = (suffix: string): TableSet => Object.fromEntries(TABLE_KEYS.map((k) => [k, `${k}-${suffix}`])) as unknown as TableSet

const ADMIN = { email: 'boss@example.com', sub: 's', groups: ['ADMIN'], isAdmin: true }
const SIGNER = { email: 'signer@example.com', sub: 's2', groups: ['page-aljexSignoff'], isAdmin: false }
const CUTOFF = '2026-11-07'
const TAG = { liveTag: 'REHEARSAL-1' }

function harness(tables: TableSet = tablesNamed('test')) {
  const store = new MemoryStore({ tables })
  store.seed('settings', [{ id: 'default', defaultPaymentTermsDays: 30 }])
  const objects = new Map<string, string>()
  let n = 0
  const deps: RouterDeps = {
    store,
    bucket: 'b',
    now: () => '2026-11-08T12:00:00.000Z',
    devStack: false,
    runSlice: async () => { throw new Error('unused') },
    seedProCounter: async () => { throw new Error('unused') },
    reconcile: async () => { throw new Error('unused') },
    invokeSelf: async () => {},
    presignPut: async (k) => `https://put/${k}`,
    presignGet: async (k) => `https://get/${k}`,
    headObject: async (k) => (objects.has(k) ? { size: Buffer.byteLength(objects.get(k) as string) } : null),
    listObjects: async () => [],
    getText: async (k) => objects.get(k) ?? null,
    streamText: async function* (k) {
      const text = objects.get(k)
      if (text == null) throw new Error('no object')
      yield text
    },
    putText: async (k, b) => { objects.set(k, b) },
    invokeMcp: async () => { throw new Error('unused') },
    remainingMs: () => 900_000,
    randomId: () => String(++n).padStart(4, '0'),
  }
  const router = createRouter(deps)
  const dispatch = (action: string, input: Record<string, unknown>, caller = ADMIN) => router.dispatch(action, input, caller)
  return { router, store, objects, dispatch }
}
type H = ReturnType<typeof harness>

/** PREPARE, the browser's PUT, STAGE: returns the staged (or refused) job. */
async function upload(h: H, kind: FileKind, fileName: string, csv: string): Promise<AljexImportJob> {
  const prep = await h.dispatch('IMPORT_PREPARE', {
    fileName, fileHash: createHash('sha256').update(csv).digest('hex'), sizeBytes: Buffer.byteLength(csv), layoutId: FILE_KIND_LAYOUT_ID[kind],
  })
  h.objects.set(prep.uploadKey as string, csv)
  const staged = await h.dispatch('IMPORT_STAGE', { jobId: (prep.job as AljexImportJob).id })
  return staged.job as AljexImportJob
}

const jobOf = async (h: H, id: string): Promise<AljexImportJob> => (await h.dispatch('IMPORT_GET', { jobId: id })).job as AljexImportJob
const audits = (h: H) => h.store.own('auditLog').filter((a) => a.entityType === 'AljexImport').map((a) => String(a.action))

interface FileResult { mode: string; rerun: boolean; job: AljexImportJob; result: { counts: Record<string, Record<string, number>>; summary: Record<string, unknown>; reconcile: Record<string, unknown> | null; review: unknown[]; reviewTotal: number } }
const run = async (h: H, action: string, input: Record<string, unknown>) => (await h.dispatch(action, { cutoffDate: CUTOFF, ...input })) as unknown as FileResult

// ── synthetic files ──────────────────────────────────────────────────────────

const CUST_HEADERS = Object.values(CUSTOMER_COLUMNS)
function custRow(over: Partial<Record<keyof typeof CUSTOMER_COLUMNS, string>>): string[] {
  const base: Record<keyof typeof CUSTOMER_COLUMNS, string> = {
    name: 'Northwind Foods', address: '1 Main St', address2: '', city: 'Springfield', state: 'IL', zip: '62701', zip4: '', phone: '555-0100', fax: '', contact: 'Pat',
    contactExt: '', contactEmail: 'pat@example.com', contact2: '', contact2Ext: '', contact2Email: '', account: '900001', status: 'Y', customerType: '', termsDays: '',
    revType: 'B', creditLimit: '100.00', balanceDue: '0', invoiceBy: '1', eBillingEmail: 'ap@example.com', firstShipment: '01/05/26', lastShipment: '10/01/26', totalShipments: '3', ...over,
  }
  return (Object.keys(CUSTOMER_COLUMNS) as Array<keyof typeof CUSTOMER_COLUMNS>).map((k) => base[k])
}
const customersCsv = (withPassword: boolean): string => csvOf([
  withPassword ? [...CUST_HEADERS, 'Web Password'] : CUST_HEADERS,
  ...[custRow({ account: '900001' }), custRow({ account: '900002', name: 'Fox Logistics' }), custRow({ account: '900003', name: 'Old Dock Co', status: 'N' })].map((r) => (withPassword ? [...r, 'CANARY-SECRET'] : r)),
])

const CAR_HEADERS = Object.values(CARRIER_COLUMNS)
const SENSITIVE_CAR = ['Fed/SS #', 'Bank Account', 'Routing #']
function carRow(over: Partial<Record<keyof typeof CARRIER_COLUMNS, string>>): string[] {
  const base: Record<keyof typeof CARRIER_COLUMNS, string> = {
    name: 'ZZ Blue Line', address: '9 Road', address2: '', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0111', fax: '', contact: 'Sam', payableTo: '',
    remitAddress: '', remitAddress2: '', remitCity: '', remitState: '', remitZip: '', remitZip4: '', phoneAccounting: '', isCarrier: 'Y', active: 'Y', mc: '700001',
    dot: '3000001', safetyRating: 'NONE', terms: '', quickPay: '', quickPayDays: '', quickPayPct: '', lastUpdate: '06/01/26', id: '900000001', factorId: '', ...over,
  }
  return (Object.keys(CARRIER_COLUMNS) as Array<keyof typeof CARRIER_COLUMNS>).map((k) => base[k])
}
const carriersRaw = (): string[][] => [
  [...CAR_HEADERS, ...SENSITIVE_CAR],
  ...[carRow({}), carRow({ id: '900000002', name: 'ZZ Red Line', mc: '700002', dot: '3000002' })].map((r) => [...r, 'CANARY-TAX', 'CANARY-BANK', 'CANARY-ROUTING']),
]

function apTarget(h: H): void {
  h.store.seed('carrier', Array.from({ length: FIXTURE_VENDORS }, (_, v) => ({ id: `car-${v}`, name: `ZZ Vendor ${v}`, aljexCode: String(900000001 + v), factorPaymentMethodId: v === 0 ? 'pm-factor-0' : undefined })))
  for (const b of fixtureBills()) {
    const v = Number(b.vendorId) - 900000001
    h.store.seed('load', [{ id: `lod-${b.pro}`, aljexId: b.pro, shipmentId: `shp-${b.pro}`, activeLoadCarrierId: `lcr-${b.pro}`, customer: 'ZZ CUSTOMER', carrierName: `ZZ VENDOR ${v}`, originName: 'ZZ SHIPPER', originCity: 'ZZTOWN, WI', destinationName: 'ZZ CONSIGNEE', destinationCity: 'ZZVILLE, NY' }])
    h.store.seed('loadCarrier', [{ id: `lcr-${b.pro}`, loadId: `lod-${b.pro}`, shipmentId: `shp-${b.pro}`, carrierId: `car-${v}`, kind: 'CARRIER' }])
    h.store.seed('loadFinancials', [{ id: `lod-${b.pro}`, customerRateCents: 175_000, carrierRateCents: 130_000 }])
  }
}

function arTarget(h: H): void {
  h.store.seed('customer', FIXTURE_AR_ACCOUNTS.map((a) => ({ id: `cus-${a}`, name: `ZZ CUSTOMER ${a}`, aljexCode: a, billingMethod: a === FIXTURE_AR_FACTORED_ACCOUNT ? 'FACTOR' : 'MANUAL' })))
  for (const f of fixtureArInvoices()) {
    h.store.seed('order', [{ id: `ord-${f.pro}`, shipmentId: `shp-${f.pro}`, customerId: `cus-${f.customerAccount}` }])
    h.store.seed('load', [{ id: `lod-${f.pro}`, aljexId: f.pro, orderId: `ord-${f.pro}`, shipmentId: `shp-${f.pro}` }])
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('sensitive columns are refused before anything is read', () => {
  it('a customer file with a Web Password column is refused at STAGE and the stored object is blanked', async () => {
    const h = harness()
    const job = await upload(h, 'CUSTOMERS_MASTER', 'customers.csv', customersCsv(true))
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/Web Password/)
    expect(h.objects.get(`imports/source/${job.id}/customers.csv`)).toBe('')
    await expect(run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'PLAN' })).rejects.toThrow(/upload and stage it first/)
    expect(h.store.own('customer')).toHaveLength(0)
  })

  it('a carrier file with Fed/SS #, Bank Account, Routing # (or the tax-id-shaped Account #) is refused; the CLI-stripped copy is accepted', async () => {
    const h = harness()
    const raw = carriersRaw()
    const refused = await upload(h, 'CARRIERS_MASTER', 'carriers.csv', csvOf(raw))
    expect(refused.status).toBe('FAILED')
    expect(refused.error).toMatch(/Fed\/SS #, Bank Account, Routing #/)
    expect(h.objects.get(`imports/source/${refused.id}/carriers.csv`)).toBe('')

    const withAccount = csvOf([[...CAR_HEADERS, 'Account #'], ...raw.slice(1).map((r) => [...r.slice(0, CAR_HEADERS.length), 'CANARY-ACCT'])])
    expect((await upload(h, 'CARRIERS_MASTER', 'carriers2.csv', withAccount)).status).toBe('FAILED')

    const stripped = stripRefusedColumns('CARRIERS_MASTER', raw[0], raw.slice(1))
    expect(stripped.dropped).toEqual(SENSITIVE_CAR)
    const csv = csvOf([stripped.headers, ...stripped.rows])
    expect(csv).not.toMatch(/CANARY/)
    const ok = await upload(h, 'CARRIERS_MASTER', 'carriers3.csv', csv)
    expect(ok).toMatchObject({ status: 'READY', rowCount: 2 })
  })

  it('a file whose columns are another layout is refused', async () => {
    const h = harness()
    const job = await upload(h, 'CUSTOMERS_MASTER', 'x.csv', apAgingCsv())
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/does not match|not a Customer list/i)
  })
})

describe('customers master', () => {
  it('dry run writes nothing; apply needs the dry run and the tag; apply twice changes nothing; every run is audited', async () => {
    const h = harness()
    const job = await upload(h, 'CUSTOMERS_MASTER', 'customers.csv', customersCsv(false))
    expect(job).toMatchObject({ status: 'READY', rowCount: 3 })

    await expect(run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'APPLY', options: TAG })).rejects.toThrow(/dry run/)
    const plan = await run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'PLAN' })
    expect(plan).toMatchObject({ mode: 'PLAN', rerun: false })
    expect(plan.result.counts.CUSTOMER).toMatchObject({ staged: 2, created: 2 })
    expect(plan.result.summary).toMatchObject({ customersCreated: 2, locationsCreated: 1 })
    expect(plan.job.status).toBe('PLANNED')
    expect(h.store.own('customer')).toHaveLength(0)
    expect(h.store.own('location')).toHaveLength(0)

    await expect(run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'APPLY' })).rejects.toThrow(/confirmation tag/)
    const applied = await run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(applied).toMatchObject({ mode: 'APPLY', rerun: false })
    expect(applied.job).toMatchObject({ status: 'APPLIED', appliedBy: ADMIN.email })
    expect(h.store.own('customer').map((c) => c.aljexCode).sort()).toEqual(['900001', '900002'])
    expect(h.store.own('location')).toHaveLength(1)

    const again = await run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(again.rerun).toBe(true)
    expect(again.result.counts.CUSTOMER).toMatchObject({ created: 0, matched: 2 })
    expect(h.store.own('customer')).toHaveLength(2)
    expect(audits(h)).toEqual(['IMPORT_CUSTOMERS_MASTER_PLAN', 'IMPORT_CUSTOMERS_MASTER_APPLY', 'IMPORT_CUSTOMERS_MASTER_APPLY'])
    // The audit trail carries counts, never names or addresses.
    expect(JSON.stringify(h.store.own('auditLog'))).not.toMatch(/Northwind Foods|pat@example|1 Main St/)
  })
})

describe('carriers master', () => {
  it('plans, applies and re-applies idempotently from the stripped file', async () => {
    const h = harness()
    const raw = carriersRaw()
    const stripped = stripRefusedColumns('CARRIERS_MASTER', raw[0], raw.slice(1))
    const job = await upload(h, 'CARRIERS_MASTER', 'carriers.csv', csvOf([stripped.headers, ...stripped.rows]))
    const plan = await run(h, 'IMPORT_CARRIERS_MASTER', { jobId: job.id, mode: 'PLAN' })
    expect(plan.result.summary).toMatchObject({ created: 2 })
    expect(h.store.own('carrier')).toHaveLength(0)
    await run(h, 'IMPORT_CARRIERS_MASTER', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(h.store.own('carrier').map((c) => c.aljexCode).sort()).toEqual(['900000001', '900000002'])
    const again = await run(h, 'IMPORT_CARRIERS_MASTER', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(again.result.summary).toMatchObject({ created: 0 })
    expect(h.store.own('carrier')).toHaveLength(2)
    expect(JSON.stringify(h.store.own('carrier'))).not.toMatch(/CANARY/)
  })
})

describe('AP aging + expected', () => {
  it('imports the 67 bills ($83,407.20 fixture) from both files, ties to the cent, and re-applying creates nothing', async () => {
    const h = harness()
    apTarget(h)
    const aging = await upload(h, 'AP_AGING', 'ap-aging.csv', apAgingCsv())
    const expected = await upload(h, 'AP_EXPECTED', 'ap-expected.csv', apExpectedCsv([{ pro: '900001', cents: 120_000, ship: '10/20/26' }, { pro: '900002', cents: 50_000, ship: '10/21/26' }]))
    expect([aging.status, expected.status]).toEqual(['READY', 'READY'])
    const ids = { agingJobId: aging.id, expectedJobId: expected.id }

    const plan = await run(h, 'IMPORT_AP_FILES', { ...ids, mode: 'PLAN' })
    expect(plan.result.counts.BILL).toMatchObject({ staged: FIXTURE_AP_BILLS, created: FIXTURE_AP_BILLS })
    expect(plan.result.reconcile).toMatchObject({ allMatched: true, fileCents: FIXTURE_AP_TOTAL_CENTS })
    expect(h.store.own('carrierBill')).toHaveLength(0)

    const applied = await run(h, 'IMPORT_AP_FILES', { ...ids, mode: 'APPLY', options: TAG })
    expect(applied.job.status).toBe('APPLIED')
    const bills = h.store.own('carrierBill')
    expect(bills).toHaveLength(FIXTURE_AP_BILLS)
    expect(bills.reduce((n, b) => n + (b.balanceCents as number), 0)).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(applied.result.reconcile).toMatchObject({ allMatched: true, bcatMatchedCents: FIXTURE_AP_TOTAL_CENTS })
    expect((await jobOf(h, expected.id)).status).toBe('APPLIED')

    const again = await run(h, 'IMPORT_AP_FILES', { ...ids, mode: 'APPLY', options: TAG })
    expect(again.rerun).toBe(true)
    expect(again.result.counts.BILL).toMatchObject({ created: 0, matched: FIXTURE_AP_BILLS })
    expect(h.store.own('carrierBill')).toHaveLength(FIXTURE_AP_BILLS)
    expect(audits(h)).toEqual(['IMPORT_AP_FILES_PLAN', 'IMPORT_AP_FILES_APPLY', 'IMPORT_AP_FILES_APPLY'])
  })

  it('needs at least one AP job', async () => {
    const h = harness()
    await expect(run(h, 'IMPORT_AP_FILES', { mode: 'PLAN' })).rejects.toThrow(/agingJobId or expectedJobId is required/)
  })
})

describe('AR file', () => {
  it('imports the 296 open invoices ($357,753.44 fixture), the AR reconciliation reads the same file, and re-applying creates nothing', async () => {
    const h = harness()
    arTarget(h)
    const job = await upload(h, 'AR_REPORT', 'ar.csv', arCsv())
    expect(job).toMatchObject({ status: 'READY', rowCount: FIXTURE_AR_INVOICES })
    const plan = await run(h, 'IMPORT_AR_FILE', { jobId: job.id, mode: 'PLAN' })
    expect(plan.result.counts.INVOICE).toMatchObject({ staged: FIXTURE_AR_INVOICES, created: FIXTURE_AR_INVOICES })
    expect(h.store.own('invoice')).toHaveLength(0)

    await run(h, 'IMPORT_AR_FILE', { jobId: job.id, mode: 'APPLY', options: TAG })
    const invoices = h.store.own('invoice')
    expect(invoices).toHaveLength(FIXTURE_AR_INVOICES)
    expect(invoices.reduce((n, i) => n + (i.balanceCents as number), 0)).toBe(FIXTURE_AR_TOTAL_CENTS)
    const again = await run(h, 'IMPORT_AR_FILE', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(again.result.counts.INVOICE).toMatchObject({ created: 0 })
    expect(h.store.own('invoice')).toHaveLength(FIXTURE_AR_INVOICES)

    // IMPORT_RECONCILE_ENTITY AR compares BCAT with this file: the money side by side ties to the cent.
    const started = await h.dispatch('IMPORT_RECONCILE_ENTITY', { entity: 'AR', sourceJobId: job.id, cutoffDate: CUTOFF })
    const recId = (started.job as { id: string }).id
    await h.router.work({ kind: 'RECONCILE_ENTITY', jobId: recId })
    const page = (await h.dispatch('IMPORT_RECONCILE_GET', { jobId: recId })) as unknown as { report: { counts: { aljexRows: number }; money: { aljexCents: number; bcatCents: number } } }
    expect(page.report.counts.aljexRows).toBe(FIXTURE_AR_INVOICES)
    expect(page.report.money).toMatchObject({ aljexCents: FIXTURE_AR_TOTAL_CENTS, bcatCents: FIXTURE_AR_TOTAL_CENTS })
  })
})

describe('active-shipments check', () => {
  it('reports OK / DIFFERS / MISSING in a dry run and on apply, and writes no table row', async () => {
    const h = harness()
    apTarget(h)
    const csv = activeCsv([{ pro: '900001', carrier: 'ZZ VENDOR 0' }, { pro: '900002', carrier: 'ZZ OTHER', carrierRate: '1250.0' }, { pro: '555555' }])
    const job = await upload(h, 'ACTIVE_SHIPMENTS', 'active.csv', csv)
    const before = (['load', 'carrierBill', 'invoice'] as const).map((t) => h.store.own(t).length)
    const plan = await run(h, 'IMPORT_ACTIVE_SHIPMENTS_CHECK', { jobId: job.id, mode: 'PLAN' })
    expect(plan.result.summary.activeShipments).toMatchObject({ rows: 3, ok: 1, differs: 1, missing: 1 })
    expect(plan.result.reviewTotal).toBe(2)
    const applied = await run(h, 'IMPORT_ACTIVE_SHIPMENTS_CHECK', { jobId: job.id, mode: 'APPLY', options: TAG })
    expect(applied.result.summary.activeShipments).toMatchObject({ ok: 1, differs: 1, missing: 1 })
    expect((['load', 'carrierBill', 'invoice'] as const).map((t) => h.store.own(t).length)).toEqual(before)
    expect(audits(h)).toEqual(['IMPORT_ACTIVE_SHIPMENTS_CHECK_PLAN', 'IMPORT_ACTIVE_SHIPMENTS_CHECK_APPLY'])
  })
})

describe('authorization and target safety', () => {
  it.each(['IMPORT_CUSTOMERS_MASTER', 'IMPORT_CARRIERS_MASTER', 'IMPORT_AP_FILES', 'IMPORT_AR_FILE', 'IMPORT_ACTIVE_SHIPMENTS_CHECK'])('%s is ADMIN only: the sign-off grant alone does not reach it', async (action) => {
    const h = harness()
    await expect(h.dispatch(action, { jobId: 'x', mode: 'PLAN' }, SIGNER)).rejects.toThrow(/Forbidden/)
  })

  it('refuses to import into production tables', async () => {
    const h = harness(tablesNamed(PROD_SUFFIX))
    const job = await upload(h, 'CUSTOMERS_MASTER', 'customers.csv', customersCsv(false))
    await expect(run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: job.id, mode: 'PLAN' })).rejects.toThrow(/production table/)
    expect(h.store.own('customer')).toHaveLength(0)
  })

  it('only the uploaded file of the right layout is accepted', async () => {
    const h = harness()
    const aging = await upload(h, 'AP_AGING', 'ap-aging.csv', apAgingCsv())
    await expect(run(h, 'IMPORT_CUSTOMERS_MASTER', { jobId: aging.id, mode: 'PLAN' })).rejects.toThrow(/not an uploaded Customer list/)
  })
})
