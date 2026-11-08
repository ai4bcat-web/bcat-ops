/** Paste a request that did not arrive by mail (a call, a text): same storage and expiry as any other. */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { spotAction } from '@/lib/apiClient'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function AddRequestDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (requestId: string) => void
}) {
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const { request } = await spotAction('SPOT_ADD_MANUAL', {
        text,
        subject: subject.trim() || undefined,
        fromEmail: fromEmail.trim() || undefined,
        fromName: fromName.trim() || undefined,
      })
      toast.success('Request added')
      setText(''); setSubject(''); setFromEmail(''); setFromName('')
      onOpenChange(false)
      onAdded(request.id)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a request"
      description="Paste the text of a quote request. A suggested response will be prepared for you to copy and send yourself."
      footer={
        <>
          <TmsButton onClick={() => onOpenChange(false)}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="spot-add-submit" disabled={busy || text.trim() === ''} onClick={() => void add()}>
            Add request
          </TmsButton>
        </>
      }
    >
      {error ? <p className="tms-field-error">{error}</p> : null}
      <TmsField label="Request text">
        <TmsTextarea data-testid="spot-add-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </TmsField>
      <TmsField label="From e-mail">
        <TmsInput data-testid="spot-add-from" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
      </TmsField>
      <TmsField label="From name">
        <TmsInput value={fromName} onChange={(e) => setFromName(e.target.value)} />
      </TmsField>
      <TmsField label="Subject (optional)">
        <TmsInput value={subject} onChange={(e) => setSubject(e.target.value)} />
      </TmsField>
    </TmsDialog>
  )
}
