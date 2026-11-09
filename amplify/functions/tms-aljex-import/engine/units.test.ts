import { describe, expect, it } from 'vitest'
import { carrierKey, customerKey, locationAddressKey, locationKey } from '../../_shared/directoryKeys'
import { DEFAULT_ALJEX_PROFILE } from '../../../../src/lib/aljex/profile'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { selectedCarriers } from './directory'
import { apFromRow } from './facts'
import { invoiceMath } from './memos'
import { liveTableSet, main, parseArgs, parseSlice, parseTarget } from './cli'
import { makeFixture, makeStore } from './testKit'
import { MemoryStore } from './memoryStore'
import { assertTargets, DEV_SUFFIX, PROD_SUFFIX, productionPolicy, tableSetFor, TargetRefused } from './tables'
import type { StagedMasters, MasterCarrier } from './types'

describe('directory keys (golden corpus: each helper keeps its historical output)', () => {
  it.each([
    ['Acme Logistics, LLC', 'acme logistics', 'acme logistics'],
    ['O’Brien & Sons Co.', 'o brien sons', 'o brien sons co'],
    ['Global Enterprises Inc', 'global', 'global enterprises'],
    ['Café Frio Incorporated', 'caf frio incorporated', 'cafe frio'],
  ])('%s', (name, customer, carrier) => {
    expect(customerKey(name)).toBe(customer)
    expect(locationKey(name)).toBe(customer)
    expect(carrierKey(name)).toBe(carrier)
  })

  it('builds the location address key from the non-empty parts only', () => {
    expect(locationAddressKey({ street: '1 Main St.', city: 'Joliet', state: 'IL', zip: '60431', country: 'US' })).toBe('1 main st joliet il 60431 us')
    expect(locationAddressKey({ street: '', city: 'Joliet', state: null, zip: undefined, country: 'US' })).toBe('joliet us')
    expect(locationAddressKey({})).toBe('')
  })
})

function carrier(over: Partial<MasterCarrier>): MasterCarrier {
  return { id: 'K1', name: 'ZZ Carrier', names: [], mc: '123', mcPrefix: 'MC', dot: '', scac: '', safetyRating: '', phone: '', email: '', dispatcher: '', dispatchPhone: '', loads: 1, newestShip: '2024-01-10', openBill: false, inFlight: false, costCents: 0, ownAsset: false, caIntrastate: '', caIntrastateExp: null, txPuc: '', txPucExp: null, ...over }
}

describe('carrier window (DECIDED-7)', () => {
  const masters = (carriers: MasterCarrier[], newest: string | null): StagedMasters => ({ customers: [], carriers, memos: { byInvoice: {}, orphans: [], appliedCents: 0, orphanCents: 0 }, newestShip: newest, window: { start: '2000-01-01', end: '2035-12-31' }, chunkCount: 0, rowsPerChunk: 500 })

  it('anchors on the data: 12 months before the newest ship date, with open-bill and in-flight carriers promoted', () => {
    const m = masters(
      [carrier({ id: 'recent', newestShip: '2026-05-01' }), carrier({ id: 'old', newestShip: '2025-10-01' }), carrier({ id: 'old-open', newestShip: '2024-01-01', openBill: true }), carrier({ id: 'old-live', newestShip: '2024-01-01', inFlight: true }), carrier({ id: 'ivan', newestShip: '2026-06-01', ownAsset: true })],
      '2026-11-02',
    )
    const { selected, skipped } = selectedCarriers(m, DEFAULT_ALJEX_PROFILE)
    expect(selected.map((c) => c.id).sort()).toEqual(['old-live', 'old-open', 'recent'])
    expect(skipped.map((c) => c.id)).toEqual(['old'])
  })

  it('an explicit cutoff replaces the data anchor', () => {
    const m = masters([carrier({ id: 'a', newestShip: '2025-10-01' })], '2026-11-02')
    expect(selectedCarriers(m, { ...DEFAULT_ALJEX_PROFILE, carrierCutoffDate: '2025-12-31' }).selected).toHaveLength(1)
    expect(selectedCarriers(m, { ...DEFAULT_ALJEX_PROFILE, carrierCutoffDate: '2027-12-31' }).selected).toHaveLength(0)
  })
})

function row(over: Partial<CanonicalRow> & { paid?: Array<{ name: string; gl: string; cents: number }>; projected?: number[] }): CanonicalRow {
  const base = {
    kind: 'LOAD',
    carrier: { id: 'K1', name: 'ZZ Carrier', mc: '1' },
    projectedExpenses: (over.projected ?? [100000]).map((c, i) => ({ n: i + 1, payee: '', amountCents: c, type: i === 0 ? 'LINE' : 'MISC' })),
    paidExpenses: (over.paid ?? []).map((p, i) => ({ n: i + 1, name: p.name, gl: p.gl, amountCents: p.cents, date: '2026-01-02', checkNo: '' })),
    money: { projectedCarrierExpenseCents: 0, actualCarrierExpCents: 0 },
  }
  return base as unknown as CanonicalRow
}

