import { describe, expect, it } from 'vitest'
import { carryStopState } from './stopCarry'
import { stopAddressFromLocation, stopPlace } from '../../../src/lib/stopPlace'
import { placeOf } from '../../../src/lib/factorHandoff'

// The Raven Cargo load from Build (Ryne 2026-11-16): what the form captured has to survive every later save.
const built = {
  id: 'stp-pu', type: 'pickup', sequence: 0, locationId: 'loc-fabtech', name: 'FabTech', city: 'LIBERTYVILLE, IL',
  appt: '2026-11-16T14:00:00.000Z',
  address: { street: '1925 Enterprise Ct', city: 'LIBERTYVILLE', state: 'IL', zip: '60048', country: 'US' },
}

describe('a stop address entered on Build', () => {
  it('reads back the same ZIP and street from the shared accessors', () => {
    expect(stopPlace(built)).toMatchObject({ street: '1925 Enterprise Ct', city: 'LIBERTYVILLE', state: 'IL', zip: '60048' })
    expect(placeOf(built as never)).toEqual({ city: 'LIBERTYVILLE', state: 'IL', zip: '60048' })
  })

  it('survives an order-form save that sends no address for the same place', () => {
    const next = [{ ...built, address: null }]
    expect(carryStopState(next as never, [built] as never)[0].address).toEqual(built.address)
  })

  it('keeps a field the save left out, and lets an explicit clear through', () => {
    const thin = [{ ...built, address: { street: '1925 Enterprise Ct', city: 'LIBERTYVILLE', state: 'IL' } }]
    expect((carryStopState(thin as never, [built] as never)[0].address as { zip?: string }).zip).toBe('60048')
    const cleared = [{ ...built, address: { ...built.address, zip: null } }]
    expect((carryStopState(cleared as never, [built] as never)[0].address as { zip?: string | null }).zip).toBeNull()
  })

  it('takes the new place as sent when the stop moves to a different place', () => {
    const moved = [{ ...built, locationId: 'loc-other', address: { city: 'ELGIN', state: 'IL', zip: '60120' } }]
    expect(carryStopState(moved as never, [built] as never)[0].address).toEqual({ city: 'ELGIN', state: 'IL', zip: '60120' })
  })
})

describe('stopAddressFromLocation', () => {
  it('copies the saved place onto the stop', () => {
    expect(stopAddressFromLocation({ name: 'FabTech', street: '1925 Enterprise Ct', city: 'LIBERTYVILLE', state: 'il', zip: '60048' }))
      .toEqual({ street: '1925 Enterprise Ct', city: 'LIBERTYVILLE', state: 'IL', zip: '60048', country: 'US' })
  })
  it('is null for a place with no address', () => {
    expect(stopAddressFromLocation({ name: 'Somewhere' })).toBeNull()
    expect(stopAddressFromLocation(null)).toBeNull()
  })
})
