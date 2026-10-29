import { describe, it, expect } from 'vitest'
import { laneKeyFor, laneKey3For, laneLabelFor, laneSampleFor, type LaneSampleInput } from './laneKey'
import type { Stop } from '../types'
import { aliasMap } from './integrations/postalAliases'

const stop = (over: Partial<Stop> & Pick<Stop, 'type' | 'sequence'>): Stop => ({
  id: `s${over.sequence}`,
  driverId: null,
  appt: '2026-02-10T15:00:00.000Z',
  ...over,
})

const chicago = stop({ type: 'pickup', sequence: 0, city: 'Chicago, IL' })
const danville = stop({ type: 'delivery', sequence: 1, city: 'Danville, IL', appt: '2026-02-12T18:00:00.000Z' })

describe('laneKeyFor', () => {
  it('builds the key from the first pickup and the last delivery', () => {
    expect(laneKeyFor([chicago, danville])).toBe('CHICAGO|IL>DANVILLE|IL')
  })

  it('normalises case, punctuation and runs of whitespace', () => {
    const key = laneKeyFor([
      stop({ type: 'pickup', sequence: 0, city: 'st. louis,  mo' }),
      stop({ type: 'delivery', sequence: 1, city: "O'Fallon,   il" }),
    ])
    expect(key).toBe('ST LOUIS|MO>O FALLON|IL')
  })

  it('prefers the booked address snapshot over the display string', () => {
    const key = laneKeyFor([
      stop({ type: 'pickup', sequence: 0, city: 'Chicago, IL', address: { city: 'Elk Grove Village', state: 'il' } }),
      danville,
    ])
    expect(key).toBe('ELK GROVE VILLAGE|IL>DANVILLE|IL')
  })

  it('recovers the state from the city string when the snapshot spells it out', () => {
    const key = laneKeyFor([
      stop({ type: 'pickup', sequence: 0, city: 'Chicago, IL', address: { city: 'Chicago', state: 'Illinois' } }),
      danville,
    ])
    expect(key).toBe('CHICAGO|IL>DANVILLE|IL')
  })

  it('refuses a lane whose end has no two-letter state', () => {
    expect(laneKeyFor([stop({ type: 'pickup', sequence: 0, city: 'Chicago' }), danville])).toBeNull()
    expect(laneKeyFor([chicago, stop({ type: 'delivery', sequence: 1, city: 'Danville' })])).toBeNull()
  })

  it('refuses a lane with no city', () => {
    expect(laneKeyFor([stop({ type: 'pickup', sequence: 0, address: { state: 'IL' } }), danville])).toBeNull()
  })

  it('ignores the stops in between', () => {
    const route = [
      chicago,
      stop({ type: 'delivery', sequence: 1, city: 'Joliet, IL' }),
      stop({ type: 'pickup', sequence: 2, city: 'Peoria, IL' }),
      danville,
    ]
    expect(laneKeyFor(route)).toBe('CHICAGO|IL>DANVILLE|IL')
  })

  it('reads the route in sequence order, not array order', () => {
    expect(laneKeyFor([danville, chicago])).toBe('CHICAGO|IL>DANVILLE|IL')
  })

  it('has no lane without two stops', () => {
    expect(laneKeyFor([chicago])).toBeNull()
    expect(laneKeyFor([])).toBeNull()
    expect(laneKeyFor(null)).toBeNull()
  })

  it('spells a stop the way the org’s postal alias does', () => {
    const route = [
      stop({ type: 'pickup', sequence: 0, city: 'Bensenville, IL', address: { zip: '60106-1234' } }),
      danville,
    ]
    expect(laneKeyFor(route)).toBe('BENSENVILLE|IL>DANVILLE|IL')
    expect(laneKeyFor(route, aliasMap([{ zip: '60106', city: 'Chicago', state: 'IL' }]))).toBe(
      'CHICAGO|IL>DANVILLE|IL',
    )
  })

  it('leaves a stop whose ZIP nobody aliased exactly where it was', () => {
    const route = [
      stop({ type: 'pickup', sequence: 0, city: 'Bensenville, IL', address: { zip: '60107' } }),
      danville,
    ]
    expect(laneKeyFor(route, aliasMap([{ zip: '60106', city: 'Chicago', state: 'IL' }]))).toBe(
      'BENSENVILLE|IL>DANVILLE|IL',
    )
  })
})

