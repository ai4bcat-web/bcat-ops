import { describe, it, expect } from 'vitest'
import {
  LOAD_WORKFLOW_STATUS_LABELS,
  SHIPMENT_STATUS_LABELS,
  canTransitionLoadStatus,
  canTransitionShipmentStatus,
  isTruckloadMode,
  loadStatusFromStopTimes,
  nextLoadStatuses,
  nextShipmentStatuses,
  shipmentStatusFromLoads,
} from './shipmentStatus'
import type { StopTimesLike } from './shipmentStatus'

describe('isTruckloadMode', () => {
  it('separates the truckload family from LTL and forwarding', () => {
    expect(isTruckloadMode('FTL')).toBe(true)
    expect(isTruckloadMode('DRAYAGE')).toBe(true)
    expect(isTruckloadMode('LTL')).toBe(false)
    expect(isTruckloadMode('RLTL')).toBe(false)
    expect(isTruckloadMode('AIR')).toBe(false)
    expect(isTruckloadMode(null)).toBe(false)
  })
})

describe('nextLoadStatuses', () => {
  it('offers the truckload ladder, not the LTL one', () => {
    expect(nextLoadStatuses('SOURCING', 'FTL')).toEqual([
      'BOOKED', 'DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED', 'CANCELED',
    ])
  })

  it('offers the terminal ladder for LTL and forwarding', () => {
    expect(nextLoadStatuses('SOURCING', 'LTL')).toEqual([
      'PLANNED', 'DISPATCHED', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
      'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELED',
    ])
  })

  it('treats a legacy load with no status as sourcing', () => {
    expect(nextLoadStatuses(null, 'FTL')).toEqual(nextLoadStatuses('SOURCING', 'FTL'))
  })

  it('never offers invoicing by hand', () => {
    expect(nextLoadStatuses('DELIVERED', 'FTL')).toEqual([])
    expect(nextLoadStatuses('IN_TRANSIT', 'FTL')).not.toContain('INVOICING')
  })

  it('stops offering anything once the load is canceled or invoicing', () => {
    expect(nextLoadStatuses('CANCELED', 'FTL')).toEqual([])
    expect(nextLoadStatuses('INVOICING', 'FTL')).toEqual([])
  })
})

describe('canTransitionLoadStatus', () => {
  it('allows skipping forward on the ladder', () => {
    expect(canTransitionLoadStatus('SOURCING', 'IN_TRANSIT', 'FTL')).toBe(true)
  })

  it('refuses every regression', () => {
    expect(canTransitionLoadStatus('IN_TRANSIT', 'LOADING', 'FTL')).toBe(false)
    expect(canTransitionLoadStatus('DELIVERED', 'IN_TRANSIT', 'FTL')).toBe(false)
    expect(canTransitionLoadStatus('BOOKED', 'SOURCING', 'FTL')).toBe(false)
  })

  it('refuses standing still', () => {
    expect(canTransitionLoadStatus('LOADING', 'LOADING', 'FTL')).toBe(false)
  })

  it('refuses the other family\'s ladder when the mode is known', () => {
    expect(canTransitionLoadStatus('SOURCING', 'PLANNED', 'FTL')).toBe(false)
    expect(canTransitionLoadStatus('SOURCING', 'BOOKED', 'LTL')).toBe(false)
  })

  it('accepts either ladder when the mode is not supplied', () => {
    expect(canTransitionLoadStatus('SOURCING', 'PLANNED')).toBe(true)
    expect(canTransitionLoadStatus('SOURCING', 'BOOKED')).toBe(true)
  })

  it('refuses invoicing and un-canceling', () => {
    expect(canTransitionLoadStatus('DELIVERED', 'INVOICING', 'FTL')).toBe(false)
    expect(canTransitionLoadStatus('CANCELED', 'SOURCING', 'FTL')).toBe(false)
  })

  it('allows canceling until the freight is delivered', () => {
    expect(canTransitionLoadStatus('IN_TRANSIT', 'CANCELED', 'FTL')).toBe(true)
    expect(canTransitionLoadStatus('DELIVERED', 'CANCELED', 'FTL')).toBe(false)
  })
})

