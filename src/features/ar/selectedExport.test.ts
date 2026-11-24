import { describe, it, expect } from 'vitest'
import { exportCellOf, selectedRowsCsv } from './selectedExport'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'

interface Row { pro: string; customer: string; rateCents: number | null; carrier: string | null }

const cols: Array<DenseColumn<Row>> = [
  { key: 'select', header: '', text: () => '', fixed: true },
  { key: 'pro', header: 'PRO', text: (r) => r.pro },
  { key: 'customer', header: 'Customer', text: (r) => r.customer },
  {
    key: 'rate', header: 'Customer Rate', text: (r) => (r.rateCents == null ? '—' : `$${(r.rateCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`),
    filter: 'number', numberOf: (r) => (r.rateCents ?? 0) / 100, numberUnit: '$',
  },
  { key: 'carrier', header: 'Carrier', text: (r) => r.carrier ?? '—' },
  { key: 'actions', header: '', text: () => '', fixed: true },
]

describe('selectedRowsCsv', () => {
  it('writes only the shown, non-fixed columns in the order given, one row per record', () => {
    const csv = selectedRowsCsv(cols, [
      { pro: '14588', customer: 'AUTO SHIPPER', rateCents: 125_000, carrier: 'ALLSTATE CARGO LLC' },
      { pro: '13029', customer: 'AUTO SHIPPER', rateCents: 210_000, carrier: null },
    ])
    expect(csv.split('\r\n')).toEqual([
      'PRO,Customer,Customer Rate,Carrier',
      '14588,AUTO SHIPPER,1250.00,ALLSTATE CARGO LLC',
      '13029,AUTO SHIPPER,2100.00,',
    ])
  })

  it('exports only the columns passed, so a hidden carrier column stays out', () => {
    const csv = selectedRowsCsv(cols.filter((c) => c.key !== 'carrier'), [{ pro: '1', customer: 'A', rateCents: 100, carrier: 'X' }])
    expect(csv).toBe('PRO,Customer,Customer Rate\r\n1,A,1.00')
  })

  it('quotes commas and quotes, and neutralises formula prefixes', () => {
    const csv = selectedRowsCsv(cols, [
      { pro: '=1+1', customer: 'Smith, "Bob" & Co', rateCents: null, carrier: '@evil' },
      { pro: '-5 owed', customer: '+cmd', rateCents: 0, carrier: null },
    ])
    const [, a, b] = csv.split('\r\n')
    expect(a).toBe(`'=1+1,"Smith, ""Bob"" & Co",,'@evil`)
    expect(b).toBe(`'-5 owed,'+cmd,0.00,`)
  })

  it('blanks the dash placeholder and keeps negative dollar amounts numeric', () => {
    const rate = cols[3]
    expect(exportCellOf(rate, { pro: '', customer: '', rateCents: null, carrier: null })).toBe('')
    expect(exportCellOf(rate, { pro: '', customer: '', rateCents: -15_050, carrier: null })).toBe('-150.50')
  })

  it('writes just the header for an empty selection', () => {
    expect(selectedRowsCsv(cols, [])).toBe('PRO,Customer,Customer Rate,Carrier')
  })
})