describe('laneKey3For', () => {
  const zipped = (pickupZip: string, deliveryZip: string): Stop[] => [
    stop({ type: 'pickup', sequence: 0, city: 'Chicago, IL', address: { zip: pickupZip } }),
    stop({ type: 'delivery', sequence: 1, city: 'Danville, IL', address: { zip: deliveryZip } }),
  ]

  it('takes the first three digits of each five-digit ZIP', () => {
    expect(laneKey3For(zipped('60601', '61832'))).toBe('606>618')
  })

  it('accepts ZIP+4', () => {
    expect(laneKey3For(zipped('60601-1234', '618324321'))).toBe('606>618')
  })

  it('refuses a missing or malformed ZIP', () => {
    expect(laneKey3For(zipped('6060', '61832'))).toBeNull()
    expect(laneKey3For(zipped('60601', 'K1A 0B1'))).toBeNull()
    expect(laneKey3For([chicago, danville])).toBeNull()
  })
})

describe('laneLabelFor', () => {
  it('reads the key back as a place', () => {
    expect(laneLabelFor('CHICAGO|IL>DANVILLE|IL')).toBe('Chicago, IL → Danville, IL')
    expect(laneLabelFor('ST LOUIS|MO>ELK GROVE VILLAGE|IL')).toBe('St Louis, MO → Elk Grove Village, IL')
  })

  it('says nothing about a lane that is not there', () => {
    expect(laneLabelFor(null)).toBe('')
    expect(laneLabelFor('CHICAGO|IL')).toBe('')
    expect(laneLabelFor('CHICAGO>DANVILLE')).toBe('')
  })
})

