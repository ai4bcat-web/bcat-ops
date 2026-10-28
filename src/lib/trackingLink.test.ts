import { describe, it, expect } from 'vitest'
import { carrierView, customerView, linkExpiry, smsBodyFor } from './trackingLink'
import { MAX_SMS_BODY } from './dispatch'
import type { LastKnownFix } from './trackingTimeline'
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
