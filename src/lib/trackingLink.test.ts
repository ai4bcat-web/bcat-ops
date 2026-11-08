import { describe, it, expect } from 'vitest'
import { TOKEN_BYTES, carrierView, consentText, loadIsClosed, routeWaypoints, customerView, isLinkToken, linkExpiry, newLinkToken, smsBodyFor } from './trackingLink'
import { MAX_SMS_BODY } from './dispatch'
import type { LastKnownFix } from './trackingTimeline'
import type { TrackingFix } from './trackingPings'
import type {
  LoadCarrierRecord,
  LoadCheckCallRecord,
  OrderRecord,
  ShipmentLoad,
  ShipmentRecord,
  TrackingLinkRecord,
} from '../types/tms'
import type { Stop } from '../types'

const TOKEN = 'Tok0123456789abcdefghijklmnopqrs'
const CARRIER_NAME = 'Mega Carrier Inc'
const DRIVER_PHONE = '+13125550147'
const CUSTOMER_NAME = 'Acme Foods'

const shipment: ShipmentRecord = {
  id: 'shp-1',
  number: 'S-1001',
  status: 'IN_TRANSIT',
  customerId: 'cust-1',
  customerName: CUSTOMER_NAME,
  mode: 'FTL',
  source: 'MANUAL',
  createdBy: 'rep@example.com',
  updatedBy: 'rep@example.com',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
}

const order: OrderRecord = {
  id: 'ord-1',
  shipmentId: 'shp-1',
  customerId: 'cust-1',
  customerName: CUSTOMER_NAME,
  mode: 'FTL',
  references: [
    { code: 'PO', value: 'PO-55512', level: 'ORDER', visibility: 'CUSTOMER' },
    { code: 'BOL', value: 'BOL-900', level: 'ORDER', visibility: 'ALL' },
    { code: 'MARGIN_NOTE', value: 'INTERNAL-ONLY-77', level: 'ORDER', visibility: 'INTERNAL' },
    { code: 'PICKUP_NUMBER', value: 'CARRIER-ONLY-42', level: 'ORDER', visibility: 'CARRIER' },
  ],
  customerRateCents: 425000,
  revenueCents: 425000,
  createdBy: 'rep@example.com',
  updatedBy: 'rep@example.com',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
}

function stop(id: string, type: Stop['type'], sequence: number, over: Partial<Stop> = {}): Stop {
  return {
    id,
    type,
    sequence,
    name: type === 'pickup' ? 'Shipper Dock 4' : 'Consignee DC',
    city: 'Joliet, IL',
    appt: '2026-03-02T12:00:00.000Z',
    driverId: null,
    refs: [
      { code: 'SEAL', value: 'SEAL-1', level: 'STOP', visibility: 'ALL' },
      { code: 'DOCK', value: 'CARRIER-DOCK-9', level: 'STOP', visibility: 'CARRIER' },
      { code: 'NOTE', value: 'INTERNAL-ONLY-88', level: 'STOP', visibility: 'INTERNAL' },
    ],
    ...over,
  }
}

const load: ShipmentLoad = {
  id: 'load-1',
  loadNumber: 'S-1001-1',
  leg: 1,
  status: 'IN_TRANSIT',
  customer: CUSTOMER_NAME,
  rate: 350000,
  stops: [
    stop('pu1', 'pickup', 0, {
      arrivedAt: '2026-03-02T11:30:00.000Z',
      departedAt: '2026-03-02T13:00:00.000Z',
    }),
    stop('de1', 'delivery', 1, { appt: '2026-03-03T09:00:00.000Z' }),
  ],
}

const loadCarrier: LoadCarrierRecord = {
  id: 'lc-1',
  loadId: 'load-1',
  shipmentId: 'shp-1',
  kind: 'CARRIER',
  status: 'ACTIVE',
  carrierName: CARRIER_NAME,
  driverName: 'Dale Driver',
  driverPhone: DRIVER_PHONE,
  dispatcherPhone: '+13125550148',
  carrierRateCents: 350000,
  costCents: 350000,
  deliveryEtaAt: '2026-03-03T08:30:00.000Z',
  createdBy: 'rep@example.com',
  updatedBy: 'rep@example.com',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
}

