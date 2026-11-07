/**
 * Reconciliation actions of the tms-aljex-import router (Step AW E.2), over the engine's MemoryStore with synthetic
 * data: who may decide and sign off (the aljexSignoff grant alone, no role bypass), that decisions persist with
 * approver / time / reason and gate sign-off, and that the AP report ties to the file to the cent.
 */
import { describe, expect, it } from 'vitest'
import type { AljexImportJob, EngineRow, TableSet } from '../../../src/types/tms'
import type { ReconPage } from '../../../src/lib/aljexReconcile'
import { MemoryStore } from './engine/memoryStore'
import { authorize, createRouter, type RouterDeps } from './router'

const TABLE_KEYS = [
  'shipment', 'order', 'load', 'loadCarrier', 'loadFinancials', 'loadCharge', 'customer', 'location', 'carrier',
  'invoice', 'arPayment', 'carrierBill', 'apPayment', 'proClaim', 'settings', 'auditLog', 'legacyAljexRow',
  'aljexImportJob', 'aljexMappingProfile', 'factoringItem', 'driver', 'userProfile', 'ownershipDivision',
  'ownershipRule', 'division', 'integration',
]
const TABLES = Object.fromEntries(TABLE_KEYS.map((k) => [k, `${k}-test`])) as unknown as TableSet

const ADMIN = { email: 'boss@example.com', sub: 's', groups: ['ADMIN'], isAdmin: true }
const SIGNER = { email: 'signer@example.com', sub: 's2', groups: ['page-aljexSignoff'], isAdmin: false }
// An ADMIN who also holds nothing else: the grant is per user, so even ADMIN+owner stay refused without it.
const OWNER = { email: 'ryne@bcatcorp.com', sub: 's3', groups: ['ADMIN'], isAdmin: true }

const AP_FILE = [
  'Vendor,Pro #,Vendor ID,Due Date,0 - 30 Days,31 - 60 Days,61 - 90 Days,91 - 120 Days,120 Days or More,Amount Paid,Check/Draft',
  'Carrier A,7001,V1,11/20/2026,$1000.00,,,,,$1000.00,C',
  'Carrier B,7002,V2,10/01/2026,,$250.50,,,,$250.50,D',
  'Carrier C,7003,V3,10/01/2026,,$80.00,,,,$80.00,D',
].join('\n')