describe('laneSampleFor', () => {
  const base = (): LaneSampleInput => ({
    load: {
      id: 'load-1',
      shipmentId: 'ship-1',
      orderId: 'order-1',
      status: 'DELIVERED',
      stops: [chicago, danville],
      miles: 140,
      equipmentType: 'VAN',
      divisionKey: 'BCAT',
      rate: 9999,
    },
    financials: {
      customerRateCents: 180_000,
      revenueCents: 185_000,
      carrierRateCents: 140_000,
      costCents: 142_000,
      profitCents: 43_000,
      marginBps: 2324,
    },
    order: { id: 'order-1', customerId: 'cust-1', customerName: 'Batory', rateType: 'SPOT', mode: 'FTL' },
    loadCarrier: { kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Zippy LLC' },
    shipment: { id: 'ship-1', number: 'S1042', status: 'DELIVERED', mode: 'FTL' },
  })

  it('samples a delivered, priced load off the financials row', () => {
    const sample = laneSampleFor(base(), '2026-02-20T00:00:00.000Z')
    expect(sample).not.toBeNull()
    expect(sample).toMatchObject({
      id: 'lrs:load-1',
      laneKey: 'CHICAGO|IL>DANVILLE|IL',
      loadId: 'load-1',
      shipmentId: 'ship-1',
      shipmentNumber: 'S1042',
      customerName: 'Batory',
      customerRateCents: 180_000,
      revenueCents: 185_000,
      carrierRateCents: 140_000,
      costCents: 142_000,
      profitCents: 43_000,
      marginBps: 2324,
      miles: 140,
      rateType: 'SPOT',
      equipmentType: 'VAN',
      source: 'LOAD',
      excluded: false,
      sampledAt: '2026-02-20T00:00:00.000Z',
    })
  })

  it('dates the sample on the last delivery appointment', () => {
    expect(laneSampleFor(base(), '2026-02-20T00:00:00.000Z')?.date).toBe('2026-02-12')
  })

  it('falls back to the delivery stamp, then to now, when there is no appointment', () => {
    const input = base()
    input.load.stops = [chicago, stop({ type: 'delivery', sequence: 1, city: 'Danville, IL', appt: '' })]
    input.load.deliveredAt = '2026-02-13T09:00:00.000Z'
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.date).toBe('2026-02-13')

    input.load.deliveredAt = null
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.date).toBe('2026-02-20')
  })

  it('carries the assignment kind of the active assignment', () => {
    const input = base()
    input.loadCarrier = { kind: 'OWN_ASSET', status: 'ACTIVE' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.assignmentKind).toBe('OWN_ASSET')

    input.loadCarrier = null
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.assignmentKind).toBeNull()
  })

  it('never samples an unpriced load', () => {
    const input = base()
    input.financials = null
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).toBeNull()
  })

  it('never samples a load that has not delivered', () => {
    const input = base()
    for (const status of ['SOURCING', 'BOOKED', 'IN_TRANSIT', 'UNLOADING', 'CANCELED'] as const) {
      input.load.status = status
      expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).toBeNull()
    }
    input.load.status = 'INVOICING'
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).not.toBeNull()
  })

  it('treats a legacy load with no status as delivered only once it has delivered', () => {
    const input = base()
    input.load.status = null
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).toBeNull()
    input.load.deliveredAt = '2026-02-12T20:00:00.000Z'
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.loadStatus).toBeNull()
  })

  it('never samples a load whose lane has no state', () => {
    const input = base()
    input.load.stops = [stop({ type: 'pickup', sequence: 0, city: 'Chicago' }), danville]
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).toBeNull()
  })

  it('keeps a canceled shipment and refuses to count it', () => {
    const input = base()
    input.shipment = { ...input.shipment, status: 'CANCELED' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.excluded).toBe(true)
  })

  it('keeps a TONU assignment and refuses to count it', () => {
    const input = base()
    input.loadCarrier = { kind: 'CARRIER', status: 'TONU', carrierName: 'Zippy LLC' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.excluded).toBe(true)
  })

  it('leaves money it was not given absent rather than guessing from the legacy rate', () => {
    const input = base()
    input.financials = { customerRateCents: 180_000, revenueCents: 185_000 }
    const sample = laneSampleFor(input, '2026-02-20T00:00:00.000Z')
    expect(sample?.carrierRateCents).toBeNull()
    expect(sample?.costCents).toBeNull()
    expect(sample?.customerRateCents).toBe(180_000)
  })

  it('drops a mileage of zero rather than dividing by it later', () => {
    const input = base()
    input.load.miles = 0
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.miles).toBeNull()
  })

  it('stamps the reporting month from the sample date', () => {
    const sample = laneSampleFor(base(), '2026-02-20T00:00:00.000Z')
    expect(sample?.date).toBe('2026-02-12')
    expect(sample?.sampleMonth).toBe('2026-02')
  })

  it('takes the customer rep off the order and the carrier rep off the active assignment', () => {
    const input = base()
    input.order = { ...input.order, customerRepId: 'rep-cust' }
    input.load.carrierRepId = 'rep-load'
    input.loadCarrier = { ...input.loadCarrier, carrierRepId: 'rep-assign' }
    const sample = laneSampleFor(input, '2026-02-20T00:00:00.000Z')
    expect(sample?.customerRepId).toBe('rep-cust')
    expect(sample?.carrierRepId).toBe('rep-assign')
  })

  it('falls back to the load carrier rep when the assignment carries none', () => {
    const input = base()
    input.load.carrierRepId = 'rep-load'
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.carrierRepId).toBe('rep-load')
  })

  it('takes the team off the billed customer', () => {
    const input = base()
    input.customer = { id: 'cust-1', teamKey: 'MIDWEST' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.teamKey).toBe('MIDWEST')
  })

  it('dates the invoice month off the order, from a stamp or a plain date', () => {
    const input = base()
    input.order = { ...input.order, invoiceId: 'inv-7', invoicedAt: '2026-03-02T19:30:00.000Z' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')).toMatchObject({
      invoiceId: 'inv-7',
      invoiceMonth: '2026-03',
    })

    input.order = { ...input.order, invoicedAt: '2026-04-01' }
    expect(laneSampleFor(input, '2026-02-20T00:00:00.000Z')?.invoiceMonth).toBe('2026-04')
  })

  it('still samples when nothing names a rep, a team or an invoice', () => {
    const input = base()
    input.order = { id: 'order-1', customerId: 'cust-1' }
    const sample = laneSampleFor(input, '2026-02-20T00:00:00.000Z')
    expect(sample?.sampleMonth).toBe('2026-02')
    expect(sample?.customerRepId).toBeNull()
    expect(sample?.carrierRepId).toBeNull()
    expect(sample?.teamKey).toBeNull()
    expect(sample?.invoiceId).toBeNull()
    expect(sample?.invoiceMonth).toBeNull()
  })
})
