import { describe, expect, it } from 'vitest'
import {
  CHASE_ROUTING_NUMBERS,
  buildNachaFile,
  isBankBusinessDay,
  isValidRoutingNumber,
  nachaText,
  nextBankBusinessDay,
  type NachaFileInput,
} from './nacha'

// Synthetic numbers only. 021000021 is Chase's public routing number; 011000015 is a public Federal Reserve one.
const FAKE_ROUTING_A = '011000015'
const FAKE_ROUTING_B = '021000021'

const base: NachaFileInput = {
  origin: {
    companyName: 'Test Company Inc',
    companyId: '1234567890',
    odfiRouting: '021000021',
    secCode: 'CCD',
    entryDescription: 'CARRIERPAY',
  },
  fileDate: '2026-11-19',
  fileTime: '0715',
  effectiveDate: '2026-11-20',
  entries: [
    { key: 'a', routingNumber: FAKE_ROUTING_A, accountNumber: '000123456', accountType: 'CHECKING', amountCents: 95000, identification: '14525', name: 'Fake Trucking LLC', addenda: 'BCAT PRO 14525' },
    { key: 'b', routingNumber: FAKE_ROUTING_B, accountNumber: '9876543210', accountType: 'SAVINGS', amountCents: 123456, identification: '14610', name: 'Sample Haulers & Sons', addenda: 'BCAT PRO 14610' },
  ],
}

describe('routing numbers', () => {
  it('checks the ABA checksum', () => {
    expect(isValidRoutingNumber(FAKE_ROUTING_A)).toBe(true)
    expect(isValidRoutingNumber(FAKE_ROUTING_B)).toBe(true)
    expect(isValidRoutingNumber('021000022')).toBe(false)
    expect(isValidRoutingNumber('12345')).toBe(false)
  })
  it('every Chase number in the spec passes the checksum', () => {
    for (const routing of CHASE_ROUTING_NUMBERS) expect(isValidRoutingNumber(routing)).toBe(true)
  })
})

describe('business days', () => {
  it('skips weekends and bank holidays', () => {
    expect(nextBankBusinessDay('2026-11-19')).toBe('2026-11-20') // Thu -> Fri
    expect(nextBankBusinessDay('2026-11-20')).toBe('2026-11-23') // Fri -> Mon
    expect(nextBankBusinessDay('2026-11-25')).toBe('2026-11-27') // Wed before Thanksgiving -> Fri
    expect(isBankBusinessDay('2026-12-25')).toBe(false)
  })
})

describe('nachaText', () => {
  it('upper-cases, strips symbols and pads or cuts to length', () => {
    expect(nachaText('Smith & Sons, LLC #1', 22)).toBe('SMITH & SONS LLC 1'.padEnd(22, ' '))
    expect(nachaText('x'.repeat(40), 22)).toHaveLength(22)
  })
})

