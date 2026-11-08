/**
 * The rep's own word that the customer took a quote. Nothing is sent and no shipment is built — a
 * quote that is converted is WON by the conversion itself; this is for the deal done by phone or
 * mail the rep already had. The note is optional.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, markQuoteWon } from '@/lib/apiClient'
import type { QuoteRecord } from '@/types/tms'

export function MarkWonDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    setBusy(true)
    setError(null)
    markQuoteWon({ quoteId: quote.id, expectedVersion: quote.version, note: note.trim() || undefined })
      .then(() => {
        toast.success(`${quote.id} marked won`)
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
      title={`Mark ${quote.id} won`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Mark the quote won" disabled={busy} onClick={submit}>
            {busy ? 'Closing…' : 'Mark won'}
          </TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="tms-muted" style={{ fontSize: 13 }}>
          Records that the customer took this quote. It counts toward the lane's win rate. No shipment is created — use
          Convert to shipment for that.
        </p>
        <TmsField label="Anything worth remembering" htmlFor="mark-won-note">
          <TmsTextarea id="mark-won-note" rows={2} value={note} disabled={busy} placeholder="how they accepted, PO number" onChange={(e) => setNote(e.target.value)} />
        </TmsField>
        {error && <p className="tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
