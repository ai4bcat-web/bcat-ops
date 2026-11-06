/**
 * How this load is tracked, as one always-visible 28 px row inside the summary strip card:
 * three small selects (Mode, Method, Driver SMS to) plus Save and Reset. Each choice can
 * inherit the customer (first option) or be pinned for this shipment only; pinning nothing
 * clears the override.
 *
 * It replaces the floating popover (which opened over the strip and the SMS pane): the row is
 * rendered unconditionally with a fixed height, Save and Reset are disabled rather than
 * removed, and nothing here is a portal or an overlay — so saving can never move the panes.
 */
import { TrackingModeNotSetChip } from '../../trackingModeControl/TrackingModeNotSetChip'
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsSelect } from '@/features/tms/kit'
import { setTrackingPrefs } from '@/lib/apiClient'
import {
  DRIVER_SMS_TARGETS, DRIVER_SMS_TARGET_LABELS, TRACKING_METHODS, TRACKING_METHOD_LABELS, TRACKING_MODES,
  TRACKING_MODE_LABELS, effectiveTrackingPrefs, parseTrackingPrefs,
  type DriverSmsTarget, type TrackingMethod, type TrackingMode, type TrackingPrefsOverride,
} from '@/lib/trackingPrefs'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

const SHORT_MODE: Record<TrackingMode, string> = { AGENT: 'AI agent', MANUAL: 'Manual', NONE: 'No tracking' }
const SHORT_METHOD: Record<TrackingMethod, string> = { EMAIL: 'E-mail', SMS: 'SMS', BOTH: 'E-mail + SMS' }

interface Draft { mode: TrackingMode | ''; method: TrackingMethod | ''; driverSms: DriverSmsTarget | '' }

function draftOf(override: TrackingPrefsOverride | null): Draft {
  return { mode: override?.mode ?? '', method: override?.method ?? '', driverSms: override?.driverSms ?? '' }
}

/** Only the pinned keys; nothing pinned = no override at all. */
function overrideOf(draft: Draft): TrackingPrefsOverride | null {
  const out: TrackingPrefsOverride = {}
  if (draft.mode) out.mode = draft.mode
  if (draft.method) out.method = draft.method
  if (draft.driverSms) out.driverSms = draft.driverSms
  return Object.keys(out).length > 0 ? out : null
}

export function TrackingPrefsRow({ shipment, customer, hasCarrier = false, onSaved }: {
  shipment: ShipmentRecord
  customer: CustomerRecord | null
  /** A carrier is booked: an unconfirmed tracking mode then shows the amber "Tracking mode not set" chip. */
  hasCarrier?: boolean
  /** Called after a successful save so the owner re-reads the shipment. */
  onSaved: () => void | Promise<void>
}) {
  const override = parseTrackingPrefs(shipment.trackingPrefs)
  const saved = draftOf(override)
  const effective = effectiveTrackingPrefs({ shipment, customer })
  const inherited = effectiveTrackingPrefs({ customer })
  const [draft, setDraft] = useState<Draft>(saved)
  const [busy, setBusy] = useState(false)
  const dirty = draft.mode !== saved.mode || draft.method !== saved.method || draft.driverSms !== saved.driverSms

  const save = async () => {
    setBusy(true)
    try {
      await setTrackingPrefs({ shipmentId: shipment.id, prefs: overrideOf(draft) })
      await onSaved()
    } catch (err) {
      // The draft stays: the tracker can fix it and try again.
      toast.error(err instanceof Error ? err.message : 'Could not save tracking settings')
    } finally {
      setBusy(false)
    }
  }

  const inForce = [
    effective.mode ? SHORT_MODE[effective.mode] : 'not set',
    effective.method ? SHORT_METHOD[effective.method] : 'plan channels',
    DRIVER_SMS_TARGET_LABELS[effective.driverSms].toLowerCase(),
  ].join(' · ')

  return (
    <div className="tms-strip-prefs" data-testid="tracking-prefs-row">
      <span className="tms-strip-prefs-label">Tracking</span>
      <TrackingModeNotSetChip shipment={shipment} hasCarrier={hasCarrier} />
      <TmsSelect aria-label="Mode" data-field="mode" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
        <option value="">Inherit ({inherited.mode ? TRACKING_MODE_LABELS[inherited.mode] : 'not set'})</option>
        {TRACKING_MODES.map((m) => <option key={m} value={m}>{TRACKING_MODE_LABELS[m]}</option>)}
      </TmsSelect>
      <TmsSelect aria-label="Method" data-field="method" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as Draft['method'] })}>
        <option value="">Inherit ({inherited.method ? TRACKING_METHOD_LABELS[inherited.method] : 'not set'})</option>
        {TRACKING_METHODS.map((m) => <option key={m} value={m}>{TRACKING_METHOD_LABELS[m]}</option>)}
      </TmsSelect>
      <TmsSelect aria-label="Driver SMS to" data-field="sms" value={draft.driverSms} onChange={(e) => setDraft({ ...draft, driverSms: e.target.value as Draft['driverSms'] })}>
        <option value="">Inherit ({DRIVER_SMS_TARGET_LABELS[inherited.driverSms]})</option>
        {DRIVER_SMS_TARGETS.map((m) => <option key={m} value={m}>{DRIVER_SMS_TARGET_LABELS[m]}</option>)}
      </TmsSelect>
      <TmsButton size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</TmsButton>
      <TmsButton size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>Reset</TmsButton>
      <span className="tms-strip-prefs-effective tms-muted" data-testid="tracking-prefs-effective" title={`In force: ${inForce}`}>
        In force: {inForce}
        {override ? <span className="tms-dot" role="img" aria-label="customised for this shipment" title="Customised for this shipment" data-testid="tracking-prefs-dot" /> : null}
      </span>
    </div>
  )
}
