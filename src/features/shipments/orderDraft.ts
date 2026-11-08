/**
 * What the draft shipment editor refuses to submit, as pure functions.
 *
 * These are the same rules `SAVE_ORDER_FORM` / `SUBMIT_ORDER` enforce in the Lambda —
 * duplicated here only so the user sees the problem beside the field instead of as a
 * toast after a round trip. The server stays authoritative; this never permits anything
 * the server would refuse.
 */
import type {
  FreightItem, OrderReference, RequiredReference, ShipmentMode, SpecialRequirements,
} from '@/types/tms'
import type { Stop } from '@/types'

/** FTL, PTL, Bulk, Drayage, Intermodal and RLTL share the truckload editor (spec §6.4). */
export const TRUCKLOAD_MODES: ShipmentMode[] = ['FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL']

export const MODE_OPTIONS: { value: ShipmentMode; label: string }[] = [
  { value: 'FTL', label: 'FTL' },
  { value: 'PTL', label: 'Partial' },
  { value: 'BULK', label: 'Bulk' },
  { value: 'DRAYAGE', label: 'Drayage' },
  { value: 'INTERMODAL', label: 'Intermodal' },
  { value: 'RLTL', label: 'Rated LTL' },
  { value: 'LTL', label: 'LTL' },
  { value: 'AIR', label: 'Air' },
  { value: 'OCEAN', label: 'Ocean' },
  { value: 'RAIL', label: 'Rail' },
]

export interface DraftIssue {
  /** Editor section key, so the section header can show its own error count. */
  section: 'general' | 'stops' | 'contents' | 'references' | 'equipment'
  message: string
}

export interface OrderDraft {
  mode: ShipmentMode
  equipmentType?: string | null
  equipmentLengthFt?: number | null
  references: OrderReference[]
  freight: FreightItem[]
  specialRequirements?: SpecialRequirements | null
}

/**
 * Every reason this draft cannot be submitted, in section order. An empty array means
 * Submit is allowed — the credit check is separate and lives on the server.
 */
export function validateOrderDraft(
  draft: OrderDraft,
  stops: Stop[],
  requiredReferences: RequiredReference[],
): DraftIssue[] {
  const issues: DraftIssue[] = []

  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  if (!ordered.some((s) => s.type === 'pickup')) issues.push({ section: 'stops', message: 'Add at least one pick-up stop.' })
  if (!ordered.some((s) => s.type === 'delivery')) issues.push({ section: 'stops', message: 'Add at least one delivery stop.' })
  if (ordered.some((s) => !s.appt)) issues.push({ section: 'stops', message: 'Every stop needs an appointment date.' })

  // Chronological: a route that goes backwards in time is a data-entry slip, not a plan.
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    if (prev.appt && cur.appt && cur.appt < prev.appt) {
      issues.push({ section: 'stops', message: `Stop ${i + 1} is scheduled before stop ${i}.` })
      break
    }
  }

  if (TRUCKLOAD_MODES.includes(draft.mode) && !draft.equipmentType?.trim()) {
    issues.push({ section: 'equipment', message: 'Truckload shipments need an equipment type.' })
  }

  // One weight unit for the whole order: mixed IN/CM dimensions silently break class and
  // cube math downstream, so the editor makes the user pick one.
  const units = new Set(draft.freight.map((f) => f.dims?.unit).filter(Boolean))
  if (units.size > 1) issues.push({ section: 'contents', message: 'All freight dimensions must use the same unit.' })

  for (const item of draft.freight) {
    if (item.qty <= 0) issues.push({ section: 'contents', message: 'Each freight line needs a quantity above zero.' })
    if (!item.hazmat) continue
    if (!item.hazmat.un?.trim() || !item.hazmat.hazClass?.trim() || !item.hazmat.emergencyContact?.trim()) {
      issues.push({ section: 'contents', message: 'Hazmat freight needs a UN number, hazard class and emergency contact.' })
    }
  }

  for (const required of requiredReferences) {
    if (required.countOnNewOrder <= 0) continue
    const supplied = draft.references.filter((r) => r.code === required.code && r.value.trim()).length
    if (supplied < required.countOnNewOrder) {
      issues.push({
        section: 'references',
        message: `${required.label || required.code}: ${required.countOnNewOrder} value${required.countOnNewOrder === 1 ? '' : 's'} required, ${supplied} entered.`,
      })
    }
  }

  return issues
}

export function issuesForSection(issues: readonly DraftIssue[], section: DraftIssue['section']): DraftIssue[] {
  return issues.filter((i) => i.section === section)
}
