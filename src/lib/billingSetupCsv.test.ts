import { describe, expect, it } from 'vitest'
import { parseCsvText } from '@/lib/aljex/csv'
import {
  applyPatchOf, billingCounts, exportBillingCsv, isMissing, lastMonths, loadsByCustomer, needsAnswerCsv, previewBillingImport,
  type BillingCustomer,
} from './billingSetupCsv'

const cust = (o: Partial<BillingCustomer> & { id: string; name: string }): BillingCustomer => ({ ...o })

const CUSTOMERS: BillingCustomer[] = [
  cust({ id: 'a', name: 'ZZ Alpha Freight', aljexCode: '900001', billingMethod: 'FACTOR' }),
  cust({ id: 'b', name: 'ZZ Beta Foods', aljexCode: '900002', billingMethod: 'MANUAL', apEmail: 'ap@beta.example', invoiceCopyEmails: ['x@beta.example'] }),
  cust({ id: 'c', name: 'ZZ Gamma', aljexCode: '900003' }),
  cust({ id: 'd', name: 'ZZ Delta', aljexCode: '900004', billingMethod: 'MANUAL' }),
  cust({ id: 'e', name: 'ZZ Eps', aljexCode: '900005', billingMethod: 'MANUAL', apEmail: 'old@eps.example', billingNeedsReview: 'internal billing address' }),
  cust({ id: 'f', name: 'ZZ Twin', aljexCode: '900006' }),
  cust({ id: 'g', name: 'ZZ Twin', aljexCode: '900007' }),
]

const header = 'customer,aljexCode,method,apEmail,copyList'

describe('header counts and Missing filter', () => {
  it('counts methods, not set and needs review', () => {
    expect(billingCounts(CUSTOMERS)).toEqual({ factor: 1, manual: 3, notSet: 3, needsReview: 1 })
  })
  it('Missing = unset, MANUAL without AP e-mail, or flagged', () => {
    expect(CUSTOMERS.filter(isMissing).map((c) => c.id)).toEqual(['c', 'd', 'e', 'f', 'g'])
  })
})

describe('last 12 months and loads', () => {
  it('walks back across a year boundary', () => {
    const m = lastMonths(new Date('2026-02-10T00:00:00Z'), 12)
    expect(m[0]).toBe('2026-02')
    expect(m[2]).toBe('2025-12')
    expect(m[11]).toBe('2025-03')
  })
  it('counts shipments per customer and ignores unlinked ones', () => {
    const m = loadsByCustomer([{ customerId: 'a' }, { customerId: 'a' }, { customerId: null }, { customerId: 'b' }])
    expect(m.get('a')).toBe(2)
    expect(m.has('null')).toBe(false)
  })
})

describe('CSV export and the needs-your-answer report', () => {
  it('quotes commas and round-trips through the parser', () => {
    const csv = exportBillingCsv([cust({ id: 'q', name: 'ZZ "Quoted", Inc', billingMethod: 'MANUAL', apEmail: 'a@q.example', invoiceCopyEmails: ['b@q.example', 'c@q.example'] })])
    const rows = parseCsvText(csv)
    expect(rows[0]).toEqual(['customer', 'aljexCode', 'method', 'apEmail', 'copyList', 'termsDays', 'note'])
    expect(rows[1][0]).toBe('ZZ "Quoted", Inc')
    expect(rows[1][4]).toBe('b@q.example;c@q.example')
  })
  it('lists only rows needing an answer, busiest first, with import columns first', () => {
    const rows = parseCsvText(needsAnswerCsv(CUSTOMERS, new Map([['d', 9], ['c', 3]])))
    expect(rows.slice(1).map((r) => r[0])).toEqual(['ZZ Delta', 'ZZ Gamma', 'ZZ Eps', 'ZZ Twin', 'ZZ Twin'])
    expect(rows[0].slice(0, 5)).toEqual(['customer', 'aljexCode', 'method', 'apEmail', 'copyList'])
    expect(rows[1][5]).toMatch(/accounts-payable/)
  })
  it('the report re-imports: a filled-in answer becomes a change', () => {
    const filled = [header + ',question', 'ZZ Gamma,900003,MANUAL,ap@gamma.example,,q'].join('\n')
    const p = previewBillingImport(filled, CUSTOMERS)
    expect(p.rows[0].status).toBe('CHANGED')
  })
})

describe('CSV import preview', () => {
  const run = (...lines: string[]) => previewBillingImport([header, ...lines].join('\r\n'), CUSTOMERS)

  it('classifies changed, unchanged, unknown, invalid and duplicate rows', () => {
    const p = run(
      'ZZ Alpha Freight,900001,FACTOR,,', // unchanged
      'x,900002,MANUAL,new@beta.example,x@beta.example', // changed (AP e-mail)
      'x,999999,MANUAL,a@b.example,', // unknown account
      'ZZ Gamma,,MANUAL,,', // manual without AP
      'ZZ Eps,,FAX,a@b.example,', // bad method
      'ZZ Delta,900004,MANUAL,not-an-email,', // bad AP
    )
    expect(p.rows.map((r) => r.status)).toEqual(['UNCHANGED', 'CHANGED', 'UNKNOWN', 'INVALID', 'INVALID', 'INVALID'])
    expect(p.counts.CHANGED).toBe(1)
  })
  it('flags duplicate account numbers in the file and applies neither row', () => {
    const p = run('a,900003,MANUAL,a@x.example,', 'b,900003,FACTOR,,')
    expect(p.rows.map((r) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE'])
    expect(p.rows.every((r) => applyPatchOf(r, new Set([2, 3])) === null)).toBe(true)
  })
  it('refuses to guess between customers that share a name; the account number resolves it', () => {
    expect(run('ZZ Twin,,FACTOR,,').rows[0].status).toBe('UNKNOWN')
    expect(run('ZZ Twin,900006,FACTOR,,').rows[0].status).toBe('CHANGED')
  })
  it('a blank method never clears a set method', () => {
    expect(run('ZZ Beta Foods,900002,,,').rows[0].status).toBe('INVALID')
    expect(run('ZZ Gamma,900003,,,').rows[0].status).toBe('UNCHANGED')
  })
  it('holds a needs-review row until it is confirmed, then applies it and clears the flag', () => {
    const p = run('ZZ Eps,900005,MANUAL,new@eps.example,')
    const row = p.rows[0]
    expect(row.status).toBe('HELD')
    expect(applyPatchOf(row, new Set())).toBeNull()
    expect(applyPatchOf(row, new Set([row.line]))).toEqual({
      billingMethod: 'MANUAL', apEmail: 'new@eps.example', invoiceCopyEmails: [], billingNeedsReview: null,
    })
  })
  it('a note column in the file also holds a changed row', () => {
    const p = previewBillingImport(`${header},note\nZZ Gamma,900003,FACTOR,,,check with Ryne`, CUSTOMERS)
    expect(p.rows[0].status).toBe('HELD')
  })
  it('normalises e-mails and de-duplicates the copy list', () => {
    const p = run('ZZ Gamma,900003,MANUAL,AP@Gamma.example,"A@x.example; a@x.example, b@x.example"')
    expect(p.rows[0].patch).toEqual({ billingMethod: 'MANUAL', apEmail: 'ap@gamma.example', invoiceCopyEmails: ['a@x.example', 'b@x.example'] })
  })
  it('rejects a file without the import columns', () => {
    expect(previewBillingImport('foo,bar\n1,2', CUSTOMERS).error).toMatch(/Header/)
    expect(previewBillingImport('', CUSTOMERS).error).toMatch(/empty/)
  })
})
