/**
 * MVMNT's 17 Classic cards, in MVMNT's order (`MVMNT_UI_REFERENCE.md` §3).
 *
 * The arithmetic lives in `src/lib/dashboardCharts.ts`; this file is the catalogue —
 * key, title, kind, and which rows and metric each card reads. Counts come from the
 * shipments, money from the `LaneRateSample` facts (the priced delivered loads), and a
 * card that has no facts to read says so rather than drawing a shape.
 */
import {
  addCount,
  addSample,
  applyFilters,
  collect,
  dimensionRowOf,
  formatValue,
  groupKey,
  limitRows,
  metricValue,
  pricedSamples,
  quoteRow,
  rankRows,
  sampleRow,
  shipmentRow,
  sortRowsByKey,
  toSeries,
  totals,
  type Bucket,
  type Dimension,
  type Metric,
} from '@/lib/dashboardCharts'
import type {
  ChartDef,
  ChartSeries,
  DashboardData,
  DashboardFilters,
  DashboardGroupBy,
  ValueFormat,
} from './types'

/** Said once, under every money card that had nothing priced to read. */
const NO_FACTS = 'No priced shipments in this window: revenue, cost and profit are the real zero, not an estimate.'

/** Twelve bars is what fits a 410px card; the thirteenth customer onward is "Other". */
const TOP_N = 12

function moneyNote(data: DashboardData): string | null {
  return pricedSamples(data.samples).length === 0 ? NO_FACTS : null
}

/** Revenue / cost / profit / margin by month, from the rate samples. */
function monthlyMoney(metric: Metric, valueFormat: ValueFormat) {
  return (raw: DashboardData, filters: DashboardFilters, groupBy: DashboardGroupBy | null): ChartSeries => {
    const data = applyFilters(raw, filters)
    const grouped = sortRowsByKey(collect(
      pricedSamples(data.samples),
      (sample) => dimensionRowOf('MONTH', sampleRow(sample, data), data),
      (sample) => groupKey(groupBy, sampleRow(sample, data), data),
      addSample,
    ))
    return toSeries(grouped, metric, valueFormat, moneyNote(data))
  }
}

/** Revenue / profit / margin by rep, customer or carrier, biggest first. */
function moneyBy(dimension: Dimension, metric: Metric, valueFormat: ValueFormat, limit?: number) {
  return (raw: DashboardData, filters: DashboardFilters, groupBy: DashboardGroupBy | null): ChartSeries => {
    const data = applyFilters(raw, filters)
    const grouped = collect(
      pricedSamples(data.samples),
      (sample) => dimensionRowOf(dimension, sampleRow(sample, data), data),
      (sample) => groupKey(groupBy, sampleRow(sample, data), data),
      addSample,
    )
    // A margin chart ranks on revenue — the biggest margin on $400 of freight is noise.
    const rank = metric === 'margin'
      ? (bucket: Bucket) => bucket.revenueCents
      : (bucket: Bucket) => metricValue(bucket, metric)
    const ranked = rankRows(grouped, rank)
    const rows = limit ? limitRows(ranked, limit) : ranked
    const note = moneyNote(data)
    return toSeries(rows, metric, valueFormat, limit && ranked.rows.length > limit
      ? [`Top ${limit} by revenue; everything else is rolled into Other.`, note].filter(Boolean).join(' ')
      : note)
  }
}

