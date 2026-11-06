import { describe, expect, it } from 'vitest'
import { bolParty, bolRecipientOptions } from './bolRecipients'
import type { LocationRecord, ShipmentBundle } from '@/types/tms'

const bundle = (over: {
  stops?: unknown[]
  carriers?: unknown[]
  form?: unknown
}): ShipmentBundle => ({
  loads: [{ id: 'l1', stops: over.stops ?? [] }],
  loadCarriers: over.carriers ?? [],
  orders: [{ specialRequirements: { form: over.form ?? {} } }],
}) as unknown as ShipmentBundle

describe('bolRecipientOptions', () => {
  it('offers stop contacts, dispatcher and driver addresses, in that order, tied to their party', () => {
    const options = bolRecipientOptions(bundle({
      stops: [
        { id: 's1', type: 'pickup', name: 'Acme', documentContact: { email: 'ship@acme.com' } },
        { id: 's2', type: 'delivery', name: 'Kroger', contact: { email: 'dock@kroger.com' } },
      ],
      carriers: [{ id: 'lc1', status: 'ACTIVE', carrierName: 'Swift', dispatcherEmail: 'disp@swift.com', driverName: 'Sam' }],
      form: { carriers: [{ slot: 'a', loadCarrierId: 'lc1', driverEmail1: 'sam@swift.com' }] },
    }), [])
    expect(options.map((o) => [o.email, o.party])).toEqual([
      ['ship@acme.com', 'CUSTOMER'],
      ['dock@kroger.com', 'CUSTOMER'],
      ['disp@swift.com', 'DISPATCHER'],
      ['sam@swift.com', 'DRIVER'],
    ])
    expect(options[0].label).toBe('Shipper contact · Acme')
    expect(options[3].label).toBe('Driver · Sam')
  })

  it('falls back to the saved location, skips malformed and duplicate addresses, ignores removed carriers', () => {
    const locations = [{ id: 'loc1', apptContactEmail: 'Dock@Kroger.com' }] as LocationRecord[]
    const options = bolRecipientOptions(bundle({
      stops: [
        { id: 's1', type: 'delivery', locationId: 'loc1' },
        { id: 's2', type: 'delivery', documentContact: { email: 'dock@kroger.com' } },
        { id: 's3', type: 'delivery', documentContact: { email: 'not an email' } },
      ],
      carriers: [{ id: 'lc2', status: 'BOUNCED', dispatcherEmail: 'gone@x.com' }],
    }), locations)
    expect(options.map((o) => o.email)).toEqual(['Dock@Kroger.com'])
  })

  it('reads the legacy single-carrier driver key', () => {
    const options = bolRecipientOptions(bundle({
      carriers: [{ id: 'lc1', status: 'ACTIVE' }],
      form: { carrier: { loadCarrierId: 'lc1', driverEmail2: 'two@x.com' } },
    }), [])
    expect(options).toEqual([{ email: 'two@x.com', label: 'Driver 2', party: 'DRIVER' }])
  })
})

describe('bolParty', () => {
  const options = [
    { email: 'a@x.com', label: 'd', party: 'DRIVER' as const },
    { email: 'b@x.com', label: 'd', party: 'DISPATCHER' as const },
  ]
  it('uses the shared party, else CARRIER', () => {
    expect(bolParty(['A@x.com'], options)).toBe('DRIVER')
    expect(bolParty(['a@x.com', 'b@x.com'], options)).toBe('CARRIER')
    expect(bolParty(['typed@x.com'], options)).toBe('CARRIER')
  })
})
