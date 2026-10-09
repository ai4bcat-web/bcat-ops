import { describe, it, expect } from 'vitest'
import { matchStopLocation, locationInputForStop, splitCityState } from './locationAutoSave'
import type { LocationRecord } from '../types/tms'

const loc = (over: Partial<LocationRecord>): LocationRecord =>
  ({ id: 'L', name: 'X', active: true, createdAt: '', updatedAt: '', ...over } as LocationRecord)

const batory = loc({ id: 'batory', name: "BATORY'S OAKLEY CHICAGO", city: 'Chicago', state: 'IL', street: '2234 W 43rd St', zip: '60609', aliases: ['Batory Oakley'] })
const heights = loc({ id: 'heights', name: "BATORY'S OAKLEY CHICAGO", city: 'Chicago Heights', state: 'IL' })

describe('matchStopLocation', () => {
  it('links the same name in the same city, by name or alias, whatever the casing', () => {
    expect(matchStopLocation({ type: 'pickup', name: "batory's oakley chicago", city: 'Chicago, IL' }, [heights, batory])?.id).toBe('batory')
    expect(matchStopLocation({ type: 'pickup', name: 'Batory Oakley', city: 'CHICAGO, IL' }, [batory])?.id).toBe('batory')
  })

  it('does not link the same name in a different city', () => {
    expect(matchStopLocation({ type: 'pickup', name: "Batory's Oakley Chicago", city: 'Pleasant Prairie, WI' }, [batory])).toBeNull()
  })

  it('links by street address when the name differs — the same strict address rule the directory dedups on', () => {
    const stop = { type: 'pickup' as const, name: 'Batory Foods', address: { street: '2234 W 43rd St', city: 'Chicago', state: 'IL', zip: '60609' } }
    expect(matchStopLocation(stop, [batory])?.id).toBe('batory')
    // A differently spelled street is a different address to the directory, so no link.
    const spelled = { ...stop, address: { ...stop.address, street: '2234 W. 43rd Street' } }
    expect(matchStopLocation(spelled, [batory])).toBeNull()
  })

  it('never links a similar-but-different name', () => {
    expect(matchStopLocation({ type: 'delivery', name: "Batory's Oakley", city: 'Chicago, IL' }, [batory])).toBeNull()
  })

  it('skips archived and merged records', () => {
    expect(matchStopLocation({ type: 'pickup', name: "BATORY'S OAKLEY CHICAGO", city: 'Chicago, IL' }, [{ ...batory, active: false }])).toBeNull()
  })
})

describe('locationInputForStop', () => {
  it('files a pickup as a shipper with the parts of its address', () => {
    expect(locationInputForStop({ type: 'pickup', name: 'Eagle Foods', city: 'Waukegan, IL', address: { street: '10700 88th Ave', zip: '60085' } }))
      .toEqual({ name: 'Eagle Foods', street: '10700 88th Ave', city: 'Waukegan', state: 'IL', zip: '60085', facilityType: 'SHIPPER' })
    expect(locationInputForStop({ type: 'delivery', name: 'Olds Products', city: 'Pleasant Prairie, WI' })?.facilityType).toBe('RECEIVER')
  })

  it('files nothing for a stop with no name', () => {
    expect(locationInputForStop({ type: 'pickup', city: 'Chicago, IL' })).toBeNull()
  })

  it('splits a city string the way loads carry it', () => {
    expect(splitCityState('Chicago, IL')).toEqual({ city: 'Chicago', state: 'IL' })
    expect(splitCityState('ELK GROVE VILLAGE IL')).toEqual({ city: 'ELK GROVE VILLAGE', state: 'IL' })
    expect(splitCityState('Waukegan')).toEqual({ city: 'Waukegan', state: null })
  })
})