export const CLASSIC_CHARTS: ChartDef[] = [
  {
    key: 'basic-kpis',
    title: 'Basic KPIs',
    group: 'classic',
    kind: 'kpis',
    compute(raw, filters) {
      const data = applyFilters(raw, filters)
      const bucket = totals(data.samples)
      const margin = metricValue(bucket, 'margin')
      return {
        kpis: [
          { label: 'Shipments', value: formatValue(data.shipments.length, 'count'), sub: 'picked up in this window' },
          { label: 'Revenue', value: formatValue(bucket.revenueCents, 'cents'), sub: `${formatValue(bucket.count, 'count')} priced` },
          { label: 'Cost', value: formatValue(bucket.costCents, 'cents'), sub: null },
          { label: 'Profit', value: formatValue(bucket.profitCents, 'cents'), sub: null },
          { label: 'Margin', value: formatValue(margin, 'bps'), sub: 'profit ÷ revenue' },
        ],
        rows: [],
        groups: ['total'],
        valueFormat: 'cents',
        note: moneyNote(data),
      }
    },
  },
  {
    key: 'shipments',
    title: 'Shipments',
    group: 'classic',
    kind: 'line',
    compute(raw, filters, groupBy) {
      const data = applyFilters(raw, filters)
      const grouped = sortRowsByKey(collect(
        data.shipments,
        (shipment) => dimensionRowOf('MONTH', shipmentRow(shipment, data), data),
        (shipment) => groupKey(groupBy, shipmentRow(shipment, data), data),
        addCount,
      ))
      return toSeries(grouped, 'count', 'count')
    },
  },
  { key: 'revenue', title: 'Revenue', group: 'classic', kind: 'line', compute: monthlyMoney('revenue', 'cents') },
  { key: 'profit', title: 'Profit', group: 'classic', kind: 'line', compute: monthlyMoney('profit', 'cents') },
  { key: 'margin', title: 'Margin', group: 'classic', kind: 'line', compute: monthlyMoney('margin', 'bps') },
  { key: 'revenue-by-rep', title: 'Revenue by rep', group: 'classic', kind: 'bar', compute: moneyBy('REP', 'revenue', 'cents') },
  { key: 'profit-by-rep', title: 'Profit by rep', group: 'classic', kind: 'bar', compute: moneyBy('REP', 'profit', 'cents') },
  { key: 'margin-by-rep', title: 'Margin by rep', group: 'classic', kind: 'bar', compute: moneyBy('REP', 'margin', 'bps') },
  { key: 'revenue-by-customer', title: 'Revenue by customer', group: 'classic', kind: 'bar', compute: moneyBy('CUSTOMER', 'revenue', 'cents', TOP_N) },
  { key: 'profit-by-customer', title: 'Profit by customer', group: 'classic', kind: 'bar', compute: moneyBy('CUSTOMER', 'profit', 'cents', TOP_N) },
  { key: 'margin-by-customer', title: 'Margin by customer', group: 'classic', kind: 'bar', compute: moneyBy('CUSTOMER', 'margin', 'bps', TOP_N) },
  { key: 'margin-by-carrier', title: 'Margin by carrier', group: 'classic', kind: 'bar', compute: moneyBy('CARRIER', 'margin', 'bps', TOP_N) },
  { key: 'profit-by-carrier', title: 'Profit by carrier', group: 'classic', kind: 'bar', compute: moneyBy('CARRIER', 'profit', 'cents', TOP_N) },
  {
    key: 'shipments-by-status',
    title: 'Shipments by status',
    group: 'classic',
    kind: 'pie',
    compute(raw, filters) {
      const data = applyFilters(raw, filters)
      // A pie's slices are the statuses; a second dimension has nowhere to go in one.
      const grouped = rankRows(collect(
        data.shipments,
        (shipment) => dimensionRowOf('STATUS', shipmentRow(shipment, data), data),
        () => 'total',
        addCount,
      ), (bucket) => bucket.count)
      return toSeries(grouped, 'count', 'count')
    },
  },
  {
    key: 'quotes-top-5-customers',
    title: 'Quotes by top 5 customers',
    group: 'classic',
    kind: 'bar',
    compute(raw, filters, groupBy) {
      const data = applyFilters(raw, filters)
      const grouped = limitRows(rankRows(collect(
        data.quotes,
        (quote) => dimensionRowOf('CUSTOMER', quoteRow(quote, data), data),
        (quote) => groupKey(groupBy, quoteRow(quote, data), data),
        addCount,
      ), (bucket) => bucket.count), 5, null)
      return toSeries(grouped, 'count', 'count',
        'Quotes are counted on the date they were quoted. A quote that is not yet a shipment carries no division tag, so it is shown under every division.')
    },
  },
  { key: 'top-10-customers', title: 'Top 10 customers', group: 'classic', kind: 'table', compute: moneyBy('CUSTOMER', 'revenue', 'cents', 10) },
  { key: 'top-10-carriers', title: 'Top 10 carriers', group: 'classic', kind: 'table', compute: moneyBy('CARRIER', 'cost', 'cents', 10) },
]