function customerLink(over: Partial<TrackingLinkRecord> = {}): TrackingLinkRecord {
  return {
    id: TOKEN,
    kind: 'CUSTOMER_VIEW',
    shipmentId: 'shp-1',
    status: 'ACTIVE',
    expiresAt: '2026-03-16T00:00:00.000Z',
    contactName: 'Rita Rep',
    contactEmail: 'rita@example.com',
    contactPhone: '+13125550100',
    showCarrier: false,
    showPosition: true,
    createdBy: 'rep@example.com',
    ...over,
  }
}

const position: LastKnownFix = {
  at: '2026-03-02T18:00:00.000Z',
  lat: 41.5249731,
  lng: -88.0817323,
  description: 'Joliet, IL',
  source: 'LINK',
}

function view(over: Partial<TrackingLinkRecord> = {}) {
  return customerView({
    shipment,
    orders: [order],
    loads: [load],
    loadCarriers: [loadCarrier],
    events: [
      {
        id: 'cc-1',
        loadId: 'load-1',
        shipmentId: 'shp-1',
        at: '2026-03-02T18:00:00.000Z',
        type: 'TRACKING_PING',
        source: 'LINK',
        note: 'Driver says traffic is bad, told customer we are still fine',
        createdBy: `link:${TOKEN.slice(0, 8)}`,
      },
    ],
    position,
    link: customerLink(over),
    division: { id: 'd1', key: 'bcat', name: 'BCAT Logistics', active: true, createdAt: '', updatedAt: '' },
    nowIso: '2026-03-02T18:05:00.000Z',
  })
}

describe('customerView', () => {
  it('tells the customer where the freight is and nothing else', () => {
    const result = view()
    const json = JSON.stringify(result)

    expect(result.number).toBe('S-1001')
    expect(result.statusLabel).toBe('In transit')
    expect(result.stops.map((s) => s.arrivedAt)).toEqual(['2026-03-02T11:30:00.000Z', null])
    expect(result.eta).toBe('2026-03-03T08:30:00.000Z')
    expect(result.lastUpdate).toEqual({ at: '2026-03-02T18:00:00.000Z', type: 'TRACKING_PING' })

    expect(json).not.toContain(CARRIER_NAME)
    expect(json).not.toContain(DRIVER_PHONE)
    expect(json).not.toContain('350000')
    expect(json).not.toContain('425000')
    expect(json).not.toContain('INTERNAL-ONLY')
    expect(json).not.toContain('CARRIER-ONLY-42')
    expect(json).not.toContain('CARRIER-DOCK-9')
    expect(json).not.toContain('traffic is bad')
  })

  it('shows only the references the customer is allowed to see', () => {
    expect(view().references.map((r) => r.value)).toEqual(['PO-55512', 'BOL-900'])
    expect(view().stops[0].references.map((r) => r.value)).toEqual(['SEAL-1'])
  })

  it('rounds the pin to about a hundred metres', () => {
    expect(view().position).toEqual({
      lat: 41.525,
      lng: -88.082,
      at: '2026-03-02T18:00:00.000Z',
      description: 'Joliet, IL',
    })
  })

  it('leaves the position out entirely when the link hides it', () => {
    const result = view({ showPosition: false })
    expect('position' in result).toBe(false)
  })

  it('names the carrier only when the link was minted saying it may', () => {
    expect('carrier' in view()).toBe(false)
    expect(view({ showCarrier: true }).carrier).toEqual({ name: CARRIER_NAME })
  })
})

