import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateAljex, renderAljexCsv, SYNTH_PRO_MAX, SYNTH_PRO_MIN } from '../../../scripts/lib/aljexFixture.mjs'
import type { CanonicalRow } from './canonical'
import { arFacts, balDueIdentityHolds, classifyRow, hasInvoice, isOwnAssetCarrier, pickDivision, rowFindings, rowSignature } from './classify'
import { resolveMemos } from './memos'
import { rawRowColumns, readRawColumn } from './rawRow'
import { customerChargeTotal } from './charges'
import { createCsvParser } from './csv'
import { detectLayout } from './layout'
import { mapAljexRow } from './mapRow'
import { DEFAULT_ALJEX_PROFILE, findUnmapped, type DistinctValues } from './profile'
import { mapStatus } from './status'

type Oracle = ReturnType<typeof generateAljex>['oracle']

function parseAndMap(csv: string, chunk = 4096): { rows: CanonicalRow[]; cells: string[][] } {
  const cells: string[][] = []
  const p = createCsvParser((r) => cells.push(r))
  for (let i = 0; i < csv.length; i += chunk) p.write(csv.slice(i, i + chunk))
  p.end()
  const layout = detectLayout(cells[0])
  return { rows: cells.slice(1).map((r, i) => mapAljexRow(r, layout, { rowNumber: i + 1 })), cells: cells.slice(1) }
}

/** What the engine's STAGE does with duplicates: first row of a PRO wins; identical repeats collapse, others conflict. */
function dedupe(rows: CanonicalRow[], cells: string[][]) {
  const first = new Map<string, number>()
  const unique: CanonicalRow[] = []
  let identical = 0
  let conflicting = 0
  rows.forEach((r, i) => {
    const key = r.proKey ?? `row${i}`
    const at = first.get(key)
    if (at === undefined) {
      first.set(key, i)
      unique.push(r)
    } else if (rowSignature(cells[at]) === rowSignature(cells[i])) identical++
    else conflicting++
  })
  return { unique, identical, conflicting }
}

