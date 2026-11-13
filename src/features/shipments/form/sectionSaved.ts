/**
 * Only one numbered card reads as "done": Carrier & Tracking, once the saved load is covered by a
 * carrier (Ryne, 2026-11-13: no green on the other cards, no Unsaved chips). An unsaved edit in the
 * carrier card takes the green away until it is saved.
 *
 * Nothing is green before the shipment exists on the server (create mode).
 */
import type { ShipmentBundle } from '@/types/tms'
import type { CardKey } from './cards/cardRegistry'
import { liveCarriers, type ShipmentFormValues } from './model'

export type SectionState = 'complete' | 'neutral'

function carrierSlice(values: ShipmentFormValues): string {
  return JSON.stringify([values.carrier, values.carriers, values.checkCall])
}

export function sectionState(
  key: CardKey,
  values: ShipmentFormValues,
  savedValues: ShipmentFormValues | null,
  bundle: ShipmentBundle | null,
): SectionState {
  if (key !== 'carrier' || !savedValues || !bundle) return 'neutral'
  if (carrierSlice(values) !== carrierSlice(savedValues)) return 'neutral'
  return liveCarriers(bundle).length > 0 ? 'complete' : 'neutral'
}
