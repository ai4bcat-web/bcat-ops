import { describe, it, expect } from 'vitest'
import { validateOrderDraft, type OrderDraft } from './orderDraft'
import type { RequiredReference } from '@/types/tms'
import type { Stop } from '@/types'

function stop(patch: Partial<Stop> & Pick<Stop, 'id' | 'type' | 'sequence'>): Stop {
  return { appt: '2026-04-01T12:00:00.000Z', driverId: null, ...patch }
}

const pickup = stop({ id: 'p1', type: 'pickup', sequence: 0, appt: '2026-04-01T08:00:00.000Z' })
const delivery = stop({ id: 'd1', type: 'delivery', sequence: 1, appt: '2026-04-02T08:00:00.000Z' })

function draft(patch: Partial<OrderDraft> = {}): OrderDraft {
  return { mode: 'FTL', equipmentType: "53' Dry Van", references: [], freight: [], ...patch }
}

describe('validateOrderDraft', () => {
  it('accepts a truckload draft with a pickup, a delivery and equipment', () => {
    expect(validateOrderDraft(draft(), [pickup, delivery], [])).toEqual([])
  })

  it('requires both a pickup and a delivery', () => {
    expect(validateOrderDraft(draft(), [pickup], []).map((i) => i.message))
      .toContain('Add at least one delivery stop.')
    expect(validateOrderDraft(draft(), [delivery], []).map((i) => i.message))
      .toContain('Add at least one pick-up stop.')
  })

  it('refuses a route that runs backwards in time', () => {
    const backwards = [pickup, stop({ id: 'd1', type: 'delivery', sequence: 1, appt: '2026-03-30T08:00:00.000Z' })]
    expect(validateOrderDraft(draft(), backwards, []).map((i) => i.message))
      .toContain('Stop 2 is scheduled before stop 1.')
  })

  it('requires equipment for the truckload family but not for LTL', () => {
    const issues = validateOrderDraft(draft({ equipmentType: '' }), [pickup, delivery], [])
    expect(issues.map((i) => i.message)).toContain('Truckload orders need an equipment type.')
    expect(validateOrderDraft(draft({ mode: 'LTL', equipmentType: '' }), [pickup, delivery], [])).toEqual([])
  })

  it('refuses freight dimensions in two different units', () => {
    const mixed = draft({
      freight: [
        { id: 'f1', handlingUnit: 'PALLET', qty: 2, dims: { l: 48, w: 40, h: 50, unit: 'IN' } },
        { id: 'f2', handlingUnit: 'CRATE', qty: 1, dims: { l: 100, w: 80, h: 90, unit: 'CM' } },
      ],
    })
    expect(validateOrderDraft(mixed, [pickup, delivery], []).map((i) => i.message))
      .toContain('All freight dimensions must use the same unit.')
  })

  it('requires the full hazmat set once a line is hazmat', () => {
    const hazmat = draft({
      freight: [{
        id: 'f1', handlingUnit: 'DRUM', qty: 4,
        hazmat: { un: 'UN1203', hazClass: '3', emergencyContact: '' },
      }],
    })
    expect(validateOrderDraft(hazmat, [pickup, delivery], []).map((i) => i.message))
      .toContain('Hazmat freight needs a UN number, hazard class and emergency contact.')
  })

  it('counts supplied reference values against countOnNewOrder', () => {
    const required: RequiredReference[] = [{ code: 'PO', label: 'PO number', level: 'ORDER', display: true, countOnNewOrder: 2 }]
    const one = draft({ references: [{ code: 'PO', value: '4471', level: 'ORDER', visibility: 'ALL' }] })
    expect(validateOrderDraft(one, [pickup, delivery], required).map((i) => i.message))
      .toContain('PO number: 2 values required, 1 entered.')

    const two = draft({
      references: [
        { code: 'PO', value: '4471', level: 'ORDER', visibility: 'ALL' },
        { code: 'PO', value: '4472', level: 'ORDER', visibility: 'ALL' },
      ],
    })
    expect(validateOrderDraft(two, [pickup, delivery], required)).toEqual([])
  })

  it('ignores a reference that is not required on a new order', () => {
    const required: RequiredReference[] = [{ code: 'BOL', level: 'ORDER', display: true, countOnNewOrder: 0 }]
    expect(validateOrderDraft(draft(), [pickup, delivery], required)).toEqual([])
  })
})