describe('mapAljexRow reproduces the generator oracle (standard anomalies, 1k rows, chunked parse)', () => {
  const result = generateAljex({ rows: 1000, seed: 7, anomalies: 'standard' })
  const o: Oracle = result.oracle
  const { rows, cells } = parseAndMap(renderAljexCsv(result), 997)
  const { unique, identical, conflicting } = dedupe(rows, cells)
  const loads = unique.filter((r) => r.kind === 'LOAD')
  const memos = unique.filter((r) => r.kind !== 'LOAD')
  const sum = <T,>(arr: T[], f: (t: T) => number) => arr.reduce((s, x) => s + f(x), 0)

  it('has no row-level errors and no blocking findings, and classifies every row', () => {
    expect(rows.flatMap((r) => r.errors)).toEqual([])
    const blocking = rows.flatMap((r) => rowFindings(r, DEFAULT_ALJEX_PROFILE)).filter((f) => f.outcome === 'blocking' || f.outcome === 'error')
    expect(blocking).toEqual([])
    expect(rows.every((r) => classifyRow(r) !== 'JUNK')).toBe(true)
  })

  it('counts rows, loads, memos and duplicates', () => {
    expect(rows).toHaveLength(o.fileRows)
    expect(loads).toHaveLength(o.loads)
    expect(memos).toHaveLength(o.memos)
    expect(memos.filter((r) => r.kind === 'MEMO_DEBT')).toHaveLength(o.memoDebt)
    expect(memos.filter((r) => r.kind === 'MEMO_CRED')).toHaveLength(o.memoCred)
    expect(identical).toBe(o.identicalDuplicateRows)
    expect(conflicting).toBe(o.conflictingDuplicateRows)
    expect(unique.length + identical + conflicting).toBe(rows.length)
  })

  it('counts statuses, with odd spellings (lowercase, trailing space, VOID WEB) landing on mapped statuses', () => {
    const counts: Record<string, number> = {}
    for (const r of loads) counts[r.statusKey] = (counts[r.statusKey] ?? 0) + 1
    expect(counts).toEqual(o.statusCounts)
    for (const r of loads) expect(mapStatus(r.statusKey, DEFAULT_ALJEX_PROFILE)).not.toBeNull()
  })

  it('sums every money column to the cent', () => {
    const t = o.uniqueTotals
    expect(sum(loads, (r) => r.money.lhRevenueCents) + sum(memos, (r) => r.money.lhRevenueCents)).toBe(t.lhRevenue)
    expect(sum(loads, (r) => r.money.accRevenueCents)).toBe(t.accRevenue)
    expect(sum(loads, (r) => r.money.fscRevenueCents)).toBe(t.fscRevenue)
    expect(sum(loads, (r) => r.money.invoiceAmountCents)).toBe(t.invoiceAmountLoads)
    expect(sum(unique, (r) => r.money.invoiceAmountCents)).toBe(t.invoiceAmount)
    expect(sum(loads, (r) => r.money.paymentsReceivedCents)).toBe(t.payments)
    expect(sum(loads, (r) => r.money.creditsCents)).toBe(t.credits)
    expect(sum(loads, (r) => r.money.debitsCents)).toBe(t.debits)
    expect(sum(loads, (r) => r.money.balDueCents ?? 0)).toBe(t.balDue)
    // the file total (duplicate rows included) is what a naive sum would report
    expect(sum(rows, (r) => r.money.invoiceAmountCents)).toBe(o.fileTotals.invoiceAmount)
  })

  it('Σ charge extensions = Invoice Amount on every row, and Σ payments equals the payment blocks', () => {
    for (const r of unique) expect(customerChargeTotal(r)).toBe(r.money.invoiceAmountCents)
    for (const r of rows) expect(sum(r.payments, (p) => p.amountCents)).toBe(r.money.paymentsReceivedCents)
    for (const r of loads) expect(r.charges[0]?.line ?? 1).toBe(1)
  })

  it('reconciles AR with memos as invoice adjustments: open invoices, unapplied credit, per-customer balances, the bridge', () => {
    const invoiced = loads.filter(hasInvoice)
    expect(invoiced).toHaveLength(o.invoices)
    const memoSet = resolveMemos(unique)
    const adj = (r: CanonicalRow) => memoSet.netByInvoice.get(r.proKey as string) ?? 0
    for (const r of invoiced) expect(balDueIdentityHolds(r, adj(r))).toBe(true)
    const facts = (r: CanonicalRow) => arFacts(r, adj(r))
    const open = invoiced.filter((r) => facts(r).balanceCents > 0)
    expect(open).toHaveLength(o.openAr.count)
    expect(sum(open, (r) => facts(r).balanceCents)).toBe(o.openAr.balance)
    expect(sum(invoiced, (r) => facts(r).unappliedCents)).toBe(o.unappliedCredit)
    expect(sum(open, (r) => facts(r).balanceCents) - sum(invoiced, (r) => facts(r).unappliedCents)).toBe(o.netOpenAr)
    const perCustomer: Record<string, number> = {}
    for (const r of open) perCustomer[r.customer.account] = (perCustomer[r.customer.account] ?? 0) + facts(r).balanceCents
    expect(perCustomer).toEqual(o.perCustomerOpen)
    // bridge: Σ invoice totals (charges + memo adjustments) - Σ payments = Σ Bal Due
    expect(sum(invoiced, (r) => facts(r).totalCents)).toBe(o.invoiceTotalWithMemos)
    expect(sum(invoiced, (r) => facts(r).totalCents - facts(r).paymentsCents)).toBe(o.netOpenAr)
    expect(o.invoiceTotalWithMemos - o.invoicePayments).toBe(o.netOpenAr)
    // memos: every one is applied to its invoice or reported as an orphan, nothing is lost
    expect(Object.fromEntries(memoSet.netByInvoice)).toEqual(o.memoAdjustments.byInvoice)
    expect(memoSet.appliedCents).toBe(o.memoAdjustments.appliedNet)
    expect(memoSet.orphanCents).toBe(o.memoAdjustments.orphanNet)
    expect(memoSet.orphans.map((x) => [x.memoPro, x.reason])).toEqual(o.memoAdjustments.orphans.map((x) => [x.memoPro, x.reason]))
    expect(sum([...memoSet.byInvoice.values()].flat(), () => 1) + memoSet.orphans.length).toBe(o.memos)
    expect(memoSet.appliedCents + memoSet.orphanCents).toBe(o.memoNet)
    // memos whose reference is a load in the file are echoed by that load's Credits/Debits columns
    const linked = memos.filter((r) => r.memo?.referenceProKey && loads.some((l) => l.proKey === r.memo?.referenceProKey))
    expect(sum(linked.filter((r) => r.kind === 'MEMO_CRED'), (r) => r.memoAmountCents ?? 0)).toBe(-sum(loads, (r) => r.money.creditsCents))
    expect(sum(linked.filter((r) => r.kind === 'MEMO_DEBT'), (r) => r.memoAmountCents ?? 0)).toBe(sum(loads, (r) => r.money.debitsCents))
    for (const r of memos) expect(r.memo?.signedAmountCents).toBe(r.memoAmountCents)
  })

  it('finds the un-invoiced loads (blank Bal Due, not zero) and zero-amount invoices', () => {
    const uninvoiced = loads.filter((r) => !hasInvoice(r))
    expect(sum(uninvoiced, (r) => r.money.invoiceAmountCents)).toBe(o.uninvoicedAmount)
    for (const r of loads.filter((x) => x.dates.invoice === null)) expect(r.money.balDueCents).toBeNull()
    expect(loads.filter((r) => r.warnings.some((w) => w.code === 'ZERO_INVOICE')).map((r) => r.pro)).toEqual(o.anomalyPros.zeroInvoice)
  })

  it('reports junk and out-of-order dates, blank customers, wide rows', () => {
    const withWarning = (code: string) => loads.filter((r) => r.warnings.some((w) => w.code === code)).map((r) => r.pro)
    expect(withWarning('SHIP_AFTER_DELIVERED')).toEqual(o.anomalyPros.shipAfterDelivered)
    expect(loads.filter((r) => r.junkDates.some((j) => j.column === 'shipDate' && j.value?.startsWith('1970'))).length).toBeGreaterThan(0)
    expect(loads.filter((r) => r.customer.account === '').map((r) => r.pro)).toEqual(o.anomalyPros.blankCustomer)
    const wide = cells.filter((c) => c.length > 474)
    expect(wide.length).toBeGreaterThan(0)
    for (const r of loads.filter((x) => o.anomalyPros.wideRows.includes(x.pro))) expect(r.projectedExpenses.length).toBeGreaterThanOrEqual(6)
  })

  it('identifies the own-asset carrier by name, one id, and picks divisions by the ordered rules', () => {
    const ivan = loads.filter((r) => isOwnAssetCarrier(r.carrier?.name, DEFAULT_ALJEX_PROFILE))
    expect(ivan).toHaveLength(o.ivanLoads)
    for (const r of ivan) expect(pickDivision(r, DEFAULT_ALJEX_PROFILE)).toBe('ASSETS')
    for (const r of memos) expect(pickDivision(r, DEFAULT_ALJEX_PROFILE)).toBe('BROKERAGE')
    const vehicle = loads.filter((r) => !isOwnAssetCarrier(r.carrier?.name, DEFAULT_ALJEX_PROFILE) && ['V', 'VA', 'VH', 'VM', 'VZ'].includes(r.typeOfShipment))
    for (const r of vehicle) expect(pickDivision(r, DEFAULT_ALJEX_PROFILE)).toBe('CAR_SHIPPING')
    expect(new Set(loads.filter((r) => r.carrier).map((r) => r.carrier?.id)).size).toBe(o.carriers)
    expect(new Set(unique.filter((r) => r.customer.account).map((r) => r.customer.account)).size).toBe(o.customers)
  })

  it('only synthetic identities: reserved PRO band, ZZ names', () => {
    for (const r of rows) {
      expect(Number(r.pro)).toBeGreaterThanOrEqual(SYNTH_PRO_MIN)
      expect(Number(r.pro)).toBeLessThanOrEqual(SYNTH_PRO_MAX)
      if (r.customer.name) expect(r.customer.name.startsWith('ZZ ')).toBe(true)
      if (r.carrier) expect(r.carrier.name.startsWith('ZZ ')).toBe(true)
    }
  })

  it('survives unicode and embedded quotes/newlines/commas in quoted fields', () => {
    expect(loads.some((r) => r.customer.name.includes('\u5317\u4eac'))).toBe(true)
    // control characters (newline) are collapsed to a space, quotes and commas kept
    expect(loads.some((r) => r.freight.commodity === 'PALLETS, "FRAGILE" HANDLE WITH CARE')).toBe(true)
  })

  it('keeps leading-zero MCs, the MC/MX prefix and carriers with no MC', () => {
    const cars = loads.flatMap((r) => (r.carrier ? [r.carrier] : []))
    expect(cars.some((c) => c.mc.startsWith('00'))).toBe(true)
    expect(cars.some((c) => c.mcPrefix === 'MX')).toBe(true)
    expect(cars.some((c) => c.mc === '' && c.id !== '')).toBe(true)
  })

  it('stops: pickup first, consignee last, extra blocks between by marker, none for memos/voids', () => {
    for (const r of memos) expect(r.stops).toEqual([])
    const multi = loads.filter((r) => o.scenarios.MULTI_STOP?.includes(r.pro))
    expect(multi.length).toBeGreaterThan(0)
    for (const r of multi) {
      expect(r.stops.length).toBeGreaterThanOrEqual(3)
      expect(r.stops[0].type).toBe('pickup')
      expect(r.stops[0].source).toBe('PICKUP')
      expect(r.stops[r.stops.length - 1].source).toBe('CONSIGNEE')
      expect(r.stops.map((s) => s.sequence)).toEqual(r.stops.map((_, i) => i))
      expect(r.stops[1].type).toBe(r.stops[1].marker === 'P' ? 'pickup' : 'delivery')
    }
    for (const r of loads.filter((x) => x.stops.length === 2)) expect(r.stops.map((s) => s.type)).toEqual(['pickup', 'delivery'])
  })

  it('maps salesrep ids with zero-padding (`10` -> `010`)', () => {
    expect(loads.some((r) => r.salesrepId === '010')).toBe(true)
    expect(loads.some((r) => r.salesrepId === '10')).toBe(false)
  })

  it('keeps every Aljex code verbatim for the code-mapping table (sales rep, created by, service rep, assigned dispatcher)', () => {
    const pick = (f: (r: CanonicalRow) => string) => Object.fromEntries(loads.filter((r) => f(r)).map((r) => [r.pro, f(r)]))
    expect(pick((r) => r.salesrepId)).toEqual(o.codes.salesRep)
    expect(pick((r) => r.staff.createdBy)).toEqual(o.codes.createdBy)
    expect(pick((r) => r.staff.serviceRep)).toEqual(o.codes.serviceRep)
    expect(pick((r) => r.staff.assignedDispatcher)).toEqual(o.codes.dispatcher)
    expect(pick((r) => r.staff.actualDispatcher)).toEqual(o.codes.actualDispatcher)
  })

  it('promotes the formerly ignored columns: references, OSD, pallets, flags, declared value, fees', () => {
    const rich = loads.filter((r) => o.promoted[r.pro])
    expect(rich.length).toBe(Object.keys(o.promoted).length)
    for (const r of rich) {
      const p = o.promoted[r.pro]
      expect([r.quoteNo, r.manifest, r.containerNo, r.consigneeRefNo, r.additionalRefs]).toEqual([p.quoteNo, p.manifest, p.container, p.consigneeRef, p.additionalRefs])
      expect([r.osd, r.freight.pltIn, r.freight.pltOut, r.freight.seal, r.money.declaredValueCents]).toEqual([p.osd, p.pltIn, p.pltOut, p.seal, p.declaredValueCents])
      for (const k of p.flags) expect((r.freight as unknown as Record<string, boolean>)[k], k).toBe(true)
      expect([r.originRegion, r.destinationRegion, r.officeCoveredBy]).toEqual(['WC', 'NE', 'ZZ'])
    }
    for (const r of loads.filter((x) => !o.promoted[x.pro])) expect([r.osd, r.quoteNo, r.freight.pltIn, r.freight.customsBond]).toEqual([false, '', null, false])
    expect(sum(loads, (r) => r.money.quickPayFeesCents)).toBe(o.fees.quickPayCents)
    expect(sum(loads, (r) => r.money.advanceFeesCents)).toBe(o.fees.advanceCents)
    expect(o.fees.quickPayCents).toBeLessThan(0)
    expect(o.fees.advanceCents).toBeGreaterThan(0)
  })

  it('reads carrier compliance numbers/expiries, customer lead source and warns on a non-USD currency', () => {
    const comp: Record<string, unknown> = {}
    for (const r of loads) if (r.carrier?.caIntrastate) comp[r.carrier.id] = { caIntrastate: r.carrier.caIntrastate, caIntrastateExp: r.carrier.caIntrastateExp, txPuc: r.carrier.txPuc, txPucExp: r.carrier.txPucExp }
    expect(comp).toEqual(o.carrierCompliance)
    expect(Object.keys(comp).length).toBeGreaterThan(0)
    const lead: Record<string, string> = {}
    for (const r of loads) if (r.leadSource) lead[r.customer.account] = r.leadSource
    expect(lead).toEqual(o.customerLeadSource)
    expect(loads.filter((r) => r.warnings.some((w) => w.code === 'CURRENCY_NOT_USD')).map((r) => r.pro)).toEqual(o.nonUsdCurrencyPros)
    expect(o.nonUsdCurrencyPros.length).toBeGreaterThan(0)
  })

  it('captures every non-empty cell verbatim by position + header and reads any column back', () => {
    for (const [ri, r] of rows.entries()) {
      const c = cells[ri]
      const expected = c.map((v, i) => [i + 1, v] as const).filter(([, v]) => v.trim() !== '')
      expect(Object.keys(r.raw)).toHaveLength(expected.length)
      for (const [pos, v] of expected) {
        expect(r.raw[`c${pos}`].v).toBe(v)
        expect(readRawColumn(r.raw, pos)).toBe(v)
      }
    }
    const first = loads[0]
    expect(readRawColumn(JSON.stringify(first.raw), 'Pro #')).toBe(first.pro)
    expect(readRawColumn(first.raw, 'No Such Header')).toBeNull()
    expect(rawRowColumns(first.raw).map((c) => c.position)).toEqual([...rawRowColumns(first.raw).map((c) => c.position)].sort((a, b) => a - b))
  })

  it('findUnmapped lists nothing blocking for the standard fixture and reports rep ids', () => {
    const d: DistinctValues = {
      status: [...new Set(loads.map((r) => r.statusKey))],
      typeOfShipment: [...new Set(rows.map((r) => r.typeOfShipment))],
      safetyRating: [...new Set(loads.flatMap((r) => (r.carrier ? [r.carrier.safetyRating] : [])))],
      stopMarkers: [...new Set(loads.flatMap((r) => r.stops.map((s) => s.marker)))],
      salesreps: [...new Set(loads.map((r) => r.salesrepId))],
      dispatchers: [],
    }
    const unmapped = findUnmapped(DEFAULT_ALJEX_PROFILE, d)
    expect(unmapped.filter((u) => u.blocking)).toEqual([])
    expect(unmapped.filter((u) => u.column === 'salesrep').length).toBeGreaterThan(0)
  })
})

