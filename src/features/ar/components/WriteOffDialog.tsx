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
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, writeOffInvoice } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { invoiceStatusAfter, writeOffPlan } from '@/lib/paymentApply'
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
    partyId: invoice.customerId,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    offsetCents: invoice.writtenOffCents,
    balanceCents: invoice.balanceCents,
    voided: invoice.status === 'VOID',
    number: invoice.number,
  }, amountCents)
  const after = plan.documents[0] ?? null
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
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Write off invoice ${invoice.number}`}
      footer={
        <>
          <p className="mr-auto text-xs tms-muted">
            Posted as a WRITE_OFF row — the balance is settled, not collected.
          </p>
          <TmsButton variant="ghost" onClick={onClose} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !ready}>
            {posting ? 'Posting…' : 'Write off'}
          </TmsButton>
        </>
      }
    >
      <p className="p-2 text-xs" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
        {formatCents(invoice.totalCents)} billed · {formatCents(invoice.paidCents)} paid ·
        {' '}<strong>{formatCents(invoice.balanceCents)} outstanding</strong>
      </p>

      <div className="tms-grid tms-grid-2">
        <TmsField label="Amount">
          <TmsInput
            aria-label="Write-off amount"
            inputMode="decimal"
            value={amount}
            disabled={disabled}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </TmsField>
        <div className="flex items-end">
          <p className="text-xs tms-muted">
            {after
              ? `Leaves ${formatCents(after.balanceCents)} — ${invoiceStatusAfter(invoice.totalCents, after.paidCents, after.offsetCents).toLowerCase()}`
              : 'Nothing to post yet'}
          </p>
        </div>
      </div>

      <TmsField label="Reason">
        <TmsTextarea
          aria-label="Write-off reason"
          rows={3}
          value={reason}
          disabled={disabled}
          placeholder="why this balance will not be collected"
          onChange={(e) => setReason(e.target.value)}
        />
      </TmsField>
      {plan.errors.map((text) => (
        <p key={text} className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{text}</p>
      ))}
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
