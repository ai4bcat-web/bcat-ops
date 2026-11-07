import { describe, expect, it } from 'vitest'
import { AR_BUCKETS, AR_REPORT_LAYOUT_ID, parseArReportCsv } from './arReport'
import { AR_HEADER, arCsv, arCsvOf, FIXTURE_AR_BILL_TO_DIFFERS, FIXTURE_AR_INVOICES, FIXTURE_AR_PAID_CENTS, FIXTURE_AR_TOTAL_CENTS, fixtureArInvoices } from './arReportFixture'
import { LayoutHeaderError } from './apAging'

describe('AR report layout', () => {
  it('reads the open amount as the sum of the aging buckets, never the customer-level Balance Due', () => {
    const p = parseArReportCsv(arCsv())
    expect(p.layoutId).toBe(AR_REPORT_LAYOUT_ID)
    expect(p.invoices).toHaveLength(FIXTURE_AR_INVOICES)
    expect(p.totalCents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(AR_BUCKETS.reduce((n, b) => n + p.byBucket[b], 0)).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(AR_BUCKETS.every((b) => p.byBucket[b] > 0)).toBe(true)
    // Invoice Amount minus Previous Payments ties to the buckets, so no amount finding is raised.
    expect(p.invoiceTotalCents - p.previousPaidCents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(p.previousPaidCents).toBe(FIXTURE_AR_PAID_CENTS)
    expect(p.partialCount).toBe(3)
    expect(p.findings.filter((f) => f.code !== 'AR_BUCKET_DAYS_MISMATCH')).toEqual([])
    expect(p.invoices.every((i) => i.openCents !== 99_999_999)).toBe(true)
  })

  it('keeps Aljex dates, bill-to party by account and the invoice bucket from Days', () => {
    const p = parseArReportCsv(arCsv())
    const fixture = fixtureArInvoices()
    expect(p.billToDiffersCount).toBe(FIXTURE_AR_BILL_TO_DIFFERS)
    expect(p.billToNameDiffersCount).toBe(FIXTURE_AR_BILL_TO_DIFFERS)
    for (const [i, f] of fixture.entries()) {
      const r = p.invoices[i]
      expect(r).toMatchObject({ pro: f.pro, invoiceDate: f.invoiceDate, dueDate: f.dueDate, customerAccount: f.customerAccount, billToAccount: f.billToAccount, openCents: f.openCents, previousPaidCents: f.paidCents })
    }
    expect(p.invoices.map((i) => i.bucket)).toEqual(fixture.map((f) => AR_BUCKETS[f.bucketIndex]))
    expect(p.termsCounts['90']).toBe(54)
  })

  it('refuses a file that still carries a credential column, and one without the aging columns', () => {
    const withSecret = arCsvOf([[...AR_HEADER, 'Web Password'], ...fixtureArInvoices().slice(0, 1).map(() => [...AR_HEADER.map(() => ''), 'x'])])
    expect(() => parseArReportCsv(withSecret)).toThrow(LayoutHeaderError)
    const noBuckets = arCsvOf([AR_HEADER.filter((h) => h !== '31 - 60 Days'), []])
    expect(() => parseArReportCsv(noBuckets)).toThrow(/31 - 60 Days/)
  })

  it('rejects rows without an open amount or a readable date and keeps the first of a repeated PRO', () => {
    const rows = arCsv().trim().split('\n')
    const dup = rows[1]
    const noMoney = rows[2].replace(/"\d+\.\d\d"/g, '""')
    const p = parseArReportCsv([rows[0], rows[1], dup, noMoney, rows[3]].join('\n'))
    expect(p.invoices).toHaveLength(2)
    expect(p.duplicates).toHaveLength(1)
    expect(p.rejected).toHaveLength(1)
    expect(p.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['AR_DUPLICATE_KEY', 'AR_ROW_REJECTED']))
  })
})