describe('carrierView', () => {
  const pings: LoadCheckCallRecord[] = [
    {
      id: 'p1',
      loadId: 'load-1',
      shipmentId: 'shp-1',
      at: '2026-03-02T17:00:00.000Z',
      type: 'TRACKING_PING',
      source: 'LINK',
      lat: 41.5,
      lng: -88.1,
      accuracyM: 20,
      createdBy: `link:${TOKEN.slice(0, 8)}`,
    },
    {
      id: 'p2',
      loadId: 'load-1',
      shipmentId: 'shp-1',
      at: '2026-03-02T18:00:00.000Z',
      type: 'TRACKING_PING',
      source: 'LINK',
      createdBy: 'link:otherlnk',
    },
    {
      id: 'p3',
      loadId: 'load-1',
      shipmentId: 'shp-1',
      at: '2026-03-02T16:00:00.000Z',
      type: 'NOTE',
      source: 'MANUAL',
      note: `Called ${CUSTOMER_NAME} about the delay`,
      createdBy: 'rep@example.com',
    },
  ]

  const result = carrierView({
    load,
    events: pings,
    link: { ...customerLink(), kind: 'CARRIER_PING', loadId: 'load-1', loadCarrierId: 'lc-1' },
    contactPhone: '+13125550199',
    nowIso: '2026-03-02T18:05:00.000Z',
  })

  it('shows the driver the load and the next stop, never the customer or the money', () => {
    const json = JSON.stringify(result)
    expect(result.loadNumber).toBe('S-1001-1')
    expect(result.nextStop?.id).toBe('de1')
    expect(result.contactPhone).toBe('+13125550199')
    expect(json).not.toContain(CUSTOMER_NAME)
    expect(json).not.toContain('350000')
    expect(json).not.toContain('PO-55512')
  })

  it('shows the pings this link sent, newest first', () => {
    expect(result.pings).toEqual([
      { at: '2026-03-02T17:00:00.000Z', lat: 41.5, lng: -88.1, accuracyM: 20 },
    ])
  })

  it('shows the references a carrier may see', () => {
    expect(result.stops[0].references.map((r) => r.value)).toEqual(['SEAL-1', 'CARRIER-DOCK-9'])
  })
})