describe('nextShipmentStatuses', () => {
  it('lets a draft be submitted or killed', () => {
    expect(nextShipmentStatuses('DRAFT')).toEqual(['OPEN', 'CANCELED'])
  })

  it('answers a pending tender three ways', () => {
    expect(nextShipmentStatuses('TENDER_PENDING')).toEqual(['OPEN', 'TENDER_REJECTED', 'CANCELED'])
    expect(nextShipmentStatuses('TENDER_REJECTED')).toEqual(['TENDER_PENDING', 'CANCELED'])
  })

  it('holds and releases', () => {
    expect(nextShipmentStatuses('OPEN')).toEqual(['ON_HOLD', 'CANCELED'])
    expect(nextShipmentStatuses('ON_HOLD')).toEqual(['OPEN', 'CANCELED'])
  })

  it('un-cancels back to open', () => {
    expect(nextShipmentStatuses('CANCELED')).toEqual(['OPEN'])
  })

  it('never offers a derived movement status by hand', () => {
    expect(nextShipmentStatuses('IN_TRANSIT')).toEqual(['ON_HOLD', 'CANCELED'])
    expect(canTransitionShipmentStatus('OPEN', 'BOOKED')).toBe(false)
    expect(canTransitionShipmentStatus('BOOKED', 'IN_TRANSIT')).toBe(false)
  })

  it('leaves a delivered shipment alone', () => {
    expect(nextShipmentStatuses('DELIVERED')).toEqual([])
    expect(canTransitionShipmentStatus('DELIVERED', 'CANCELED')).toBe(false)
  })
})

describe('shipmentStatusFromLoads', () => {
  it('is only as far along as its least advanced leg', () => {
    expect(shipmentStatusFromLoads([{ status: 'DISPATCHED' }, { status: 'BOOKED' }])).toBe('BOOKED')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED' }, { status: 'IN_TRANSIT' }])).toBe('IN_TRANSIT')
  })

  it('says dispatched or delivered only once every leg is', () => {
    expect(shipmentStatusFromLoads([{ status: 'DISPATCHED' }, { status: 'DISPATCHED' }])).toBe('DISPATCHED')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED' }, { status: 'DELIVERED' }])).toBe('DELIVERED')
  })

  it('reports a sourcing or legacy load as an open shipment', () => {
    expect(shipmentStatusFromLoads([{ status: 'SOURCING' }])).toBe('OPEN')
    expect(shipmentStatusFromLoads([{}])).toBe('OPEN')
  })

  it('shows invoicing as delivered to the customer', () => {
    expect(shipmentStatusFromLoads([{ status: 'INVOICING' }])).toBe('DELIVERED')
  })

  it('ignores canceled legs, and is canceled only when they all are', () => {
    expect(shipmentStatusFromLoads([{ status: 'CANCELED' }, { status: 'IN_TRANSIT' }])).toBe('IN_TRANSIT')
    expect(shipmentStatusFromLoads([{ status: 'CANCELED' }, { status: 'CANCELED' }])).toBe('CANCELED')
  })

  it('falls back to sourcing when a leg has no active carrier left', () => {
    expect(shipmentStatusFromLoads([{ status: 'BOOKED', carrierStatuses: ['TONU'] }])).toBe('OPEN')
    expect(shipmentStatusFromLoads([{ status: 'BOOKED', carrierStatuses: ['BOUNCED', 'TONU'] }])).toBe('OPEN')
    expect(shipmentStatusFromLoads([{ status: 'BOOKED', carrierStatuses: ['TONU', 'ACTIVE'] }])).toBe('BOOKED')
  })

  it('keeps a status a person set, whatever the trucks are doing', () => {
    expect(shipmentStatusFromLoads([{ status: 'IN_TRANSIT' }], 'ON_HOLD')).toBe('ON_HOLD')
    expect(shipmentStatusFromLoads([{ status: 'IN_TRANSIT' }], 'CANCELED')).toBe('CANCELED')
    expect(shipmentStatusFromLoads([{ status: 'SOURCING' }], 'DRAFT')).toBe('DRAFT')
    expect(shipmentStatusFromLoads([{ status: 'SOURCING' }], 'TENDER_PENDING')).toBe('TENDER_PENDING')
  })

  it('leaves a shipment with no loads where it was', () => {
    expect(shipmentStatusFromLoads([], 'OPEN')).toBe('OPEN')
    expect(shipmentStatusFromLoads([])).toBe('OPEN')
  })
})