describe('carrier AP rule (ALJEX_MAPPING D14)', () => {
  it('treats GL 7030 as the quick-pay fee and GL 4400 as a carrier payment', () => {
    const ap = apFromRow(row({ paid: [{ name: 'SOMEONE ELSE', gl: '4400', cents: 90000 }, { name: 'ZZ Carrier', gl: '7030', cents: -2000 }] }), DEFAULT_ALJEX_PROFILE, true)!
    expect(ap).toMatchObject({ grossCents: 100000, feeCents: 2000, netCents: 98000, paidCents: 90000, balanceCents: 8000, status: 'PARTIAL' })
  })

  it('other paid entries are extra bill lines that are also paid, so they never move the balance', () => {
    const ap = apFromRow(row({ paid: [{ name: 'ZZ Carrier', gl: '', cents: 100000 }, { name: 'Misc Vendor', gl: '2000', cents: 5000 }] }), DEFAULT_ALJEX_PROFILE, true)!
    expect(ap).toMatchObject({ grossCents: 105000, paidCents: 105000, balanceCents: 0, status: 'PAID' })
  })

  it('keeps an overpayment as unapplied money instead of a negative balance', () => {
    const ap = apFromRow(row({ paid: [{ name: 'ZZ Carrier', gl: '4400', cents: 120000 }] }), DEFAULT_ALJEX_PROFILE, true)!
    expect(ap).toMatchObject({ paidCents: 100000, unappliedCents: 20000, balanceCents: 0 })
  })

  it('yields no bill for an undelivered load, an own-asset carrier or no carrier cost', () => {
    expect(apFromRow(row({}), DEFAULT_ALJEX_PROFILE, false)).toBeNull()
    const ivan = row({})
    ;(ivan.carrier as { name: string }).name = 'ZZ Ivan Cartage'
    expect(apFromRow(ivan, DEFAULT_ALJEX_PROFILE, true)).toBeNull()
    expect(apFromRow(row({ projected: [] }), DEFAULT_ALJEX_PROFILE, true)).toBeNull()
  })
})

describe('MemoryStore enforces what DynamoDB enforces', () => {
  const mk = (): MemoryStore => makeStore()
  const shipment = { id: 's1', number: 'X1', createdBy: 'a', updatedBy: 'a' }

  it('refuses an empty or null index key (the undated-shipment failure)', async () => {
    const store = mk()
    await expect(store.transact([{ op: 'put', table: 'shipment', item: { ...shipment, pickupAppt: '' } }], 't')).rejects.toThrow(/Index key shipment.pickupAppt/)
    await expect(store.transact([{ op: 'put', table: 'shipment', item: { ...shipment, customerId: null } }], 't')).rejects.toThrow(/customerId/)
    expect(store.own('shipment')).toHaveLength(0)
  })

  it('applies a transaction atomically and rejects two writes to one item', async () => {
    const store = mk()
    store.seed('proClaim', [{ id: '100', loadId: 'a' }])
    const res = await store.transact([{ op: 'put', table: 'shipment', item: shipment }, { op: 'put', table: 'proClaim', item: { id: '100', loadId: 'b' }, ifNotExists: true }], 't')
    expect(res).toEqual({ ok: false, reason: 'CONDITION', failedIndex: 1 })
    expect(store.own('shipment')).toHaveLength(0)
    const dup = await store.transact([{ op: 'put', table: 'shipment', item: shipment }, { op: 'update', table: 'shipment', id: 's1', set: { number: 'X2' } }], 't')
    expect(dup.ok).toBe(false)
  })
})

