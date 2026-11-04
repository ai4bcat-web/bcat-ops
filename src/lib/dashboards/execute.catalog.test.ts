// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { QUERY_CATALOG, QUERY_IDS, parseParams } from './catalog'
import { runSpec, runWidget, type InvoiceRow, type QuoteRow, type RunCtx, type SampleRow, type ShipmentRow } from './execute'
import { OVERVIEW_SPEC } from './builtin'
import { parseSpec } from './spec'
import type { DashboardFilters, DashboardSpec, Widget } from './types'
import { makeVisibleReader, type RawSource } from './visibleReader'
import { dataViewer, type VisCustomer } from '../dataVisibility'

/**
 * T2 — the catalog-wide invariant. Hidden rows carry a sentinel (name, amount, rep id). For EVERY
 * query and EVERY widget type it allows, a non-viewAll viewer's serialised result contains no
 * sentinel and its totals equal the visible-only totals; viewAll sees both. A new catalog entry
 * runs through the same loop, so one that read around the VisibleReader would fail here.
 */
const SENTINEL = /zzsentinel|777777/i

const customers: (VisCustomer & { name: string })[] = [
  { id: 'c1', name: 'Visible Co', accountOwnerIds: ['repa@bcat.test'] },
  { id: 'c2', name: 'Team Co', teamKey: 'east' },
  { id: 'c3', name: 'ZZSENTINEL Hidden Co', accountOwnerIds: ['someone@else.test'] },
  { id: 'c4', name: 'ZZSENTINEL Orphan Co' },
]
const byId = new Map<string, VisCustomer>(customers.map((c) => [c.id, c]))
const cname = (id: string) => customers.find((c) => c.id === id)!.name

const AMOUNT: Record<string, number> = { c1: 100_000, c2: 200_000, c3: 777_777_777, c4: 777_777_778 }
const hiddenRep = 'zzsentinel-rep@else.test'

const samples: SampleRow[] = customers.map((c, i) => ({
  shipmentId: `s${i}`, date: '2026-11-10', revenueCents: AMOUNT[c.id], costCents: 0, profitCents: AMOUNT[c.id],
  customerId: c.id, customerName: c.name, carrierName: c.id === 'c3' ? 'ZZSENTINEL Carrier' : 'Fine Carrier',
  revDivision: 'BROKERAGE', salesRepId: c.id === 'c3' ? hiddenRep : null, mode: 'FTL',
}))
const shipments: ShipmentRow[] = customers.map((c, i) => ({
  id: `s${i}`, number: c.id === 'c3' ? 'ZZSENTINEL-1' : `N${i}`, status: i % 2 ? 'DELIVERED' : 'IN_TRANSIT', pickupAppt: `2026-11-1${i}T10:00:00Z`,
  customerId: c.id, customerName: c.name, revDivision: 'BROKERAGE', salesRepId: c.id === 'c3' ? hiddenRep : null, mode: 'FTL',
}))
const invoices: InvoiceRow[] = customers.map((c, i) => ({
  id: `i${i}`, number: `INV-${i}`, customerId: c.id, customerName: c.name, invoiceDate: '2026-09-01', dueAt: '2026-10-01',
  balanceCents: AMOUNT[c.id], shipmentId: `s${i}`, revDivision: 'BROKERAGE', salesRepId: c.id === 'c3' ? hiddenRep : null,
}))
const quotes: QuoteRow[] = customers.map((c, i) => ({
  id: `q${i}`, side: 'SELL', status: i % 2 ? 'WON' : 'QUOTED', quoteDate: '2026-11-05', customerId: c.id, customerName: c.name,
  customerRepId: c.id === 'c3' ? hiddenRep : null, mode: 'FTL', amountCents: AMOUNT[c.id],
}))

const raw: RawSource = {
  samples: async () => samples,
  shipments: async () => shipments,
  openInvoices: async () => invoices,
  quotes: async () => quotes,
}
void cname

const teams = [{ key: 'EAST', name: 'East', memberIds: ['repa@bcat.test'], active: true }]
const repA = dataViewer({ id: 'repa@bcat.test', email: 'repa@bcat.test', groups: ['page-tms'], teams })
const nobody = dataViewer({ id: 'zed@bcat.test', email: 'zed@bcat.test', groups: ['page-tms'], teams })
const all = dataViewer({ id: 'acct@bcat.test', email: 'acct@bcat.test', groups: ['page-tms', 'role-AR_AP'], teams })
const ctx: RunCtx = { now: '2026-11-15T12:00:00Z', divisions: [{ code: 'BROKERAGE', name: 'Brokerage', parentId: null }] }
const filters: DashboardFilters = { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: [], repIds: [], modes: [] }

const widgetsFor = (): Widget[] =>
  QUERY_IDS.flatMap((id) =>
    QUERY_CATALOG[id].types.map((type, n): Widget => {
      const parsed = parseParams(id, {})
      if (!parsed.ok) throw new Error(parsed.issues.join())
      return { id: `w${n + 1}`, type, title: `${id} ${type}`, size: 'M', query: { id, params: parsed.params } }
    }),
  )

