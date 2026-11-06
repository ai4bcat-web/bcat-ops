/**
 * Per-carrier tracking override (AT-plan D5): one carrier of a multi-carrier load may be tracked differently from
 * the shipment (`LoadCarrier.trackingPrefs`). Absent = inherits `Shipment.trackingPrefs`. Writes go through
 * UPDATE_LOAD_CARRIER_DETAILS; `null` clears the override back to the shipment's.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsSelect } from '@/features/tms/kit'
import { updateLoadCarrierDetails } from '@/lib/apiClient'
import {
  TRACKING_METHOD_LABELS, TRACKING_METHODS, TRACKING_MODE_LABELS, TRACKING_MODES, parseTrackingPrefs,
  type TrackingMethod, type TrackingMode, type TrackingPrefsOverride,
} from '@/lib/trackingPrefs'
import type { LoadCarrierRecord } from '@/types/tms'
import './trackingModeControl.css'

const MODE_CHOICE_LABEL: Record<TrackingMode, string> = { AGENT: 'Automated', MANUAL: 'Manual', NONE: 'None' }

export interface CarrierTrackingOverrideProps {
  /** The form slot key; every testid carries it. */
  slot: string
  loadCarrier: Pick<LoadCarrierRecord, 'id' | 'updatedAt' | 'trackingPrefs'>
  disabled?: boolean
  onSaved: () => void | Promise<void>
}

export function CarrierTrackingOverride({ slot, loadCarrier, disabled = false, onSaved }: CarrierTrackingOverrideProps) {
  const override = parseTrackingPrefs(loadCarrier.trackingPrefs)
  const [mode, setMode] = useState<TrackingMode | ''>(override?.mode ?? '')
  const [method, setMethod] = useState<TrackingMethod | ''>(override?.method ?? '')
  const [busy, setBusy] = useState(false)
  const dirty = mode !== (override?.mode ?? '') || (mode === 'AGENT' && method !== (override?.method ?? ''))

  const write = async (prefs: TrackingPrefsOverride | null) => {
    setBusy(true)
    try {
      await updateLoadCarrierDetails({ loadCarrierId: loadCarrier.id, expectedUpdatedAt: loadCarrier.updatedAt, trackingPrefs: prefs })
      await onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the tracking settings')
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (!mode) return
    void write({ mode, ...(mode === 'AGENT' && method ? { method } : {}) })
  }
  const clear = () => {
    setMode('')
    setMethod('')
    void write(null)
  }
  const off = disabled || busy

  return (
    <div className="tms-trkctl" data-testid={`carrier-tracking-${slot}`} data-compact data-disabled={disabled}>
      <div className="tms-trkctl-row">
        <span className="tms-card-cap">Tracking for this carrier</span>
        <div className="tms-trkctl-modes" role="radiogroup" aria-label={`Tracking mode ${slot}`}>
          {TRACKING_MODES.map((m) => (
            <label key={m} className="tms-card-chip" data-on={mode === m} data-disabled={off}>
              <input
                type="radio" name={`carrier-tracking-mode-${slot}`} className="tms-card-chip-input"
                data-testid={`carrier-tracking-mode-${slot}-${m}`} checked={mode === m} disabled={off} onChange={() => setMode(m)}
              />
              {MODE_CHOICE_LABEL[m]}
            </label>
          ))}
        </div>
        {override?.mode ? (
          <span className="tms-muted text-xs" data-testid={`carrier-tracking-own-${slot}`}>{TRACKING_MODE_LABELS[override.mode]} for this carrier</span>
        ) : (
          <span className="tms-muted text-xs" data-testid={`carrier-tracking-inherits-${slot}`}>Inherits shipment setting</span>
        )}
      </div>
      {mode === 'AGENT' ? (
        <div className="tms-trkctl-row tms-trkctl-fields">
          <label className="tms-trkctl-field">
            <span className="tms-card-cap">Method</span>
            <TmsSelect
              aria-label={`Tracking method ${slot}`} data-testid={`carrier-tracking-method-${slot}`}
              value={method || 'BOTH'} disabled={off} onChange={(e) => setMethod(e.target.value as TrackingMethod)}
            >
              {TRACKING_METHODS.map((m) => <option key={m} value={m}>{TRACKING_METHOD_LABELS[m]}</option>)}
            </TmsSelect>
          </label>
        </div>
      ) : null}
      {disabled ? null : (
        <div className="tms-trkctl-actions">
          <TmsButton size="sm" variant="primary" data-testid={`carrier-tracking-save-${slot}`} disabled={off || !mode || !dirty} onClick={save}>
            {busy ? 'Saving…' : 'Save for this carrier'}
          </TmsButton>
          {override ? (
            <TmsButton size="sm" variant="ghost" data-testid={`carrier-tracking-clear-${slot}`} disabled={off} onClick={clear}>
              Use shipment setting
            </TmsButton>
          ) : null}
        </div>
      )}
    </div>
  )
}
