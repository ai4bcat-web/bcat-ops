import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AljexEntityCounts, EngineRow, EngineTable } from '../../../../src/types/tms'
import { apply, devTables, drive, FIXED_NOW, fullRun, makeFixture, makeStore, plan, stage } from './testKit'
import { CrashInjected, type MemoryStore } from './memoryStore'
import { conservation, reconcile } from './reconcile'
import { seedProCounter, SeedRefused } from './seedCounter'
import { DEV_SUFFIX, MODEL_NAME, PROD_SUFFIX } from './tables'
import { readAll } from './util'
import { arOpenKey, revenueDifferencesCsv, summarizeRevenueDifferences, summaryLines, type RevenueDifference } from './revenueBasis'
import { normalizePro } from '../../../../src/lib/proNumber'

interface Oracle {
  loads: number
  memos: number
  identicalDuplicateRows: number
  conflictingDuplicateRows: number
  openAr: { count: number; balance: number }
  unappliedCredit: number
  perCustomerOpen: Record<string, number>
  memoCredTotal: number
  nonUsdCurrencyPros: string[]
  memoDebtTotal: number
  invoiceTotalWithMemos: number
  memoAdjustments: { applied: number; appliedNet: number; byInvoice: Record<string, number>; orphans: Array<{ memoPro: string }> }
  ap: { bills: number; open: number; perCarrierOpen: Record<string, number> }
}

const fixture = makeFixture({ rows: 300, seed: 1 })
const oracle = fixture.oracle as unknown as Oracle

const table = (store: MemoryStore, t: EngineTable): EngineRow[] => store.own(t)
const sumOf = (rows: EngineRow[], f: string): number => rows.reduce((n, r) => n + (typeof r[f] === 'number' ? (r[f] as number) : 0), 0)

async function applied(rows = fixture) {
  const store = makeStore()
  const run = await fullRun(store, rows.csv)
  return { store, ...run }
}