describe('customerView map', () => {
  const at = (min: number) => new Date(Date.parse('2026-03-02T14:00:00.000Z') + min * 60_000).toISOString()
  const fix = (min: number, over: Partial<TrackingFix> = {}): TrackingFix => ({
    at: at(min), lat: 41.5249731 + min / 1000, lng: -88.0817323, source: 'link', accuracyM: 14, approx: false,
    speedMph: 61, headingDeg: 180, place: null, ...over,
  })
  const located: ShipmentLoad = {
    ...load,
    stops: [
      stop('pu1', 'pickup', 0, { address: { street: '1 Dock', city: 'Joliet', state: 'IL', zip: '60431', lat: 41.52497, lng: -88.08173 } as Stop['address'] }),
      stop('de1', 'delivery', 1, { address: { street: '2 Dock', city: 'Dallas', state: 'TX', zip: '75201', lat: 32.77671, lng: -96.79699 } as Stop['address'] }),
    ],
  }
  const build = (fixes: TrackingFix[] | null, over: Partial<TrackingLinkRecord> = {}, route: string | null = 'abc') =>
    customerView({
      shipment, orders: [order], loads: [located], loadCarriers: [loadCarrier], fixes, route,
      link: customerLink(over), nowIso: at(300), position: null,
    })

  it('thins the trail to fifteen minutes, rounds to three decimals and flags a guess', () => {
    const fixes = [0, 3, 8, 16, 20, 31].map((m) => fix(m))
    fixes.push(fix(40, { approx: true, source: 'sms-geocode', accuracyM: 8000 }))
    const map = build(fixes).map!
    expect(map.trail.map((t) => t.at)).toEqual([at(0), at(16), at(31), at(40)].filter((a) => map.trail.some((t) => t.at === a)))
    for (let i = 1; i < map.trail.length - 1; i++) {
      expect(Date.parse(map.trail[i].at) - Date.parse(map.trail[i - 1].at)).toBeGreaterThanOrEqual(15 * 60_000)
    }
    expect(map.trail[0].lat).toBe(41.525)
    expect(map.trail.at(-1)).toMatchObject({ approx: true })
    expect(map.trail[0].approx).toBeUndefined()
    expect(map.stops).toEqual([
      { type: 'pickup', lat: 41.525, lng: -88.082 },
      { type: 'delivery', lat: 32.777, lng: -96.797 },
    ])
    expect(map.route).toBe('abc')
  })

  it('never says where a fix came from, how exact it was, or how fast the truck went', () => {
    const json = JSON.stringify(build([fix(0), fix(20, { source: 'provider:macropoint' }), fix(40, { approx: true, accuracyM: 9000 })]))
    for (const leak of ['source', 'accuracyM', 'speed', 'heading', 'refId', 'macropoint', 'sms-', '9000']) {
      expect(json).not.toContain(leak)
    }
  })

  it('leaves out map and position when the link hides position', () => {
    const result = build([fix(0)], { showPosition: false })
    expect(result.map).toBeUndefined()
    expect(result.position).toBeUndefined()
  })

  it('shows no map when no fixes were read, and an empty trail when there are none', () => {
    expect(build(null).map).toBeUndefined()
    expect(build([]).map?.trail).toEqual([])
  })

  it('keeps a fresh precise fix as the position over a newer guess', () => {
    const result = build([fix(280), fix(295, { approx: true, source: 'sms-geocode', lat: 40, lng: -90 })])
    expect(result.position).toMatchObject({ lat: 41.805, at: at(280) })
    expect(result.position?.approx).toBeUndefined()
  })

  it('flags the position as approximate when nothing precise is recent', () => {
    const result = build([fix(0), fix(60, { approx: true, source: 'sms-geocode', lat: 40.1234, lng: -90 })], {}, null)
    // nowIso is 5 h after the precise fix, so the guess takes over
    expect(result.position).toMatchObject({ lat: 40.123, approx: true })
  })

  it('prefers a staff-logged position that has no ping of its own when it is clearly newer', () => {
    const result = customerView({
      shipment, orders: [order], loads: [located], loadCarriers: [loadCarrier], fixes: [fix(0)],
      position: { at: at(30), lat: 38.1, lng: -92.2, description: 'Columbia, MO', source: 'MANUAL' },
      link: customerLink(), nowIso: at(300),
    })
    expect(result.position).toMatchObject({ lat: 38.1, description: 'Columbia, MO' })
  })
})

describe('routeWaypoints', () => {
  const at = (n: number): Stop['address'] => ({ lat: 40 + n, lng: -90 - n }) as Stop['address']
  it('keeps the first pickup, the middle stops and the last delivery that carry coordinates', () => {
    const w = routeWaypoints([
      stop('c', 'delivery', 3, { address: at(3) }),
      stop('a', 'pickup', 0, { address: at(0) }),
      stop('x', 'pickup', 1, { address: null }),
      stop('b', 'pickup', 2, { address: at(2) }),
    ])
    expect(w.map((p) => p.type)).toEqual(['pickup', 'stop', 'delivery'])
    expect(w.map((p) => p.lat)).toEqual([40, 42, 43])
  })
  it('is empty when no stop has coordinates', () => {
    expect(routeWaypoints([stop('a', 'pickup', 0), stop('b', 'delivery', 1)])).toEqual([])
  })
})

