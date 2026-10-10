import { describe, it, expect } from 'vitest'
import { paperworkLocationLabel, paperworkStatusLine, normalizePaperworkLocation, pickupsNeedingPaperworkLocation, deliveriesNeedingPaperworkConfirm } from './paperworkLocation'

describe('paperwork location', () => {
  it('labels each place', () => {
    expect(paperworkLocationLabel({ kind: 'TRUCK', unit: '3114' })).toBe('Passenger seat of truck 3114')
    expect(paperworkLocationLabel({ kind: 'TRAILER', unit: '5302' })).toBe('In trailer 5302')
    expect(paperworkLocationLabel({ kind: 'SHED' })).toBe('In the shed')
    expect(paperworkLocationLabel(null)).toBe('')
  })
  it('accepts the shed with no number but insists on one for a truck or trailer', () => {
    expect(normalizePaperworkLocation({ kind: 'shed', unit: '99' })).toEqual({ kind: 'SHED', unit: null })
    expect(normalizePaperworkLocation({ kind: 'TRUCK', unit: ' 3114 ' })).toEqual({ kind: 'TRUCK', unit: '3114' })
    expect(normalizePaperworkLocation({ kind: 'TRUCK', unit: '' })).toBeNull()
    expect(normalizePaperworkLocation({ kind: 'cab' })).toBeNull()
  })
  it('lists today’s pickups that have no answer yet', () => {
    const stop = (over: Record<string, unknown>) => ({ type: 'pickup', date: '2026-10-10', yours: true, name: 'Batory', ...over })
    const loads = [
      { id: 'a', reference: '14578', stops: [stop({})] },
      { id: 'b', reference: '14579', stops: [stop({ date: '2026-10-09', arrivedAt: '2026-10-10T14:00:00Z' })] },   // arrived today, dated yesterday
      { id: 'c', reference: '14580', stops: [stop({})], paperworkLocation: { kind: 'SHED', at: 'x' } },           // answered
      { id: 'd', reference: '14581', stops: [stop({ yours: false })] },                                            // someone else's pickup
      { id: 'e', reference: '14582', stops: [stop({ type: 'delivery' })] },                                        // a delivery
      { id: 'f', reference: '14583', stops: [stop({ date: '2026-10-11' })] },                                      // tomorrow
    ]
    expect(pickupsNeedingPaperworkLocation(loads, '2026-10-10').map((x) => x.load.id)).toEqual(['a', 'b'])
  })
})

describe('start of day', () => {
  const stop = (over: Record<string, unknown>) => ({ type: 'delivery', date: '2026-10-10', yours: true, name: 'Jewel DC', ...over })
  const pickupYesterday = { type: 'pickup', date: '2026-10-09', yours: true, name: 'Batory', departedAt: '2026-10-09T18:00:00Z' }
  it('asks about today’s deliveries whose pickup happened earlier, once per day', () => {
    const loads = [
      { id: 'a', reference: '1', stops: [pickupYesterday, stop({})], paperworkLocation: { kind: 'TRUCK' as const, unit: '3114', at: 'x' } },
      { id: 'b', reference: '2', stops: [{ ...pickupYesterday, date: '2026-10-10', departedAt: '2026-10-10T13:00:00Z' }, stop({})] },   // picked up today: end-of-day question instead
      { id: 'c', reference: '3', stops: [pickupYesterday, stop({})], paperworkLocation: { kind: 'SHED' as const, at: 'x', inHandAt: '2026-10-10T11:00:00Z' } },   // already confirmed today
      { id: 'd', reference: '4', stops: [pickupYesterday, stop({ arrivedAt: '2026-10-10T12:00:00Z' })] },   // already at the dock
      { id: 'e', reference: '5', stops: [pickupYesterday, stop({})] },   // never recorded: still ask
    ]
    const r = deliveriesNeedingPaperworkConfirm(loads, '2026-10-10')
    expect(r.map((x) => [x.load.id, x.where])).toEqual([['a', 'Passenger seat of truck 3114'], ['e', null]])
  })
  it('describes the paperwork state for a card', () => {
    expect(paperworkStatusLine({ kind: 'SHED', at: 'x' })).toBe('In the shed')
    expect(paperworkStatusLine({ kind: 'SHED', at: 'x', inHandAt: 'y', inHandBy: 'Jason' })).toBe('Jason has it (was: in the shed)')
    expect(paperworkStatusLine({ kind: 'UNKNOWN', at: 'x', missingAt: 'y', missingBy: 'Jason' })).toBe('Jason could not find it')
    expect(paperworkStatusLine(null)).toBeNull()
  })
})
