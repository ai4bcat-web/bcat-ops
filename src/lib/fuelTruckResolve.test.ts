import { describe, it, expect } from 'vitest'
import { cardToTruckMap, resolveFuelTruckId, withResolvedTruckIds } from './fuelTruckResolve'

const equipment = [
  { id: 'eq-3890', fuelCardNumbers: ['00114'] },
  { id: 'eq-89510', fuelCardNumbers: ['00080', '00081'] },
  { id: 'eq-trailer', fuelCardNumbers: null },
]

describe('fuelTruckResolve', () => {
  it('builds a card → truck map from Equipment.fuelCardNumbers', () => {
    const m = cardToTruckMap(equipment)
    expect(m.get('00114')).toBe('eq-3890')
    expect(m.get('00081')).toBe('eq-89510')
    expect(m.size).toBe(3)
  })

  it('keeps an existing truckId and falls back to the card for rows without one', () => {
    const cards = cardToTruckMap(equipment)
    expect(resolveFuelTruckId({ truckId: 'eq-530', cardNumber: '00114' }, cards)).toBe('eq-530')
    expect(resolveFuelTruckId({ truckId: null, cardNumber: '00114' }, cards)).toBe('eq-3890')
    expect(resolveFuelTruckId({ truckId: null, cardNumber: '99999' }, cards)).toBeNull()
    expect(resolveFuelTruckId({}, cards)).toBeNull()
  })

  it('withResolvedTruckIds fills only the rows that need it', () => {
    const txs = [
      { id: 'a', truckId: null, cardNumber: '00080', amount: 100 },
      { id: 'b', truckId: 'eq-530', cardNumber: '00007', amount: 50 },
      { id: 'c', truckId: null, cardNumber: '12345', amount: 25 },
    ]
    const out = withResolvedTruckIds(txs, equipment)
    expect(out.map((t) => t.truckId)).toEqual(['eq-89510', 'eq-530', null])
    expect(out[1]).toBe(txs[1])
  })
})