describe('carrierView share', () => {
  const link = { ...customerLink(), kind: 'CARRIER_PING' as const, loadId: 'load-1', loadCarrierId: 'lc-1' }
  const run = (l: TrackingLinkRecord, over: Partial<ShipmentLoad> = {}) =>
    carrierView({ load: { ...load, ...over }, link: l, broker: 'Acme Brokerage', nowIso: '2026-03-02T18:05:00.000Z' }).share!

  it('asks for consent until the server has recorded it, and names the broker and load', () => {
    const fresh = run(link)
    expect(fresh).toMatchObject({ consentRequired: true, consentVersion: 'ao-1', everyMin: 5, active: true })
    expect(fresh.consentText).toBe(consentText('Acme Brokerage', 'S-1001-1'))
    expect(run({ ...link, consentAt: '2026-03-02T17:00:00.000Z' }).consentRequired).toBe(false)
  })

  it('stops being active when the load is delivered, invoiced, canceled or has a delivery time', () => {
    for (const status of ['DELIVERED', 'INVOICING', 'CANCELED'] as const) {
      expect(run(link, { status }).active).toBe(false)
    }
    expect(loadIsClosed({ status: 'IN_TRANSIT', deliveredAt: '2026-03-03T10:00:00.000Z' })).toBe(true)
    expect(loadIsClosed({ status: 'IN_TRANSIT' })).toBe(false)
  })

  it('reports the counters', () => {
    expect(run({ ...link, lastPingAt: '2026-03-02T18:00:00.000Z', pingCount: 7 })).toMatchObject({ lastPingAt: '2026-03-02T18:00:00.000Z', pingCount: 7 })
  })
})

describe('linkExpiry', () => {
  const now = '2026-03-02T18:00:00.000Z'

  it('gives a ping link the configured hours past the last delivery', () => {
    expect(linkExpiry('CARRIER_PING', '2026-03-03T09:00:00.000Z', null, now)).toBe(
      '2026-03-06T09:00:00.000Z',
    )
  })

  it('never hands out a link with less than a day on it', () => {
    expect(linkExpiry('CARRIER_PING', '2026-02-20T09:00:00.000Z', { trackingLinkExpiryHours: 1 }, now)).toBe(
      '2026-03-03T18:00:00.000Z',
    )
    expect(linkExpiry('CUSTOMER_VIEW', null, { customerLinkExpiryDays: 0.1 }, now)).toBe(
      '2026-03-03T18:00:00.000Z',
    )
  })

  it('treats a provider subscription like a ping link', () => {
    expect(linkExpiry('PROVIDER_TRACK', '2026-03-03T09:00:00.000Z', null, now)).toBe(linkExpiry('CARRIER_PING', '2026-03-03T09:00:00.000Z', null, now))
  })

  it('gives a customer link its days from now', () => {
    expect(linkExpiry('CUSTOMER_VIEW', null, null, now)).toBe('2026-03-16T18:00:00.000Z')
  })
})

describe('smsBodyFor', () => {
  it('fills the template in', () => {
    expect(
      smsBodyFor(null, { broker: 'BCAT', loadNumber: 'S-1001-1', url: 'https://x.co/l/abc' }),
    ).toBe('BCAT: share your location for load S-1001-1 here: https://x.co/l/abc')
  })

  it('keeps the link inside one text however long the template is', () => {
    const url = 'https://ops.example.com/track/l/' + TOKEN
    const body = smsBodyFor('{broker} '.repeat(400) + '{url}', {
      broker: 'BCAT Logistics',
      loadNumber: 'S-1001-1',
      url,
    })
    expect(body.length).toBeLessThanOrEqual(MAX_SMS_BODY)
    expect(body.endsWith(url)).toBe(true)
  })
})

describe('newLinkToken', () => {
  it('mints something the link routes will accept', () => {
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, at) => (at * 37 + 11) % 256)
    const token = newLinkToken(bytes)
    expect(token).toHaveLength(32)
    expect(isLinkToken(token)).toBe(true)
  })

  it('carries every byte of the randomness it was handed', () => {
    const first = newLinkToken((n) => Uint8Array.from({ length: n }, (_, at) => at))
    const second = newLinkToken((n) => Uint8Array.from({ length: n }, (_, at) => (at === n - 1 ? at + 1 : at)))
    expect(second).not.toBe(first)
    expect(isLinkToken(second)).toBe(true)
  })

  it('refuses to mint a short token rather than mint a guessable one', () => {
    expect(() => newLinkToken(() => new Uint8Array(TOKEN_BYTES - 1))).toThrow(/random bytes/)
  })
})
