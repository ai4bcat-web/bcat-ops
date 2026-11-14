import { describe, expect, it } from 'vitest'
import {
  allServices, costCsv, costMonthIds, dailyCosts, headline, toMeta, toMonthRow, totalsBy, weekOf,
  type CostManualEntry, type CostMeta, type CostMonthRow,
} from './costToRun'

const meta: CostMeta = {
  services: [
    { key: 'aws.amplify.prod', label: 'Amplify', category: 'hosting', source: 'billed' },
    { key: 'twilio.sms', label: 'Texts', category: 'phone', source: 'billed' },
  ],
  asOf: '2026-11-10', collectedAt: null, sources: {}, notes: [],
}
const rows: CostMonthRow[] = [
  { month: '2026-10', days: { '2026-10-15': { 'aws.amplify.prod': 300, 'twilio.sms': 100 } }, excluded: {} },
  { month: '2026-11', days: { '2026-11-02': { 'aws.amplify.prod': 200 }, '2026-11-09': { 'twilio.sms': 50 } }, excluded: {} },
]
const workspace: CostManualEntry = { id: 'gw', label: 'Google Workspace', category: 'email', monthlyCents: 3000, startMonth: '2026-11', endMonth: null }

describe('costToRun', () => {
  it('spreads a fixed monthly cost over the days of the months it covers only', () => {
    const daily = dailyCosts(rows, [workspace], '2026-10-01', '2026-11-30')
    const months = totalsBy('month', daily, allServices(meta, [workspace]))
    expect(months.map((m) => m.period)).toEqual(['2026-10', '2026-11'])
    expect(months[0].byCategory.email).toBeUndefined()
    expect(months[1].byCategory.email).toBeCloseTo(3000)
    expect(months[0].total).toBe(400)
    expect(months[1].byCategory.hosting).toBe(200)
  })

  it('groups weeks Monday to Sunday', () => {
    expect(weekOf('2026-11-09')).toBe('2026-11-09') // a Monday
    expect(weekOf('2026-11-15')).toBe('2026-11-09') // the Sunday after
    const weeks = totalsBy('week', dailyCosts(rows, [], '2026-11-02', '2026-11-15'), meta.services)
    expect(weeks.map((w) => [w.period, w.total])).toEqual([['2026-11-02', 200], ['2026-11-09', 50]])
  })

  it('projects the month from its daily rate so far', () => {
    const h = headline(dailyCosts(rows, [], '2026-10-01', '2026-11-10'), '2026-11-10')
    expect(h.monthToDate).toBe(250)
    expect(h.lastMonth).toBe(400)
    expect(h.projectedMonth).toBeCloseTo((250 / 10) * 30)
  })

  it('writes one CSV line per service and a total per period', () => {
    const months = totalsBy('month', dailyCosts(rows, [], '2026-10-01', '2026-10-31'), meta.services)
    expect(costCsv(months, meta.services).split('\n')).toEqual([
      'Period,Category,Service,Source,Cost (USD)',
      '2026-10,Hosting,Amplify,billed,3.00',
      '2026-10,Phone & texts,Texts,billed,1.00',
      '2026-10,Total,,,4.00',
    ])
  })

  it('reads stored rows whether the payload arrives as a string or an object', () => {
    expect(toMonthRow('COST:2026-11', JSON.stringify(JSON.stringify({ days: { '2026-11-01': { a: 1 } } })))?.days['2026-11-01'].a).toBe(1)
    expect(toMeta({ services: [], asOf: '2026-11-10' })?.asOf).toBe('2026-11-10')
    expect(toMonthRow('COST:2026-11', 'not json')).toBeNull()
  })

  it('lists the month ids ending with the given month', () => {
    expect(costMonthIds('2026-02', 3)).toEqual(['COST:2025-12', 'COST:2026-01', 'COST:2026-02'])
  })
})
