/**
 * Stop assembly (ALJEX_MAPPING.md §4.3). Order: scalar pickup first, `PS1..PS12` blocks in
 * ordinal order, scalar consignee always last. A block that restates the scalar pickup/consignee
 * (same normalized name + city + state) is dropped. Marker `P` -> pickup, `S` -> delivery
 * (stop-off) by the profile's `stopMarkerMap` (D4). If the scalar pickup is blank and a block
 * exists, the first block becomes the first stop and is a pickup.
 */
import type { CanonicalStop, RowWarning } from './canonical'

export interface RawStop {
  name: string
  street: string
  city: string
  state: string
  zip: string
  phone: string
  contact: string
  ref: string
}

export interface RawStopBlock extends RawStop {
  ordinal: number
  marker: string
}

export interface StopInputs {
  pickup: RawStop
  consignee: RawStop
  blocks: RawStopBlock[]
  shipDate: string | null
  deliveryApptDate: string | null
  deliveryApptTime: string | null
  mustDeliverDate: string | null
  markerMap: Record<string, 'pickup' | 'delivery'>
}

const keyPart = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const identity = (s: RawStop): string => `${keyPart(s.name)}|${keyPart(s.city)}|${keyPart(s.state)}`
const hasPlace = (s: RawStop): boolean => !!(s.name || s.city || s.street || s.zip)

export function buildStops(input: StopInputs): { stops: CanonicalStop[]; warnings: RowWarning[] } {
  const warnings: RowWarning[] = []
  const pickupKey = identity(input.pickup)
  const consigneeKey = identity(input.consignee)
  const hasPickup = hasPlace(input.pickup)
  const hasConsignee = hasPlace(input.consignee)

  const blocks = input.blocks.filter((b) => {
    if (!hasPlace(b)) return false
    const k = identity(b)
    if (hasPickup && k === pickupKey) return false
    if (hasConsignee && k === consigneeKey) return false
    return true
  })

  const out: CanonicalStop[] = []
  const push = (s: RawStop, type: 'pickup' | 'delivery', source: CanonicalStop['source'], marker: string, extra: Partial<CanonicalStop> = {}) =>
    out.push({
      sequence: out.length,
      type,
      source,
      marker,
      name: s.name,
      street: s.street,
      city: s.city,
      state: s.state,
      zip: s.zip,
      phone: s.phone,
      contact: s.contact,
      ref: s.ref,
      apptDate: null,
      apptTime: null,
      apptEndDate: null,
      ...extra,
    })

  let queue = blocks
  if (hasPickup) push(input.pickup, 'pickup', 'PICKUP', '', { apptDate: input.shipDate })
  else if (queue.length) {
    const [first, ...rest] = queue
    push(first, 'pickup', `PS${first.ordinal}`, first.marker, { apptDate: input.shipDate })
    queue = rest
    warnings.push({ code: 'PICKUP_FROM_STOP_BLOCK' })
  }
  for (const b of queue) {
    const type = input.markerMap[b.marker.trim().toUpperCase()] ?? 'delivery'
    push(b, type, `PS${b.ordinal}`, b.marker)
  }
  if (hasConsignee) {
    push(input.consignee, 'delivery', 'CONSIGNEE', '', {
      apptDate: input.deliveryApptDate,
      apptTime: input.deliveryApptDate ? input.deliveryApptTime : null,
      apptEndDate: input.mustDeliverDate && input.mustDeliverDate !== input.deliveryApptDate ? input.mustDeliverDate : null,
    })
  } else {
    const lastDelivery = [...out].reverse().find((s) => s.type === 'delivery' && s.source !== 'PICKUP')
    if (!lastDelivery) warnings.push({ code: 'NO_DELIVERY_STOP' })
    else if (input.deliveryApptDate) {
      lastDelivery.apptDate = input.deliveryApptDate
      lastDelivery.apptTime = input.deliveryApptTime
    }
  }
  return { stops: out, warnings }
}
