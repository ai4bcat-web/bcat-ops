import { describe, expect, it } from 'vitest'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { cityState, readyFactsOf } from './readyFacts'

const board = (over: Partial<ShipmentListRow>) => ({
  id: 's1', originCity: 'Dallas, TX', destinationCity: 'Joliet', fromState: 'TX', toState: 'il',
  carrierName: 'Ace Freight', carriers: [], costCents: 150_000, revenueCents: 175_000,
  customerReference: 'FR-113188-3', reference: 'REF-1', ...over,
}) as unknown as ShipmentListRow

describe('Ready to invoice facts', () => {
  it('reads reference, lane as City, ST, carrier, both rates and profit', () => {
    expect(readyFactsOf(board({}), null, 0)).toEqual({
      customerRef: 'FR-113188-3', origin: 'Dallas, TX', destination: 'Joliet, IL', carrier: 'Ace Freight',
      customerRateCents: 175_000, carrierRateCents: 150_000, profitCents: 25_000,
    })
  })

  it('a loss is negative profit; unknown carrier pay is no profit at all', () => {
    expect(readyFactsOf(board({ costCents: 200_000 }), null, 0).profitCents).toBe(-25_000)
    expect(readyFactsOf(board({ costCents: null }), null, 0).profitCents).toBeNull()
    // Before the board row arrives: the invoice amount, no carrier side.
    expect(readyFactsOf(undefined, null, 99_00)).toMatchObject({ customerRateCents: 99_00, carrierRateCents: null, profitCents: null, carrier: null })
  })

  it('lists every carrier on a multi-carrier shipment', () => {
    expect(readyFactsOf(board({ carriers: [{ name: 'A' }, { name: 'B' }] as ShipmentListRow['carriers'] }), null, 0).carrier).toBe('A, B')
  })

  it('cityState keeps a state already on the city and upper-cases it', () => {
    expect(cityState('Mesquite, tx', 'OK')).toBe('Mesquite, TX')
    expect(cityState('Tulsa', 'ok')).toBe('Tulsa, OK')
    expect(cityState('Tulsa', null)).toBe('Tulsa')
    expect(cityState('  ', 'TX')).toBeNull()
  })
})