describe('CLI', () => {
  it('parses targets and slices and refuses malformed ones', () => {
    expect(parseTarget('rehearsal:rh1103')).toEqual({ target: 'REHEARSAL', targetTag: 'rh1103', liveTag: null })
    expect(parseTarget('live:ZZ-1k')).toEqual({ target: 'LIVE', targetTag: null, liveTag: 'ZZ-1k' })
    expect(() => parseTarget('rehearsal:X!')).toThrow()
    expect(() => parseTarget('prod')).toThrow()
    expect(parseSlice('every:8')).toBe(8)
    expect(parseSlice(undefined)).toBeNull()
    expect(() => parseSlice('every:1')).toThrow()
    expect(parseArgs(['run', '--source', 'f.csv', '--synthetic']).flags.get('synthetic')).toBe(true)
  })

  it('runs stage, plan and apply end to end on a synthetic file against an in-memory target and reconciles', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'aljex-cli-test-'))
    const file = join(dir, 'synthetic.csv')
    writeFileSync(file, makeFixture({ rows: 120, seed: 5 }).csv)
    const lines: string[] = []
    const code = await main(['run', '--memory', '--synthetic', '--source', file, '--target', 'live:ZZ-CLI'], { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) })
    expect(lines.join('\n')).toMatch(/reconciled YES/)
    expect(code).toBe(0)
  })

  it('refuses a live target without going near any table when real data has no rehearsal', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const file = join(mkdtempSync(join(tmpdir(), 'aljex-cli-test-')), 'real.csv')
    writeFileSync(file, makeFixture({ rows: 60, seed: 6 }).csv)
    const lines: string[] = []
    const code = await main(['run', '--memory', '--source', file, '--target', 'live:ZZ-CLI'], { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/rehearsal/i)
  })
})

describe('invoice math with memo adjustments (DECIDED-1)', () => {
  const load = (m: { invoice: number; paid: number; bal: number | null }) => ({ money: { invoiceAmountCents: m.invoice, paymentsReceivedCents: m.paid, balDueCents: m.bal } }) as unknown as CanonicalRow

  it('adds the memos to the total and leaves no residual when Bal Due agrees', () => {
    const r = invoiceMath(load({ invoice: 100_00, paid: 40_00, bal: 45_00 }), -15_00)
    expect(r).toMatchObject({ totalCents: 85_00, residualCents: 0, paidAppliedCents: 40_00, balanceCents: 45_00, status: 'PARTIAL' })
  })

  it('ties to Aljex Bal Due with a residual when the memos do not explain it', () => {
    const r = invoiceMath(load({ invoice: 100_00, paid: 0, bal: 70_00 }), -15_00)
    expect(r.residualCents).toBe(-15_00)
    expect(r.totalCents - r.paidAppliedCents).toBe(70_00)
    expect(r.balanceCents).toBe(70_00)
  })

  it('keeps an overpayment as surplus, never a negative balance', () => {
    const r = invoiceMath(load({ invoice: 100_00, paid: 130_00, bal: -30_00 }), 0)
    expect(r).toMatchObject({ balanceCents: 0, surplusCents: 30_00, paidAppliedCents: 100_00, status: 'PAID' })
  })

  it('paidAmount: the invoice shows the money actually received, whatever Bal Due says (short pay and overpay)', () => {
    expect(invoiceMath(load({ invoice: 100_00, paid: 80_00, bal: 20_00 }), 0, { paidAmount: true })).toMatchObject({ totalCents: 80_00, residualCents: -20_00, balanceCents: 0, surplusCents: 0, status: 'PAID' })
    expect(invoiceMath(load({ invoice: 100_00, paid: 130_00, bal: -30_00 }), 0, { paidAmount: true })).toMatchObject({ totalCents: 130_00, balanceCents: 0, surplusCents: 0, status: 'PAID' })
  })

  it('does not invent a residual when the load has no Bal Due', () => {
    expect(invoiceMath(load({ invoice: 100_00, paid: 0, bal: null }), 10_00)).toMatchObject({ residualCents: 0, totalCents: 110_00, balanceCents: 110_00 })
  })
})

