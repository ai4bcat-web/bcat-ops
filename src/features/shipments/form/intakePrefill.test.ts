import { describe, expect, it } from 'vitest'
import { emptyIntakeFields } from '@/lib/intakeLoad'
import type { IntakeFields } from '@/types/intake'
import { intakePrefill } from './intakePrefill'

const fields = (over: Partial<IntakeFields> = {}): IntakeFields => ({
  ...emptyIntakeFields(),
  customerName: 'Acme Paper', reference: 'PO-77', pickupNumber: 'PU-9', deliveryNumber: 'DL-3',
  equipmentType: 'Dry Van', commodity: 'Paper', weightLb: 20000.4, customerRateCents: 150050,
  stops: [
    { type: 'delivery', name: 'DC', street: '2 Dock', city: 'Dallas', state: 'tx', zip: '75201', date: '2026-11-11', time: null, instructions: 'Call ahead' },
    { type: 'pickup', name: 'Mill', street: '1 Mill Rd', city: 'Chicago', state: 'IL', zip: '60601', date: '2026-11-10', time: '08:30', instructions: null },
  ],
  ...over,
})

describe('intakePrefill', () => {
  it('maps the extraction onto the form and marks exactly the fields it filled', () => {
    const { values, fromEmail } = intakePrefill({ fields: fields() }, null)
    expect(values.customer).toMatchObject({ typedName: 'Acme Paper', useTyped: true, refNo: 'PO-77' })
    expect(values.ship).toMatchObject({ equipmentType: 'Dry Van', description: 'Paper', weightLbs: '20000' })
    expect(values.rates.customer).toMatchObject({ rateType: 'FLAT', lhRate: '1500.50' })
    // pickups first, whatever order the e-mail listed them in
    expect(values.stops.map((s) => [s.type, s.name])).toEqual([['pickup', 'Mill'], ['delivery', 'DC']])
    expect(values.stops[0]).toMatchObject({ refNo: 'PU-9', ready: '2026-11-10T08:30', appt: '2026-11-10T08:30' })
    expect(values.stops[1]).toMatchObject({ state: 'TX', refNo: 'DL-3', note: 'Call ahead', appt: '2026-11-11T00:00', ready: '' })
    expect(fromEmail).toEqual(expect.arrayContaining([
      'f-customer-refNo', 'f-shipping-weightLbs', 'f-rates-customerLhRate', 'f-pickup-name', 'f-pickup-ready', 'f-consignee-city', 'f-consignee-note',
    ]))
    expect(fromEmail).not.toContain('f-customer-name') // typed text, no directory record picked
    expect(fromEmail).not.toContain('f-pickup-contact')
  })

  it('leaves a bare date as Ready only, and never invents values for what was not extracted', () => {
    const f = fields({
      commodity: null, weightLb: null, customerRateCents: null, equipmentType: null,
      stops: [{ type: 'pickup', name: null, street: null, city: 'Joliet', state: 'IL', zip: null, date: '2026-11-10', time: null, instructions: null }],
    })
    const { values, fromEmail } = intakePrefill({ fields: f }, null)
    expect(values.stops[0]).toMatchObject({ ready: '2026-11-10T00:00', appt: '' })
    expect(values.stops).toHaveLength(2) // a Consignee is always there to fill in
    expect(values.stops[1]).toMatchObject({ type: 'delivery', city: '' })
    expect(values.ship.weightLbs).toBe('')
    expect(fromEmail.some((k) => k.startsWith('f-shipping-weight') || k.startsWith('f-rates'))).toBe(false)
  })

  it('numbers inserted stops by their position so their controls can be marked', () => {
    const mk = (type: 'pickup' | 'delivery', city: string) => ({ type, name: null, street: null, city, state: null, zip: null, date: null, time: null, instructions: null })
    const { values, fromEmail } = intakePrefill({ fields: fields({ stops: [mk('pickup', 'A'), mk('pickup', 'B'), mk('delivery', 'C'), mk('delivery', 'D')] }) }, null)
    expect(values.stops.map((s) => s.city)).toEqual(['A', 'B', 'C', 'D'])
    expect(fromEmail).toEqual(expect.arrayContaining(['f-pickup-city', 'f-stop-1-city', 'f-stop-2-city', 'f-consignee-city']))
  })
})
