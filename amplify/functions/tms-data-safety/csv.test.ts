import { describe, expect, it } from 'vitest'
import { csvLine, dateOnly, moneyFromCents, orderColumns, rawCell, sheetText } from './csv'

describe('raw cells', () => {
  it('quotes delimiters, quotes and line breaks and nothing else', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', 'x\ny', ''])).toBe('a,"b,c","say ""hi""","x\ny",\r\n')
  })

  it('prints nested values as JSON and scalars as stored', () => {
    expect(rawCell({ a: [1, 2] })).toBe('{"a":[1,2]}')
    expect(rawCell(12345)).toBe('12345')
    expect(rawCell(false)).toBe('false')
    expect(rawCell(null)).toBe('')
    expect(rawCell(undefined)).toBe('')
    expect(rawCell(new Set(['x', 'y']))).toBe('["x","y"]')
  })

  it('never rewrites a value that looks like a formula (raw dumps stay faithful)', () => {
    expect(rawCell('=SUM(A1)')).toBe('=SUM(A1)')
  })

  it('puts id first and sorts the rest', () => {
    expect(orderColumns(['zeta', 'id', 'alpha'])).toEqual(['id', 'alpha', 'zeta'])
    expect(orderColumns(['b'])).toEqual(['id', 'b'])
  })
})

describe('accountant cells', () => {
  it('defuses spreadsheet formulas but leaves negative numbers alone', () => {
    expect(sheetText('=1+1')).toBe("'=1+1")
    expect(sheetText('+cmd')).toBe("'+cmd")
    expect(sheetText('@SUM')).toBe("'@SUM")
    expect(sheetText('-cmd')).toBe("'-cmd")
    expect(sheetText('-12.50')).toBe('-12.50')
    expect(sheetText('plain = text')).toBe('plain = text')
    expect(sheetText(null)).toBe('')
  })

  it('formats cents as two-place dollars with a leading minus', () => {
    expect(moneyFromCents(0)).toBe('0.00')
    expect(moneyFromCents(5)).toBe('0.05')
    expect(moneyFromCents(123456)).toBe('1234.56')
    expect(moneyFromCents(-5)).toBe('-0.05')
    expect(moneyFromCents(-100)).toBe('-1.00')
    expect(moneyFromCents(undefined)).toBe('')
    expect(moneyFromCents('12')).toBe('')
  })

  it('takes the day from dates and datetimes', () => {
    expect(dateOnly('2026-03-04T12:00:00.000Z')).toBe('2026-03-04')
    expect(dateOnly('2026-03-04')).toBe('2026-03-04')
    expect(dateOnly(undefined)).toBe('')
  })
})
