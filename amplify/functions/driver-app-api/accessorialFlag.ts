/**
 * Ryne 2026-11-19: a driver's photo or document whose note says "Detention pay" (or TONU) flags the shipment for it, so the Active
 * Shipments strip, the list badge, the calendar and Load Review show it with nobody setting it by hand.
 *
 * Handed to tms-shipment-actions (FLAG_ACCESSORIAL_FROM_DRIVER_DOC), which never overwrites a flag that is already standing, skips a
 * voided shipment and charges nothing. Once per submission: the submission row is stamped (`autoFlaggedAt`) before the hand-off, so a
 * retried "complete" cannot raise a flag that staff have since cleared. Fire and forget, and it never throws: a flag problem must not
 * fail the driver's upload.
 *
 * The collaborators are passed in so the rules can be tested without AWS.
 */
import type { Load, Stop } from '../../../src/types'
import { getStops } from '../../../src/lib/stops'
import { driverDocAccessorials, driverDocFlagNote, stopTypeForDriverDoc, type DriverDocAccessorial } from '../../../src/lib/driverDocAccessorials'

export interface MiscSubmission {
  id: string
  note?: string | null
  loadId?: string | null
  stopId?: string | null
  stopLabel?: string | null
}

export interface AccessorialFlagDeps {
  /** Empty in a stack without the shipment Lambda: nothing is flagged. */
  functionName: string
  getSubmission(id: string): Promise<MiscSubmission | null>
  linkToLoad(sub: MiscSubmission): Promise<string | null>
  getLoad(loadId: string): Promise<{ shipmentId?: string | null } | null>
  /** True when this call stamped the submission; false when an earlier call already had. */
  claim(id: string, kinds: DriverDocAccessorial[]): Promise<boolean>
  invoke(payload: Record<string, unknown>): Promise<void>
  log(level: 'info' | 'error', message: string, detail: Record<string, unknown>): void
}

export async function flagAccessorialsFromMisc(deps: AccessorialFlagDeps, driverName: string, submissionId: string): Promise<void> {
  try {
    if (!deps.functionName) return
    const sub = await deps.getSubmission(submissionId)
    if (!sub) return
    const kinds = driverDocAccessorials(sub.note)
    if (kinds.length === 0) return
    const loadId = sub.loadId || (await deps.linkToLoad(sub))
    if (!loadId) {
      deps.log('info', 'accessorial note not flagged: no load matched', { submissionId, kinds })
      return
    }
    const load = await deps.getLoad(loadId)
    const shipmentId = load?.shipmentId
    if (!shipmentId) return
    if (!(await deps.claim(submissionId, kinds))) return
    const stop = sub.stopId ? (getStops(load as unknown as Load) as Stop[]).find((s) => s.id === sub.stopId) : null
    for (const kind of kinds) {
      await deps.invoke({
        systemCaller: 'driver-app-api',
        arguments: {
          action: 'FLAG_ACCESSORIAL_FROM_DRIVER_DOC',
          input: JSON.stringify({
            shipmentId,
            kind,
            submissionId,
            driverName,
            stopId: sub.stopId ?? null,
            stopLabel: sub.stopLabel ?? null,
            stopType: stopTypeForDriverDoc(stop, sub.stopLabel),
            note: driverDocFlagNote({ driverName, note: sub.note }),
          }),
        },
      })
    }
  } catch (err) {
    deps.log('error', 'could not flag the shipment from the driver note', { submissionId, error: err instanceof Error ? err.message : String(err) })
  }
}
