import type { ShipmentListRow } from '@/hooks/useShipments'
import type { DemoShipment } from './demoOffers'

/** What the offers panel needs to know about the clicked load, real or demo. */
export interface OffersTarget {
  id: string
  number: string
  origin: string
  destination: string
  pickupAt: string | null
  deliveryAt: string | null
  equipment: string
  customerRateCents: number | null
  targetBuyCents: number | null
  /** Set ONLY for a demo shipment. A real load never carries demo offers. */
  demo: DemoShipment | null
}

export function targetFromRow(row: ShipmentListRow): OffersTarget {
  return {
    id: row.id,
    number: row.number ?? row.id,
    origin: row.originCity || row.fromState || '—',
    destination: row.destinationCity || row.toState || '—',
    pickupAt: row.pickupAppt ?? null,
    deliveryAt: row.deliveryAppt ?? null,
    equipment: row.equipmentType || '—',
    customerRateCents: row.customerRateCents ?? null,
    targetBuyCents: null,
    demo: null,
  }
}

export function targetFromDemo(s: DemoShipment): OffersTarget {
  return {
    id: s.id,
    number: s.number,
    origin: s.origin,
    destination: s.destination,
    pickupAt: s.pickupAt,
    deliveryAt: s.deliveryAt,
    equipment: s.equipment,
    customerRateCents: s.customerRateCents,
    targetBuyCents: s.targetBuyCents,
    demo: s,
  }
}
