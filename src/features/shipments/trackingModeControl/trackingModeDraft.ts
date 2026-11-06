/**
 * Pure model behind the TrackingModeControl (feedback 9): what the person has picked, what is already
 * in force on the load, and the writes that picking implies. Everything goes through the EXISTING
 * per-load fields and actions, no new schema:
 *   mode / method / confirmation -> SET_TRACKING_PREFS (`Shipment.trackingPrefs`, `confirmed: true`)
 *   cadence                      -> SAVE_CHECK_CALL_PLAN (`Load.checkCallPlan.intervalHours`)
 *   assignee                     -> ASSIGN_TRACKER (`Shipment.trackerId`)
 */
import type { CheckCallPlan } from '@/lib/checkCallPlan'
import {
  effectiveTrackingPrefs, parseTrackingPrefs,
  type TrackingMethod, type TrackingMode, type TrackingPrefsInput,
} from '@/lib/trackingPrefs'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

export interface TrackingDraft {
  /** '' = nobody picked yet (and the customer suggests nothing). */
  mode: TrackingMode | ''
  /** '' = the plan's channels as configured. */
  method: TrackingMethod | ''
  cadenceHours: number
  trackerId: string | null
}

export interface TrackingBaseline {
  draft: TrackingDraft
  confirmed: boolean
  /** The pre-selected mode came from the customer, not from this load. */
  suggested: boolean
}

export const MIN_CADENCE_HOURS = 1
export const MAX_CADENCE_HOURS = 24

/** The control's starting point: the load's own pick when there is one, else the customer's suggestion. */
export function baselineOf(
  shipment: Pick<ShipmentRecord, 'trackingPrefs' | 'createdAt' | 'trackerId'> | null,
  customer: CustomerRecord | null,
  plan: Pick<CheckCallPlan, 'intervalHours'>,
): TrackingBaseline {
  const override = parseTrackingPrefs(shipment?.trackingPrefs)
  const eff = effectiveTrackingPrefs({ shipment, customer })
  return {
    draft: { mode: eff.mode ?? '', method: eff.method ?? '', cadenceHours: plan.intervalHours, trackerId: shipment?.trackerId ?? null },
    confirmed: Boolean(override?.confirmedAt) || eff.confirmed,
    suggested: eff.source.mode === 'CUSTOMER',
  }
}

export interface TrackingWrites {
  prefs: TrackingPrefsInput | null
  /** New interval, or null when it is unchanged. */
  cadenceHours: number | null
  /** `undefined` = unchanged. */
  trackerId: string | null | undefined
}

export function cadenceValid(hours: number): boolean {
  return Number.isInteger(hours) && hours >= MIN_CADENCE_HOURS && hours <= MAX_CADENCE_HOURS
}

/** What Confirm / Save must write. The prefs write is always sent: it is what confirms the mode. */
export function writesFor(draft: TrackingDraft, base: TrackingBaseline): TrackingWrites {
  const auto = draft.mode === 'AGENT'
  return {
    prefs: draft.mode
      ? { mode: draft.mode, ...(auto && draft.method ? { method: draft.method } : {}), confirmed: true }
      : null,
    cadenceHours: auto && draft.cadenceHours !== base.draft.cadenceHours ? draft.cadenceHours : null,
    trackerId: draft.trackerId !== base.draft.trackerId ? draft.trackerId : undefined,
  }
}

export function draftDirty(draft: TrackingDraft, base: TrackingBaseline): boolean {
  return draft.mode !== base.draft.mode || draft.method !== base.draft.method
    || draft.cadenceHours !== base.draft.cadenceHours || draft.trackerId !== base.draft.trackerId
}

/** Confirm needs a mode (and, for automated tracking, a sane cadence); once confirmed, Save needs a change. */
export function canSave(draft: TrackingDraft, base: TrackingBaseline): boolean {
  if (!draft.mode) return false
  if (draft.mode === 'AGENT' && !cadenceValid(draft.cadenceHours)) return false
  return !base.confirmed || draftDirty(draft, base)
}
