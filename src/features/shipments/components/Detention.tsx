/**
 * Detention flag UI (Ryne 2026-11-13): the pill a flagged shipment wears, and the dialog that raises,
 * edits or clears the flag. The flag itself, its validation and its wording live in `@/lib/detentionFlag`;
 * the write is tms-shipment-actions SET_DETENTION_FLAG (stamps who and when, logs it in Activity).
 */
import { useState } from 'react'
import { Hourglass } from 'lucide-react'
import { toast } from 'sonner'
import { DateTime24Input } from '@/features/shipments/form/DateTime24Input'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { setDetentionFlag } from '@/lib/apiClient'
import { formatDateTime, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import {
  DETENTION_NOTE_MAX, detentionSummary, detentionTooltip, hoursBetween, parseDetentionFlag,
  type DetentionFlag, type DetentionStopType,
} from '@/lib/detentionFlag'
import { errorText } from '@/lib/errorText'
import type { boardStatusOf } from '@/lib/shipmentViewDefs'
import type { ShipmentRecord } from '@/types/tms'

/** The "Detention" pill, with stop, hours, note, who and when on hover. Renders nothing when not flagged. */
export function DetentionPill({ flag, onClick }: { flag: unknown; onClick?: () => void }) {
  const parsed = parseDetentionFlag(flag)
  if (!parsed) return null
  const badge = (
    <TmsBadge tone="orange" title={detentionTooltip(parsed, formatDateTime)} data-testid="detention-pill">
      <Hourglass size={11} aria-hidden style={{ marginRight: 3, verticalAlign: '-1px' }} />Detention
    </TmsBadge>
  )
  if (!onClick) return badge
  return (
    <button type="button" className="tms-plain-button" onClick={(e) => { e.stopPropagation(); onClick() }} aria-label="Edit detention flag" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
      {badge}
    </button>
  )
}

/** A full-width notice for the shipment page and Load Review: billing must add the detention charge by hand. */
export function DetentionNotice({ flag, onEdit }: { flag: unknown; onEdit?: () => void }) {
  const parsed = parseDetentionFlag(flag)
  if (!parsed) return null
  return (
    <div data-testid="detention-notice"><TmsAlert tone="orange" title={`Detention: ${detentionSummary(parsed)}`}>
      <span style={{ whiteSpace: 'pre-line' }}>
        {[
          parsed.arrivedAt ? `Arrived ${formatDateTime(parsed.arrivedAt)}` : '',
          parsed.departedAt ? `Departed ${formatDateTime(parsed.departedAt)}` : '',
          parsed.note ?? '',
          `Flagged by ${parsed.flaggedBy} · ${formatDateTime(parsed.flaggedAt)}`,
          'Billing: add the detention charge to the customer invoice and check the carrier\'s detention bill.',
        ].filter(Boolean).join('\n')}
      </span>
      {onEdit && (
        <div style={{ marginTop: 6 }}>
          <TmsButton size="sm" onClick={onEdit}>Edit detention</TmsButton>
        </div>
      )}
    </TmsAlert></div>
  )
}

export interface DetentionTarget {
  id: string
  number?: string | null
  detentionFlag?: unknown
  pickupName?: string | null
  consigneeName?: string | null
  originCity?: string | null
  destinationCity?: string | null
  /** The board status, to guess which stop the truck is sitting at. */
  defaultStop?: DetentionStopType
}

const stopLabelOf = (t: DetentionTarget, stop: DetentionStopType): string => {
  const name = stop === 'pickup' ? (t.pickupName || t.originCity) : (t.consigneeName || t.destinationCity)
  return `${stop === 'pickup' ? 'Pickup' : 'Delivery'}${name ? ` · ${name}` : ''}`
}

/** Raise, edit or clear the detention flag on one shipment. */
export function DetentionDialog({ target, onClose, onSaved }: {
  target: DetentionTarget
  onClose: () => void
  onSaved?: (shipment: ShipmentRecord) => void
}) {
  const existing: DetentionFlag | null = parseDetentionFlag(target.detentionFlag)
  const [stop, setStop] = useState<DetentionStopType>(existing?.stopType ?? target.defaultStop ?? 'pickup')
  const [arrived, setArrived] = useState(existing?.arrivedAt ? formatDateTimeInput(existing.arrivedAt) : '')
  const [departed, setDeparted] = useState(existing?.departedAt ? formatDateTimeInput(existing.departedAt) : '')
  const [hours, setHours] = useState(existing?.hours != null ? String(existing.hours) : '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const arrivedIso = arrived ? fromDateTimeInput(arrived) : null
  const departedIso = departed ? fromDateTimeInput(departed) : null
  const worked = hoursBetween(arrivedIso, departedIso)

  const save = async (clear: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const { shipment } = await setDetentionFlag({
        shipmentId: target.id,
        flag: clear ? null : {
          stopType: stop,
          stopLabel: stopLabelOf(target, stop),
          arrivedAt: arrivedIso,
          departedAt: departedIso,
          hours: hours.trim() ? Number(hours) : null,
          note: note.trim() || null,
        },
      })
      toast.success(clear ? `Detention cleared on ${target.number ?? 'the shipment'}` : `${target.number ?? 'Shipment'} flagged for detention`)
      onSaved?.(shipment)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`${existing ? 'Detention' : 'Flag detention'}${target.number ? ` · ${target.number}` : ''}`}
      description="Marks the load as needing detention. Billing sees it in Load Review; no charge is added automatically."
      footer={(
        <>
          {existing && <TmsButton variant="ghost" disabled={busy} onClick={() => void save(true)} data-testid="detention-clear">Clear flag</TmsButton>}
          <TmsButton variant="secondary" disabled={busy} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={busy} onClick={() => void save(false)} data-testid="detention-save">{existing ? 'Save' : 'Flag detention'}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <TmsField label="Stop" htmlFor="detention-stop">
          <TmsSelect id="detention-stop" value={stop} onChange={(e) => setStop(e.target.value as DetentionStopType)}>
            <option value="pickup">{stopLabelOf(target, 'pickup')}</option>
            <option value="delivery">{stopLabelOf(target, 'delivery')}</option>
          </TmsSelect>
        </TmsField>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <TmsField label="Arrived (optional)">
            <DateTime24Input value={arrived} onChange={setArrived} inputProps={{ 'aria-label': 'Arrived date', id: 'detention-arrived' }} />
          </TmsField>
          <TmsField label="Departed (optional)">
            <DateTime24Input value={departed} onChange={setDeparted} inputProps={{ 'aria-label': 'Departed date', id: 'detention-departed' }} />
          </TmsField>
        </div>
        <TmsField label="Hours waited (optional)" htmlFor="detention-hours" hint={worked != null && !hours.trim() ? `${worked} hrs from arrived to departed` : undefined}>
          <TmsInput id="detention-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder={worked != null ? String(worked) : 'e.g. 3.5'} />
        </TmsField>
        <TmsField label="Note (optional)" htmlFor="detention-note">
          <TmsTextarea id="detention-note" rows={2} maxLength={DETENTION_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Receiver had no door until 14:30" />
        </TmsField>
        {error && <TmsAlert tone="red">{error}</TmsAlert>}
      </div>
    </TmsDialog>
  )
}

/** The notice plus its own edit dialog, for pages that show one shipment (detail, edit form, Load Review). */
export function DetentionSection({ shipment, onChanged, canEdit = true }: {
  shipment: DetentionTarget & { status?: Parameters<typeof boardStatusOf>[0]['status'] }
  onChanged?: () => void
  canEdit?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!parseDetentionFlag(shipment.detentionFlag)) return null
  return (
    <>
      <DetentionNotice flag={shipment.detentionFlag} onEdit={canEdit ? () => setOpen(true) : undefined} />
      {open && <DetentionDialog target={shipment} onClose={() => setOpen(false)} onSaved={() => onChanged?.()} />}
    </>
  )
}