describe("the Lambda's own stack suffix (dev / rehearsal branch)", () => {
  const REHEARSAL = 'abcd1234efgh5678ijkl9012mn-NONE'
  const job = { target: 'LIVE' as const, targetTag: null, liveTag: 'REHEARSAL-1' }
  const rehearsal = tableSetFor(REHEARSAL, REHEARSAL)
  const envOf = (suffix: string, flag: string | null = 'true') => ({ BCAT_DEV_STACK: flag ?? undefined, ORDER_TABLE_NAME: `Order-${suffix}`, LOAD_TABLE_NAME: `Load-${suffix}` })

  it('accepts the stack the Lambda runs on, and its -rh siblings, only with BCAT_DEV_STACK=true', () => {
    expect(() => assertTargets(rehearsal, rehearsal, job, undefined, envOf(REHEARSAL))).not.toThrow()
    const rh = tableSetFor(REHEARSAL, `${REHEARSAL}-rhabc`)
    expect(() => assertTargets(rehearsal, rh, { ...job, target: 'REHEARSAL', targetTag: 'abc' }, undefined, envOf(REHEARSAL))).not.toThrow()
    expect(() => assertTargets(rehearsal, rehearsal, job, undefined, envOf(REHEARSAL, null))).toThrow(TargetRefused)
    expect(() => assertTargets(rehearsal, rehearsal, job, undefined, envOf(REHEARSAL, 'false'))).toThrow(TargetRefused)
  })

  it('a stack other than the one the Lambda runs on is still refused', () => {
    expect(() => assertTargets(rehearsal, rehearsal, job, undefined, envOf('zzzz1234efgh5678ijkl9012mn-NONE'))).toThrow(/not a dev-stack table/)
    expect(() => assertTargets(rehearsal, rehearsal, job, undefined, { BCAT_DEV_STACK: 'true', ORDER_TABLE_NAME: `Order-${REHEARSAL}`, LOAD_TABLE_NAME: 'Load-other-NONE' })).toThrow(TargetRefused)
  })

  it('the offline CLI follows the selected stack: its live tables are the rehearsal branch tables, dev otherwise', () => {
    const saved = { f: process.env.BCAT_DEV_STACK, o: process.env.ORDER_TABLE_NAME, l: process.env.LOAD_TABLE_NAME }
    try {
      expect(liveTableSet().order).toBe(`Order-${DEV_SUFFIX}`)
      Object.assign(process.env, { BCAT_DEV_STACK: 'true', ORDER_TABLE_NAME: `Order-${REHEARSAL}`, LOAD_TABLE_NAME: `Load-${REHEARSAL}` })
      expect(liveTableSet().carrierBill).toBe(`CarrierBill-${REHEARSAL}`)
    } finally {
      for (const [k, v] of [['BCAT_DEV_STACK', saved.f], ['ORDER_TABLE_NAME', saved.o], ['LOAD_TABLE_NAME', saved.l]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('production is refused in every mode, even when the Lambda claims it as its own stack', () => {
    const prod = tableSetFor(PROD_SUFFIX, PROD_SUFFIX)
    expect(() => assertTargets(prod, prod, job, undefined, envOf(PROD_SUFFIX))).toThrow(/production table/)
    expect(() => assertTargets(prod, prod, job, undefined, envOf(PROD_SUFFIX, 'false'))).toThrow(/production table/)
    expect(() => assertTargets(rehearsal, prod, job, undefined, envOf(REHEARSAL))).toThrow(/production table/)
  })
})

describe('production policy (offline CLI only)', () => {
  const job = { target: 'LIVE' as const, targetTag: null, liveTag: 'GO-LIVE' }
  const dev = tableSetFor(DEV_SUFFIX, DEV_SUFFIX)

  it('without a policy production tables stay refused', () => {
    const prod = tableSetFor(PROD_SUFFIX, PROD_SUFFIX)
    expect(() => assertTargets(prod, prod, job)).toThrow(TargetRefused)
  })

  it('accepts exactly the policy table set, for production and for the dev-shaped rehearsal seam', () => {
    const prod = tableSetFor(PROD_SUFFIX, PROD_SUFFIX)
    expect(() => assertTargets(prod, prod, job, productionPolicy(PROD_SUFFIX))).not.toThrow()
    const rh = tableSetFor(DEV_SUFFIX, `${DEV_SUFFIX}-rhabc`)
    expect(() => assertTargets(rh, rh, job, productionPolicy(`${DEV_SUFFIX}-rhabc`))).not.toThrow()
  })

  it('refuses mixed stacks, a rehearsal job, a missing live tag and foreign suffixes', () => {
    const p = productionPolicy(PROD_SUFFIX)
    const mixed = { ...tableSetFor(PROD_SUFFIX, PROD_SUFFIX), load: `Load-${DEV_SUFFIX}` }
    expect(() => assertTargets(mixed, mixed, job, p)).toThrow(TargetRefused)
    expect(() => assertTargets(dev, dev, job, p)).toThrow(TargetRefused)
    const prod = tableSetFor(PROD_SUFFIX, PROD_SUFFIX)
    expect(() => assertTargets(prod, prod, { ...job, target: 'REHEARSAL', targetTag: 'abc' }, p)).toThrow(/LIVE/)
    expect(() => assertTargets(prod, prod, { ...job, liveTag: ' ' }, p)).toThrow(/live tag/)
    expect(() => productionPolicy('other-NONE')).toThrow(TargetRefused)
  })

  it('production mode runs end to end in memory (synthetic fixture) and refuses dev tooling commands', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const file = join(mkdtempSync(join(tmpdir(), 'aljex-cli-prod-')), 'synthetic.csv')
    writeFileSync(file, makeFixture({ rows: 60, seed: 7 }).csv)
    const lines: string[] = []
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) }
    const code = await main(['run', '--memory', '--synthetic', '--source', file, '--target', 'live:ZZ-P'], io, { prod: productionPolicy(PROD_SUFFIX) })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/PRODUCTION-GATED .*reconciled YES|PRODUCTION-GATED/s)
    expect(await main(['rehearsal-drop', '--tag', 'abc'], io, { prod: productionPolicy(PROD_SUFFIX) })).toBe(1)
  })
})