describe('loadStatusFromStopTimes', () => {
  const stop = (over: Partial<StopTimesLike> & Pick<StopTimesLike, 'type'>): StopTimesLike => ({
    sequence: 0,
    ...over,
  })

  const route = (times: {
    pickupIn?: string
    pickupOut?: string
    dropIn?: string
    dropOut?: string
  }): StopTimesLike[] => [
    stop({ type: 'pickup', sequence: 0, arrivedAt: times.pickupIn, departedAt: times.pickupOut }),
    stop({ type: 'delivery', sequence: 1, arrivedAt: times.dropIn, departedAt: times.dropOut }),
  ]

  it('reads the clock at the first pickup and the last delivery', () => {
    expect(loadStatusFromStopTimes(route({}), 'BOOKED')).toBe('BOOKED')
    expect(loadStatusFromStopTimes(route({ pickupIn: '2026-10-20T13:00:00Z' }), 'BOOKED')).toBe('LOADING')
    expect(loadStatusFromStopTimes(route({ pickupIn: '2026-10-20T13:00:00Z', pickupOut: '2026-10-20T15:00:00Z' }), 'BOOKED')).toBe('IN_TRANSIT')
    expect(loadStatusFromStopTimes(route({ pickupIn: 'x', pickupOut: 'x', dropIn: '2026-10-21T09:00:00Z' }), 'BOOKED')).toBe('UNLOADING')
    expect(loadStatusFromStopTimes(route({ pickupIn: 'x', pickupOut: 'x', dropIn: 'x', dropOut: '2026-10-21T11:00:00Z' }), 'BOOKED')).toBe('DELIVERED')
  })

  it('uses the LAST delivery, not the first, on a multi-drop load', () => {
    const stops = [
      stop({ type: 'pickup', sequence: 0, arrivedAt: 'a', departedAt: 'b' }),
      stop({ type: 'delivery', sequence: 1, arrivedAt: 'c', departedAt: 'd' }),
      stop({ type: 'delivery', sequence: 2 }),
    ]
    expect(loadStatusFromStopTimes(stops, 'BOOKED')).toBe('IN_TRANSIT')
  })

  it('orders stops by sequence, not by array position', () => {
    const stops = [
      stop({ type: 'delivery', sequence: 1 }),
      stop({ type: 'pickup', sequence: 0, arrivedAt: 'a', departedAt: 'b' }),
    ]
    expect(loadStatusFromStopTimes(stops, 'BOOKED')).toBe('IN_TRANSIT')
  })

  it('never walks the status backwards', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a' }), 'DELIVERED')).toBe('DELIVERED')
    expect(loadStatusFromStopTimes(route({}), 'IN_TRANSIT')).toBe('IN_TRANSIT')
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a', pickupOut: 'b' }), 'UNLOADING')).toBe('UNLOADING')
  })

  it('does not un-deliver a load when a mistaken time is cleared', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a', pickupOut: 'b', dropIn: '', dropOut: '' }), 'DELIVERED')).toBe('DELIVERED')
  })

  it('treats blank timestamps as no evidence at all', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: '   ' }), 'BOOKED')).toBe('BOOKED')
    expect(loadStatusFromStopTimes(route({ pickupIn: null as unknown as string }), 'BOOKED')).toBe('BOOKED')
  })

  it('advances a legacy load with no stored status', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a' }))).toBe('LOADING')
    expect(loadStatusFromStopTimes(route({}))).toBe('SOURCING')
  })

  it('leaves a canceled load canceled', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a', pickupOut: 'b', dropIn: 'c', dropOut: 'd' }), 'CANCELED')).toBe('CANCELED')
  })

  it('leaves an invoicing load alone', () => {
    expect(loadStatusFromStopTimes(route({ pickupIn: 'a', pickupOut: 'b', dropIn: 'c', dropOut: 'd' }), 'INVOICING')).toBe('INVOICING')
  })
})

describe('board labels', () => {
  it('uses MVMNT\'s short labels verbatim', () => {
    expect(SHIPMENT_STATUS_LABELS.TENDER_PENDING).toBe('TEND PNDG')
    expect(SHIPMENT_STATUS_LABELS.ARRIVED_AT_DELIVERY_TERMINAL).toBe('ARVD @ DEL')
    expect(SHIPMENT_STATUS_LABELS.CANCELED).toBe('CXLD')
    expect(LOAD_WORKFLOW_STATUS_LABELS.SOURCING).toBe('SRCNG')
    expect(LOAD_WORKFLOW_STATUS_LABELS.INVOICING).toBe('INVCNG')
  })
})
