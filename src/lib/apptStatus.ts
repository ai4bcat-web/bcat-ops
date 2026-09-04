import { requiresApptProofs } from './apptQueue'
import { apptHasTime } from './date'
import type { Load, Stop, ApptWorkflowStatus } from '@/types'

/**
 * The Batory appointment workflow ladder, and the non-Batory ratecon rule.
 *
 * Batory (per stop):
 *   pickup:   NEED TO REQUEST → REQUESTED → CONFIRMED
 *   delivery: NEED TO BOOK (Ruben picks the time) → NEED TO REQUEST (Dennis books)
 *             → REQUESTED → CONFIRMED
 *   any:      CHANGE NEEDED (Ruben/Ryne only, with the wanted time) → REQUESTED → CONFIRMED
 *
 * Screenshot gates — the ladder cannot advance without them:
 *   → REQUESTED needs the REQUEST-EMAIL screenshot,
 *   → CONFIRMED needs the CONFIRMED-EMAIL and E2OPEN screenshots.
 * Entering CHANGE NEEDED clears all three, so the new cycle needs fresh proof.
 *
 * Non-Batory: no screenshots and no ladder — the builder uploads the RATECON on the
 * load; its appointments are CONFIRMED automatically (the appt times come from the
 * ratecon), and show RATECON NEEDED until it is uploaded.
 */

export type { ApptWorkflowStatus }

/** Only these two may put an appointment into CHANGE NEEDED. */
export const CHANGE_SETTERS = ['ryne@bcatcorp.com', 'ruben@bcatcorp.com'] as const
export const canSetChangeNeeded = (email: string | null | undefined): boolean =>
  CHANGE_SETTERS.includes((email ?? '').toLowerCase() as (typeof CHANGE_SETTERS)[number])

/** Who works each phase. */
export const DENNIS = 'dennis@bcatcorp.com'
export const RUBEN  = 'ruben@bcatcorp.com'

/** The standing rule: every new Batory pickup is requested for noon. */
export const BATORY_PICKUP_REQUEST_TIME = '12:00 PM'

export type EffectiveApptStatus = ApptWorkflowStatus | 'ratecon_needed'

/**
 * The status in force for a stop, grandfathering stops from before the ladder:
 * booked + confirmation screenshots → confirmed; booked without → requested (the
 * request clearly happened — the time is in); unbooked → the phase's entry status.
 */
export function apptWorkflowStatus(stop: Stop, load: Pick<Load, 'customer' | 'rateConfirmKey' | 'rateConfirmUrl'>): EffectiveApptStatus {
  if (!requiresApptProofs(load.customer)) {
    return (load.rateConfirmKey || load.rateConfirmUrl) ? 'confirmed' : 'ratecon_needed'
  }
  if (stop.apptStatus) return stop.apptStatus
  // Grandfathering (stops written before apptStatus existed):
  if (stop.apptMoveRequested) return 'change_needed'
  const booked = (stop.apptType ?? 'exact') !== 'tbd' &&
    (stop.apptType === 'fcfs' || stop.apptType === 'range' || apptHasTime(stop.appt))
  if (booked) return (stop.apptProofs?.e2open && stop.apptProofs?.email) ? 'confirmed' : 'requested'
  return stop.type === 'delivery' ? 'need_book' : 'need_request'
}

/** Screenshot gates. */
export const canMarkRequested = (stop: Stop): boolean => !!stop.apptProofs?.request
export const canMarkConfirmed = (stop: Stop): boolean =>
  !!stop.apptProofs?.e2open && !!stop.apptProofs?.email

/**
 * The stop patch that puts an appointment into CHANGE NEEDED: the wanted time is
 * recorded, the ladder restarts, and every screenshot is cleared — the new cycle
 * must earn fresh proof (stale screenshots were exactly the audit hole).
 */
export function changeNeededPatch(changeTo: string): Partial<Stop> {
  return {
    apptStatus: 'change_needed',
    apptChangeTo: changeTo,
    apptMoveRequested: true,           // rides the existing Slack-thread + task plumbing
    apptProofs: { request: null, e2open: null, email: null },
  }
}

export const STATUS_META: Record<EffectiveApptStatus, { label: string; tone: 'red' | 'amber' | 'blue' | 'green' }> = {
  need_request:   { label: 'NEED TO REQUEST', tone: 'red' },
  need_book:      { label: 'NEED TO BOOK',    tone: 'red' },
  requested:      { label: 'REQUESTED',       tone: 'amber' },
  change_needed:  { label: 'CHANGE NEEDED',   tone: 'amber' },
  confirmed:      { label: 'CONFIRMED',       tone: 'green' },
  ratecon_needed: { label: 'RATECON NEEDED',  tone: 'blue' },
}
