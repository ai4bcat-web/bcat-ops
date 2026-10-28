/**
 * Issuing a credit memo: money owed back to the customer, sitting unapplied until a
 * payment spends it.
 *
 * A memo is never applied here. `planPayment` refuses a CREDIT_MEMO that carries
 * applications, for the good reason that a credit which lands straight on an invoice
 * leaves no record of why the customer was owed anything — so this dialog issues the
 * amount and the reason, and Receive Payment is where it gets used.
 *
 * The note is required, and the `clientRequestId` is generated once per mount: a Post
 * that times out can be pressed again without issuing the credit twice.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createCredit, graphqlErrorText } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateInput } from '@/lib/date'
import { centsFromInput } from './money'

export function CreditMemoDialog({ customerId, customerName, busy, onClose, onDone }: {
  customerId: string
  customerName?: string
  busy?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [memoDate, setMemoDate] = useState(() => formatDateInput(new Date().toISOString()))
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amountCents = centsFromInput(amount)
  const disabled = busy === true || posting
  const ready = amountCents !== null && amountCents > 0 && note.trim().length > 0

  const submit = () => {
    if (amountCents === null || amountCents <= 0 || !note.trim()) return
    setPosting(true)
    setError(null)
    createCredit({
      customerId,
      memoDate,
      amountCents,
      note: note.trim(),
      clientRequestId,
      reference: reference.trim() || undefined,
    })
      .then((row) => {
        toast.success(row.duplicate
          ? 'That credit memo was already issued'
          : `Credit of ${formatCents(row.payment.amountCents)} issued`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setPosting(false))
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Credit memo{customerName ? ` — ${customerName}` : ''}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Memo date</Label>
            <Input
              aria-label="Credit memo date"
              type="date"
              value={memoDate}
              disabled={disabled}
              onChange={(e) => setMemoDate(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Amount</Label>
            <Input
              aria-label="Credit memo amount"
              inputMode="decimal"
              value={amount}
              disabled={disabled}
              placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reference</Label>
            <Input
              aria-label="Credit memo reference"
              value={reference}
              disabled={disabled}
              placeholder="optional — claim or memo #"
              onChange={(e) => setReference(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reason</Label>
            <Textarea
              aria-label="Credit memo reason"
              rows={3}
              value={note}
              disabled={disabled}
              placeholder="why this customer is owed money"
              onChange={(e) => setNote(e.target.value)}
              className="text-sm"
            />
          </div>
          {amount.trim() && amountCents === null && (
            <p className="col-span-2 text-xs text-destructive">
              Enter a nonnegative amount with at most two decimal places.
            </p>
          )}
          {error && <p className="col-span-2 text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Issued unapplied — spend it on an invoice through Receive payment.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={posting}>Cancel</Button>
            <Button onClick={submit} disabled={disabled || !ready}>
              {posting ? 'Issuing…' : 'Issue credit'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
