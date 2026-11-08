/**
 * Step K — reading a carrier's availability e-mail into a note.
 *
 * A capacity run ends NOTED, never PROPOSED: there is nothing to apply. The value is
 * that the lane and the equipment are written down in the brokerage's own vocabulary
 * instead of sitting in a mailbox as "got a reefer open out of Chicago Thursday".
 */
import type { CapacityProposal, WorkflowConfidence } from '../../types/tms'

/**
 * `Carrier.equipment`, which is what a carrier profile stores and what the capacity
 * note has to be comparable with. Most specific phrases first: a step deck is
 * specialized equipment even though the word "deck" reads like a flatbed.
 */
const EQUIPMENT_VOCABULARY: ReadonlyArray<[string, RegExp]> = [
  ['POWER_ONLY', /\bpower[\s-]?only\b/],
  ['SPECIALIZED', /\b(?:rgn|lowboy|low[\s-]?boy|step[\s-]?deck|double[\s-]?drop|heavy[\s-]?haul|specialized)\b/],
  ['REEFER', /\b(?:reefer|refrigerated|temp[\s-]?control(?:led)?)\b/],
  ['TANKER', /\b(?:tanker|tank)\b/],
  ['CONTAINER', /\b(?:container|intermodal|drayage)\b/],
  ['FLATBED', /\b(?:flat[\s-]?bed|flatbed|conestoga)\b/],
  ['VAN', /\b(?:dry[\s-]?van|van)\b/],
]

/** The `Carrier.equipment` term this text names, or null when it names none. */
export function normalizeEquipment(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return null
  for (const [term, shape] of EQUIPMENT_VOCABULARY) {
    if (shape.test(raw)) return term
  }
  return null
}

/** The model's `json_schema` answer for a capacity e-mail. */
export interface CapacityEmailParse {
  carrier?: string | null
  equipment?: string | null
  originCity?: string | null
  originState?: string | null
  destinationCity?: string | null
  destinationState?: string | null
  availableDate?: string | null
  trucks?: number | null
  notes?: string | null
  confidence?: WorkflowConfidence | null
}

function text(value: string | null | undefined): string | null {
  return (value ?? '').trim() || null
}

export function postingFrom(parsed: CapacityEmailParse): CapacityProposal {
  const trucks =
    typeof parsed.trucks === 'number' && Number.isFinite(parsed.trucks) && parsed.trucks > 0
      ? Math.trunc(parsed.trucks)
      : null
  return {
    kind: 'CAPACITY',
    carrierName: text(parsed.carrier),
    equipment: normalizeEquipment(parsed.equipment),
    originCity: text(parsed.originCity),
    originState: text(parsed.originState),
    destinationCity: text(parsed.destinationCity),
    destinationState: text(parsed.destinationState),
    availableDate: text(parsed.availableDate),
    trucks,
    notes: text(parsed.notes),
    confidence: parsed.confidence ?? null,
  }
}