describe('anomalies=all: rows that must block, conflict or error', () => {
  const result = generateAljex({ rows: 200, seed: 11, anomalies: 'all' })
  const { rows } = parseAndMap(renderAljexCsv(result))
  const findings = (pro: string) => {
    const r = rows.find((x) => x.pro === pro)
    expect(r).toBeDefined()
    return rowFindings(r as CanonicalRow, DEFAULT_ALJEX_PROFILE).filter((f) => f.outcome !== 'warning').map((f) => `${f.outcome}:${f.code}`)
  }
  const p = result.oracle.anomalyPros

  it('an unknown status blocks instead of becoming OPEN', () => {
    expect(p.unknownStatus.length).toBe(1)
    expect(findings(p.unknownStatus[0])).toContain('blocking:UNMAPPED_STATUS')
  })
  it('derived-shape and non-numeric PROs are conflicts; an over-long PRO is an error', () => {
    const [derived, alpha, long] = p.badPros
    expect(findings(derived)).toEqual(expect.arrayContaining(['conflict:NON_NUMERIC_PRO', 'conflict:DERIVED_SHAPE']))
    expect(findings(alpha)).toContain('conflict:NON_NUMERIC_PRO')
    expect(findings(long)).toContain('error:OVERLONG_PRO')
  })
  it('a row wider than the header is an error row', () => {
    expect(p.longRows.length).toBe(1)
    expect(findings(p.longRows[0])).toContain('error:ROW_TOO_LONG')
  })
  it('a charge-sum that disagrees with Invoice Amount is visible to the engine', () => {
    const r = rows.find((x) => x.pro === p.chargeMismatch[0]) as CanonicalRow
    expect(customerChargeTotal(r)).not.toBe(r.money.invoiceAmountCents)
  })
})

