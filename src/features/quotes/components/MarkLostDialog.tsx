/**
 * Closing a quote nobody took.
 *
 * The reason is the point: "too high" and "no truck available" are different businesses
 * to fix, and a lost column with one bucket in it teaches nothing. EXPIRED and
 * NO_RESPONSE are offered here because a human may close a quote for the same reason the
 * sweep would have — they are conclusions about silence, not things somebody said.
 *
 * A lost quote is restorable. Nothing here deletes anything.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, markQuoteLost } from '@/lib/apiClient'
import { LOST_REASONS } from '@/lib/quotes'
import { LOST_REASON_LABEL, statusLabel } from '../quoteViews'
import type { QuoteLostReason, QuoteRecord } from '@/types/tms'

export function MarkLostDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = useState<QuoteLostReason>('TOO_HIGH')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    setBusy(true)
    setError(null)
    markQuoteLost({
      quoteId: quote.id,
      expectedVersion: quote.version,
      reason,
      note: note.trim() || undefined,
    })
      .then(() => {
        toast.success(`${quote.id} marked lost — ${LOST_REASON_LABEL[reason].toLowerCase()}`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Mark ${quote.id} lost`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="destructive" aria-label="Mark the quote lost" disabled={busy} onClick={submit}>
            {busy ? 'Closing…' : 'Mark lost'}
          </TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="tms-muted" style={{ fontSize: 13 }}>
          It is {statusLabel(quote).toLowerCase()} now. Closing it takes it off the board and leaves it on the
          month's record; it can be restored.
        </p>

        <TmsField label="Why we did not get it" htmlFor="mark-lost-reason">
          <TmsSelect
            id="mark-lost-reason"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as QuoteLostReason)}
            options={LOST_REASONS.map((value) => ({ value, label: LOST_REASON_LABEL[value] }))}
          />
        </TmsField>

        <TmsField label="Anything worth remembering" htmlFor="mark-lost-note">
          <TmsTextarea
            id="mark-lost-note"
            rows={2}
            value={note}
            disabled={busy}
            placeholder="who they went with, what they paid"
            onChange={(e) => setNote(e.target.value)}
          />
        </TmsField>

        {error && <p className="tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
