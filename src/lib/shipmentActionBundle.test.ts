import { describe, expect, it } from 'vitest'
import { withParsedStops } from './apiClient'
import { stopsList } from './stopPlace'

const stop = { id: 's1', type: 'pickup', sequence: 0 }

describe('a shipment action result carries stops as a list (Ryne: Save on a load showed "(t.stops ?? []).some is not a function")', () => {
  it('parses a stops string on every load of a bundle', () => {
    const out = withParsedStops({ shipment: { id: 'shp' }, loads: [{ id: 'l1', stops: JSON.stringify([stop]) }] }) as { loads: { stops: unknown }[] }
    expect(out.loads[0].stops).toEqual([stop])
  })
  it('parses a double-encoded string', () => {
    const out = withParsedStops({ loads: [{ id: 'l1', stops: JSON.stringify(JSON.stringify([stop])) }] }) as { loads: { stops: unknown }[] }
    expect(out.loads[0].stops).toEqual([stop])
  })
  it('reads a bundle wrapped as { bundle, totals }', () => {
    const out = withParsedStops({ bundle: { loads: [{ id: 'l1', stops: JSON.stringify([stop]) }] }, totals: {} }) as { bundle: { loads: { stops: unknown }[] } }
    expect(out.bundle.loads[0].stops).toEqual([stop])
  })
  it('turns a keyed object of stops into a list, and anything else into an empty list', () => {
    const out = withParsedStops({ loads: [{ id: 'a', stops: { 0: stop } }, { id: 'b', stops: {} }, { id: 'c', stops: 5 }] }) as { loads: { stops: unknown }[] }
    expect(out.loads.map((l) => l.stops)).toEqual([[stop], [], []])
  })
  it('leaves a normal array, a missing stops and a non-bundle result alone', () => {
    const arr = [stop]
    const out = withParsedStops({ loads: [{ id: 'a', stops: arr }, { id: 'b' }] }) as { loads: { stops?: unknown }[] }
    expect(out.loads[0].stops).toBe(arr)
    expect('stops' in out.loads[1]).toBe(false)
    expect(withParsedStops('ok')).toBe('ok')
    expect(withParsedStops(null)).toBeNull()
    expect(withParsedStops({ created: true })).toEqual({ created: true })
  })
})

describe('stopsList', () => {
  it('reads a keyed object of stops', () => {
    expect(stopsList({ 0: stop, 1: { ...stop, id: 's2' } })).toHaveLength(2)
  })
})
