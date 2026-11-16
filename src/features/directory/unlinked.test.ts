import { describe, expect, it } from 'vitest'
import type { UnlinkedShipment } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'
import { bestCustomerFor, candidatesFor, confidenceLabel, isLinkCustomerQuestion, linkQuestionShipment, searchUnlinked } from './unlinked'

const ship = (over: Partial<UnlinkedShipment>): UnlinkedShipment => ({
  id: 'shp-1', number: '20007', customerName: 'R&R Transport, Inc.', originCity: 'MADISON, WI', destinationCity: 'CHICAGO, IL',
  pickupAppt: '2026-11-09T14:00:00.000Z', deliveryAppt: null, status: 'DELIVERED', inLoadReview: false, updatedAt: null, ...over,
})
const customer = (over: Partial<CustomerRecord>): CustomerRecord => ({ id: 'cus-1', name: 'R and R Transport', aliases: [], active: true, ...over }) as CustomerRecord

describe('candidatesFor', () => {
  it('finds the loads typed with this customer\'s name, best match first', () => {
    const rows = [ship({ id: 'a', number: '1', customerName: 'Rome Transportation' }), ship({ id: 'b', number: '2' }), ship({ id: 'c', number: '3', customerName: 'R & R Transport' })]
    const out = candidatesFor(customer({}), rows)
    expect(out.map((c) => c.shipment.id)).toEqual(['c', 'b'])
    expect(out[0].score).toBe(1)
  })

  it('matches an alias and still works when the profile is an inactive customer', () => {
    const out = candidatesFor(customer({ name: 'RR Logistics', aliases: ['R&R Transport, Inc.'], active: false }), [ship({})])
    expect(out).toHaveLength(1)
  })

  it('leaves out names that are not close', () => {
    expect(candidatesFor(customer({}), [ship({ customerName: 'Danisco USA Inc.' })])).toEqual([])
  })
})

describe('searchUnlinked', () => {
  const rows = [ship({}), ship({ id: 'b', number: '14000', customerName: 'Coyne Transportation', originCity: 'ERIE, PA' })]
  it('searches PRO, typed name and lane, and returns all rows for a blank query', () => {
    expect(searchUnlinked(rows, '')).toHaveLength(2)
    expect(searchUnlinked(rows, '14000').map((r) => r.id)).toEqual(['b'])
    expect(searchUnlinked(rows, 'coyne').map((r) => r.id)).toEqual(['b'])
    expect(searchUnlinked(rows, 'erie').map((r) => r.id)).toEqual(['b'])
    expect(searchUnlinked(rows, 'nothing')).toEqual([])
  })
})

describe('bestCustomerFor / confidenceLabel', () => {
  it('suggests the closest customer, or none when nothing is close', () => {
    const list = [customer({ id: 'x', name: 'FLS Transportation Services Inc.' }), customer({ id: 'y', name: 'King of Freight 3rd Party' })]
    expect(bestCustomerFor('King of Freight', list)?.customer.id).toBe('y')
    expect(bestCustomerFor('Zzzz Qqqq', list)).toBeNull()
  })

  it('labels scores', () => {
    expect([confidenceLabel(1), confidenceLabel(0.7), confidenceLabel(0.5)]).toEqual(['High', 'Medium', 'Low'])
  })
})

describe('the sweep\'s questions', () => {
  const q = { id: 'oq-link-customer-13894', details: { source: 'Unlinked-customer sweep 2026-11-16', refs: [{ pro: '13894', shipmentId: 'shp-4d34', party: 'SIMPLIFIED LOGISTICS SOLUTIONS' }] } }
  it('is recognised by its id or its source, and names one shipment', () => {
    expect(isLinkCustomerQuestion(q)).toBe(true)
    expect(isLinkCustomerQuestion({ id: 'x', details: { source: 'Unlinked-customer sweep 2026-11-16' } })).toBe(true)
    expect(isLinkCustomerQuestion({ id: 'oq-ap-13780', details: { source: 'AP review' } })).toBe(false)
    expect(linkQuestionShipment(q)).toEqual({ shipmentId: 'shp-4d34', pro: '13894', typedName: 'SIMPLIFIED LOGISTICS SOLUTIONS' })
    expect(linkQuestionShipment({ details: { refs: [{ pro: '1' }] } })).toBeNull()
  })
})
