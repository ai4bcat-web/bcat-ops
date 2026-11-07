import { describe, expect, it } from 'vitest'
import {
  apAgingReader,
  canSignOff,
  carriersReader,
  compareLedger,
  compareRecords,
  customersReader,
  CUSTOMER_FIELDS,
  decisionStats,
  mergeDecisions,
  pageRows,
  proKeyOf,
  ReconDecisionError,
  reconCsv,
  type LedgerItem,
  type ReconReport,
  type ReconSideRow,
} from './aljexReconcile'

const side = (key: string, name: string, fields: ReconSideRow['fields'] = {}): ReconSideRow => ({ key, name, fields: { name, ...fields } })
const item = (key: string, party: string, openCents: number, dueAt = '2026-11-30'): LedgerItem => ({ key, name: key, partyName: party, openCents, dueAt })

describe('compareRecords', () => {
  it('splits matched, Aljex-only, BCAT-only and field mismatches; blank Aljex values are not differences', () => {
    const aljex = [
      side('100', 'ACME Freight, Inc.', { termsDays: 30, contactEmail: null }),
      side('101', 'Beta LLC', { termsDays: 45 }),
      side('102', 'Gone Co'),
    ]
    const bcat = [
      side('100', 'Acme Freight Inc', { termsDays: 30, contactEmail: 'x@example.com' }),
      side('101', 'Beta LLC', { termsDays: 30 }),
      side('999', 'Native Only'),
    ]
    const r = compareRecords(aljex, bcat, CUSTOMER_FIELDS.filter((f) => f.field !== 'active'))
    expect(r.counts).toMatchObject({ aljexRows: 3, bcatRows: 3, matched: 1, aljexOnly: 1, bcatOnly: 1, mismatched: 1, diffs: 3 })
    expect(r.diffs.map((d) => d.key).sort()).toEqual(['ALJEX_ONLY|102|', 'BCAT_ONLY|999|', 'MISMATCH|101|termsDays'])
  })

  it('treats a row matched through a merged-duplicate alias as present with nothing to compare', () => {
    const r = compareRecords([side('ID-2', 'Dup Carrier', { mc: '111' })], [side('ID-2', 'Primary Carrier', { mc: '222', __alias: 1 })], [{ field: 'mc', label: 'MC', kind: 'text' }])
    expect(r.counts.matched).toBe(1)
    expect(r.diffs).toEqual([])
  })
})

describe('compareLedger', () => {
  it('ties money to the cent by invoice number, flags amount and due-date differences and the total', () => {
    const aljex = [item('1001', 'ACME', 10050), item('1002', 'ACME', 2500), item('1003', 'BETA', 100, '2026-12-01'), item('1004', 'BETA', 999)]
    const bcat = [item('1001', 'ACME', 10050), item('1002', 'ACME', 2499), item('1003', 'BETA', 100, '2026-12-15'), item('1005', 'GAMMA', 700)]
    const r = compareLedger('AR', aljex, bcat, '2026-11-07')
    expect(r.counts).toMatchObject({ matched: 1, mismatched: 2, aljexOnly: 1, bcatOnly: 1 })
    expect(r.money).toMatchObject({ aljexCents: 13649, bcatCents: 13349, diffCents: -300 })
    expect(r.diffs.map((d) => d.key).sort()).toEqual([
      'ALJEX_ONLY|1004|', 'BCAT_ONLY|1005|', 'MISMATCH|1003|dueAt', 'MONEY_TOTAL|total|openCents', 'MONEY|1002|openCents',
    ])
    expect(r.diffs.find((d) => d.key === 'MONEY|1002|openCents')?.diffCents).toBe(-1)
    expect(r.money.byParty.reduce((n, l) => n + l.aljexCents, 0)).toBe(13649)
    expect(r.money.byBucket.reduce((n, l) => n + l.bcatCents, 0)).toBe(13349)
  })

  it('a ledger that ties produces no differences at all', () => {
    const r = compareLedger('AP', [item('6000-V1', 'Carrier', 5000)], [item('6000-V1', 'Carrier', 5000)], '2026-11-07')
    expect(r.diffs).toEqual([])
    expect(r.counts.matched).toBe(1)
  })
})

