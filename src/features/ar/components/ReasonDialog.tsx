/**
 * The written reason behind a correction — voiding an invoice, reversing a receipt.
 *
 * Both are irreversible postings that an auditor reads back months later, so neither is
 * a bare confirm: the Lambda requires the text and this dialog is where it is typed.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'

export function ReasonDialog({ title, description, label, confirmLabel, tone = 'destructive', busy, onClose, onConfirm }: {
  title: string
  description: string
  label: string
  confirmLabel: string
  /** A correction is destructive; recording what already happened by hand is not. */
  tone?: 'destructive' | 'default'
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      description={description}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            aria-label={confirmLabel}
            disabled={busy || reason.trim().length === 0}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </TmsButton>
        </>
      }
    >
      <TmsField label={label} htmlFor="ar-reason">
        <TmsTextarea
          id="ar-reason"
          aria-label={label}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </TmsField>
    </TmsDialog>
  )
}
