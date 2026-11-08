import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import { crmAction } from '@/lib/apiClient'

interface AddNoteDialogProps {
  customerId: string
  customerName: string
  onClose: () => void
  onSaved: () => void
}

/** Row action on the Customers list: one note on the account's activity timeline. */
export function AddNoteDialog({ customerId, customerName, onClose, onSaved }: AddNoteDialogProps) {
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await crmAction('CRM_ADD_ACTIVITY', { customerId, kind: 'NOTE', summary: summary.trim() })
      toast.success('Note added')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the note')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title={`Add note — ${customerName}`}
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => void save()} disabled={busy || !summary.trim()} data-testid="crm-note-save">Add note</TmsButton>
        </>
      }
    >
      <TmsField label="Note">
        <TmsTextarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} data-testid="crm-note-text" />
      </TmsField>
    </TmsDialog>
  )
}
