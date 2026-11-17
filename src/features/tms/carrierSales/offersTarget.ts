import type { ShipmentListRow } from '@/hooks/useShipments'

/** What the offers panel needs to know about the clicked load, . */
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
  }
}
