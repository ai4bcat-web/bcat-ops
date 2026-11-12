/**
 * The Intake duplicate affordances: the delete confirm (owner/ADMIN) and the amber "Possible duplicate" notice that asks whether to
 * delete this one. Used by the queue rows and the review page.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { deleteIntake, markIntakeNotDuplicate } from '@/lib/apiClient'
import { intakeRowLabel, type DuplicateInfo } from '@/lib/intakeDuplicates'
import type { IntakeLoadRecord } from '@/types/intake'

export function DeleteIntakeDialog({ row, open, onOpenChange, onDeleted }: {
  row: IntakeLoadRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (row: IntakeLoadRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const done = await deleteIntake({ intakeId: row.id, expectedVersion: row.version })
      toast.success('Deleted from Intake')
      onOpenChange(false)
      onDeleted(done)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this load from Intake?"
      description={`${intakeRowLabel(row)}. It is removed from Intake only: a shipment already built from it is not touched, and repeat e-mails for it will not bring it back.`}
      footer={(
        <div className="tms-intake-footer">
          <TmsButton size="sm" onClick={() => onOpenChange(false)}>Cancel</TmsButton>
          <TmsButton size="sm" variant="destructive" data-testid="intake-delete-confirm" disabled={busy} onClick={() => { void run() }}>Delete</TmsButton>
        </div>
      )}
    >
      {null}
    </TmsDialog>
  )
}

/** "Possible duplicate. Delete this one?" with who the other row is; owner/ADMIN get the delete, everyone who reviews gets "Not a duplicate". */
export function DuplicateNotice({ row, info, isAdmin, canReview, onDelete, onChanged }: {
  row: IntakeLoadRecord
  info: DuplicateInfo
  isAdmin: boolean
  canReview: boolean
  onDelete: () => void
  onChanged: (row: IntakeLoadRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  const other = info.isOriginal ? info.otherIds[0] : info.originalId
  async function notDuplicate() {
    setBusy(true)
    try {
      onChanged(await markIntakeNotDuplicate({ intakeId: row.id, expectedVersion: row.version }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tms-intake-dup" data-testid="intake-dup-notice" onClick={(e) => e.stopPropagation()}>
      <TmsBadge tone="orange">Possible duplicate</TmsBadge>
      <span className="tms-intake-dup-q">
        {info.isOriginal ? `Same as ${info.count - 1} later e-mail${info.count - 1 === 1 ? '' : 's'}. ` : `Same as ${info.originalLabel}. `}
        Delete this one?
      </span>
      {other ? <Link className="tms-intake-dup-link" to={`/tms/shipments/intake/${encodeURIComponent(other)}`}>{info.isOriginal ? 'See the other' : 'See the original'}</Link> : null}
      {isAdmin ? <TmsButton size="sm" variant="destructive" data-testid="intake-dup-delete" disabled={busy} onClick={onDelete}>Delete duplicate</TmsButton> : null}
      {canReview ? <TmsButton size="sm" variant="ghost" data-testid="intake-dup-not" disabled={busy} onClick={() => { void notDuplicate() }}>Not a duplicate</TmsButton> : null}
    </div>
  )
}
