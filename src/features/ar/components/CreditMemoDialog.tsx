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
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
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
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Credit memo${customerName ? ` — ${customerName}` : ''}`}
      footer={
        <>
          <p className="mr-auto text-xs tms-muted">
            Issued unapplied — spend it on an invoice through Receive payment.
          </p>
          <TmsButton variant="ghost" onClick={onClose} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !ready}>
            {posting ? 'Issuing…' : 'Issue credit'}
          </TmsButton>
        </>
      }
    >
      <div className="tms-grid tms-grid-2">
        <TmsField label="Memo date">
          <TmsInput
            aria-label="Credit memo date"
            type="date"
            value={memoDate}
            disabled={disabled}
            onChange={(e) => setMemoDate(e.target.value)}
          />
        </TmsField>
        <TmsField label="Amount">
          <TmsInput
            aria-label="Credit memo amount"
            inputMode="decimal"
            value={amount}
            disabled={disabled}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </TmsField>
      </div>
      <TmsField label="Reference">
        <TmsInput
          aria-label="Credit memo reference"
          value={reference}
          disabled={disabled}
          placeholder="optional — claim or memo #"
          onChange={(e) => setReference(e.target.value)}
        />
      </TmsField>
      <TmsField label="Reason">
        <TmsTextarea
          aria-label="Credit memo reason"
          rows={3}
          value={note}
          disabled={disabled}
          placeholder="why this customer is owed money"
          onChange={(e) => setNote(e.target.value)}
        />
      </TmsField>
      {amount.trim() && amountCents === null && (
        <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>
          Enter a nonnegative amount with at most two decimal places.
        </p>
      )}
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
