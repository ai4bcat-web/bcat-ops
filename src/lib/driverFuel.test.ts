import { describe, it, expect } from 'vitest'
import { matchedFuelForCard, sumFuel, isFuelTx } from './driverFuel'
import type { FuelTransaction } from '@/lib/apiClient'

function tx(p: Partial<FuelTransaction>): FuelTransaction {
  return {
    id: Math.random().toString(36).slice(2),
    transactionDate: '2026-06-10', cardNumber: '00049', invoiceNumber: 'INV1',
    fuelType: 'ULSD', itemCategory: 'FUEL', pricePerUnit: 3.5, quantity: 10, amount: 100,
    ...p,
  } as FuelTransaction
}

describe('matchedFuelForCard', () => {
  it('matches the card despite leading-zero formatting', () => {
    const txs = [tx({ amount: 200 })]
    expect(sumFuel(matchedFuelForCard(txs, '49', '2026-06-07', '2026-06-13'))).toBe(200)
    expect(sumFuel(matchedFuelForCard(txs, '0049', '2026-06-07', '2026-06-13'))).toBe(200)
  })

  it('excludes non-fuel lines even when the category is missing', () => {
    const txs = [
      tx({ invoiceNumber: 'A', itemCategory: 'FUEL', fuelType: 'ULSD', amount: 100 }),
      tx({ invoiceNumber: 'B', itemCategory: 'SCALE', fuelType: 'SCLE', amount: 10 }),     // scale fee
      tx({ invoiceNumber: 'C', itemCategory: undefined, fuelType: 'CDSL', amount: 185.6 }), // discount diesel, no category
      tx({ invoiceNumber: 'D', itemCategory: undefined, fuelType: 'CASH', amount: 50 }),    // cash advance, no category
      tx({ invoiceNumber: 'E', itemCategory: undefined, fuelType: 'ULSD', amount: 80 }),    // real fuel, no category
    ]
    // 100 (FUEL) + 80 (ULSD, no category) = 180. CDSL/SCLE/CASH excluded.
    expect(sumFuel(matchedFuelForCard(txs, '49', '2026-06-07', '2026-06-13'))).toBe(180)
  })

  it('de-duplicates a transaction that landed twice', () => {
    const dup = { transactionDate: '2026-06-10', cardNumber: '00049', invoiceNumber: 'INV9', fuelType: 'ULSD', amount: 185.6 }
    const txs = [tx({ ...dup, id: '1' }), tx({ ...dup, id: '2' }), tx({ invoiceNumber: 'INV10', amount: 100 })]
    expect(sumFuel(matchedFuelForCard(txs, '49', '2026-06-07', '2026-06-13'))).toBe(285.6)
  })

  it('respects the date window', () => {
    const txs = [
      tx({ invoiceNumber: 'A', transactionDate: '2026-06-06', amount: 999 }), // before
      tx({ invoiceNumber: 'B', transactionDate: '2026-06-07', amount: 100 }), // first day
      tx({ invoiceNumber: 'C', transactionDate: '2026-06-13', amount: 100 }), // last day
      tx({ invoiceNumber: 'D', transactionDate: '2026-06-14', amount: 999 }), // after
    ]
    expect(sumFuel(matchedFuelForCard(txs, '49', '2026-06-07', '2026-06-13'))).toBe(200)
  })

  it('isFuelTx trusts an explicit category over fuelType', () => {
    expect(isFuelTx({ itemCategory: 'OTHER', fuelType: 'ULSD' })).toBe(false)
    expect(isFuelTx({ itemCategory: 'FUEL', fuelType: 'SCLE' })).toBe(true)
    expect(isFuelTx({ itemCategory: undefined, fuelType: 'DEFD' })).toBe(true)
  })
})
