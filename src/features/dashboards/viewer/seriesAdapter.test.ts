import { describe, expect, it } from 'vitest'
import { toChartSeries } from './seriesAdapter'

describe('toChartSeries', () => {
  it('keys grouped rows by their group and prints KPI values with their format', () => {
    const s = toChartSeries({
      kpis: [{ label: 'Revenue', value: 123_400, format: 'cents' }, { label: 'Loads', value: null }],
      rows: [{ label: 'Acme', values: [100, null] }],
      groups: ['Revenue', 'Profit'],
      valueFormat: 'cents',
    }, 'bar')
    expect(s.rows[0]).toEqual({ label: 'Acme', values: { Revenue: 100 } })
    expect(s.kpis).toEqual([{ label: 'Revenue', value: '$1,234.00' }, { label: 'Loads', value: '—' }])
  })

  it('maps a table: column 0 is the label, text and numeric columns keep their own cells', () => {
    const s = toChartSeries({
      rows: [{ label: 'S-1', values: [null, null, 5000], text: ['S-1', 'Delivered', ''] }],
      groups: [],
      columns: [{ key: 'n', label: 'Load' }, { key: 's', label: 'Status' }, { key: 'r', label: 'Revenue', format: 'cents' }],
      valueFormat: 'count',
    }, 'table')
    expect(s.columns?.map((c) => [c.label, c.format])).toEqual([['Status', 'text'], ['Revenue', 'cents']])
    expect(s.rows[0]).toMatchObject({ label: 'S-1', text: { '1': 'Delivered' }, values: { '2': 5000 } })
  })
})
