/** The amber "Tracking mode not set" chip: a carrier is booked but nobody confirmed how the load is tracked. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { setTrackingPrefs } from '@/lib/apiClient'
import { parseTrackingPrefs, trackingModeNotSet, type TrackingPrefsOverride } from '@/lib/trackingPrefs'
import { rowLinkStage } from '@/lib/trackingLinkState'
import { TRACKING_SET_PATH, isCoveredAndLive } from './trackingModeRow'
import './trackingModeControl.css'

export const TRACKING_NOT_SET_TEXT = 'Tracking link not sent'
export const TRACKING_NOT_REQUIRED_TEXT = 'Tracking not required'

export function TrackingModeNotSetChip({ shipment, hasCarrier, className }: {
  shipment: { trackingPrefs?: unknown; createdAt?: string | null } | null
  hasCarrier: boolean
  className?: string
}) {
  if (!trackingModeNotSet(shipment, hasCarrier)) return null
  return (
    <span
      className={`tms-trk-notset${className ? ` ${className}` : ''}`} data-testid="tracking-not-set"
      title="A carrier is booked but the tracking mode was never confirmed for this load. Automation is off; the rate con is not blocked."
    >
      {TRACKING_NOT_SET_TEXT}
    </span>
  )
}

/**
 * A board / Load Tracking row. Covered, live and no tracking mode yet: an amber chip that opens a small dialog with the two ways out:
 * set tracking (the shipment's Carrier & Tracking card: dispatcher name, e-mail and phone, or driver name, phone, truck and trailer,
 * either or both) or mark tracking not required. A load marked not required shows a gray "Tracking not required" pill instead.
 */
export function TrackingModeNotSetRowChip({ row }: {
  row: { id?: string; revDivision?: string | null; number?: string | null; trackingPrefs?: unknown; createdAt?: string | null; assignmentType?: string | null; status?: string | null; voidedAt?: string | null; trackingStartedAt?: string | null; trackingStoppedAt?: string | null; trackingAcceptedAt?: string | null }
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [marked, setMarked] = useState(false)
  if (!isCoveredAndLive(row)) return null
  const notRequired = marked || parseTrackingPrefs(row.trackingPrefs)?.mode === 'NONE'
  if (notRequired) {
    return <span className="tms-trk-notreq tms-trk-notset-row" data-testid="tracking-not-required" title="Tracking is not required on this load.">{TRACKING_NOT_REQUIRED_TEXT}</span>
  }
  // The chip follows the link itself: once a link has gone out, "not sent" is false, whatever the old tracking-mode setting says.
  const stage = rowLinkStage(row)
  if (stage === 'ACCEPTED') return <TmsBadge tone="green" className="tms-trk-notset-row" data-testid="tracking-link-accepted" title="The driver accepted the tracking link and is sharing location.">Driver accepted</TmsBadge>
  if (stage === 'SENT') return <TmsBadge tone="blue" className="tms-trk-notset-row" data-testid="tracking-link-sent" title="A tracking link has been sent to the driver; waiting for them to accept.">Tracking link sent</TmsBadge>
  const className = 'tms-trk-notset tms-trk-notset-row'
  const title = 'Covered, but no tracking link has been sent yet. Click to send one or mark tracking not required.'
  if (!row.id) return <span className={className} data-testid="tracking-not-set" title={title}>{TRACKING_NOT_SET_TEXT}</span>
  const id = row.id
  const markNotRequired = async () => {
    setBusy(true)
    try {
      // Mode NONE with confirmed: true is the "no tracking on this load" choice the Tracking card's None button saves.
      await setTrackingPrefs({ shipmentId: id, prefs: { mode: 'NONE', confirmed: true } as unknown as TrackingPrefsOverride })
      setMarked(true)
      setOpen(false)
      toast.success(`Tracking marked not required${row.number ? ` on ${row.number}` : ''}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally { setBusy(false) }
  }
  return (
    <>
      <button type="button" className={`${className} tms-trk-notset-link`} data-testid="tracking-not-set" title={title} onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        {TRACKING_NOT_SET_TEXT}
      </button>
      <TmsDialog
        open={open}
        onOpenChange={setOpen}
        title={`Tracking${row.number ? ` · ${row.number}` : ''}`}
        description="This load is covered but nobody has said how it is tracked. Add the dispatcher (name, e-mail, phone) or the driver (name, phone, truck, trailer number), or both. Or mark that no tracking is needed."
        footer={(
          <>
            <TmsButton variant="ghost" onClick={() => setOpen(false)}>Cancel</TmsButton>
            <TmsButton variant="secondary" disabled={busy} onClick={() => void markNotRequired()}>Tracking not required</TmsButton>
            <TmsButton variant="primary" onClick={() => navigate(TRACKING_SET_PATH(id))}>Set tracking</TmsButton>
          </>
        )}
      >
        <p className="text-sm">Set tracking opens the shipment's Carrier &amp; Tracking card.</p>
      </TmsDialog>
    </>
  )
}
