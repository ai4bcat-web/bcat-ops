/**
 * Mark a Needs review flag reviewed (Ryne 2026-11-18: "add an ability to remove the needs review flag
 * after we've checked it"). One dialog for every place the flag is cleared: the AR and AP Needs review
 * lists, the AP bill row and the bill drawer. The note is optional; the flag's old text and the note
 * go to the audit log, so clearing a flag never loses what it said. It changes no bill and no money.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import { financeAction, type FinanceReviewShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'

export function MarkReviewedDialog({ flag, showApNote, onClose, onCleared }: {
  flag: Pick<FinanceReviewShipment, 'id' | 'number' | 'financeReviewReason' | 'financeReviewApNote'>
  /** The carrier note is carrier pay: only the AP side shows it. */
  showApNote: boolean
  onClose: () => void
  onCleared: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const pro = flag.number ?? flag.id
  const reason = flag.financeReviewReason?.trim()
  const apNote = showApNote ? flag.financeReviewApNote?.trim() : ''

  const confirm = () => {
    setBusy(true)
    financeAction('CLEAR_FINANCE_REVIEW', { shipmentId: flag.id, ...(note.trim() ? { note: note.trim() } : {}) })
      .then(() => { toast.success(`PRO ${pro} cleared from Needs review`); onCleared(); onClose() })
      .catch((e: unknown) => toast.error(errorText(e) || 'Could not clear the flag'))
      .finally(() => setBusy(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title={`Mark PRO ${pro} reviewed`}
      description="The Needs review flag comes off. What it said and your note stay in the audit log. No bill or amount changes."
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton variant="primary" onClick={confirm} disabled={busy} aria-label="Mark reviewed">Mark reviewed</TmsButton>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {(reason || apNote) && (
          <div className="text-sm">
            <div className="text-xs tms-muted">Flagged for</div>
            <div>{[reason, apNote].filter(Boolean).join(' · ')}</div>
          </div>
        )}
        <TmsField label="Note (optional)" htmlFor="review-note">
          <TmsTextarea id="review-note" aria-label="Note" rows={3} placeholder="Checked: …" value={note} onChange={(e) => setNote(e.target.value)} />
        </TmsField>
      </div>
    </TmsDialog>
  )
}
