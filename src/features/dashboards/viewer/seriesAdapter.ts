/**
 * Server widget results -> the dashboard's `ChartSeries`, so the existing renderers
 * (`ChartCard`, `SeriesTable`, `TmsKpiCard`) draw them unchanged.
 *
 * Wire convention (AI2): non-table rows carry `values[i]` aligned with `groups[i]`; a table's
 * `columns[0]` is the label column (`text[0]` = row label) and the remaining columns read
 * `values[i]` (numeric) or `text[i]` (text), arrays as long as `columns`.
 */
import { formatValue } from '@/lib/dashboardCharts'
import type { ChartColumn, ChartDef, ChartSeries } from '@/features/tms/dashboard/types'
import type { ResultKind, ResultSeries, WidgetResult } from '@/lib/dashboards/types'

export function toChartSeries(series: ResultSeries, kind: ResultKind): ChartSeries {
  const kpis = series.kpis?.map((kpi) => ({
    label: kpi.label,
    value: kpi.value == null ? '—' : formatValue(kpi.value, kpi.format ?? series.valueFormat),
  }))
  if (kind === 'table' && series.columns) {
    const columns = series.columns
    const body: ChartColumn[] = columns.slice(1).map((column, i) => {
      const index = i + 1
      const isText = series.rows.some((row) => row.text?.[index] != null && row.values[index] == null)
      return { key: String(index), label: column.label, format: isText ? 'text' : column.format }
    })
    return {
      kpis,
      groups: [],
      columns: body,
      valueFormat: series.valueFormat,
      note: series.note ?? null,
      rows: series.rows.map((row) => {
        const values: Record<string, number> = {}
        const text: Record<string, string> = {}
        for (let i = 1; i < columns.length; i += 1) {
          const v = row.values[i]
          if (v != null) values[String(i)] = v
          const t = row.text?.[i]
          if (t != null) text[String(i)] = t
        }
        return { label: row.text?.[0] ?? row.label, values, text }
      }),
    }
  }
  return {
    kpis,
    groups: series.groups,
    valueFormat: series.valueFormat,
    note: series.note ?? null,
    rows: series.rows.map((row) => {
      const values: Record<string, number> = {}
      series.groups.forEach((group, i) => {
        const v = row.values[i]
        if (v != null) values[group] = v
      })
      return { label: row.label, values }
    }),
  }
}

const KIND_FOR: Record<ResultKind, ChartDef['kind']> = { kpis: 'kpis', bar: 'bar', line: 'line', pie: 'pie', table: 'table' }

/** A `ChartDef` whose `compute` returns the series the server already computed. */
export function chartDefFor(widgetId: string, title: string, result: Extract<WidgetResult, { ok: true }>): { def: ChartDef; series: ChartSeries } {
  const series = toChartSeries(result.series, result.kind)
  return {
    series,
    def: { key: `dash:${widgetId}`, title, group: 'brokerage', kind: KIND_FOR[result.kind], compute: () => series },
  }
}
