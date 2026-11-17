/**
 * TONU flag UI (Ryne 2026-11-16): the pill a shipment waiting for a TONU wears, and the dialog that raises, edits or clears the flag.
 * The flag itself, its validation and its wording live in `@/lib/tonuFlag`; the write is tms-shipment-actions SET_TONU_FLAG
 * (stamps who and when, logs it in Activity). Mirrors the detention flag next door; nothing is charged automatically.
 */
import { useState } from 'react'
import { PackageX } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { setTonuFlag } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { TONU_NOTE_MAX, parseTonuFlag, tonuSummary, tonuTooltip } from '@/lib/tonuFlag'
import type { ShipmentRecord } from '@/types/tms'

/** The "TONU" pill, with amount, note, who and when on hover. Renders nothing when not flagged. */
export function TonuPill({ flag, onClick }: { flag: unknown; onClick?: () => void }) {
  const parsed = parseTonuFlag(flag)
  if (!parsed) return null
  const badge = (
    <TmsBadge tone="purple" title={tonuTooltip(parsed, formatDateTime)} data-testid="tonu-pill">
      <PackageX size={11} aria-hidden style={{ marginRight: 3, verticalAlign: '-1px' }} />TONU
    </TmsBadge>
  )
  if (!onClick) return badge
  return (
    <button type="button" className="tms-plain-button" onClick={(e) => { e.stopPropagation(); onClick() }} aria-label="Edit TONU flag" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
      {badge}
    </button>
  )
}

/** A full-width notice for the shipment page and Load Review: billing must add the TONU charge by hand. */
export function TonuNotice({ flag, onEdit }: { flag: unknown; onEdit?: () => void }) {
  const parsed = parseTonuFlag(flag)
  if (!parsed) return null
  return (
    <div data-testid="tonu-notice"><TmsAlert tone="orange" title={`Waiting for ${tonuSummary(parsed)}`}>
      <span style={{ whiteSpace: 'pre-line' }}>
        {[
          parsed.note ?? '',
          `Flagged by ${parsed.flaggedBy} · ${formatDateTime(parsed.flaggedAt)}`,
          'Billing: add the TONU charge to the customer invoice and check the carrier\'s TONU bill.',
        ].filter(Boolean).join('\n')}
      </span>
      {onEdit && (
        <div style={{ marginTop: 6 }}>
          <TmsButton size="sm" onClick={onEdit}>Edit TONU</TmsButton>
        </div>
      )}
    </TmsAlert></div>
  )
}

export interface TonuTarget {
  id: string
  number?: string | null
  tonuFlag?: unknown
}

/** Raise, edit or clear the TONU flag on one shipment. */
export function TonuDialog({ target, onClose, onSaved }: {
  target: TonuTarget
  onClose: () => void
  onSaved?: (shipment: ShipmentRecord) => void
}) {
  const existing = parseTonuFlag(target.tonuFlag)
  const [amount, setAmount] = useState(existing?.amount != null ? String(existing.amount) : '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (clear: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const { shipment } = await setTonuFlag({
        shipmentId: target.id,
        flag: clear ? null : { amount: amount.trim() ? Number(amount.replace(/[$,]/g, '')) : null, note: note.trim() || null },
      })
      toast.success(clear ? `TONU cleared on ${target.number ?? 'the shipment'}` : `${target.number ?? 'Shipment'} flagged waiting for TONU`)
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
      title={`${existing ? 'TONU' : 'Flag waiting for TONU'}${target.number ? ` · ${target.number}` : ''}`}
      description="Marks the load as waiting for a truck order not used (TONU) charge. Billing sees it in Load Review; no charge is added automatically."
      footer={(
        <>
          {existing && <TmsButton variant="ghost" disabled={busy} onClick={() => void save(true)} data-testid="tonu-clear">Clear flag</TmsButton>}
          <TmsButton variant="secondary" disabled={busy} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={busy} onClick={() => void save(false)} data-testid="tonu-save">{existing ? 'Save' : 'Flag TONU'}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <TmsField label="Expected TONU amount (optional)" htmlFor="tonu-amount">
          <TmsInput id="tonu-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250" />
        </TmsField>
        <TmsField label="Note (optional)" htmlFor="tonu-note">
          <TmsTextarea id="tonu-note" rows={2} maxLength={TONU_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Shipper cancelled after the truck arrived" />
        </TmsField>
        {error && <TmsAlert tone="red">{error}</TmsAlert>}
      </div>
    </TmsDialog>
  )
}

/** The notice plus its own edit dialog, for pages that show one shipment (detail, edit form, Load Review). */
export function TonuSection({ shipment, onChanged, canEdit = true }: {
  shipment: TonuTarget
  onChanged?: () => void
  canEdit?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!parseTonuFlag(shipment.tonuFlag)) return null
  return (
    <>
      <TonuNotice flag={shipment.tonuFlag} onEdit={canEdit ? () => setOpen(true) : undefined} />
      {open && <TonuDialog target={shipment} onClose={() => setOpen(false)} onSaved={() => onChanged?.()} />}
    </>
  )
}
