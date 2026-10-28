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
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {quote.id} lost</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            It is {statusLabel(quote).toLowerCase()} now. Closing it takes it off the board and leaves it on the
            month's record; it can be restored.
          </p>

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="mark-lost-reason">
              Why we did not get it
            </Label>
            <select
              id="mark-lost-reason"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value as QuoteLostReason)}
            >
              {LOST_REASONS.map((value) => (
                <option key={value} value={value}>{LOST_REASON_LABEL[value]}</option>
              ))}
            </select>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="mark-lost-note">
              Anything worth remembering
            </Label>
            <Textarea
              id="mark-lost-note"
              rows={2}
              className="text-sm"
              value={note}
              disabled={busy}
              placeholder="who they went with, what they paid"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" aria-label="Mark the quote lost" disabled={busy} onClick={submit}>
            {busy ? 'Closing…' : 'Mark lost'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