describe('buildNachaFile', () => {
  const file = buildNachaFile(base)
  const lines = file.text.split('\r\n').filter((line) => line.length > 0)

  it('writes 94-character records in whole blocks of ten', () => {
    expect(lines.every((line) => line.length === 94)).toBe(true)
    expect(lines.length % 10).toBe(0)
    expect(file.lineCount).toBe(lines.length)
    expect(file.blockCount).toBe(lines.length / 10)
  })

  it('has the Chase file header', () => {
    const header = lines[0]
    expect(header.slice(0, 3)).toBe('101')
    expect(header.slice(3, 13)).toBe(' 021000021')
    expect(header.slice(13, 23)).toBe('1234567890')
    expect(header.slice(23, 29)).toBe('261119')
    expect(header.slice(29, 33)).toBe('0715')
    expect(header.slice(33, 40)).toBe('A094101')
    expect(header.slice(40, 63).trimEnd()).toBe('JPMORGAN CHASE')
    expect(header.slice(63, 86).trimEnd()).toBe('TEST COMPANY INC')
  })

  it('has a credit-only CCD batch header', () => {
    const batch = lines[1]
    expect(batch.slice(0, 4)).toBe('5220')
    expect(batch.slice(4, 20).trimEnd()).toBe('TEST COMPANY INC')
    expect(batch.slice(40, 50)).toBe('1234567890')
    expect(batch.slice(50, 53)).toBe('CCD')
    expect(batch.slice(53, 63).trimEnd()).toBe('CARRIERPAY')
    expect(batch.slice(69, 75)).toBe('261120')
    expect(batch.slice(78, 87)).toBe('102100002')
    expect(batch.slice(87, 94)).toBe('0000001')
  })

  it('writes one entry plus one addenda per payment with trace numbers off the ODFI', () => {
    const entries = lines.filter((line) => line[0] === '6')
    const addenda = lines.filter((line) => line[0] === '7')
    expect(entries).toHaveLength(2)
    expect(addenda).toHaveLength(2)
    expect(entries[0].slice(1, 3)).toBe('22')
    expect(entries[1].slice(1, 3)).toBe('32')
    expect(entries[0].slice(3, 12)).toBe('011000015')
    expect(entries[0].slice(12, 29).trimEnd()).toBe('000123456')
    expect(entries[0].slice(29, 39)).toBe('0000095000')
    expect(entries[0].slice(39, 54).trimEnd()).toBe('14525')
    expect(entries[0].slice(78, 79)).toBe('1')
    expect(entries[0].slice(79, 94)).toBe('021000020000001')
    expect(entries[1].slice(79, 94)).toBe('021000020000002')
    expect(addenda[0].slice(0, 3)).toBe('705')
    expect(addenda[0].slice(3, 83).trimEnd()).toBe('BCAT PRO 14525')
    expect(addenda[0].slice(83, 94)).toBe('00010000001')
  })

  it('makes the control totals add up', () => {
    const batchControl = lines.find((line) => line[0] === '8') as string
    const fileControl = lines.find((line) => line[0] === '9') as string
    expect(batchControl.slice(1, 4)).toBe('220')
    expect(batchControl.slice(4, 10)).toBe('000004') // 2 entries + 2 addenda
    expect(batchControl.slice(10, 20)).toBe('0003200003') // 01100001 + 02100002
    expect(batchControl.slice(20, 32)).toBe('000000000000')
    expect(batchControl.slice(32, 44)).toBe('000000218456')
    expect(batchControl.slice(44, 54)).toBe('1234567890')
    expect(batchControl.slice(79, 87)).toBe('02100002')
    expect(fileControl.slice(0, 7)).toBe('9000001')
    expect(fileControl.slice(7, 13)).toBe('000001')
    expect(fileControl.slice(13, 21)).toBe('00000004')
    expect(fileControl.slice(21, 31)).toBe('0003200003')
    expect(fileControl.slice(31, 43)).toBe('000000000000')
    expect(fileControl.slice(43, 55)).toBe('000000218456')
    expect(file.totalCreditCents).toBe(218456)
  })

  it('pads with 9-filled records', () => {
    const padding = lines.filter((line) => line === '9'.repeat(94))
    expect(padding.length).toBe(lines.length - 8)
  })

  it('names the file with its date, time and modifier', () => {
    expect(file.fileName).toBe('BCAT-ACH-20261119-0715A.ach')
  })

  it('refuses a bad origin, effective date, entry or empty file', () => {
    expect(() => buildNachaFile({ ...base, origin: { ...base.origin, companyId: '123' } })).toThrow('10 digits')
    expect(() => buildNachaFile({ ...base, origin: { ...base.origin, odfiRouting: FAKE_ROUTING_A } })).toThrow('Chase')
    expect(() => buildNachaFile({ ...base, origin: { ...base.origin, entryDescription: 'PAYROLL' } })).toThrow('PAYROLL')
    expect(() => buildNachaFile({ ...base, effectiveDate: '2026-11-19' })).toThrow('after')
    expect(() => buildNachaFile({ ...base, effectiveDate: '2026-11-21' })).toThrow('business day')
    expect(() => buildNachaFile({ ...base, entries: [] })).toThrow('no payments')
    expect(() => buildNachaFile({ ...base, entries: [{ ...base.entries[0], amountCents: 0 }] })).toThrow('amount')
    expect(() => buildNachaFile({ ...base, entries: [{ ...base.entries[0], routingNumber: '021000022' }] })).toThrow('routing')
  })

  it('keeps an entry without addenda to a single record', () => {
    const single = buildNachaFile({ ...base, entries: [{ ...base.entries[0], addenda: undefined }] })
    const rows = single.text.split('\r\n').filter((line) => line.length > 0)
    expect(rows.filter((line) => line[0] === '7')).toHaveLength(0)
    expect(rows.find((line) => line[0] === '6')?.slice(78, 79)).toBe('0')
  })
})
