export type TmsTone = 'blue' | 'green' | 'orange' | 'pink' | 'purple' | 'red' | 'turquoise' | 'gray'

const TONES: Record<string, TmsTone> = {
  DRAFT: 'gray',
  OPEN: 'blue',
  ON_HOLD: 'orange',
  BOOKED: 'turquoise',
  PLANNED: 'turquoise',
  DISPATCHED: 'blue',
  LOADING: 'blue',
  PICKED_UP: 'blue',
  IN_TRANSIT: 'blue',
  RECOVERED: 'blue',
  ARRIVED_AT_DELIVERY_TERMINAL: 'blue',
  OUT_FOR_DELIVERY: 'blue',
  UNLOADING: 'blue',
  DELIVERED: 'green',
  CANCELED: 'red',
  VOIDED: 'red',
  // AR
  DOCS_NEEDED: 'orange',
  UNBILLED: 'purple',
  UNPAID: 'blue',
  PAID: 'green',
  // AP
  AWAITING_INVOICE: 'orange',
  IN_REVIEW: 'purple',
  TO_BE_PAID: 'blue',
}

/** Status vocabularies (shipment, AR, AP) onto the seven MVMNT badge colours. */
export function statusTone(status: string): TmsTone {
  const key = (status ?? '').toUpperCase()
  if (key.startsWith('TENDER_')) return 'purple'
  return TONES[key] ?? 'gray'
}
