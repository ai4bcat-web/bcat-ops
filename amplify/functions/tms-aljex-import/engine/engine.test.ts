import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AljexEntityCounts, EngineRow, EngineTable } from '../../../../src/types/tms'
import { apply, devTables, drive, FIXED_NOW, fullRun, makeFixture, makeStore, plan, stage } from './testKit'
import { CrashInjected, type MemoryStore } from './memoryStore'
import { conservation, reconcile } from './reconcile'
import { seedProCounter, SeedRefused } from './seedCounter'
import { DEV_SUFFIX, MODEL_NAME, PROD_SUFFIX } from './tables'
import { readAll } from './util'
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
    for (const [pro, code] of Object.entries(o.codes.salesRep)) expect({ pro, code: shipments.get(pro)?.salesRepCode }).toEqual({ pro, code })
    for (const [pro, code] of Object.entries(o.codes.createdBy)) expect({ pro, code: shipments.get(pro)?.createdByCode }).toEqual({ pro, code })
    for (const [pro, code] of Object.entries(o.codes.dispatcher)) expect({ pro, code: shipments.get(pro)?.dispatcherCode }).toEqual({ pro, code })
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
  it('enriches a live record with finance only, leaves its status/stops/carrier untouched, and reports unlinked and conflicting PROs', async () => {
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
    expect(counts.LOAD?.skipped).toBeGreaterThanOrEqual(1)
    expect(conservation(counts).ok).toBe(true)
    expect(planned.entityCounts).toEqual(done.entityCounts)
    expect(JSON.stringify(table(store, 'shipment').find((s) => s.id === 'live-shp-1'))).toBe(shipmentBefore)
    expect(JSON.stringify(table(store, 'load').find((l) => l.id === 'live-load-1'))).toBe(loadBefore)
    const order = table(store, 'order').find((o) => o.id === 'live-order-1')!
    expect(order.invoiceId).toBeTruthy()
    expect(order.arStatus).toMatch(/PAID|UNPAID/)
    expect(table(store, 'auditLog').some((a) => a.entityId === 'live-order-1' && a.action === 'ALJEX_IMPORT_ENRICH')).toBe(true)
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
    const [mismatchInv, invoicedInv] = others
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