describe('encoding variants parse to identical rows', () => {
  const result = generateAljex({ rows: 60, seed: 5, anomalies: 'standard' })
  const plain = parseAndMap(renderAljexCsv(result)).rows
  it('BOM + CRLF', () => {
    expect(parseAndMap(renderAljexCsv(result, { bom: true, crlf: true }), 1).rows).toEqual(plain)
  })
})

describe('golden 40-row fixture', () => {
  it('is exactly what the generator produces (reproducible) and its oracle matches', () => {
    const fresh = generateAljex({ rows: 40, seed: 1, anomalies: 'standard' })
    const committed = readFileSync(new URL('../../../scripts/fixtures/aljex-synth-40.csv', import.meta.url), 'utf8')
    expect(committed).toBe(renderAljexCsv(fresh))
    const oracle = JSON.parse(readFileSync(new URL('../../../scripts/fixtures/aljex-synth-40.expected.json', import.meta.url), 'utf8'))
    expect(oracle).toEqual(JSON.parse(JSON.stringify(fresh.oracle)))
  })
  it('covers every scenario the engine tests rely on', () => {
    const o = JSON.parse(readFileSync(new URL('../../../scripts/fixtures/aljex-synth-40.expected.json', import.meta.url), 'utf8'))
    for (const s of ['PAID', 'PARTIAL', 'UNPAID', 'OVERPAID', 'TWO_PAYMENTS', 'CREDIT', 'DEBIT', 'IVAN', 'VOID', 'VOID_WEB', 'CONSIGNEE', 'MULTI_STOP', 'UNINVOICED_DELIVERED', 'ZERO_INVOICE']) {
      expect(Object.keys(o.scenarios), s).toContain(s)
    }
    expect(o.identicalDuplicateRows).toBeGreaterThan(0)
    expect(o.conflictingDuplicateRows).toBe(1)
    expect(o.memoCred).toBeGreaterThan(0)
    expect(o.memoDebt).toBeGreaterThan(0)
    expect(o.memoAdjustments.orphans.map((x: { reason: string }) => x.reason).sort()).toEqual(expect.arrayContaining(['NO_REFERENCE', 'REFERENCE_NOT_FOUND']))
    expect(Object.keys(o.promoted).length).toBeGreaterThan(0)
  })
})
