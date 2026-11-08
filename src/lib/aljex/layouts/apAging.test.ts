import { describe, expect, it } from 'vitest'
import { apAgingBucketOfDays, LayoutHeaderError, parseApAgingCsv, parseCsvRows, parsePayMethod } from './apAging'
import { AP_AGING_HEADER, apAgingCsv, csvOf, FIXTURE_AP_BILLS, FIXTURE_AP_TOTAL_CENTS, fixtureBills } from './apFilesFixture'

describe('AP_AGING layout', () => {
  const parse = parseApAgingCsv(apAgingCsv())

  it('reads the open bills and totals them to the cent', () => {
    expect(parse.bills).toHaveLength(FIXTURE_AP_BILLS)
    expect(parse.totalCents).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(parse.byBucket.D0_30 + parse.byBucket.D31_60).toBe(FIXTURE_AP_TOTAL_CENTS)
    expect(parse.byBucket.D31_60).toBe(12 * 120_000 + 420_720)
    expect(parse.byBucket.D61_90 + parse.byBucket.D91_120 + parse.byBucket.D121_PLUS).toBe(0)
    expect(parse.findings).toEqual([])
  })

  it('keys a bill by PRO + vendor and keeps Vend Invoice # as a reference only', () => {
    const b = parse.bills[0]
    expect(b.billNumber).toBe('900001-900000001')
    expect(b.vendorInvoiceRef).toBe('LINE')
    expect(parse.bills[1].vendorInvoiceRef).toBe('900002')
    expect(parse.bills[1].billNumber).toBe('900002-900000002')
  })

  it('reads Amount Paid as the bill amount, never as a payment', () => {
    expect(parse.bills.every((b) => b.amountCents > 0)).toBe(true)
    expect(parse.bills[66].amountCents).toBe(420_720)
  })

  it('maps Check/Draft C -> CHECK and D -> DIRECT_DEPOSIT (a leading flag letter is ignored)', () => {
    expect(parsePayMethod('NC')).toBe('CHECK')
    expect(parsePayMethod('d')).toBe('DIRECT_DEPOSIT')
    expect(parsePayMethod('N')).toBeNull()
    expect(parse.payMethodCounts).toEqual({ CHECK: 34, DIRECT_DEPOSIT: 33, UNKNOWN: 0 })
  })

  it('flags a pay-to that differs from the vendor', () => {
    expect(parse.payToDiffersCount).toBe(40)
    expect(parse.bills[0].payToDiffers).toBe(true)
    expect(parse.bills[50].payToDiffers).toBe(false)
  })

  it('buckets like Aljex (whole days from the aging date)', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 120, 121].map(apAgingBucketOfDays)).toEqual(['D0_30', 'D0_30', 'D31_60', 'D31_60', 'D61_90', 'D61_90', 'D91_120', 'D91_120', 'D121_PLUS'])
  })

  it('keeps the first row of a repeated PRO + vendor and lists the rest', () => {
    const bills = fixtureBills()
    const p = parseApAgingCsv(apAgingCsv([...bills, { ...bills[0] }]))
    expect(p.bills).toHaveLength(FIXTURE_AP_BILLS)
    expect(p.duplicates).toHaveLength(1)
    expect(p.totalCents).toBe(FIXTURE_AP_TOTAL_CENTS)
  })

  it('rejects rows it cannot read instead of guessing', () => {
    const rows = parseCsvRows(apAgingCsv([fixtureBills()[0]]))
    rows[1][AP_AGING_HEADER.indexOf('Amount Paid')] = ''
    const p = parseApAgingCsv(csvOf(rows))
    expect(p.bills).toHaveLength(0)
    expect(p.rejected).toEqual([{ rowNumber: 2, reason: 'amount missing or not positive' }])
  })

  it('refuses a file that still carries a sensitive column, and one missing a required column', () => {
    expect(() => parseApAgingCsv(csvOf([[...AP_AGING_HEADER, 'Bank Account']]))).toThrow(LayoutHeaderError)
    expect(() => parseApAgingCsv(csvOf([AP_AGING_HEADER.filter((h) => h !== 'Vendor ID')]))).toThrow(/Vendor ID/)
  })
})