describe('catalog-wide visibility invariant', () => {
  it('covers every catalog query and type', () => {
    expect(widgetsFor().length).toBeGreaterThanOrEqual(QUERY_IDS.length)
  })

  for (const w of widgetsFor()) {
    it(`${w.query.id} as ${w.type}: a rep never sees hidden rows; viewAll does`, async () => {
      const mine = await runWidget(w, filters, makeVisibleReader(raw, repA, byId), ctx)
      expect(mine.ok, JSON.stringify(mine)).toBe(true)
      expect(JSON.stringify(mine)).not.toMatch(SENTINEL)

      const nothing = await runWidget(w, filters, makeVisibleReader(raw, nobody, byId), ctx)
      expect(nothing.ok).toBe(true)
      expect(JSON.stringify(nothing)).not.toMatch(SENTINEL)

      const everything = await runWidget(w, filters, makeVisibleReader(raw, all, byId), ctx)
      expect(everything.ok).toBe(true)
      // Queries that name a customer/rep/carrier/invoice must surface the hidden rows to viewAll (pure time or status aggregates carry no name; their totals are asserted below).
      if (!['fin.summary', 'fin.byTime', 'ship.byStatus', 'ship.byTime', 'ship.summary', 'quote.byStatus', 'quote.summary', 'ar.summary', 'ar.aging'].includes(w.query.id)) {
        expect(JSON.stringify(everything)).toMatch(SENTINEL)
      }
    })
  }

  it('totals equal the visible-only totals (money, counts, margin recomputed)', async () => {
    const run = async (viewer: typeof repA, id: string, params: Record<string, string | string[]>, type: Widget['type'] = 'KPI') => {
      const r = await runWidget({ id: 'w1', type, title: 't', size: 'M', query: { id: id as Widget['query']['id'], params } }, filters, makeVisibleReader(raw, viewer, byId), ctx)
      if (!r.ok) throw new Error(r.error)
      return r.series.kpis?.map((k) => k.value)
    }
    expect(await run(repA, 'fin.summary', { metrics: ['revenue', 'count', 'margin'] })).toEqual([300_000, 2, 10_000])
    expect(await run(all, 'fin.summary', { metrics: ['revenue'] })).toEqual([100_000 + 200_000 + 777_777_777 + 777_777_778])
    expect(await run(repA, 'ar.summary', { metrics: ['open', 'overdue', 'count'] })).toEqual([300_000, 300_000, 2])
    // No visible rows: "no data" is null, a real zero count is 0.
    expect(await run(nobody, 'fin.summary', { metrics: ['revenue', 'count'] })).toEqual([null, 0])
  })

  it('a hand-typed customer filter cannot reach a hidden customer', async () => {
    const f: DashboardFilters = { ...filters, customerIds: ['c3'] }
    const w: Widget = { id: 'w1', type: 'KPI', title: 't', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue', 'count'] } } }
    const r = await runWidget(w, f, makeVisibleReader(raw, repA, byId), ctx)
    expect(r.ok && r.series.kpis?.map((k) => k.value)).toEqual([null, 0])
  })

  it('a direct rep link makes a hidden-customer row visible, and only that row', async () => {
    const direct = dataViewer({ id: 'zzsentinel-rep@else.test', email: hiddenRep, groups: ['page-tms'], teams: [] })
    const w: Widget = { id: 'w1', type: 'KPI', title: 't', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue'] } } }
    const r = await runWidget(w, filters, makeVisibleReader(raw, direct, byId), ctx)
    expect(r.ok && r.series.kpis?.[0]?.value).toBe(777_777_777)
  })
})

describe('window and widget limits', () => {
  it('an over-long window is a per-widget error, not a blank dashboard', async () => {
    const w: Widget = { id: 'w1', type: 'KPI', title: 't', size: 'M', query: { id: 'ship.summary', params: { metrics: ['count'] } } }
    const r = await runWidget(w, { ...filters, window: { preset: 'YEAR_TO_DATE' } }, makeVisibleReader(raw, all, byId), ctx)
    expect(r).toMatchObject({ ok: false })
  })

  it('the built-in Overview is a valid spec and runs for a non-viewAll viewer without errors', async () => {
    expect(parseSpec(OVERVIEW_SPEC).ok).toBe(true)
    const { results } = await runSpec(OVERVIEW_SPEC as DashboardSpec, makeVisibleReader(raw, repA, byId), ctx)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(JSON.stringify(results)).not.toMatch(SENTINEL)
  })

  it('table and chart series follow the documented shapes', async () => {
    const mk = (type: Widget['type'], id: Widget['query']['id'], params: Widget['query']['params']): Widget => ({ id: 'w1', type, title: 't', size: 'M', query: { id, params } })
    const reader = makeVisibleReader(raw, all, byId)
    const table = await runWidget(mk('TABLE', 'ar.byCustomer', { limit: 5 }), filters, reader, ctx)
    const bar = await runWidget(mk('BAR', 'ar.byCustomer', { limit: 5 }), filters, reader, ctx)
    if (!table.ok || !bar.ok) throw new Error('run failed')
    expect(table.series.columns?.[0]?.key).toBe('label')
    for (const row of table.series.rows) {
      expect(row.values).toHaveLength(table.series.columns!.length)
      expect(row.text).toHaveLength(table.series.columns!.length)
      expect(row.text?.[0]).toBe(row.label)
    }
    expect(bar.series.rows.every((r) => r.values.length === bar.series.groups.length)).toBe(true)
  })
})
