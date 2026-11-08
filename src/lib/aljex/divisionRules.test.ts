import { describe, it, expect } from 'vitest'
import { pickDivision } from './classify'
import { DEFAULT_ALJEX_PROFILE } from './profile'
import type { CanonicalRow } from './canonical'

const row = (revenueType: string, over: Record<string, unknown> = {}) =>
  ({ kind: 'LOAD', typeOfShipment: 'TL', carrier: { name: 'Acme Freight', id: 'c1', mc: null }, freight: { revenueType }, ...over }) as unknown as CanonicalRow

describe('pickDivision by Aljex Rev Type', () => {
  it('maps B/I/A/O to the four divisions and falls back to BROKERAGE', () => {
    expect(['B', 'I', 'A', 'O', '', 'Z'].map((t) => pickDivision(row(t), DEFAULT_ALJEX_PROFILE)))
      .toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'OWNER_OPERATOR', 'BROKERAGE', 'BROKERAGE'])
  })
  it('lets the own-asset carrier beat Rev Type B', () => {
    expect(pickDivision(row('B', { carrier: { name: 'IVAN CARTAGE LLC', id: 'x', mc: null } }), DEFAULT_ALJEX_PROFILE)).toBe('ASSETS')
  })
})
