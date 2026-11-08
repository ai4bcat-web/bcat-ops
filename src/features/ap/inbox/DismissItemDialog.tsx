/** Step AG §7.1: dismiss a queued e-mail with a reason; its stored files are deleted server-side. */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { graphqlErrorText } from '@/lib/apiClient'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import { apInboxDismiss, DISMISS_REASONS } from './apInboxClient'

export function DismissItemDialog({ item, onOpenChange, onDone }: {
  item: ApInboxItemRecord
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = useState<string>(DISMISS_REASONS[0].code)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    setSaving(true)
    setError(null)
    apInboxDismiss(item.id, reason, note.trim() || undefined)
      .then(() => { toast.success('E-mail dismissed'); onDone() })
      .catch((e: unknown) => { const t = graphqlErrorText(e); setError(t); toast.error(t) })
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={onOpenChange}
      title="Dismiss e-mail"
      description="The e-mail and its files are removed from the portal; the mailbox itself is never touched."
      footer={
        <>
          <TmsButton onClick={() => onOpenChange(false)} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="destructive" data-testid="ap-inbox-dismiss-confirm" disabled={saving} onClick={submit}>Dismiss</TmsButton>
        </>
      }
    >
      <div className="space-y-3">
        <TmsField label="Reason">
          <TmsSelect aria-label="Dismiss reason" value={reason} onChange={(e) => setReason(e.target.value)} options={DISMISS_REASONS.map((r) => ({ value: r.code, label: r.label }))} />
        </TmsField>
        <TmsField label="Note (optional)"><TmsInput value={note} onChange={(e) => setNote(e.target.value)} /></TmsField>
        {error && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
