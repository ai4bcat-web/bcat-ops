import { describe, expect, it } from 'vitest'
import { buildStops, type RawStop, type StopInputs } from './stops'

const blankStop: RawStop = { name: '', street: '', city: '', state: '', zip: '', phone: '', contact: '', ref: '' }
const place = (name: string, city: string, state = 'IL'): RawStop => ({ ...blankStop, name, city, state, street: '1 Main' })
const input = (p: Partial<StopInputs>): StopInputs => ({
  pickup: place('Origin', 'Joliet'),
  consignee: place('Dest', 'Dallas', 'TX'),
  blocks: [],
  shipDate: '2025-05-01',
  deliveryApptDate: '2025-05-03',
  deliveryApptTime: '09:00',
  mustDeliverDate: '2025-05-04',
  markerMap: { P: 'pickup', S: 'delivery' },
  ...p,
})
const block = (ordinal: number, marker: string, s: RawStop) => ({ ...s, ordinal, marker })

describe('buildStops', () => {
  it('pickup first, consignee last, blocks between, appointment data on the right stops', () => {
    const { stops } = buildStops(input({ blocks: [block(1, 'S', place('Stop A', 'Gary', 'IN')), block(2, 'P', place('Stop B', 'Omaha', 'NE'))] }))
    expect(stops.map((s) => [s.source, s.type])).toEqual([['PICKUP', 'pickup'], ['PS1', 'delivery'], ['PS2', 'pickup'], ['CONSIGNEE', 'delivery']])
    expect(stops[0].apptDate).toBe('2025-05-01')
    expect(stops[3]).toMatchObject({ apptDate: '2025-05-03', apptTime: '09:00', apptEndDate: '2025-05-04' })
    expect(stops[1].apptDate).toBeNull()
  })
  it('drops a block that restates the scalar pickup or consignee (name + city + state, case/punctuation-insensitive)', () => {
    const { stops } = buildStops(input({ blocks: [block(1, 'P', place('ORIGIN', 'joliet')), block(2, 'S', place('Dest.', 'Dallas', 'TX'))] }))
    expect(stops.map((s) => s.source)).toEqual(['PICKUP', 'CONSIGNEE'])
  })
  it('with no scalar pickup the first block becomes the pickup, whatever its marker', () => {
    const { stops, warnings } = buildStops(input({ pickup: blankStop, blocks: [block(1, 'S', place('Stop A', 'Gary', 'IN'))] }))
    expect(stops.map((s) => [s.source, s.type])).toEqual([['PS1', 'pickup'], ['CONSIGNEE', 'delivery']])
    expect(warnings.map((w) => w.code)).toEqual(['PICKUP_FROM_STOP_BLOCK'])
  })
  it('warns when nothing can be a delivery, and puts the appointment on the last block delivery when there is no consignee', () => {
    expect(buildStops(input({ consignee: blankStop })).warnings.map((w) => w.code)).toEqual(['NO_DELIVERY_STOP'])
    const { stops } = buildStops(input({ consignee: blankStop, blocks: [block(1, 'S', place('Stop A', 'Gary', 'IN'))] }))
    expect(stops[stops.length - 1]).toMatchObject({ source: 'PS1', apptDate: '2025-05-03' })
  })
  it('ignores empty blocks and maps an unknown marker to a delivery', () => {
    const { stops } = buildStops(input({ blocks: [block(1, 'S', blankStop), block(2, 'Q', place('Stop B', 'Omaha', 'NE'))] }))
    expect(stops.map((s) => s.source)).toEqual(['PICKUP', 'PS2', 'CONSIGNEE'])
    expect(stops[1].type).toBe('delivery')
  })
  it('no appt end when Must Deliver equals the appointment day', () => {
    const { stops } = buildStops(input({ mustDeliverDate: '2025-05-03' }))
    expect(stops[1].apptEndDate).toBeNull()
  })
})
