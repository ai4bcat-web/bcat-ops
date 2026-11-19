import { describe, expect, it } from 'vitest'
import { buildChaseCsv, csvCell } from './chaseCsv'
import { buildNachaFile, type NachaFileInput } from './nacha'

// Synthetic numbers only (public Fed / Chase routing numbers, made-up accounts).
const input: NachaFileInput = {
  origin: { companyName: 'Test Company Inc', companyId: '1234567890', odfiRouting: '021000021', secCode: 'CCD', entryDescription: 'CARRIERPAY' },
  fileDate: '2026-11-19',
  fileTime: '0715',
  effectiveDate: '2026-11-20',
  fileIdModifier: 'B',
  entries: [
    { key: 'a', routingNumber: '011000015', accountNumber: '000123456', accountType: 'CHECKING', amountCents: 95000, identification: '14525', name: 'Fake Trucking LLC', addenda: 'BCAT PRO 14525' },
    { key: 'b', routingNumber: '021000021', accountNumber: '9876543210', accountType: 'SAVINGS', amountCents: 123456, identification: '14610', name: 'Sample, Haulers "Inc"', addenda: 'BCAT PRO 14610' },
  ],
}

describe('buildChaseCsv', () => {
  it('writes the three Chase sections exactly (golden file)', () => {
    const file = buildChaseCsv(input)
    expect(file.text).toBe([
      'Indicator,File ID (Modifier),File creation date,File creation time,Total trxn,Total ACH credit amount,Total ACH debit amount,Batch Count',
      '1,B,11/19/2026,0715,2,2184.56,0.00,1',
      'Indicator,Service class code,Chase Acct,SEC Code,Entry description,Delivery by date,Batch credit amount,Batch debit amount,Batch number,Trxn in Batch',
      '5,220,,CCD,CARRIERPAY,11/20/2026,2184.56,0.00,1,2',
      'Indicator,Trxn Code,Routing Num,Acct number,Trxn amount,ID Number,Payee name,Trxn ID,Addenda',
      '6,22,011000015,000123456,950.00,14525,FAKE TRUCKING LLC,B0001,BCAT PRO 14525',
      '6,32,021000021,9876543210,1234.56,14610,SAMPLE HAULERS INC,B0002,BCAT PRO 14610',
      '',
    ].join('\r\n'))
    expect(file.fileName).toBe('BCAT-ACH-20261119-0715B.csv')
    expect(file.entryCount).toBe(2)
    expect(file.totalCreditCents).toBe(218456)
  })

  it('leaves the Chase pay-from account blank', () => {
    const batch = buildChaseCsv(input).text.split('\r\n')[3].split(',')
    expect(batch[2]).toBe('')
  })

  it('matches the NACHA file on totals, count and file name stem', () => {
    const csv = buildChaseCsv(input)
    const nacha = buildNachaFile(input)
    expect(csv.totalCreditCents).toBe(nacha.totalCreditCents)
    expect(csv.entryCount).toBe(nacha.entryCount)
    expect(csv.fileName.replace(/\.csv$/, '')).toBe(nacha.fileName.replace(/\.ach$/, ''))
  })

  it('keeps one payment per bill (the same carrier twice stays two rows)', () => {
    const two = { ...input, entries: [input.entries[0], { ...input.entries[0], key: 'c', identification: '14526', addenda: 'BCAT PRO 14526' }] }
    const rows = buildChaseCsv(two).text.trim().split('\r\n').filter((l) => l.startsWith('6,'))
    expect(rows).toHaveLength(2)
  })

  it('applies the same checks as the NACHA file', () => {
    expect(() => buildChaseCsv({ ...input, effectiveDate: '2026-11-21' })).toThrow('business day')
    expect(() => buildChaseCsv({ ...input, entries: [] })).toThrow('no payments')
    expect(() => buildChaseCsv({ ...input, entries: [{ ...input.entries[0], routingNumber: '021000022' }] })).toThrow('routing')
  })
})

describe('csvCell', () => {
  it('quotes commas, quotes and breaks, and drops leading formula characters', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=SUM(A1)')).toBe('SUM(A1)')
    expect(csvCell('@cmd')).toBe('cmd')
    expect(csvCell('-5')).toBe('5')
    expect(csvCell('plain')).toBe('plain')
  })
})
