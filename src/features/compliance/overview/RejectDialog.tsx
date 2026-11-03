import { useState } from 'react'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsField } from '@/features/tms/kit/TmsField'
import { TmsTextarea } from '@/features/tms/kit/TmsInput'

/**
 * The reason a document is sent back. The driver is e-mailed this text, so a blank
 * reason cannot be submitted — rejecting with no explanation leaves them guessing.
 */
export function RejectDialog({
  documentTitle, busy, onCancel, onSubmit,
}: {
  documentTitle: string
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onCancel() }}
      title={`Reject ${documentTitle}`}
      description="The driver is e-mailed this reason and the item returns to their list."
      footer={(
        <>
          <TmsButton variant="secondary" onClick={onCancel} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="reject" disabled={!trimmed || busy} onClick={() => onSubmit(trimmed)}>
            {busy ? 'Rejecting…' : 'Reject document'}
          </TmsButton>
        </>
      )}
    >
      <TmsField label="Reason">
        <TmsTextarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Photo is blurry — please re-upload" autoFocus />
      </TmsField>
    </TmsDialog>
  )
}
