/**
 * TrackingModeControl (feedback 9): the ONE control that chooses how a load is tracked, used by the
 * create/edit form's "Carrier & Tracking" card and the Carrier Sales cover step.
 *
 * Mode Automated / Manual / None, and for Automated: method (SMS to driver, e-mail thread, both),
 * check-call cadence in hours, and the tracking assignee. The customer's default only pre-selects
 * the mode (greyed "Suggested") until a person presses Confirm; then the load's own value rules,
 * and automation may run. Writes go through the existing actions (see trackingModeDraft.ts).
 * `disabled` makes it read-only (no carrier booked yet).
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TrackerPicker } from '@/components/TrackerPicker'
import { TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { assignTracker, saveLoadCheckCallPlan, setTrackingPrefs } from '@/lib/apiClient'
import './trackingModeControl.css'
import { resolveCheckCallPlanWithSource } from '../workstations/tracking/checkCallPlanSource'
import { TRACKING_METHOD_LABELS, TRACKING_MODE_LABELS, type TrackingMethod, type TrackingMode } from '@/lib/trackingPrefs'
import type { CustomerRecord, ShipmentLoad, ShipmentRecord, TmsSettings } from '@/types/tms'
import {
  baselineOf, canSave, MAX_CADENCE_HOURS, MIN_CADENCE_HOURS, writesFor, type TrackingDraft,
} from './trackingModeDraft'

export interface TrackingModeControlProps {
  shipment: Pick<ShipmentRecord, 'id' | 'trackingPrefs' | 'createdAt' | 'trackerId' | 'revDivision' | 'revSubdivision'>
  load: Pick<ShipmentLoad, 'id' | 'checkCallPlan' | 'updatedAt'> | null
  customer: CustomerRecord | null
  settings?: TmsSettings | null
  /** Read-only (no carrier booked yet, or the shipment is voided / locked). */
  disabled?: boolean
  /** Dense layout for the cover dialog. */
  compact?: boolean
  /** Called after every successful write so the owner re-reads the shipment bundle. */
  onSaved: () => void | Promise<void>
}

const MODES: readonly TrackingMode[] = ['AGENT', 'MANUAL', 'NONE']
const METHODS: readonly TrackingMethod[] = ['BOTH', 'SMS', 'EMAIL']
const MODE_CHOICE_LABEL: Record<TrackingMode, string> = { AGENT: 'Automated', MANUAL: 'Manual', NONE: 'None' }

export function TrackingModeControl({ shipment, load, customer, settings = null, disabled = false, compact = false, onSaved }: TrackingModeControlProps) {
  const plan = useMemo(
    () => resolveCheckCallPlanWithSource(load as ShipmentLoad | null, customer, settings, shipment).plan,
    [load, customer, settings, shipment],
  )
  const base = useMemo(() => baselineOf(shipment, customer, plan), [shipment, customer, plan])
  const [edit, setEdit] = useState<TrackingDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const draft = edit ?? base.draft
  const set = (patch: Partial<TrackingDraft>) => setEdit({ ...draft, ...patch })
  const suggestion = base.suggested && !base.confirmed
  const ok = canSave(draft, base) && !disabled && !busy

  const save = async () => {
    const writes = writesFor(draft, base)
    setBusy(true)
    try {
      if (writes.prefs) await setTrackingPrefs({ shipmentId: shipment.id, prefs: writes.prefs })
      if (writes.cadenceHours !== null && load) await saveLoadCheckCallPlan({ loadId: load.id, plan: { ...plan, intervalHours: writes.cadenceHours } })
      if (writes.trackerId !== undefined) {
        const result = await assignTracker({ shipmentIds: [shipment.id], trackerId: writes.trackerId })
        if (result.skipped[0]) toast.error(result.skipped[0].reason)
      }
      setEdit(null)
      await onSaved()
    } catch (err) {
      // The draft stays so the person can fix it and try again.
      toast.error(err instanceof Error ? err.message : 'Could not save the tracking settings')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tms-trkctl" data-testid="tracking-mode-control" data-compact={compact} data-confirmed={base.confirmed} data-disabled={disabled}>
      <div className="tms-trkctl-row">
        <span className="tms-card-cap">Tracking mode</span>
        <div className="tms-trkctl-modes" role="radiogroup" aria-label="Tracking mode">
          {MODES.map((m) => (
            <label key={m} className="tms-card-chip" data-on={draft.mode === m} data-disabled={disabled} data-suggested={suggestion && draft.mode === m}>
              <input
                type="radio" name={`tracking-mode-${shipment.id}`} className="tms-card-chip-input" data-testid={`tracking-mode-${m}`}
                checked={draft.mode === m} disabled={disabled || busy} onChange={() => set({ mode: m })}
              />
              {MODE_CHOICE_LABEL[m]}
            </label>
          ))}
        </div>
        {suggestion ? <span className="tms-muted text-xs" data-testid="tracking-mode-suggested">Suggested from the customer: {draft.mode ? TRACKING_MODE_LABELS[draft.mode] : '—'}. Confirm to use it for this load.</span> : null}
        {!draft.mode && !disabled ? <span className="tms-muted text-xs">Pick how this load is tracked.</span> : null}
      </div>

      {draft.mode === 'AGENT' ? (
        <div className="tms-trkctl-row tms-trkctl-fields">
          <label className="tms-trkctl-field">
            <span className="tms-card-cap">Method</span>
            <TmsSelect aria-label="Tracking method" data-testid="tracking-method" value={draft.method || 'BOTH'} disabled={disabled || busy} onChange={(e) => set({ method: e.target.value as TrackingMethod })}>
              {METHODS.map((m) => <option key={m} value={m}>{TRACKING_METHOD_LABELS[m]}</option>)}
            </TmsSelect>
          </label>
          <label className="tms-trkctl-field">
            <span className="tms-card-cap">Check call every (hours)</span>
            <TmsInput
              type="number" min={MIN_CADENCE_HOURS} max={MAX_CADENCE_HOURS} step={1} aria-label="Check-call cadence in hours" data-testid="tracking-cadence"
              value={Number.isFinite(draft.cadenceHours) ? draft.cadenceHours : ''} disabled={disabled || busy || !load}
              onChange={(e) => set({ cadenceHours: Number(e.target.value) })}
            />
          </label>
        </div>
      ) : null}

      {draft.mode && draft.mode !== 'NONE' ? (
        <div className="tms-trkctl-row">
          <span className="tms-card-cap">Tracking assignee</span>
          <TrackerPicker value={draft.trackerId} aria-label="Tracker" disabled={disabled || busy} onChange={(id) => set({ trackerId: id })} />
        </div>
      ) : null}

      {disabled ? null : (
        <div className="tms-trkctl-actions">
          <TmsButton size="sm" variant="primary" data-testid="tracking-confirm" disabled={!ok} onClick={() => void save()}>
            {busy ? 'Saving…' : base.confirmed ? 'Save tracking' : 'Confirm tracking'}
          </TmsButton>
          {!base.confirmed ? <span className="tms-muted text-xs">Not confirmed yet: automation stays off for this load.</span> : null}
        </div>
      )}
    </div>
  )
}