function harness() {
  const store = new MemoryStore({ tables: TABLES })
  const objects = new Map<string, string>()
  const invoked: Array<Record<string, unknown>> = []
  let n = 0
  const deps: RouterDeps = {
    store,
    bucket: 'b',
    now: () => new Date().toISOString(),
    devStack: false,
    runSlice: async () => { throw new Error('unused') },
    seedProCounter: async () => { throw new Error('unused') },
    reconcile: async () => { throw new Error('unused') },
    invokeSelf: async (p) => { invoked.push(p) },
    presignPut: async (k) => `https://put/${k}`,
    presignGet: async (k) => `https://get/${k}`,
    headObject: async () => null,
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
  return { router, store, objects, invoked }
}
type H = ReturnType<typeof harness>

async function runAp(h: H): Promise<string> {
  const source: AljexImportJob = { id: 'aljexrun:ap', kind: 'IMPORT', status: 'READY', phase: 'STAGE', fileName: 'ap.csv', createdBy: 'x' }
  h.store.seed('aljexImportJob', [source as unknown as EngineRow])
  h.objects.set('imports/source/aljexrun:ap/ap.csv', AP_FILE)
  // BCAT holds A at the same amount, B one cent short, and a bill Aljex does not list.
  h.store.seed('carrierBill', [
    { id: 'b1', billNumber: '7001-V1', carrierId: 'c1', carrierName: 'Carrier A', balanceCents: 100000, apOpen: 'OPEN', dueAt: '2026-11-20' },
    { id: 'b2', billNumber: '7002-V2', carrierId: 'c2', carrierName: 'Carrier B', balanceCents: 25049, apOpen: 'OPEN', dueAt: '2026-10-01' },
    { id: 'b4', billNumber: '7004-V4', carrierId: 'c4', carrierName: 'Carrier D', balanceCents: 500, apOpen: 'OPEN', dueAt: '2026-10-01' },
  ] as EngineRow[])
  const started = await h.router.dispatch('IMPORT_RECONCILE_ENTITY', { entity: 'AP', sourceJobId: source.id, cutoffDate: '2026-11-07' }, ADMIN)
  const id = (started.job as { id: string }).id
  expect(h.invoked[h.invoked.length - 1]).toMatchObject({ kind: 'RECONCILE_ENTITY', jobId: id })
  await h.router.work({ kind: 'RECONCILE_ENTITY', jobId: id })
  return id
}

describe('authorization', () => {
  const resolve = async (i: { username: string }) => i.username
  it('lets a sign-off grant holder in, but only the reconciliation actions run for them', async () => {
    await expect(authorize({ sub: 's', username: 'jenny@example.com', claims: { 'cognito:groups': ['page-aljexSignoff'] } }, resolve)).resolves.toMatchObject({ isAdmin: false })
    const h = harness()
    await expect(h.router.dispatch('IMPORT_PREPARE', { fileName: 'a.csv', fileHash: 'a'.repeat(64), sizeBytes: 1 }, SIGNER)).rejects.toThrow(/Forbidden/)
    await expect(h.router.dispatch('IMPORT_RECONCILE_GET', {}, SIGNER)).resolves.toMatchObject({ jobs: [] })
  })
})

describe('reconciliation: AP', () => {
  it('ties to the Aljex file to the cent and lists every difference', async () => {
    const h = harness()
    const id = await runAp(h)
    const page = (await h.router.dispatch('IMPORT_RECONCILE_GET', { jobId: id }, ADMIN)) as unknown as ReconPage
    expect(page.report?.money).toMatchObject({ aljexCents: 133050, bcatCents: 125549, aljexItems: 3, bcatItems: 3 })
    expect(page.report?.money?.fileBuckets?.map((b) => b.aljexCents)).toEqual([100000, 33050, 0, 0, 0])
    expect(page.rows.map((r) => r.key).sort()).toEqual(['ALJEX_ONLY|7003-V3|', 'BCAT_ONLY|7004-V4|', 'MONEY_TOTAL|total|openCents', 'MONEY|7002-V2|openCents'])
    expect(page.job.stats).toMatchObject({ total: 4, undecided: 4 })
  })

  it('only the grant holder decides; ADMIN and the owner are refused', async () => {
    const h = harness()
    const id = await runAp(h)
    for (const caller of [ADMIN, OWNER]) {
      await expect(h.router.dispatch('IMPORT_DECIDE', { jobId: id, keys: ['MONEY|7002-V2|openCents'], outcome: 'APPROVED', reason: 'ok' }, caller)).rejects.toThrow(/aljexSignoff/)
      await expect(h.router.dispatch('IMPORT_SIGNOFF', { jobId: id }, caller)).rejects.toThrow(/aljexSignoff/)
    }
    await expect(h.router.dispatch('IMPORT_DECIDE', { jobId: id, keys: ['MONEY|7002-V2|openCents'], outcome: 'APPROVED', reason: '' }, SIGNER)).rejects.toThrow(/reason/)
  })

  it('records approver, time and reason, gates sign-off on every row being decided, then locks', async () => {
    const h = harness()
    const id = await runAp(h)
    const keys = ['ALJEX_ONLY|7003-V3|', 'BCAT_ONLY|7004-V4|', 'MONEY_TOTAL|total|openCents', 'MONEY|7002-V2|openCents']
    await h.router.dispatch('IMPORT_DECIDE', { jobId: id, keys: keys.slice(0, 3), outcome: 'OPEN_BALANCE', reason: 'carrier will resend' }, SIGNER)
    await expect(h.router.dispatch('IMPORT_SIGNOFF', { jobId: id }, SIGNER)).rejects.toThrow(/1 difference/)
    await h.router.dispatch('IMPORT_DECIDE', { jobId: id, keys: [keys[3]], outcome: 'APPROVED', reason: 'one cent rounding' }, SIGNER)

    const decided = (await h.router.dispatch('IMPORT_RECONCILE_GET', { jobId: id, state: 'DECIDED' }, SIGNER)) as unknown as ReconPage
    const rounding = decided.rows.find((r) => r.key === keys[3])?.decision
    expect(rounding).toMatchObject({ outcome: 'APPROVED', approver: 'signer@example.com', reason: 'one cent rounding' })
    expect(Date.parse(rounding!.at)).not.toBeNaN()

    const signed = (await h.router.dispatch('IMPORT_SIGNOFF', { jobId: id, note: 'AP ok' }, SIGNER)).job as { signoff: { approver: string; at: string; openBalance: number; approved: number } }
    expect(signed.signoff).toMatchObject({ approver: 'signer@example.com', openBalance: 3, approved: 1 })
    await expect(h.router.dispatch('IMPORT_DECIDE', { jobId: id, keys: [keys[0]], outcome: 'APPROVED', reason: 'again' }, SIGNER)).rejects.toThrow(/signed off/)
    const csv = h.objects.get(`imports/runs/${id}/reconcile-ap.csv`)!
    expect(csv).toContain('one cent rounding')
    expect(csv).toContain('signer@example.com')
  })

  it('a later run starts from the earlier decisions that still apply', async () => {
    const h = harness()
    const first = await runAp(h)
    await h.router.dispatch('IMPORT_DECIDE', { jobId: first, keys: ['MONEY|7002-V2|openCents'], outcome: 'APPROVED', reason: 'rounding' }, SIGNER)
    const again = await h.router.dispatch('IMPORT_RECONCILE_ENTITY', { entity: 'AP', sourceJobId: 'aljexrun:ap', cutoffDate: '2026-11-07' }, ADMIN)
    const second = again.job as { id: string }
    expect(second.id).not.toBe(first)
    await h.router.work({ kind: 'RECONCILE_ENTITY', jobId: second.id })
    const page = (await h.router.dispatch('IMPORT_RECONCILE_GET', { jobId: second.id, state: 'DECIDED' }, ADMIN)) as unknown as ReconPage
    expect(page.rows.map((r) => [r.key, r.decision?.reason])).toEqual([['MONEY|7002-V2|openCents', 'rounding']])
  })
})