describe('Aljex file readers', () => {
  it('AP aging: the five aging columns are the open amount, Amount Paid is only a fallback, a repeated PRO+vendor keeps one', () => {
    const reader = apAgingReader('2026-11-07')
    const header = ['Vendor', 'Pro #', 'Vendor ID', 'Due Date', '0 - 30 Days', '31 - 60 Days', '61 - 90 Days', '91 - 120 Days', '120 Days or More', 'Amount Paid', 'Check/Draft']
    reader.push(header)
    reader.push(['Carrier A', '6269', 'V1', '11/20/2026', '$1,000.50', '', '', '', '', '$1,000.50', 'C'])
    reader.push(['Carrier A', '6269', 'V1', '11/20/2026', '$1,000.50', '', '', '', '', '$1,000.50', 'C'])
    reader.push(['Carrier B', '6270', 'V2', '10/01/2026', '', '$200.00', '', '', '', '$200.00', 'D'])
    reader.push(['Carrier C', '6271', 'V3', '10/01/2026', '', '', '', '', '', '$75.00', 'D'])
    const r = reader.finish()
    expect(r.ledger?.map((l) => [l.key, l.openCents])).toEqual([['6269-V1', 100050], ['6270-V2', 20000], ['6271-V3', 7500]])
    expect(r.excluded).toEqual({ 'duplicate bill row (same PRO and vendor)': 1 })
    expect(r.fileBuckets?.map((b) => b.aljexCents)).toEqual([100050, 20000, 0, 0, 0])
  })

  it('customers: test and ZZ names are excluded, GUEST SUPPLY stays, Status N rows are inactive, sensitive columns are never read', () => {
    const reader = customersReader()
    reader.push(['Name', 'Account #', 'Status', 'Invoice Terms Days', 'Web Password', 'E-Billing Email'])
    reader.push(['TEST CUSTOMER', '100003', 'Y', '30', 'secret-a', ''])
    reader.push(['ZZ SAMPLE', '100004', 'Y', '30', 'secret-b', ''])
    reader.push(['GUEST SUPPLY', '100005', 'Y', '30', 'secret-c', 'Bill@Example.com'])
    reader.push(['OLD CO', '100006', 'N', '30', 'secret-d', ''])
    const r = reader.finish()
    expect(r.rows.map((x) => x.key)).toEqual(['100005'])
    expect(r.rows[0].fields.billingEmail).toBe('bill@example.com')
    expect(reader.inactive().map((x) => x.key)).toEqual(['100006'])
    expect(r.excluded).toEqual({ 'test customer': 2 })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('carriers: never reads tax-id, bank or routing columns', () => {
    const reader = carriersReader()
    reader.push(['Vendor Name', 'Aljex Carrier ID', 'Fed/SS #', 'Bank Account', 'Routing #', 'MC #', 'Status Y/N', 'Quick Pay', 'Factor Id'])
    reader.push(['Truck Co', 'C1', '99-9999999', '123456789', '021000021', 'MC-123456', 'Y', 'Y', ''])
    const r = reader.finish()
    expect(r.rows[0].fields).toMatchObject({ mc: '123456', active: 1, quickPay: 1, factored: 0 })
    expect(JSON.stringify(r)).not.toMatch(/9999999|123456789|021000021/)
  })

  it('refuses a file that is not the expected layout', () => {
    expect(() => apAgingReader('2026-11-07').push(['Name', 'Address'])).toThrow(/AP aging/)
  })
})

describe('decisions', () => {
  const diffs = compareLedger('AR', [item('1', 'A', 100), item('2', 'A', 200)], [], '2026-11-07').diffs
  const valid = new Set(diffs.map((d) => d.key))

  it('requires an outcome, a reason and keys that belong to the report; the approver is taken as given by the caller', () => {
    const keys = [diffs[0].key]
    expect(() => mergeDecisions([], keys, 'APPROVED', '  ', 'jenny', 't', valid)).toThrow(ReconDecisionError)
    expect(() => mergeDecisions([], keys, 'NOPE' as never, 'why', 'jenny', 't', valid)).toThrow(/outcome/)
    expect(() => mergeDecisions([], ['MONEY|x|y'], 'APPROVED', 'why', 'jenny', 't', valid)).toThrow(/not differences/)
    const d = mergeDecisions([], keys, 'OPEN_BALANCE', 'customer disputes it', 'jenny', '2026-11-07T10:00:00Z', valid)
    expect(d).toEqual([{ key: keys[0], outcome: 'OPEN_BALANCE', approver: 'jenny', at: '2026-11-07T10:00:00Z', reason: 'customer disputes it' }])
  })

  it('a later decision replaces the earlier one and sign-off needs every difference decided', () => {
    let d = mergeDecisions([], [diffs[0].key], 'OPEN_BALANCE', 'a', 'j', 't1', valid)
    expect(canSignOff(decisionStats(diffs, d))).toBe(false)
    d = mergeDecisions(d, diffs.map((x) => x.key), 'APPROVED', 'b', 'j', 't2', valid)
    const stats = decisionStats(diffs, d)
    expect(stats).toMatchObject({ total: diffs.length, decided: diffs.length, undecided: 0, approved: diffs.length, openBalance: 0 })
    expect(canSignOff(stats)).toBe(true)
    expect(canSignOff(decisionStats([], []))).toBe(true)
  })

  it('filters undecided rows for the page and exports decisions in the CSV, neutralising formulas', () => {
    const d = mergeDecisions([], [diffs[0].key], 'APPROVED', '=cmd|x', 'j', 't', valid)
    expect(pageRows(diffs, d, { state: 'OPEN' }).rows.map((r) => r.key)).toEqual(diffs.slice(1).map((x) => x.key))
    const report: ReconReport = { entity: 'AR', generatedAt: 't', asOf: '2026-11-07', sourceJobId: 's', counts: { aljexRows: 2, bcatRows: 0, matched: 0, aljexOnly: 2, bcatOnly: 0, mismatched: 0, diffs: 3 }, excluded: {}, notes: [], diffs, money: null }
    const csv = reconCsv(report, d)
    expect(csv).toContain("APPROVED,j,t,'=cmd|x")
    expect(csv.split('\r\n')[0]).toContain('decision,approver,decided_at,reason')
    expect(csv).toContain('UNDECIDED')
  })
})

describe('proKeyOf', () => {
  it('strips one leading L, padding and the Pro# label', () => {
    expect(proKeyOf(' 14452  ')).toBe('14452')
    expect(proKeyOf('L14452')).toBe('14452')
    expect(proKeyOf('Pro# 14452')).toBe('14452')
    expect(proKeyOf('')).toBeNull()
  })
})
