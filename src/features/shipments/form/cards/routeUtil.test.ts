import { describe, expect, it } from 'vitest'
import { emptyStop, type FormStop } from '../model'
import { canInsert, laneLabel, moveStop, removeStop, stopPrefix, transitEstimate, validOrder } from './routeUtil'

const P = (name = ''): FormStop => ({ ...emptyStop('pickup'), id: `p-${name}`, name })
const D = (name = ''): FormStop => ({ ...emptyStop('delivery'), id: `d-${name}`, name })

describe('routeUtil', () => {
  it('estimates transit at 500 miles a day, minimum one day', () => {
    expect(transitEstimate('912')).toBe('2 days')
    expect(transitEstimate(500)).toBe('1 day')
    expect(transitEstimate('501')).toBe('2 days')
    expect(transitEstimate('0')).toBeNull()
    expect(transitEstimate('')).toBeNull()
  })

  it('labels the lane from the first and last stop', () => {
    const a = { ...P(), city: 'Chicago', state: 'il' }
    const b = { ...D(), city: 'Dallas', state: 'TX' }
    expect(laneLabel([a, b])).toBe('Chicago, IL → Dallas, TX')
    expect(laneLabel([P(), D()])).toBe('')
    expect(laneLabel([a, D()])).toBe('Chicago, IL → …')
  })

  it('keeps pickup first and delivery last', () => {
    const route = [P('1'), D('a'), P('2'), D('b')]
    expect(validOrder(route)).toBe(true)
    expect(canInsert(route, 0, 'delivery')).toBe(false)
    expect(canInsert(route, 4, 'pickup')).toBe(false)
    expect(canInsert(route, 4, 'delivery')).toBe(true)
    expect(canInsert(route, 0, 'pickup')).toBe(true)
    // a move that would put a delivery first is refused
    expect(moveStop(route, 1, 0).map((s) => s.id)).toEqual(route.map((s) => s.id))
    expect(moveStop(route, 1, 2).map((s) => s.id)).toEqual(['p-1', 'p-2', 'd-a', 'd-b'])
  })

  it('refuses a removal that leaves no pickup or no delivery', () => {
    const route = [P('1'), D('a'), D('b')]
    expect(removeStop(route, 1).map((s) => s.id)).toEqual(['p-1', 'd-b'])
    expect(removeStop(route, 0).map((s) => s.id)).toEqual(route.map((s) => s.id))
    expect(removeStop([P('1'), D('a')], 1)).toHaveLength(2)
  })

  it('names test-id prefixes like the AH sections', () => {
    expect([0, 1, 2, 3].map((i) => stopPrefix(i, 4))).toEqual(['pickup', 'stop-1', 'stop-2', 'consignee'])
  })
})
