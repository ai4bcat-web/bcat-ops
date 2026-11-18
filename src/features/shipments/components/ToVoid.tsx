/**
 * To-void flag UI (Ryne 2026-11-18): the pill a shipment flagged to be voided wears, and the dialog that raises, edits or clears
 * the flag. The flag itself, its validation and its wording live in `@/lib/toVoidFlag`; the write is tms-shipment-actions
 * SET_TO_VOID_FLAG (stamps who and when, logs it in Activity). Mirrors the detention and TONU flags next door, but it is only a
 * review marker: the shipment stays live until someone voids it, and "Void now" opens the usual Void dialog with the reason filled in.
 */
import { useState } from 'react'
import { Ban } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { setToVoidFlag } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { TO_VOID_NOTE_MAX, TO_VOID_REASON_MAX, parseToVoidFlag, toVoidSummary, toVoidTooltip } from '@/lib/toVoidFlag'
import { useAppStore } from '@/store/useAppStore'
import type { ShipmentRecord } from '@/types/tms'
import { VoidShipmentDialog } from './VoidShipmentDialog'

/** The "To void" pill, with reason, note, who and when on hover. Renders nothing when not flagged. */
export function ToVoidPill({ flag, onClick }: { flag: unknown; onClick?: () => void }) {
  const parsed = parseToVoidFlag(flag)
  if (!parsed) return null
  const badge = (
    <TmsBadge tone="red" title={toVoidTooltip(parsed, formatDateTime)} data-testid="to-void-pill">
      <Ban size={11} aria-hidden style={{ marginRight: 3, verticalAlign: '-1px' }} />To void
    </TmsBadge>
  )
  if (!onClick) return badge
  return (
    <button type="button" className="tms-plain-button" onClick={(e) => { e.stopPropagation(); onClick() }} aria-label="Edit to-void flag" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
      {badge}
    </button>
  )
}

/** A full-width notice for the shipment page: the shipment is still live until someone voids it. */
export function ToVoidNotice({ flag, onEdit }: { flag: unknown; onEdit?: () => void }) {
  const parsed = parseToVoidFlag(flag)
  if (!parsed) return null
  return (
    <div data-testid="to-void-notice"><TmsAlert tone="red" title={toVoidSummary(parsed)}>
      <span style={{ whiteSpace: 'pre-line' }}>
        {[
          parsed.note ?? '',
          `Flagged by ${parsed.flaggedBy} · ${formatDateTime(parsed.flaggedAt)}`,
          'This shipment is still live (calendar, billing, pay) until someone voids it.',
        ].filter(Boolean).join('\n')}
      </span>
      {onEdit && (
        <div style={{ marginTop: 6 }}>
          <TmsButton size="sm" onClick={onEdit}>Review flag</TmsButton>
        </div>
      )}
    </TmsAlert></div>
  )
}

export interface ToVoidTarget {
  id: string
  number?: string | null
  updatedAt?: string
  toVoidFlag?: unknown
}

/** Raise, edit, clear, or act on the to-void flag of one shipment. */
export function ToVoidDialog({ target, onClose, onSaved, onVoided }: {
  target: ToVoidTarget
  onClose: () => void
  onSaved?: (shipment: ShipmentRecord) => void
  /** The shipment was voided from here (the flag is cleared with it). */
  onVoided?: () => void
}) {
  const existing = parseToVoidFlag(target.toVoidFlag)
  const [reason, setReason] = useState(existing?.reason ?? '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voiding, setVoiding] = useState(false)

  const save = async (clear: boolean) => {
    if (!clear && !reason.trim()) { setError('Say why this shipment should be voided.'); return }
    setBusy(true)
    setError(null)
    try {
      const { shipment } = await setToVoidFlag({
        shipmentId: target.id,
        flag: clear ? null : { reason: reason.trim(), note: note.trim() || null },
      })
      toast.success(clear ? `To-void flag cleared on ${target.number ?? 'the shipment'}` : `${target.number ?? 'Shipment'} flagged to void`)
      onSaved?.(shipment)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (voiding) {
    return (
      <VoidShipmentDialog
        shipment={{ id: target.id, number: target.number ?? '', updatedAt: target.updatedAt ?? '' }}
        initialReason={reason.trim() || existing?.reason}
        open
        onClose={() => setVoiding(false)}
        onVoided={() => {
          // Off the calendar at once, as the row menu's own Void does.
          useAppStore.getState().markShipmentLoadsVoided(target.id, new Date().toISOString())
          toast.success(`${target.number ?? 'Shipment'} voided`)
          onVoided?.()
          onClose()
        }}
      />
    )
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`${existing ? 'To void' : 'Flag to void'}${target.number ? ` · ${target.number}` : ''}`}
      description="Marks the shipment for review as one that should be voided. Nothing changes until someone voids it: it stays on the calendar and in billing and pay."
      footer={(
        <>
          {existing && <TmsButton variant="ghost" disabled={busy} onClick={() => void save(true)} data-testid="to-void-clear">Clear flag</TmsButton>}
          {existing && <TmsButton variant="destructive" disabled={busy} onClick={() => setVoiding(true)} data-testid="to-void-now">Void now…</TmsButton>}
          <TmsButton variant="secondary" disabled={busy} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={busy} onClick={() => void save(false)} data-testid="to-void-save">{existing ? 'Save' : 'Flag to void'}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <TmsField label="Why should it be voided?" htmlFor="to-void-reason" hint={`Required. ${TO_VOID_REASON_MAX} characters at most.`}>
          <TmsInput id="to-void-reason" maxLength={TO_VOID_REASON_MAX} value={reason} onChange={(e) => { setReason(e.target.value); setError(null) }} placeholder="e.g. Duplicate of 14872" />
        </TmsField>
        <TmsField label="Note (optional)" htmlFor="to-void-note">
          <TmsTextarea id="to-void-note" rows={2} maxLength={TO_VOID_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the person voiding it should know" />
        </TmsField>
        {error && <TmsAlert tone="red">{error}</TmsAlert>}
      </div>
    </TmsDialog>
  )
}

/** The notice plus its own dialog, for pages that show one shipment (the edit form). */
export function ToVoidSection({ shipment, onChanged, canEdit = true }: {
  shipment: ToVoidTarget
  onChanged?: () => void
  canEdit?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!parseToVoidFlag(shipment.toVoidFlag)) return null
  return (
    <>
      <ToVoidNotice flag={shipment.toVoidFlag} onEdit={canEdit ? () => setOpen(true) : undefined} />
      {open && <ToVoidDialog target={shipment} onClose={() => setOpen(false)} onSaved={() => onChanged?.()} onVoided={() => onChanged?.()} />}
    </>
  )
}
