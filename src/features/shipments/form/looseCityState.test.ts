import { describe, expect, it, vi } from 'vitest'
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
import { filledValues, storedBundle } from './testFixtures'
import { valuesFromBundle } from './model'

/** Ryne 2026-11-16: a stop whose city text reads "COCHRANE. WI" showed no state in the editor. */
describe('a stop whose city text carries its state in a loose separator', () => {
  const b = storedBundle(filledValues(), { status: 'OPEN' })
  const withStops = (stops: unknown[]) => ({ ...b, loads: [{ ...b.loads[0], stops }] }) as never

  it('shows the city and the state the way every other page reads them', () => {
    const v = valuesFromBundle(withStops([
      { id: 'pu', type: 'pickup', sequence: 0, name: 'LA CROSSE MILLING CO', city: 'COCHRANE. WI', address: { street: '1 Mill Rd', city: '', state: '', zip: '' } },
      { id: 'de', type: 'delivery', sequence: 1, name: 'PETDINE LLC', city: 'HARVARD IL', address: { street: '', city: '', state: '', zip: '' } },
    ]), {})
    expect(v.stops[0]).toMatchObject({ city: 'COCHRANE', state: 'WI', address1: '1 Mill Rd' })
    expect(v.stops[1]).toMatchObject({ city: 'HARVARD', state: 'IL' })
  })

  it('keeps a state that is already in the address, and a plain city with none', () => {
    const v = valuesFromBundle(withStops([
      { id: 'pu', type: 'pickup', sequence: 0, city: 'COCHRANE, WI', address: { city: 'COCHRANE', state: 'MN', zip: '54622' } },
      { id: 'de', type: 'delivery', sequence: 1, city: 'DALLAS', address: {} },
    ]), {})
    expect(v.stops[0]).toMatchObject({ city: 'COCHRANE', state: 'MN', zip: '54622' })
    expect(v.stops[1]).toMatchObject({ city: 'DALLAS', state: '' })
  })
})
