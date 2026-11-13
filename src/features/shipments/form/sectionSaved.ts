/**
 * Which numbered cards read as "done": every required field the card owns is filled AND what the
 * card shows is what the server has (no unsaved edit in it). The required part comes from the
 * rail's `requiredRows`, so a green card always agrees with the "N / M required" counter.
 *
 *  - freight / route: their required rows are all done.
 *  - rates: a customer rate is entered (the card has no required row of its own).
 *  - carrier: the load is covered (a live carrier assignment on the saved load).
 *  - documents: no required content, so it stays neutral.
 *
 * Nothing is green before the shipment exists on the server (create mode).
 */
import type { ShipmentBundle } from '@/types/tms'
import type { CardKey } from './cards/cardRegistry'
import { liveCarriers, type ShipmentFormValues } from './model'
import type { RailRow } from './railModel'

export type SectionState = 'complete' | 'unsaved' | 'neutral'

/** The part of the values object each card edits. */
export function cardSlice(values: ShipmentFormValues, key: CardKey): unknown {
  switch (key) {
    case 'freight': return [values.mode, values.shipmentType, values.ship]
    case 'route': return values.stops
    case 'rates': return values.rates
    case 'carrier': return [values.carrier, values.carriers, values.checkCall]
    case 'documents': return values.docs
  }
}

function sameSlice(a: ShipmentFormValues, b: ShipmentFormValues, key: CardKey): boolean {
  return JSON.stringify(cardSlice(a, key)) === JSON.stringify(cardSlice(b, key))
}

function filled(values: ShipmentFormValues, key: CardKey, rows: RailRow[], bundle: ShipmentBundle | null): boolean {
  const own = rows.filter((r) => r.card === key)
  switch (key) {
    case 'freight':
    case 'route':
      return own.length > 0 && own.every((r) => r.done)
    case 'rates':
      return values.rates.customer.lhRate.trim() !== '' && own.every((r) => r.done)
    case 'carrier':
      return liveCarriers(bundle).length > 0 && own.every((r) => r.done)
    case 'documents':
      return false
  }
}

export function sectionState(
  key: CardKey,
  values: ShipmentFormValues,
  savedValues: ShipmentFormValues | null,
  rows: RailRow[],
  bundle: ShipmentBundle | null,
): SectionState {
  if (!savedValues || !bundle) return 'neutral'
  if (!sameSlice(values, savedValues, key)) return 'unsaved'
  return filled(values, key, rows, bundle) ? 'complete' : 'neutral'
}
