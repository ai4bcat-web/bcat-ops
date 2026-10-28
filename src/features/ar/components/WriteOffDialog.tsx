/**
 * Writing off what will not be collected.
 *
 * A write-off settles an invoice exactly as cash does — balance is total less paid less
 * written off — so the preview here is `writeOffPlan`, the same planner the Lambda runs,
 * and the resulting status is stated before anything is posted. Over-writing a balance
 * is refused rather than clamped, with the numbers in the sentence.
 *
 * The reason is required: a balance that vanished without one is indistinguishable from
 * a bug six months later. The `clientRequestId` is generated once per mount, so a retried
 * Post cannot write the same amount off twice.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { graphqlErrorText, writeOffInvoice } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { writeOffPlan } from '@/lib/paymentApply'
import { centsFromInput, inputFromCents } from './money'
import type { InvoiceRecord } from '@/types/tms'

export function WriteOffDialog({ invoice, busy, onClose, onDone }: {
  invoice: InvoiceRecord
  busy?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [amount, setAmount] = useState(() => inputFromCents(invoice.balanceCents))
  const [reason, setReason] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amountCents = centsFromInput(amount) ?? 0
  const plan = writeOffPlan({
    id: invoice.id,
    customerId: invoice.customerId,
    status: invoice.status,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    writtenOffCents: invoice.writtenOffCents,
    balanceCents: invoice.balanceCents,
    number: invoice.number,
  }, amountCents)
  const after = plan.invoices[0] ?? null
  const disabled = busy === true || posting
  const ready = plan.ok && reason.trim().length > 0

  const submit = () => {
    if (!ready) return
    setPosting(true)
    setError(null)
    writeOffInvoice({ invoiceId: invoice.id, amountCents, reason: reason.trim(), clientRequestId })
      .then((row) => {
        toast.success(row.duplicate
          ? 'That write-off was already posted'
          : `Wrote off ${formatCents(row.payment.amountCents)} on ${invoice.number}`)
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
        <DialogHeader><DialogTitle>Write off invoice {invoice.number}</DialogTitle></DialogHeader>

        <p className="rounded-lg border border-border bg-muted/30 p-2 text-xs">
          {formatCents(invoice.totalCents)} billed · {formatCents(invoice.paidCents)} paid ·
          {' '}<strong>{formatCents(invoice.balanceCents)} outstanding</strong>
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Amount</Label>
            <Input
              aria-label="Write-off amount"
              inputMode="decimal"
              value={amount}
              disabled={disabled}
              placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex items-end">
            <p className="text-xs text-muted-foreground">
              {after
                ? `Leaves ${formatCents(after.balanceCents)} — ${after.status.toLowerCase()}`
                : 'Nothing to post yet'}
            </p>
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reason</Label>
            <Textarea
              aria-label="Write-off reason"
              rows={3}
              value={reason}
              disabled={disabled}
              placeholder="why this balance will not be collected"
              onChange={(e) => setReason(e.target.value)}
              className="text-sm"
            />
          </div>
          {plan.errors.map((text) => (
            <p key={text} className="col-span-2 text-xs text-destructive">{text}</p>
          ))}
          {error && <p className="col-span-2 text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Posted as a WRITE_OFF row — the balance is settled, not collected.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={posting}>Cancel</Button>
            <Button onClick={submit} disabled={disabled || !ready}>
              {posting ? 'Posting…' : 'Write off'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
