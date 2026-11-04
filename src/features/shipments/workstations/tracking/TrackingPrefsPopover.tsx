/**
 * Per-shipment override of how this load is tracked. Each of the three choices can inherit
 * the customer (first option) or be pinned for this shipment only; pinning nothing clears
 * the override. The button always says what is in force right now.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsSelect } from '@/features/tms/kit'
import { setTrackingPrefs } from '@/lib/apiClient'
import {
  DRIVER_SMS_TARGETS, DRIVER_SMS_TARGET_LABELS, TRACKING_METHODS, TRACKING_METHOD_LABELS, TRACKING_MODES,
  TRACKING_MODE_LABELS, effectiveTrackingPrefs, parseTrackingPrefs,
  type DriverSmsTarget, type TrackingMethod, type TrackingMode, type TrackingPrefsOverride,
} from '@/lib/trackingPrefs'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

const SHORT_MODE: Record<TrackingMode, string> = { AGENT: 'Agent', MANUAL: 'Manual' }
const SHORT_METHOD: Record<TrackingMethod, string> = { EMAIL: 'E-mail', SMS: 'SMS', BOTH: 'Both' }

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

export function TrackingPrefsPopover({ shipment, customer, onSaved }: {
  shipment: ShipmentRecord
  customer: CustomerRecord | null
  /** Called after a successful save so the owner re-reads the shipment. */
  onSaved: () => void | Promise<void>
}) {
  const override = parseTrackingPrefs(shipment.trackingPrefs)
  const effective = effectiveTrackingPrefs({ shipment, customer })
  const inherited = effectiveTrackingPrefs({ customer })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftOf(override))
  const [busy, setBusy] = useState(false)
  const host = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (host.current && !host.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  const save = async () => {
    setBusy(true)
    try {
      await setTrackingPrefs({ shipmentId: shipment.id, prefs: overrideOf(draft) })
      setOpen(false)
      await onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save tracking settings')
    } finally {
      setBusy(false)
    }
  }

  const label = `${effective.mode ? SHORT_MODE[effective.mode] : 'Not set'} · ${effective.method ? SHORT_METHOD[effective.method] : 'Plan channels'}`

  return (
    <span className="tms-strip-menu-host" ref={host}>
      <TmsButton size="sm" aria-haspopup="dialog" aria-expanded={open} data-testid="tracking-prefs-button"
        onClick={() => { if (!open) setDraft(draftOf(override)); setOpen(!open) }}>
        <Settings2 size={13} aria-hidden /> Tracking: {label}
        {override ? <span className="tms-dot" role="img" aria-label="customised for this shipment" title="Customised for this shipment" data-testid="tracking-prefs-dot" /> : null}
        <ChevronDown size={12} aria-hidden />
      </TmsButton>
      {open && (
        <div className="tms-strip-menu tms-prefs-panel" role="dialog" aria-label="Tracking for this shipment" data-testid="tracking-prefs-panel">
          <label className="tms-prefs-field">
            <span>Mode</span>
            <TmsSelect aria-label="Mode" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
              <option value="">Inherit ({inherited.mode ? TRACKING_MODE_LABELS[inherited.mode] : 'not set'})</option>
              {TRACKING_MODES.map((m) => <option key={m} value={m}>{TRACKING_MODE_LABELS[m]}</option>)}
            </TmsSelect>
          </label>
          <label className="tms-prefs-field">
            <span>Method</span>
            <TmsSelect aria-label="Method" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as Draft['method'] })}>
              <option value="">Inherit ({inherited.method ? TRACKING_METHOD_LABELS[inherited.method] : 'not set'})</option>
              {TRACKING_METHODS.map((m) => <option key={m} value={m}>{TRACKING_METHOD_LABELS[m]}</option>)}
            </TmsSelect>
          </label>
          <label className="tms-prefs-field">
            <span>Driver SMS to</span>
            <TmsSelect aria-label="Driver SMS to" value={draft.driverSms} onChange={(e) => setDraft({ ...draft, driverSms: e.target.value as Draft['driverSms'] })}>
              <option value="">Inherit ({DRIVER_SMS_TARGET_LABELS[inherited.driverSms]})</option>
              {DRIVER_SMS_TARGETS.map((m) => <option key={m} value={m}>{DRIVER_SMS_TARGET_LABELS[m]}</option>)}
            </TmsSelect>
          </label>
          <div className="tms-prefs-foot">
            <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</TmsButton>
            <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</TmsButton>
          </div>
        </div>
      )}
    </span>
  )
}
