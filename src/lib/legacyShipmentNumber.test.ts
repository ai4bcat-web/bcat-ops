import { describe, expect, it } from 'vitest'
import { backfillShipmentNumber, digitsOnlyPro, parseLegacyShipmentNumber } from './legacyShipmentNumber'

describe('parseLegacyShipmentNumber', () => {
  it('recognises exactly the three shapes the original backfill wrote', () => {
    expect(parseLegacyShipmentNumber('L14727')).toEqual({ kind: 'L_DIGITS', digits: '14727' })
    expect(parseLegacyShipmentNumber('L14334  ')).toEqual({ kind: 'L_DIGITS_PADDED', digits: '14334' })
    expect(parseLegacyShipmentNumber('LPro# 14045')).toEqual({ kind: 'LPRO_LABEL', digits: '14045' })
  })

  it('leaves every other number alone', () => {
    for (const n of ['14727', 'S000123', 'S000123-1', 'LZZR1', 'LL14727', 'L', 'L14a27', ' L14727', '', null, undefined]) {
      expect(parseLegacyShipmentNumber(n)).toBeNull()
    }
  })
})

describe('backfillShipmentNumber', () => {
  it('is the bare trimmed PRO for padded and labelled Aljex ids', () => {
    expect(backfillShipmentNumber('14727', 'lod-1', false)).toBe('14727')
    expect(backfillShipmentNumber('14334  ', 'lod-1', false)).toBe('14334')
    expect(backfillShipmentNumber('Pro# 14045', 'lod-1', false)).toBe('14045')
  })

  it('falls back to L<pro> on a collision, and for a PRO that is not all digits', () => {
    expect(backfillShipmentNumber('14727  ', 'lod-1', true)).toBe('L14727')
    expect(backfillShipmentNumber('AB-123', 'lod-1', false)).toBe('LAB123')
    expect(backfillShipmentNumber(null, 'lod-1', false)).toBe('Llod-1')
  })

  it('keeps leading zeros: 01234 and 1234 are different PROs', () => {
    expect(digitsOnlyPro('01234')).toBe('01234')
    expect(backfillShipmentNumber('01234', 'lod-1', false)).toBe('01234')
  })
})
