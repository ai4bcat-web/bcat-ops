import { describe, expect, it, vi } from 'vitest'
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
import { filledValues, storedBundle } from './testFixtures'
import { valuesFromBundle } from './model'
import { diffStopOps } from './pipelines'

describe('a legacy load (no stops array)', () => {
  const b = storedBundle(filledValues(), { status: 'OPEN' })
  const legacy = {
    ...b,
    loads: [{ ...b.loads[0], id: 'ld-9', stops: undefined, originName: 'THE ROYAL GROUP', originCity: 'CICERO, IL', pickupAppt: '2026-03-02T13:00:00.000Z', destinationCity: 'JOLIET, IL', deliveryAppt: '2026-03-04T13:00:00.000Z' }],
  } as never

  it('is read with the same stable pickup and delivery ids every time (PRO 10793: random ids made Save try to remove stops that never existed)', () => {
    const a = valuesFromBundle(legacy, {})
    const again = valuesFromBundle(legacy, {})
    expect(a.stops.map((s) => s.id)).toEqual(['ld-9:pu', 'ld-9:de'])
    expect(again.stops.map((s) => s.id)).toEqual(a.stops.map((s) => s.id))
    expect(a.stops[0].name).toBe('THE ROYAL GROUP')
  })

  it('an untouched form produces no stop operations, and a changed city produces one edit of the existing stop, never a REMOVE', () => {
    const before = valuesFromBundle(legacy, {})
    expect(diffStopOps(before, valuesFromBundle(legacy, {}))).toEqual([])
    const after = valuesFromBundle(legacy, {})
    after.stops[0].city = 'SPRINGDALE'
    const ops = diffStopOps(before, after)
    expect(ops.some((o) => o.op === 'REMOVE' || o.op === 'ADD')).toBe(false)
    expect(ops.every((o) => 'stopId' in o && o.stopId === 'ld-9:pu')).toBe(true)
  })
})