describe('Aljex import engine on the synthetic fixture', () => {
  it('stages the file, collapsing identical duplicates and rejecting a conflicting one', async () => {
    const store = makeStore()
    const staged = await stage(store, fixture.csv)
    expect(staged.status).toBe('READY')
    const c = staged.entityCounts as AljexEntityCounts
    // 300 data rows = loads + memos + every duplicate row; each kind's staged count includes its outcomes.
    expect(c.LOAD?.skipped).toBe(oracle.identicalDuplicateRows)
    expect(c.LOAD?.conflicts).toBe(oracle.conflictingDuplicateRows)
    expect((c.MEMO_DEBT?.staged ?? 0) + (c.MEMO_CRED?.staged ?? 0)).toBe(oracle.memos)
  })

  it('applies, conserves every outcome and reconciles to the oracle to the cent', async () => {
    const { store, applied: job } = await applied()
    expect(job.status).toBe('APPLIED')
    expect(job.error ?? null).toBeNull()
    expect(conservation(job.entityCounts).ok).toBe(true)
    const invoices = table(store, 'invoice')
    const open = invoices.filter((i) => i.arOpen === 'OPEN')
    expect(sumOf(open, 'balanceCents')).toBe(oracle.openAr.balance)
    expect(open.length).toBe(oracle.openAr.count)
    const unapplied = sumOf(table(store, 'arPayment').filter((p) => p.kind === 'PAYMENT'), 'unappliedCents')
    expect(unapplied).toBe(oracle.unappliedCredit)
    const perCustomer = new Map<string, number>()
    const customers = new Map(table(store, 'customer').map((c) => [c.id as string, c.aljexCode as string]))
    for (const i of open) perCustomer.set(customers.get(i.customerId as string)!, (perCustomer.get(customers.get(i.customerId as string)!) ?? 0) + (i.balanceCents as number))
    expect(Object.fromEntries(perCustomer)).toEqual(oracle.perCustomerOpen)
    const bills = table(store, 'carrierBill')
    // Bills of carriers outside the activity window are paid history on a snapshot leg: no bill row.
    const snapshotLegs = table(store, 'loadCarrier').filter((l) => l.kind === 'CARRIER' && l.carrierId === undefined && l.apStatus === 'PAID')
    expect(bills.length + snapshotLegs.length).toBe(oracle.ap.bills)
    const openBills = bills.filter((b) => b.apOpen === 'OPEN')
    expect(sumOf(openBills, 'balanceCents')).toBe(oracle.ap.open)
    const summary = await reconcile(store, job.id)
    expect(summary.reconciled).toBe(true)
    for (const b of summary.bridge) if (b.diffCents != null) expect({ key: b.key, diff: b.diffCents }).toEqual({ key: b.key, diff: 0 })
    expect((job.options as { reconciled?: boolean }).reconciled).toBe(true)
  })

  it('numbers every bill by its PRO (the invoice number): unique per carrier even when many rows share one Carrier Ref #', async () => {
    const { store } = await applied()
    const bills = table(store, 'carrierBill')
    const refs = new Map<string, number>()
    for (const r of table(store, 'legacyAljexRow')) {
      const fields = (typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields) as Record<string, { h: string; v: string }>
      for (const cell of Object.values(fields ?? {})) {
        const ref = cell.h === 'Carrier Ref #' ? cell.v.trim() : ''
        if (ref) refs.set(ref, (refs.get(ref) ?? 0) + 1)
      }
    }
    expect(refs.size).toBeGreaterThan(0)
    // The fixture reproduces the real shape: one carrier-ref text on many loads.
    expect(Math.max(0, ...refs.values())).toBeGreaterThan(1)
    const invoiceByShipment = new Map(table(store, 'invoice').map((i) => [i.shipmentId as string, i.number as string]))
    const seen = new Set<string>()
    for (const b of bills) {
      expect(b.billNumber).toBe(b.loadNumber)
      const inv = invoiceByShipment.get(b.shipmentId as string)
      if (inv !== undefined) expect(b.billNumber).toBe(inv)
      const key = `${b.carrierId}|${String(b.billNumber).toUpperCase()}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('keeps every invoice self-consistent and every charge sum equal to the invoice amount', async () => {
    const { store } = await applied()
    const payments = table(store, 'arPayment')
    const appliedByInvoice = new Map<string, number>()
    for (const p of payments) for (const a of (p.applications as Array<{ invoiceId: string; amountCents: number }>) ?? []) appliedByInvoice.set(a.invoiceId, (appliedByInvoice.get(a.invoiceId) ?? 0) + a.amountCents)
    const charges = table(store, 'loadCharge').filter((c) => c.side === 'CUSTOMER')
    for (const inv of table(store, 'invoice')) {
      expect((inv.totalCents as number) - (appliedByInvoice.get(inv.id as string) ?? 0)).toBe(inv.balanceCents)
      const lineSum = (inv.lines as Array<{ amountCents: number }>).reduce((n, l) => n + l.amountCents, 0)
      expect(lineSum).toBe(inv.totalCents)
      expect(inv.arOpen === 'OPEN').toBe((inv.balanceCents as number) > 0)
    }
    expect(charges.length).toBeGreaterThan(0)
  })

  it('plans exactly what apply does and writes nothing while planning', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:SP')
    const before = store.checksum()
    const planned = await plan(store, 'aljexrun:SP')
    expect(planned.status).toBe('PLANNED')
    expect(store.checksum()).toBe(before)
    const done = await apply(store, 'aljexrun:SP', 'aljexrun:AP')
    expect(done.status).toBe('APPLIED')
    expect(done.entityCounts).toEqual(planned.entityCounts)
  })

  it('is idempotent: a second run with a new run id changes no row and creates nothing', async () => {
    const { store } = await applied()
    const before = store.checksum()
    const second = await apply(store, 'aljexrun:SA', 'aljexrun:A2')
    expect(second.status).toBe('APPLIED')
    expect(store.checksum()).toBe(before)
    for (const [entity, c] of Object.entries(second.entityCounts as AljexEntityCounts)) {
      if (entity === 'LOAD' || entity === 'CUSTOMER' || entity === 'CARRIER' || entity === 'INVOICE' || entity === 'BILL') expect({ entity, created: c?.created }).toEqual({ entity, created: 0 })
    }
  })

  it.each([3, 41, 150])('ends identical to an uninterrupted run after a crash before transaction %i', async (n) => {
    // Same job ids as the interrupted run: row contents carry the run id.
    const cleanStore = makeStore()
    const clean = { store: cleanStore, applied: (await fullRun(cleanStore, fixture.csv, 'K')).applied }
    const store = makeStore({ crashAtTransact: undefined })
    await stage(store, fixture.csv, 'aljexrun:SK')
    await plan(store, 'aljexrun:SK')
    store.crashAtTransact = store.transactCount + n
    await expect(apply(store, 'aljexrun:SK', 'aljexrun:AK')).rejects.toBeInstanceOf(CrashInjected)
    store.crashAtTransact = undefined
    const resumed = await drive(store, 'aljexrun:AK')
    expect(resumed.status).toBe('APPLIED')
    expect(store.checksum()).toBe(clean.store.checksum())
    expect(resumed.entityCounts).toEqual(clean.applied.entityCounts)
  })

  it('claims every PRO exactly once and links each load to its claim', async () => {
    const { store } = await applied()
    const claims = new Map(table(store, 'proClaim').map((c) => [c.id as string, c.loadId as string]))
    for (const load of table(store, 'load')) {
      expect(claims.get(normalizePro(load.aljexId as string)!)).toBe(load.id)
      expect(load.legacyImported).toBe(true)
      expect(load.readyToInvoice).toBe(false)
    }
    expect(new Set(claims.values()).size).toBe(claims.size)
  })

  it('applies memos as adjustment lines on the referenced invoice and reports the orphans (no shipments, no credit receipts)', async () => {
    const { store, applied: job } = await applied()
    expect(table(store, 'shipment').some((s) => String(s.legacySource ?? '').includes('MEMO'))).toBe(false)
    expect(table(store, 'shipment')).toHaveLength(oracle.loads)
    expect(table(store, 'arPayment').some((p) => p.kind === 'CREDIT_MEMO')).toBe(false)
    const invoices = new Map(table(store, 'invoice').map((i) => [i.number as string, i]))
    const memoLines = (inv: EngineRow) => (inv.lines as Array<{ code: string; label: string; amountCents: number }>).filter((l) => l.code === 'ADJUSTMENT' && /memo /.test(l.label))
    for (const [pro, net] of Object.entries(oracle.memoAdjustments.byInvoice)) {
      expect({ pro, net: memoLines(invoices.get(pro)!).reduce((n, l) => n + l.amountCents, 0) }).toEqual({ pro, net })
    }
    expect(sumOf(table(store, 'invoice'), 'totalCents')).toBe(oracle.invoiceTotalWithMemos)
    const counts = job.entityCounts as AljexEntityCounts
    const appliedMemos = (counts.MEMO_CRED?.created ?? 0) + (counts.MEMO_DEBT?.created ?? 0)
    const orphaned = (counts.MEMO_CRED?.skipped ?? 0) + (counts.MEMO_DEBT?.skipped ?? 0)
    expect({ applied: appliedMemos, orphaned }).toEqual({ applied: oracle.memoAdjustments.applied, orphaned: oracle.memoAdjustments.orphans.length })
    const summary = await reconcile(store, job.id)
    expect(summary.memos).toMatchObject({ total: oracle.memos, applied: oracle.memoAdjustments.applied, unmatched: oracle.memoAdjustments.orphans.length })
    expect([...(summary.memos?.unmatchedPros ?? [])].sort()).toEqual(oracle.memoAdjustments.orphans.map((o) => o.memoPro).sort())
    expect(Object.keys(summary.warnings ?? {})).toEqual(expect.arrayContaining(['MEMO_ORPHAN_NO_REFERENCE', 'MEMO_ORPHAN_REFERENCE_NOT_FOUND', 'MEMO_ORPHAN_REFERENCE_NOT_INVOICED']))
  })

  it('keeps every source row, memos included, as a sparse {c<pos>:{h,v}} copy in LegacyAljexRow and never on the Load', async () => {
    const { store } = await applied()
    const raw = table(store, 'legacyAljexRow')
    expect(raw.filter((r) => r.kind === 'LOAD')).toHaveLength(oracle.loads)
    expect(raw.filter((r) => r.kind !== 'LOAD')).toHaveLength(oracle.memos)
    const sample = raw.find((r) => r.kind === 'LOAD')!
    const fields = sample.fields as Record<string, { h: string; v: string }>
    expect(Object.keys(fields).every((k) => /^c\d+$/.test(k) && typeof fields[k].h === 'string' && fields[k].v.trim() !== '')).toBe(true)
    expect(Object.values(fields).find((x) => x.h === 'Pro #')?.v).toBe(sample.pro)
    for (const l of table(store, 'load')) expect('aljexRaw' in l || 'raw' in l).toBe(false)
  })

  it('promotes the formerly ignored columns to real fields', async () => {
    const { store } = await applied()
    const o = oracle as unknown as {
      codes: Record<'salesRep' | 'createdBy' | 'serviceRep' | 'dispatcher', Record<string, string>>
      promoted: Record<string, { quoteNo: string; manifest: string; container: string; additionalRefs: string[]; consigneeRef: string; osd: boolean; pltIn: number; pltOut: number; declaredValueCents: number }>
      fees: { byPro: Record<string, { quoteNo?: never; quickPayCents: number; advanceCents: number }> }
      carrierCompliance: Record<string, { caIntrastate: string; caIntrastateExp: string; txPuc: string; txPucExp: string }>
      customerLeadSource: Record<string, string>
    }
    const shipments = new Map(table(store, 'shipment').map((s) => [s.number as string, s]))
    // Step AW R4: Aljex rep / creator / service-rep / dispatcher codes are never imported, and nobody is assigned from them.
    expect(Object.keys(o.codes.salesRep).length).toBeGreaterThan(0)
    for (const s of shipments.values()) {
      for (const f of ['salesRepCode', 'createdByCode', 'serviceRepCode', 'dispatcherCode', 'salesRepId', 'carrierRepId']) expect(s[f]).toBeUndefined()
    }
    for (const l of table(store, 'load')) {
      for (const f of ['salesRepId', 'carrierRepId']) expect(l[f]).toBeUndefined()
    }
    const orders = new Map(table(store, 'order').map((x) => [x.id as string, x]))
    const loads = new Map(table(store, 'load').map((l) => [l.aljexId as string, l]))
    for (const [pro, p] of Object.entries(o.promoted)) {
      const s = shipments.get(pro)!
      expect(s.osd).toBe(p.osd)
      const order = orders.get(loads.get(pro)!.orderId as string)!
      const refs = (order.references as Array<{ code: string; value: string }>).map((r) => `${r.code}=${r.value}`)
      expect(refs).toEqual(expect.arrayContaining([`QUOTE_NUMBER=${p.quoteNo}`, `MANIFEST=${p.manifest}`, `CONTAINER=${p.container}`, `CONSIGNEE_REF=${p.consigneeRef}`, ...p.additionalRefs.map((r, i) => `ADDITIONAL_REF_${i + 1}=${r}`)]))
      expect(order.specialRequirements).toMatchObject({ palletsIn: p.pltIn, palletsOut: p.pltOut, hazmat: true, escort: true, oversize: true, permit: true, blind: true, team: true, tarps: true })
      expect(loads.get(pro)!.cargoValueCents).toBe(p.declaredValueCents)
    }
    const feeLines = table(store, 'loadCharge').filter((c) => c.side === 'CARRIER' && (c.code === 'QUICKPAY_FEE' || c.code === 'ADVANCE_FEE'))
    const byPro = new Map(table(store, 'load').map((l) => [l.shipmentId as string, l.aljexId as string]))
    for (const [pro, fee] of Object.entries(o.fees.byPro)) {
      const mine = feeLines.filter((c) => byPro.get(c.shipmentId as string) === pro)
      expect({ pro, qp: mine.find((c) => c.code === 'QUICKPAY_FEE')?.amountCents ?? 0, adv: mine.find((c) => c.code === 'ADVANCE_FEE')?.amountCents ?? 0 }).toEqual({ pro, qp: fee.quickPayCents, adv: fee.advanceCents })
    }
    const carriersByCode = new Map(table(store, 'carrier').map((c) => [c.aljexCode as string, c]))
    for (const [id, c] of Object.entries(o.carrierCompliance)) {
      const row = carriersByCode.get(id)
      if (!row) continue
      expect(row).toMatchObject({ caIntrastateNumber: c.caIntrastate, caIntrastateExpiresAt: c.caIntrastateExp, txPucNumber: c.txPuc, txPucExpiresAt: c.txPucExp })
    }
    const customersByCode = new Map(table(store, 'customer').map((c) => [c.aljexCode as string, c]))
    for (const [acct, src] of Object.entries(o.customerLeadSource)) expect({ acct, src: customersByCode.get(acct)?.leadSource }).toEqual({ acct, src })
  })

  it('writes a PII-free import report next to the reconcile output', async () => {
    const { store, applied: job } = await applied()
    const md = (await readAll(store.getObject(`imports/runs/${job.id}/import-report.md`)))
    expect(md).toContain('## Counts per entity')
    expect(md).toContain('## Reconciliation')
    expect(md).toContain('## Warning and finding categories')
    expect(md).toContain('## Open items for the owner')
    expect(md).toContain('CURRENCY_NOT_USD')
    for (const pro of oracle.nonUsdCurrencyPros) expect(md).toContain(pro)
    expect(md).not.toMatch(/ZZ [A-Z]/)
  })

  it('writes structured JSON fields natively and no empty or null index key', async () => {
    const { store } = await applied()
    for (const o of table(store, 'order')) if (o.references !== undefined) expect(Array.isArray(o.references)).toBe(true)
    for (const i of table(store, 'invoice')) expect(Array.isArray(i.lines)).toBe(true)
    for (const l of table(store, 'load')) if (l.stops !== undefined) expect(Array.isArray(JSON.parse(l.stops as string))).toBe(true)
    for (const s of table(store, 'shipment')) {
      if ('pickupAppt' in s) expect(s.pickupAppt).not.toBe('')
      if ('pickupMonth' in s) expect(String(s.pickupMonth)).toMatch(/^\d{4}-\d{2}$/)
    }
  })

  it('never writes a driver on imported own-asset history except a unique roster match on the leg', async () => {
    const { store } = await applied()
    for (const l of table(store, 'load')) {
      expect(l.pickupDriverId ?? null).toBeNull()
      expect(l.deliveryDriverId ?? null).toBeNull()
    }
    for (const lc of table(store, 'loadCarrier').filter((x) => x.kind === 'OWN_ASSET')) expect(lc.apStatus).toBeUndefined()
    expect(table(store, 'carrierBill').every((b) => (b.carrierId as string).length > 0)).toBe(true)
  })

  it('skips nothing silently: unmapped statuses block apply with a message', async () => {
    const odd = makeFixture({ rows: 120, seed: 2, anomalies: 'all' })
    const store = makeStore()
    const staged = await stage(store, odd.csv, 'aljexrun:SO')
    expect(staged.status).toBe('READY')
    await plan(store, 'aljexrun:SO')
    const done = await apply(store, 'aljexrun:SO', 'aljexrun:AO', { synthetic: false, target: 'REHEARSAL', targetTag: 'rhtest' })
    expect(done.status).toBe('FAILED')
  })
})

describe('target and data guards', () => {
  it('refuses a production table set', async () => {
    const tables = devTables()
    tables.shipment = `Shipment-${PROD_SUFFIX}`
    const store = makeStore({ tables })
    await stage(store, fixture.csv, 'aljexrun:SG')
    await plan(store, 'aljexrun:SG')
    const job = await apply(store, 'aljexrun:SG', 'aljexrun:AG')
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/production/i)
    expect(table(store, 'shipment')).toHaveLength(0)
  })

  it('refuses a LIVE apply without the live tag', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:ST')
    await plan(store, 'aljexrun:ST')
    const job = await apply(store, 'aljexrun:ST', 'aljexrun:AT', { liveTag: '' })
    expect(job.status).toBe('FAILED')
    expect(table(store, 'load')).toHaveLength(0)
  })

  it('refuses real (non-synthetic) data on LIVE without a reconciled rehearsal', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:SR', { synthetic: false })
    await plan(store, 'aljexrun:SR')
    const job = await apply(store, 'aljexrun:SR', 'aljexrun:AR', { synthetic: false })
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/rehearsal/i)
    expect(table(store, 'load')).toHaveLength(0)
  })

  it('refuses synthetic when the data is outside the fixture band or lacks the ZZ prefix', async () => {
    const store = makeStore()
    const bad = makeFixture({ rows: 80, seed: 3, anomalies: 'all' })
    await stage(store, bad.csv, 'aljexrun:SY')
    await plan(store, 'aljexrun:SY')
    const job = await apply(store, 'aljexrun:SY', 'aljexrun:AY')
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/synthetic/i)
  })

  it('refuses an APPLY whose plan no longer matches the stage', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:SM')
    await plan(store, 'aljexrun:SM')
    const job = await apply(store, 'aljexrun:SM', 'aljexrun:AM', { stageHash: 'something-else' })
    expect(job.status).toBe('FAILED')
  })

  it('does not let a pause written by the router be overwritten', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:SZ')
    await plan(store, 'aljexrun:SZ')
    const live = makeStoreCopyGuard(store)
    const job = await apply(live, 'aljexrun:SZ', 'aljexrun:AZ')
    expect(job.status).toBe('PAUSED')
  })
})

/** A store that flips the job to PAUSED the first time the load phase persists a cursor. */
function makeStoreCopyGuard(store: MemoryStore): MemoryStore {
  const original = store.update.bind(store)
  let flips = 0
  store.update = async (t, id, patch, cond) => {
    if (t === 'aljexImportJob' && id === 'aljexrun:AZ' && patch.phase === 'LOAD' && 'cursor' in patch && flips++ === 1) {
      await original(t, id, { status: 'PAUSED' })
    }
    return original(t, id, patch, cond)
  }
  return store
}

describe('seed counter', () => {
  it('moves forward to the highest numeric PRO, never into the fixture band, never backwards', async () => {
    const store = makeStore()
    store.seed('proClaim', [{ id: '100', loadId: 'a', claimedAt: FIXED_NOW, claimedBy: 'x' }, { id: '14912', loadId: 'b', claimedAt: FIXED_NOW, claimedBy: 'x' }, { id: '950000', loadId: 'c', claimedAt: FIXED_NOW, claimedBy: 'x' }, { id: 'S000001-1', loadId: 'd', claimedAt: FIXED_NOW, claimedBy: 'x' }])
    const preview = await seedProCounter(store, {})
    expect(preview).toMatchObject({ target: 14912, wouldChange: true, applied: false })
    expect((await store.getMany('settings', ['default']))[0].nextShipmentNumber).toBeUndefined()
    const first = await seedProCounter(store, { apply: true, enableNumericScheme: true })
    expect(first).toMatchObject({ applied: true, schemeEnabled: true })
    expect((await store.getMany('settings', ['default']))[0]).toMatchObject({ nextShipmentNumber: 14912, proScheme: 'NUMERIC' })
    await store.update('settings', 'default', { nextShipmentNumber: 20000 })
    const again = await seedProCounter(store, { apply: true })
    expect(again.wouldChange).toBe(false)
    expect((await store.getMany('settings', ['default']))[0].nextShipmentNumber).toBe(20000)
  })

  it('is refused for a synthetic run', async () => {
    const store = makeStore()
    const staged = await stage(store, fixture.csv, 'aljexrun:SS')
    await expect(seedProCounter(store, { apply: true, jobId: staged.id })).rejects.toBeInstanceOf(SeedRefused)
  })

  it('one concurrent seed wins and the other leaves the counter alone', async () => {
    const store = makeStore()
    store.seed('proClaim', [{ id: '7000', loadId: 'a', claimedAt: FIXED_NOW, claimedBy: 'x' }])
    const [a, b] = await Promise.all([seedProCounter(store, { apply: true }), seedProCounter(store, { apply: true })])
    expect((await store.getMany('settings', ['default']))[0].nextShipmentNumber).toBe(7000)
    expect([a.applied, b.applied].filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })
})

describe('dedupe against records already on the target', () => {
  it('enriches a live record with finance only, LINKs a live load that has no shipment (adds only), and reports conflicting PROs', async () => {
    const store = makeStore()
    const clean = await (async () => {
      const s = makeStore()
      await fullRun(s, fixture.csv, 'P')
      return s
    })()
    // Take three delivered, invoiced PROs from a clean run and treat them as already on the target.
    const invoiced = table(clean, 'invoice').slice(0, 3)
    const orderById = new Map(table(clean, 'order').map((o) => [o.id as string, o]))
    const [enrichInv, unlinkedInv, conflictInv] = invoiced
    const liveRows = (inv: EngineRow) => {
      const order = orderById.get(inv.orderId as string)!
      const shipment = table(clean, 'shipment').find((s) => s.id === order.shipmentId)!
      const load = table(clean, 'load').find((l) => l.shipmentId === shipment.id)!
      return { order, shipment, load }
    }
    const e = liveRows(enrichInv)
    const liveOrder = { ...e.order, id: 'live-order-1', shipmentId: 'live-shp-1', arStatus: 'DOCS_NEEDED' } as EngineRow
    delete liveOrder.invoiceId
    delete liveOrder.invoiceNumber
    delete liveOrder.invoicedAt
    delete liveOrder.arBalanceCents
    const liveShipment = { ...e.shipment, id: 'live-shp-1', status: 'DELIVERED', legacySource: undefined, legacyImported: undefined, importRunId: undefined, loadIds: ['live-load-1'], orderIds: ['live-order-1'] } as EngineRow
    const liveLoad = { ...e.load, id: 'live-load-1', shipmentId: 'live-shp-1', orderId: 'live-order-1', stops: '[]' } as EngineRow
    store.seed('order', [liveOrder])
    store.seed('shipment', [liveShipment])
    store.seed('load', [liveLoad])
    store.seed('proClaim', [{ id: normalizePro(e.load.aljexId as string)!, loadId: 'live-load-1', claimedAt: FIXED_NOW, claimedBy: 'backfill', origin: 'BACKFILL' }])
    const u = liveRows(unlinkedInv)
    store.seed('load', [{ ...u.load, id: 'live-load-2', shipmentId: undefined, orderId: undefined }])
    store.seed('proClaim', [{ id: normalizePro(u.load.aljexId as string)!, loadId: 'live-load-2', claimedAt: FIXED_NOW, claimedBy: 'backfill', origin: 'BACKFILL' }])
    const c = liveRows(conflictInv)
    store.seed('proClaim', [{ id: normalizePro(c.load.aljexId as string)!, loadId: 'someone-elses', claimedAt: FIXED_NOW, claimedBy: 'manual', origin: 'CREATE' }])
    const shipmentBefore = JSON.stringify(table(store, 'shipment').find((s) => s.id === 'live-shp-1'))
    const loadBefore = JSON.stringify(table(store, 'load').find((l) => l.id === 'live-load-1'))

    await stage(store, fixture.csv, 'aljexrun:SD')
    const planned = await plan(store, 'aljexrun:SD')
    const done = await apply(store, 'aljexrun:SD', 'aljexrun:AD')
    expect(done.status).toBe('APPLIED')
    const counts = done.entityCounts as AljexEntityCounts
    expect(counts.LOAD?.enriched).toBe(1)
    expect(counts.LOAD?.conflicts).toBeGreaterThanOrEqual(1)
    expect(conservation(counts).ok).toBe(true)
    expect(planned.entityCounts).toEqual(done.entityCounts)
    expect(JSON.stringify(table(store, 'shipment').find((s) => s.id === 'live-shp-1'))).toBe(shipmentBefore)
    expect(JSON.stringify(table(store, 'load').find((l) => l.id === 'live-load-1'))).toBe(loadBefore)
    const order = table(store, 'order').find((o) => o.id === 'live-order-1')!
    expect(order.invoiceId).toBeTruthy()
    expect(order.arStatus).toMatch(/PAID|UNPAID/)
    expect(table(store, 'auditLog').some((a) => a.entityId === 'live-order-1' && a.action === 'ALJEX_IMPORT_ENRICH')).toBe(true)
    const linked = table(store, 'load').find((l) => l.id === 'live-load-2')!
    expect(linked.shipmentId).toBeTruthy()
    expect(table(store, 'shipment').find((s) => s.id === linked.shipmentId)?.loadIds).toEqual(['live-load-2'])
    expect(table(store, 'load').filter((l) => l.aljexId === u.load.aljexId)).toHaveLength(1)
  })
})

describe('LINK class (Step AW)', () => {
  /** A clean run supplies realistic rows; a target store gets selected loads as pre-existing, unlinked Loads. */
  async function target(n: number, mutate: (i: number, load: EngineRow) => EngineRow = (_i, l) => l) {
    const clean = makeStore()
    await fullRun(clean, fixture.csv, 'P')
    const orderById = new Map(table(clean, 'order').map((o) => [o.id as string, o]))
    const invoiced = table(clean, 'invoice').slice(0, n)
    const store = makeStore()
    const live = invoiced.map((inv, i) => {
      const order = orderById.get(inv.orderId as string)!
      const load = table(clean, 'load').find((l) => l.shipmentId === order.shipmentId)!
      const row = mutate(i, { ...load, id: `live-load-${i}`, aljexId: `${load.aljexId}  `, shipmentId: undefined, orderId: undefined, loadNumber: undefined, leg: undefined, status: 'IN_TRANSIT', rate: 4242 } as EngineRow)
      store.seed('load', [row])
      store.seed('proClaim', [{ id: normalizePro(load.aljexId as string)!, loadId: row.id, claimedAt: FIXED_NOW, claimedBy: 'backfill', origin: 'BACKFILL' }])
      return { pro: load.aljexId as string, row }
    })
    return { store, live }
  }
  const strip = (r: EngineRow): EngineRow => {
    const { updatedAt: _u, ...rest } = r
    return rest
  }

  it('adds shipmentId, orderId, loadNumber and leg to the existing Load and nothing else; never inserts or deletes a Load', async () => {
    const { store, live } = await target(3)
    const before = new Map(live.map((l) => [l.row.id as string, strip(table(store, 'load').find((x) => x.id === l.row.id)!)]))
    const loadsBefore = table(store, 'load').length
    await stage(store, fixture.csv, 'aljexrun:SL')
    const planned = await plan(store, 'aljexrun:SL')
    const done = await apply(store, 'aljexrun:SL', 'aljexrun:AL')
    expect(done.status).toBe('APPLIED')
    const counts = done.entityCounts as AljexEntityCounts
    expect(conservation(counts).ok).toBe(true)
    expect(planned.entityCounts).toEqual(done.entityCounts)
    expect(JSON.parse(await readAll(store.getObject('imports/jobs/aljexrun:SL/plan-summary.json'))).classes).toMatchObject({ LINK: 3, AMBIGUOUS: 0 })
    // The importer created every OTHER load of the file; the three existing ones were reused.
    expect(table(store, 'load').length - loadsBefore).toBe((counts.LOAD?.created ?? 0) - 3)
    for (const { pro, row } of live) {
      const after = strip(table(store, 'load').find((x) => x.id === row.id)!)
      const shipment = table(store, 'shipment').find((s) => s.number === normalizePro(pro))!
      expect(after).toEqual({ ...before.get(row.id as string)!, shipmentId: shipment.id, orderId: (shipment.orderIds as string[])[0], loadNumber: normalizePro(pro), leg: 1 })
      expect(shipment.loadIds).toEqual([row.id])
      expect(table(store, 'load').filter((l) => normalizePro(l.aljexId as string) === normalizePro(pro))).toHaveLength(1)
      expect(table(store, 'proClaim').find((c) => c.id === normalizePro(pro))).toMatchObject({ loadId: row.id, shipmentId: shipment.id })
    }
  })

  it('is idempotent: a second PLAN has no LINK candidates and a second APPLY writes nothing new', async () => {
    const { store } = await target(2)
    await stage(store, fixture.csv, 'aljexrun:SI')
    await plan(store, 'aljexrun:SI')
    await apply(store, 'aljexrun:SI', 'aljexrun:AI1')
    const snapshot = JSON.stringify([...table(store, 'load'), ...table(store, 'shipment'), ...table(store, 'invoice')].map(strip).sort((a, b) => String(a.id).localeCompare(String(b.id))))
    await plan(store, 'aljexrun:SI')
    expect(JSON.parse(await readAll(store.getObject('imports/jobs/aljexrun:SI/plan-summary.json'))).classes.LINK).toBe(0)
    const second = await apply(store, 'aljexrun:SI', 'aljexrun:AI2')
    expect(second.status).toBe('APPLIED')
    expect(JSON.stringify([...table(store, 'load'), ...table(store, 'shipment'), ...table(store, 'invoice')].map(strip).sort((a, b) => String(a.id).localeCompare(String(b.id))))).toBe(snapshot)
  })

  it('writes the four-bucket link report on PLAN, without touching a table', async () => {
    const { store } = await target(2)
    store.seed('load', [{ id: 'orphan-no-pro', status: 'SOURCING' }])
    await stage(store, fixture.csv, 'aljexrun:SR')
    const loadsBefore = JSON.stringify(table(store, 'load'))
    await plan(store, 'aljexrun:SR')
    expect(JSON.stringify(table(store, 'load'))).toBe(loadsBefore)
    const md = await readAll(store.getObject('imports/runs/aljexrun:SR/link-report.md'))
    expect(md).toContain('Buckets add up: YES')
    const csv = (await readAll(store.getObject('imports/runs/aljexrun:SR/link-report.csv'))).split('\n')
    expect(csv.filter((l) => l.includes(',MATCHED_BY_PRO,'))).toHaveLength(2)
    expect(csv.some((l) => l.startsWith('orphan-no-pro,,LINKED_BY_ID,NO_PRO'))).toBe(true)
  })

  it('never guesses: a duplicated PRO, an existing shipment with that PRO, or a foreign claim writes nothing and is listed as ambiguous', async () => {
    const { store, live } = await target(4)
    // 0: a second Load carries the same PRO. 1: a Shipment with that PRO already exists. 2: claim held by another Load.
    store.seed('load', [{ ...table(store, 'load').find((l) => l.id === 'live-load-0')!, id: 'live-load-0-twin' }])
    store.seed('shipment', [{ id: 'existing-shp', number: normalizePro(live[1].pro)!, status: 'BOOKED', loadIds: [], orderIds: [] }])
    store.seed('proClaim', [{ id: normalizePro(live[2].pro)!, loadId: 'someone-elses', claimedAt: FIXED_NOW, claimedBy: 'manual', origin: 'CREATE' }])
    const before = JSON.stringify(table(store, 'load').filter((l) => ['live-load-0', 'live-load-0-twin', 'live-load-1', 'live-load-2'].includes(l.id as string)).map(strip))
    await stage(store, fixture.csv, 'aljexrun:SA')
    await plan(store, 'aljexrun:SA')
    const done = await apply(store, 'aljexrun:SA', 'aljexrun:AA')
    const counts = done.entityCounts as AljexEntityCounts
    expect(conservation(counts).ok).toBe(true)
    expect(JSON.parse(await readAll(store.getObject('imports/jobs/aljexrun:SA/plan-summary.json'))).classes.AMBIGUOUS).toBe(3)
    expect(JSON.stringify(table(store, 'load').filter((l) => ['live-load-0', 'live-load-0-twin', 'live-load-1', 'live-load-2'].includes(l.id as string)).map(strip))).toBe(before)
    const found = (await readAll(store.getObject(`imports/runs/aljexrun:AA/findings.csv`))).split('\n').filter((l) => l.startsWith('LINK_AMBIGUOUS'))
    expect(found.map((l) => l.split(',')[3]).sort()).toEqual(['DUPLICATE_LOAD_PRO', 'PRO_CLAIMED_BY_OTHER_LOAD', 'SHIPMENT_NOT_LINKED'])
    expect(table(store, 'shipment').filter((s) => s.number === normalizePro(live[0].pro))).toHaveLength(0)
    // live[3] was unambiguous and linked.
    expect(table(store, 'load').find((l) => l.id === 'live-load-3')?.shipmentId).toBeTruthy()
  })

  it('loses cleanly to a concurrent link: the conditional update fails, nothing else is written for that PRO', async () => {
    const { store, live } = await target(1)
    await stage(store, fixture.csv, 'aljexrun:SX')
    await plan(store, 'aljexrun:SX')
    const realTransact = store.transact.bind(store)
    store.transact = async (items, label) => {
      if (label.startsWith('link ')) store.seed('load', [{ ...table(store, 'load').find((l) => l.id === live[0].row.id)!, shipmentId: 'someone-else-linked-it' }])
      return realTransact(items, label)
    }
    const done = await apply(store, 'aljexrun:SX', 'aljexrun:AX')
    const counts = done.entityCounts as AljexEntityCounts
    expect(counts.LOAD?.conflicts).toBeGreaterThanOrEqual(1)
    expect(conservation(counts).ok).toBe(true)
    expect(table(store, 'load').find((l) => l.id === live[0].row.id)?.shipmentId).toBe('someone-else-linked-it')
    expect(table(store, 'shipment').filter((s) => s.number === normalizePro(live[0].pro))).toHaveLength(0)
    expect((await readAll(store.getObject('imports/runs/aljexrun:AX/findings.csv'))).split('\n').some((l) => l.startsWith('LINK_RACE'))).toBe(true)
  })

  it('does not import Aljex rep, creator, service-rep or dispatcher codes onto a linked shipment either', async () => {
    const { store } = await target(1)
    await stage(store, fixture.csv, 'aljexrun:SC2')
    await plan(store, 'aljexrun:SC2')
    await apply(store, 'aljexrun:SC2', 'aljexrun:AC2')
    for (const s of table(store, 'shipment')) for (const f of ['salesRepCode', 'createdByCode', 'serviceRepCode', 'dispatcherCode', 'salesRepId', 'carrierRepId']) expect(s[f]).toBeUndefined()
  })
})

describe('history window and carried-over marks (Step AW R19-R21)', () => {
  const shipDates = async (store: MemoryStore, root: string): Promise<string[]> => {
    const idx = JSON.parse(await readAll(store.getObject(`imports/jobs/${root}/stage-index.json`))) as { chunkCount: number }
    const out: string[] = []
    for (let c = 0; c < idx.chunkCount; c++) {
      const text = await readAll(store.getObject(`imports/jobs/${root}/rows-${String(c).padStart(4, '0')}.jsonl`))
      for (const l of text.split('\n').filter(Boolean)) {
        const r = JSON.parse(l) as { kind: string; dates: { ship: string | null } }
        if (r.kind === 'LOAD' && r.dates.ship) out.push(r.dates.ship)
      }
    }
    return out.sort()
  }

  it('keeps loads shipping on or after the cutoff (the cutoff means BOOKED) and skips + lists loads older than cutoff - 24 months', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:H0')
    const dates = await shipDates(store, 'aljexrun:H0')
    expect(dates.length).toBeGreaterThan(10)
    type Idx = { history: { cutoffDate: string; windowStart: string; beforeWindow: number; afterCutoff?: number }; stagedSkips: Record<string, number>; maxProNumber: number }
    const readIdx = async (root: string) => JSON.parse(await readAll(store.getObject(`imports/jobs/${root}/stage-index.json`))) as Idx

    // Cutoff on the newest ship day: that day is "on or after the cutoff" and is kept, nothing is skipped.
    const cutoff = dates[dates.length - 1]
    expect((await stage(store, fixture.csv, 'aljexrun:H1', { options: { cutoffDate: cutoff, minShipDate: '' } })).status).toBe('READY')
    const idx = await readIdx('aljexrun:H1')
    expect(idx.history.beforeWindow).toBe(dates.filter((d) => d < idx.history.windowStart).length)
    expect(idx.history.afterCutoff).toBeUndefined()
    expect(idx.stagedSkips.AFTER_CUTOFF).toBeUndefined()
    expect(await shipDates(store, 'aljexrun:H1')).toEqual(dates.filter((d) => d >= idx.history.windowStart))
    expect(dates.filter((d) => d >= cutoff).length).toBeGreaterThan(0)

    // Cutoff 24 months after the newest day: everything older than the newest day is before the window.
    const late = `${Number(cutoff.slice(0, 4)) + 2}${cutoff.slice(4)}`.replace(/-02-29$/, '-02-28')
    expect((await stage(store, fixture.csv, 'aljexrun:H3', { options: { cutoffDate: late, minShipDate: '' } })).status).toBe('READY')
    const idx3 = await readIdx('aljexrun:H3')
    expect(idx3.history.windowStart).toBe(cutoff)
    expect(idx3.history.beforeWindow).toBe(dates.filter((d) => d < cutoff).length)
    expect(idx3.history.beforeWindow).toBeGreaterThan(0)
    const csv = (await readAll(store.getObject('imports/jobs/aljexrun:H3/history-skipped.csv'))).split('\n').filter(Boolean)
    expect(csv).toHaveLength(1 + idx3.history.beforeWindow)
    expect(csv[0]).toBe('pro,ship_date,reason')
    expect(csv.slice(1).every((l) => l.endsWith(',BEFORE_WINDOW'))).toBe(true)
    // A skipped PRO still raises the numbering floor.
    const plain = await readIdx('aljexrun:H0')
    expect(idx3.maxProNumber).toBe(plain.maxProNumber)
  })

  it('takes the cutoff from TmsSettings.aljexCutoffAt (Chicago day) when the job gives none', async () => {
    const store = makeStore()
    store.seed('settings', [{ id: 'default', defaultPaymentTermsDays: 30, aljexCutoffAt: '2031-11-07T06:00:00.000Z' }])
    await stage(store, fixture.csv, 'aljexrun:H2')
    const idx = JSON.parse(await readAll(store.getObject('imports/jobs/aljexrun:H2/stage-index.json'))) as { history: { cutoffDate: string; windowStart: string } }
    expect(idx.history).toMatchObject({ cutoffDate: '2031-11-07', windowStart: '2029-11-07' })
  })

  it('marks every imported invoice and bill as carried over, naming the cutoff', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:H3')
    const dates = await shipDates(store, 'aljexrun:H3')
    const cutoff = `${Number(dates[dates.length - 1].slice(0, 4)) + 1}-12-31`
    await stage(store, fixture.csv, 'aljexrun:H5', { options: { cutoffDate: cutoff, minShipDate: '' } })
    await plan(store, 'aljexrun:H5')
    const done = await apply(store, 'aljexrun:H5', 'aljexrun:H6')
    expect(done.status).toBe('APPLIED')
    const invoices = table(store, 'invoice')
    const bills = table(store, 'carrierBill')
    expect(invoices.length).toBeGreaterThan(0)
    expect(bills.length).toBeGreaterThan(0)
    for (const i of invoices) expect(i).toMatchObject({ markedSentAt: i.issuedAt, markedSentNote: expect.stringMatching(/^Carried over from Aljex( \(cutoff \d{4}-\d{2}-\d{2}\))?$/) })
    for (const b of bills) expect(b).toMatchObject({ markedSentAt: expect.any(String), markedSentNote: expect.stringMatching(/^Carried over from Aljex/) })
    expect(invoices.some((i) => i.markedSentNote === `Carried over from Aljex (cutoff ${cutoff})`)).toBe(true)
  })

  it('never imports a row shipped before 2025-01-01 by default (the pre-2025 delete): skipped, counted and listed, with or without a cutoff', async () => {
    const store = makeStore()
    await stage(store, fixture.csv, 'aljexrun:M0')
    const all = await shipDates(store, 'aljexrun:M0')
    const old = all.filter((d) => d < '2025-01-01')
    expect(old.length).toBeGreaterThan(0)
    expect(all.length - old.length).toBeGreaterThan(0)
    type Idx = { history: { minShipDate?: string; beforeMinShipDate?: number }; stagedSkips: Record<string, number> }
    for (const [id, options] of [['aljexrun:M1', {}], ['aljexrun:M2', { cutoffDate: all[all.length - 1] }]] as const) {
      expect((await stage(store, fixture.csv, id, { options })).status).toBe('READY')
      const idx = JSON.parse(await readAll(store.getObject(`imports/jobs/${id}/stage-index.json`))) as Idx
      expect(idx.history).toMatchObject({ minShipDate: '2025-01-01' })
      expect((await shipDates(store, id)).every((d) => d >= '2025-01-01')).toBe(true)
      expect(idx.stagedSkips.EXCLUDED_BEFORE_MIN_SHIP_DATE).toBe(idx.history.beforeMinShipDate)
      const csv = (await readAll(store.getObject(`imports/jobs/${id}/history-skipped.csv`))).split('\n').filter(Boolean)
      expect(csv.filter((l) => l.endsWith(',BEFORE_MIN_SHIP_DATE'))).toHaveLength(idx.history.beforeMinShipDate as number)
    }
    // a job-level override moves the floor
    await stage(store, fixture.csv, 'aljexrun:M3', { options: { minShipDate: '2030-01-01' } })
    expect(await shipDates(store, 'aljexrun:M3')).toEqual([])
  })
})

describe('sensitive columns', () => {
  it.each(['Fed/SS #', 'Bank Account', 'Routing #'])('refuses a file whose header contains %s, naming the column and reading no cell', async (column) => {
    const store = makeStore()
    const [header, ...rest] = fixture.csv.split('\n')
    const csv = [`${header},${column}`, ...rest.map((l) => (l ? `${l},SENTINEL-VALUE` : l))].join('\n')
    const job = await stage(store, csv, 'aljexrun:Z')
    expect(job.status).toBe('FAILED')
    expect(job.error).toContain(column)
    expect(job.error).not.toContain('SENTINEL-VALUE')
  })
})

describe('reconciliation scope', () => {
  it('ties on everything the import wrote and names every invoiced row it did not write', async () => {
    const clean = makeStore()
    await fullRun(clean, fixture.csv, 'P')
    const orderById = new Map(table(clean, 'order').map((o) => [o.id as string, o]))
    const invoices = table(clean, 'invoice')
    const invoicesOf = (customerId: unknown) => invoices.filter((i) => i.customerId === customerId)
    // A paid invoice of a customer that has other invoiced loads in the file.
    const enrichInv = invoices.find((i) => typeof i.paidCents === 'number' && i.paidCents > 0 && invoicesOf(i.customerId).length > 1)!
    const others = invoices.filter((i) => i.id !== enrichInv.id && i.customerId !== enrichInv.customerId)
    const [mismatchInv, invoicedInv, carrierInv] = others
    const store = makeStore()
    // The live copy of an invoice's PRO: a shipment/order/load without finance, claimed by a backfill.
    const seedLive = (inv: EngineRow, n: number, tweak: (order: EngineRow) => void): string => {
      const order = orderById.get(inv.orderId as string)!
      const shipment = table(clean, 'shipment').find((s) => s.id === order.shipmentId)!
      const load = table(clean, 'load').find((l) => l.shipmentId === shipment.id)!
      const liveOrder = { ...order, id: `live-order-${n}`, shipmentId: `live-shp-${n}`, arStatus: 'DOCS_NEEDED' } as EngineRow
      for (const k of ['invoiceId', 'invoiceNumber', 'invoicedAt', 'arBalanceCents']) delete liveOrder[k]
      tweak(liveOrder)
      store.seed('order', [liveOrder])
      store.seed('shipment', [{ ...shipment, id: `live-shp-${n}`, status: 'DELIVERED', legacySource: undefined, legacyImported: undefined, importRunId: undefined, loadIds: [`live-load-${n}`], orderIds: [`live-order-${n}`] } as EngineRow])
      store.seed('load', [{ ...load, id: `live-load-${n}`, shipmentId: `live-shp-${n}`, orderId: `live-order-${n}`, stops: '[]' } as EngineRow])
      store.seed('proClaim', [{ id: normalizePro(load.aljexId as string)!, loadId: `live-load-${n}`, claimedAt: FIXED_NOW, claimedBy: 'backfill', origin: 'BACKFILL' }])
      return liveOrder.id as string
    }
    const enrichOrder = seedLive(enrichInv, 1, () => {})
    seedLive(mismatchInv, 2, (o) => { o.revenueCents = (o.revenueCents as number) + 100 })
    seedLive(invoicedInv, 3, (o) => { o.invoiceId = 'prod-invoice-3' })
    // A live leg whose carrier MC is not the Aljex row's: still a hard ENRICH_MISMATCH (revenue alone no longer is).
    const carrierOrderId = seedLive(carrierInv, 4, () => {})
    const carrierLeg = table(clean, 'loadCarrier').find((l) => l.loadId === table(clean, 'load').find((x) => x.orderId === carrierInv.orderId)!.id)!
    store.seed('loadCarrier', [{ ...carrierLeg, id: 'live-leg-4', loadId: 'live-load-4', carrierMc: '9999991', kind: 'CARRIER', carrierId: 'live-carrier-4' } as EngineRow])
    store.seed('load', [{ ...table(store, 'load').find((l) => l.id === 'live-load-4')!, activeLoadCarrierId: 'live-leg-4' } as EngineRow])
    // Two directory customers share the enriched invoice's customer name: the import cannot pick one, so the
    // account stays unresolved while the live order already carries its own customer.
    const customerName = table(clean, 'customer').find((c) => c.id === enrichInv.customerId)!.name as string
    const dup = (id: string): EngineRow => ({ id, name: customerName, normalizedName: customerName.toLowerCase(), status: 'ACTIVE', active: true })
    store.seed('customer', [dup('dup-customer-1'), dup('dup-customer-2')])

    await stage(store, fixture.csv, 'aljexrun:SC')
    await plan(store, 'aljexrun:SC')
    const done = await apply(store, 'aljexrun:SC', 'aljexrun:AC')
    expect(done.status).toBe('APPLIED')

    // The enriched invoice keeps the live order's customer, so its receipt must be written for that customer.
    const enriched = table(store, 'order').find((o) => o.id === enrichOrder)!
    const paidOnInvoice = table(store, 'arPayment').flatMap((p) => (p.applications as Array<{ invoiceId: string; amountCents: number }>) ?? []).filter((a) => a.invoiceId === enriched.invoiceId).reduce((n, a) => n + a.amountCents, 0)
    expect(paidOnInvoice).toBe(enrichInv.paidCents)

    const summary = await reconcile(store, done.id)
    expect(summary.reconciled).toBe(true)
    for (const b of summary.bridge) if (b.diffCents != null) expect({ key: b.key, diff: b.diffCents }).toEqual({ key: b.key, diff: 0 })
    const byKey = new Map(summary.bridge.map((b) => [b.key, b]))
    for (const code of ['INVOICE_NO_CUSTOMER', 'ENRICH_MISMATCH', 'EXISTING_INVOICE']) {
      expect(byKey.get(`notImported:${code}:invoiceTotal`)?.fileCents, code).toBeGreaterThan(0)
    }
    // A differing revenue no longer blocks the invoice: the Aljex amount is written, the order's revenue stays.
    const mismatchOrder = table(store, 'order').find((o) => o.id === 'live-order-2')!
    expect(mismatchOrder.invoiceId).toBeTruthy()
    expect(table(store, 'invoice').find((i) => i.id === mismatchOrder.invoiceId)!.totalCents).toBe(mismatchInv.totalCents)
    expect(table(store, 'order').find((o) => o.id === carrierOrderId)!.invoiceId).toBeUndefined()
    // The written scope and the not-imported items add up to every invoiced load of the file.
    const written = byKey.get('invoiceTotal')!
    const all = byKey.get('invoiceTotalAll')!
    const notImported = summary.bridge.filter((b) => /^notImported:.*:invoiceTotal$/.test(b.key)).reduce((n, b) => n + (b.fileCents ?? 0), 0)
    expect((written.fileCents ?? 0) + notImported).toBe(all.fileCents)
    // PLAN shows the same bridge before anything is written.
    const plannedBridge = (JSON.parse(await readAll(store.getObject('imports/jobs/aljexrun:SC/plan-summary.json'))) as { bridge: Array<{ key: string; diffCents: number | null }> }).bridge
    for (const b of plannedBridge) if (b.diffCents != null) expect({ key: b.key, diff: b.diffCents }).toEqual({ key: b.key, diff: 0 })
  })
})

describe('revenue differences (Option 1: the Aljex invoice wins, nothing live is rewritten)', () => {
  /** A live (backfilled) copy of one invoiced PRO whose BCAT revenue differs by 4321; runs stage/plan/apply with the given open-AR PRO set. */
  async function run(pick: (i: EngineRow) => boolean, arOpen: 'none' | 'open' | 'closed', tag: string) {
    const clean = makeStore()
    await fullRun(clean, fixture.csv, `R${tag}`)
    const inv = table(clean, 'invoice').find(pick)!
    expect(inv).toBeTruthy()
    const order = table(clean, 'order').find((o) => o.id === inv.orderId)!
    const shipment = table(clean, 'shipment').find((s) => s.id === order.shipmentId)!
    const load = table(clean, 'load').find((l) => l.shipmentId === shipment.id)!
    const store = makeStore()
    const liveOrder = { ...order, id: 'prod-order', shipmentId: 'prod-shp', arStatus: 'DOCS_NEEDED', revenueCents: (order.revenueCents as number) + 4321 } as EngineRow
    for (const k of ['invoiceId', 'invoiceNumber', 'invoicedAt', 'arBalanceCents']) delete liveOrder[k]
    const prodLoad = { ...load, id: 'prod-load', shipmentId: 'prod-shp', orderId: 'prod-order', rate: 123456, sortOrder: 7, stops: '[]', driverId: 'drv-1', status: 'DELIVERED', leg: 1, loadNumber: load.aljexId } as EngineRow
    store.seed('order', [liveOrder])
    store.seed('shipment', [{ ...shipment, id: 'prod-shp', status: 'DELIVERED', legacySource: undefined, legacyImported: undefined, importRunId: undefined, loadIds: ['prod-load'], orderIds: ['prod-order'] } as EngineRow])
    store.seed('load', [prodLoad])
    store.seed('proClaim', [{ id: normalizePro(load.aljexId as string)!, loadId: 'prod-load', claimedAt: FIXED_NOW, claimedBy: 'backfill', origin: 'BACKFILL' }])
    const before = JSON.stringify(table(store, 'load').find((l) => l.id === 'prod-load'))
    const stageId = `aljexrun:RD${tag}`
    if (arOpen !== 'none') await store.putObject(arOpenKey(stageId), JSON.stringify(arOpen === 'open' ? [normalizePro(load.aljexId as string)] : []))
    await stage(store, fixture.csv, stageId)
    await plan(store, stageId)
    const done = await apply(store, stageId, `${stageId}A`)
    expect(done.status).toBe('APPLIED')
    const after = table(store, 'order').find((o) => o.id === 'prod-order')!
    const findings = (await readAll(store.getObject(`imports/runs/${done.id}/findings.csv`))).split('\n')
    expect(findings.filter((l) => l.startsWith('ENRICH_MISMATCH'))).toEqual([])
    const differs = findings.filter((l) => l.startsWith('ENRICH_REVENUE_DIFFERS'))
    expect(differs).toHaveLength(1)
    const detail = JSON.parse(differs[0].slice(differs[0].indexOf('{')).replace(/"$/, '').replace(/""/g, '"'))
    const invoice = table(store, 'invoice').find((i) => i.id === after.invoiceId)!
    // Never rewritten: the Load row is byte-identical, the Order keeps BCAT's revenue.
    expect(JSON.stringify(table(store, 'load').find((l) => l.id === 'prod-load'))).toBe(before)
    expect(after.revenueCents).toBe(liveOrder.revenueCents)
    expect(detail).toMatchObject({ pro: load.aljexId, bcatCents: liveOrder.revenueCents, aljexCents: (liveOrder.revenueCents as number) - 4321, diffCents: -4321, paidCents: inv.paidCents })
    expect(typeof detail.customer).toBe('string')
    expect(typeof detail.billTo).toBe('string')
    return { inv, invoice, detail, store, done, planned: JSON.parse(await readAll(store.getObject(`imports/jobs/${stageId}/plan-revenue-differences.json`))) as Array<{ pro: string; basis: string }> }
  }

  it('without an AR report the Aljex amount is invoiced and the row stays on the review list', async () => {
    const r = await run((i) => (i.totalCents as number) > 0, 'none', 'A')
    expect(r.invoice.totalCents).toBe(r.inv.totalCents)
    expect(r.detail.basis).toBe('ALJEX_AMOUNT')
    expect(r.planned.map((p) => p.pro)).toEqual([r.detail.pro])
  })

  it('an outstanding PRO (in the open AR report) is invoiced at the Aljex amount and stays on the review list', async () => {
    const r = await run((i) => (i.paidCents as number) > 0 && (i.balanceCents as number) > 0, 'open', 'O')
    expect(r.invoice.totalCents).toBe(r.inv.totalCents)
    expect(r.invoice.balanceCents).toBe(r.inv.balanceCents)
    expect(r.detail).toMatchObject({ basis: 'ALJEX_AMOUNT', state: 'PARTIAL' })
  })

  it('a fully paid PRO (not in the open AR report) carries the amount actually paid, is not on the review list and reconciles as an explained item', async () => {
    const r = await run((i) => (i.paidCents as number) > 0 && (i.balanceCents as number) > 0, 'closed', 'P')
    expect(r.invoice).toMatchObject({ totalCents: r.inv.paidCents, paidCents: r.inv.paidCents, balanceCents: 0, status: 'PAID' })
    expect(r.detail).toMatchObject({ basis: 'PAID_AMOUNT', state: 'PAID', invoiceCents: r.detail.aljexCents })
    expect(revenueDifferencesCsv([r.detail]).rows).toBe(0)
    const summary = await reconcile(r.store, r.done.id)
    const byKey = new Map(summary.bridge.map((b) => [b.key, b]))
    expect(byKey.get('explained:PAID_AMOUNT_USED:invoiceTotal')?.fileCents).toBe(r.inv.balanceCents)
    for (const b of summary.bridge) if (b.diffCents != null) expect({ key: b.key, diff: b.diffCents }).toEqual({ key: b.key, diff: 0 })
  })
})

describe('revenue-difference summary and review CSV', () => {
  const d = (pro: string, diffCents: number, basis: 'PAID_AMOUNT' | 'ALJEX_AMOUNT', state: 'OPEN' | 'PARTIAL' | 'PAID', paidCents = 0): RevenueDifference => ({ pro, bcatCents: 100_00, aljexCents: 100_00 + diffCents, diffCents, invoiceCents: 100_00 + diffCents, paidCents, balanceCents: basis === 'PAID_AMOUNT' ? 0 : 50_00, dueDate: '2026-12-01', state, basis, customer: 'ZZ Cust', billTo: 'ZZ Bill' })
  const list = [d('1', 5_00, 'ALJEX_AMOUNT', 'OPEN'), d('2', -30_00, 'ALJEX_AMOUNT', 'PARTIAL', 10_00), d('3', 7_00, 'PAID_AMOUNT', 'PAID', 100_00), d('4', 2_00, 'PAID_AMOUNT', 'PAID', 110_00), d('5', 400_00, 'ALJEX_AMOUNT', 'OPEN')]

  it('splits paid (short/over), partial and outstanding and lists only review rows, absolute difference descending', () => {
    const s = summarizeRevenueDifferences(list)
    expect(s).toMatchObject({ total: 5, onReviewCsv: 3, paid: { count: 2, absCents: 15_00, shortCount: 1, shortCents: 7_00, overCount: 1, overCents: 8_00 }, partial: { count: 1, absCents: 30_00 }, outstanding: { count: 2, absCents: 405_00 } })
    expect(summaryLines(s, 0)[0]).toMatch(/^revenueDifferences: total 5, paid 2 \(absCents 1500, shortCount 1, shortCents 700, overCount 1, overCents 800\), partial 1 \(absCents 3000\), outstanding 2 \(absCents 40500\), onReviewCsv 3$/)
    const { csv, rows } = revenueDifferencesCsv(list)
    expect(rows).toBe(3)
    expect(csv.split('\n').slice(1, 4).map((l) => l.split(',')[0])).toEqual(['5', '2', '1'])
  })
})

describe('required schema fields', () => {
  const schema = readFileSync(new URL('../../../data/resource.ts', import.meta.url), 'utf8')
  const requiredOf = (model: string): string[] => {
    const start = schema.search(new RegExp(`^ {2}${model}: a$`, 'm'))
    const rest = schema.slice(start + 1)
    const end = rest.search(/^ {2}[A-Za-z]+: a$/m)
    const block = rest.slice(0, end < 0 ? undefined : end)
    return [...block.matchAll(/^\s{6}(\w+):\s+a\.[^\n]*\.required\(\)/gm)].map((m) => m[1])
  }

  it.each(Object.entries(MODEL_NAME).filter(([t]) => ['shipment', 'order', 'load', 'loadCarrier', 'loadFinancials', 'loadCharge', 'invoice', 'arPayment', 'carrierBill', 'apPayment', 'carrier', 'proClaim', 'auditLog', 'customer', 'location', 'legacyAljexRow'].includes(t)))(
    'every %s row written by a full run carries all of its required fields',
    async (logical, model) => {
      const { store } = await applied()
      const rows = table(store, logical as EngineTable)
      expect(rows.length).toBeGreaterThan(0)
      const required = requiredOf(model)
      expect(required.length).toBeGreaterThan(0)
      for (const row of rows) for (const f of required) expect({ model, f, present: row[f] !== undefined && row[f] !== null }).toEqual({ model, f, present: true })
    },
  )
})

describe('dev suffix pin', () => {
  it('uses the dev suffix of the dev stack', () => {
    expect(DEV_SUFFIX).toBe('nc3jsnxdmjhkpequimypiatkma-NONE')
  })
})
