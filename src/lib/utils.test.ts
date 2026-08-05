import { describe, it, expect } from 'vitest'
import { formatVin, formatPhone } from './utils'

describe('formatVin', () => {
  it('uppercases a VIN typed in lower or mixed case', () => {
    expect(formatVin('1fujgld55llaa3391')).toBe('1FUJGLD55LLAA3391')
    expect(formatVin('1FuJgLd55LlAa3391')).toBe('1FUJGLD55LLAA3391')
  })

  it('leaves an already-uppercase VIN alone', () => {
    expect(formatVin('1FUJGLD55LLAA3391')).toBe('1FUJGLD55LLAA3391')
  })

  it('trims stray whitespace from copy-paste', () => {
    expect(formatVin('  1fujgld55llaa3391 ')).toBe('1FUJGLD55LLAA3391')
  })

  it('returns an empty string for missing values so callers can fall back to a dash', () => {
    expect(formatVin(undefined)).toBe('')
    expect(formatVin(null)).toBe('')
    expect(formatVin('')).toBe('')
    expect(formatVin('   ')).toBe('')
  })
})

describe('formatPhone', () => {
  it('formats E.164 for display', () => {
    expect(formatPhone('+17085550142')).toBe('(708) 555-0142')
  })

  it('returns the input unchanged when it is not 10 digits', () => {
    expect(formatPhone('555')).toBe('555')
  })
})
