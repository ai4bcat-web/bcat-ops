/**
 * Posting cash against a customer's open invoices.
 *
 * Every number on this form is integer cents from the keystroke on: a typed amount is
 * parsed once by `centsFromInput` and nothing is ever added in floating point. The
 * arithmetic itself is not done here at all — `planPayment` from `@/lib/paymentApply`
 * is run on every change, which is the same function `RECORD_PAYMENT` runs, so the
 * refusals a person reads before posting are literally the refusals the server would
 * give afterwards. Post stays disabled until that plan is clean.
 *
 * `clientRequestId` is generated once per mount and sent on every attempt. A Post that
 * times out can be pressed again without any risk of charging the customer twice: the
 * Lambda recognises the id and returns the row it already wrote.
 *
 * A reference this customer has used before is a warning and never a block — the same
 * cheque number comes round again, and refusing it would be wrong more often than right.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import {
  graphqlErrorText,
  listArPaymentsByCustomer,
  listInvoicesByCustomer,
  recordPayment,
  writeOffInvoice,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { planPayment, suggestAllocation, type PlanCredit, type PlanDocument } from '@/lib/paymentApply'
import { formatDateInput } from '@/lib/date'
import { centsFromInput, inputFromCents } from './money'
import type { ArPaymentMethod, ArPaymentRecord, CreditApplication, InvoiceRecord, PaymentApplication } from '@/types/tms'

const METHODS: ArPaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CARD', 'FACTOR', 'OTHER']

/** Typed dollar boxes, keyed by the row they belong to. Blank means "nothing applied". */
type AmountDrafts = Record<string, string>

function appliedRows(drafts: AmountDrafts): { id: string; amountCents: number }[] {
  const rows: { id: string; amountCents: number }[] = []
  for (const [id, text] of Object.entries(drafts)) {
    const amountCents = centsFromInput(text)
    if (amountCents !== null && amountCents > 0) rows.push({ id, amountCents })
  }
  return rows
}

export function ReceivePaymentDialog({ customerId, customerName, invoiceId, method: initialMethod, busy, onClose, onDone }: {
  customerId: string
  customerName?: string
  invoiceId?: string
  method?: ArPaymentMethod
  busy?: boolean
  onClose: () => void
  onDone: () => void
}) {
  // One id for the life of this dialog: a retried Post is the same request, not a second one.
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [receivedAt, setReceivedAt] = useState(() => formatDateInput(new Date().toISOString()))
  const [method, setMethod] = useState<ArPaymentMethod>(initialMethod ?? 'CHECK')
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  // Overpaid: keep the extra as customer credit (default) or accept the payment as paid in full.
  const [overage, setOverage] = useState<'CREDIT' | 'ACCEPT'>('CREDIT')
  const [overageReason, setOverageReason] = useState('')
  // Short paid: the invoices whose unpaid rest is ignored (written off), each with its reason.
  const [ignoreRest, setIgnoreRest] = useState<Record<string, string>>({})
  const [allocations, setAllocations] = useState<AmountDrafts>({})
  const [creditUses, setCreditUses] = useState<AmountDrafts>({})
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([])
  const [payments, setPayments] = useState<ArPaymentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([listInvoicesByCustomer(customerId), listArPaymentsByCustomer(customerId)])
      .then(([invoiceRows, paymentRows]) => {
        const open = invoiceRows.filter((row) => row.status !== 'VOID' && row.balanceCents > 0)
        setInvoices(open)
        setPayments(paymentRows)
        // Opened from one invoice: that bill is the one being paid, in full, unless
        // the person says otherwise.
        const target = invoiceId ? open.find((row) => row.id === invoiceId) : undefined
        if (target) {
          setAllocations({ [target.id]: inputFromCents(target.balanceCents) })
          setAmount(inputFromCents(target.balanceCents))
        }
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [customerId, invoiceId])

  useEffect(() => { load() }, [load])

  // Rows that carry money: a credit memo or an overpayment, neither of them reversed.
  // A REVERSAL took its row's credit back, so offering it again would spend money that
  // no longer exists and under-bill the customer by exactly that amount.
  const credits = useMemo(
    () => payments.filter((row) =>
      row.unappliedCents > 0
      && row.kind !== 'REVERSAL'
      && row.kind !== 'WRITE_OFF'
      && !row.reversedByPaymentId),
    [payments],
  )

  const planDocuments = useMemo<PlanDocument[]>(() => invoices.map((row) => ({
    id: row.id,
    partyId: row.customerId,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    offsetCents: row.writtenOffCents,
    balanceCents: row.balanceCents,
    voided: row.status === 'VOID',
    number: row.number,
  })), [invoices])

  // Built from every row the read returned, not from the offered list: a use typed
  // before a poll revealed the reversal still reaches the planner, which refuses it by
  // name rather than reporting a credit that was "not found".
  const planCredits = useMemo<PlanCredit[]>(() => payments.map((row) => ({
    id: row.id,
    partyId: row.customerId,
    kind: row.kind,
    unappliedCents: row.unappliedCents,
    reference: row.reference,
    reversed: Boolean(row.reversedByPaymentId),
  })), [payments])

  const amountCents = centsFromInput(amount) ?? 0
  const applications = useMemo<PaymentApplication[]>(
    () => appliedRows(allocations).map((row) => ({ invoiceId: row.id, amountCents: row.amountCents })),
    [allocations],
  )
  const creditApplications = useMemo<CreditApplication[]>(
    () => appliedRows(creditUses).map((row) => ({ paymentId: row.id, amountCents: row.amountCents })),
    [creditUses],
  )

  const plan = useMemo(() => planPayment({
    kind: 'PAYMENT',
    partyId: customerId,
    amountCents,
    // The dialog posts and reads the AR shape; only the planner speaks `documentId`.
    applications: applications.map((row) => ({ documentId: row.invoiceId, amountCents: row.amountCents })),
    creditApplications,
    documents: planDocuments,
    credits: planCredits,
  }), [customerId, amountCents, applications, creditApplications, planDocuments, planCredits])

  const duplicate = useMemo(() => {
    const typed = reference.trim().toLowerCase()
    if (!typed) return null
    return payments.find((row) => (row.reference ?? '').trim().toLowerCase() === typed) ?? null
  }, [reference, payments])

  // Applied less than the invoice owes: the rest stays open to chase unless it is ignored.
  const shortPaid = useMemo(() => applications.flatMap((row) => {
    const invoice = invoices.find((candidate) => candidate.id === row.invoiceId)
    const restCents = invoice ? invoice.balanceCents - row.amountCents : 0
    return invoice && row.amountCents > 0 && restCents > 0 ? [{ invoice, restCents }] : []
  }), [applications, invoices])
  const ignoring = shortPaid.filter((row) => ignoreRest[row.invoice.id] !== undefined)
  const ignoreBlocked = ignoring.some((row) => !ignoreRest[row.invoice.id]?.trim())
  const disabled = busy === true || posting || loading

  const autoAllocate = () => {
    const funds = amountCents + creditApplications.reduce((sum, row) => sum + row.amountCents, 0)
    const dueAtById: Record<string, string> = {}
    for (const row of invoices) dueAtById[row.id] = row.dueAt
    const next: AmountDrafts = {}
    for (const row of suggestAllocation(funds, planDocuments, dueAtById)) {
      next[row.documentId] = inputFromCents(row.amountCents)
    }
    setAllocations(next)
  }

  const submit = () => {
    setPosting(true)
    setError(null)
    recordPayment({
      customerId,
      receivedAt,
      method,
      amountCents,
      applications,
      creditApplications,
      clientRequestId,
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
      ...(plan.unappliedCents > 0 && overage === 'ACCEPT'
        ? { acceptOverage: true, overageReason: overageReason.trim() || undefined }
        : {}),
    })
      .then(async (row) => {
        // The ignored rest of each short-paid invoice is written off after the payment posts,
        // each with its own request id so a retried Post never writes one off twice.
        for (const { invoice, restCents } of ignoring) {
          await writeOffInvoice({
            invoiceId: invoice.id,
            amountCents: restCents,
            reason: ignoreRest[invoice.id].trim(),
            clientRequestId: `${clientRequestId}-wo-${invoice.id}`.slice(0, 64),
          })
        }
        toast.success(row.duplicate
          ? 'That payment was already posted'
          : `Posted ${formatCents(row.payment.amountCents)}${ignoring.length ? `; ignored the rest on ${ignoring.length} invoice${ignoring.length === 1 ? '' : 's'}` : ''}`)
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
      title={`Receive payment${customerName ? ` — ${customerName}` : ''}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !plan.ok || ignoreBlocked}>
            {posting ? 'Posting…' : 'Post'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the account…
        </p>
      )}

      {!loading && (
        <div className="flex flex-col gap-4">
          <div className="tms-grid tms-grid-4">
            <TmsField label="Received">
              <TmsInput
                aria-label="Payment date"
                type="date"
                value={receivedAt}
                disabled={disabled}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </TmsField>
            <TmsField label="Method">
              <TmsSelect
                aria-label="Payment method"
                value={method}
                disabled={disabled}
                onChange={(e) => setMethod(e.target.value as ArPaymentMethod)}
              >
                {METHODS.map((row) => <option key={row} value={row}>{row.toLowerCase()}</option>)}
              </TmsSelect>
            </TmsField>
            <TmsField label="Reference">
              <TmsInput
                aria-label="Payment reference"
                value={reference}
                disabled={disabled}
                placeholder="cheque or trace #"
                onChange={(e) => setReference(e.target.value)}
              />
            </TmsField>
            <TmsField label="Amount">
              <TmsInput
                aria-label="Payment amount"
                inputMode="decimal"
                value={amount}
                disabled={disabled}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
              />
            </TmsField>
          </div>

          {duplicate && (
            <p
              className="flex items-start gap-2 p-2 text-xs tms-tint tms-tint-orange"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
              This customer already has a {duplicate.kind.toLowerCase().replace('_', ' ')} with reference
              {' '}{duplicate.reference} for {formatCents(duplicate.amountCents)} on {duplicate.receivedAt.slice(0, 10)}.
              Post anyway if this is a different cheque.
            </p>
          )}

          <div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Open invoices</p>
              <TmsButton size="sm" aria-label="Auto-allocate" onClick={autoAllocate} disabled={disabled}>
                <Wand2 size={12} /> Auto-allocate
              </TmsButton>
            </div>
            {invoices.length === 0 ? (
              <p className="mt-1 text-xs tms-muted">Nothing is open for this customer.</p>
            ) : (
              <ul
                className="mt-1"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              >
                {invoices.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-2 py-1.5">
                    <span className="w-32 shrink-0 font-medium">{row.number}</span>
                    <span className="w-24 shrink-0 text-xs tms-muted">due {row.dueAt}</span>
                    <span className="flex-1 text-right text-xs tms-muted">{formatCents(row.balanceCents)} open</span>
                    <TmsInput
                      aria-label={`Apply to invoice ${row.number}`}
                      inputMode="decimal"
                      value={allocations[row.id] ?? ''}
                      disabled={disabled}
                      placeholder="0.00"
                      onChange={(e) => setAllocations((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="w-28"
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {credits.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Available credits</p>
              <ul
                className="mt-1"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              >
                {credits.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-2 py-1.5">
                    <span className="w-32 shrink-0 font-medium">{row.reference ?? row.kind.toLowerCase()}</span>
                    <span className="w-24 shrink-0 text-xs tms-muted">{row.receivedAt.slice(0, 10)}</span>
                    <span className="flex-1 text-right text-xs tms-muted">{formatCents(row.unappliedCents)} left</span>
                    <TmsInput
                      aria-label={`Use credit ${row.reference ?? row.id}`}
                      inputMode="decimal"
                      value={creditUses[row.id] ?? ''}
                      disabled={disabled}
                      placeholder="0.00"
                      onChange={(e) => setCreditUses((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="w-28"
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TmsField label="Note">
            <TmsTextarea
              aria-label="Payment note"
              rows={2}
              value={note}
              disabled={disabled}
              onChange={(e) => setNote(e.target.value)}
            />
          </TmsField>

          <div className="p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>Applied <strong aria-label="Applied total">{formatCents(plan.appliedCents)}</strong></span>
              <span>From credits <strong aria-label="From credits total">{formatCents(plan.fromCreditsCents)}</strong></span>
              <span>Unapplied <strong aria-label="Unapplied total">{formatCents(plan.unappliedCents)}</strong></span>
            </div>
            {plan.unappliedCents > 0 && (
              <fieldset className="mt-2 flex flex-col gap-1 text-xs">
                <legend className="sr-only">Overpayment</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="overage"
                    aria-label="Keep the extra as customer credit"
                    checked={overage === 'CREDIT'}
                    disabled={disabled}
                    onChange={() => setOverage('CREDIT')}
                  />
                  Keep the extra {formatCents(plan.unappliedCents)} as customer credit
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="overage"
                    aria-label="Accept as paid in full"
                    checked={overage === 'ACCEPT'}
                    disabled={disabled}
                    onChange={() => setOverage('ACCEPT')}
                  />
                  Accept as paid in full — don&apos;t create a credit
                </label>
                {overage === 'ACCEPT' && (
                  <TmsInput
                    aria-label="Reason for accepting the overpayment"
                    placeholder="Reason (optional)"
                    value={overageReason}
                    disabled={disabled}
                    onChange={(e) => setOverageReason(e.target.value)}
                  />
                )}
              </fieldset>
            )}
            {shortPaid.map(({ invoice, restCents }) => (
              <div key={invoice.id} className="mt-2 flex flex-col gap-1 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Ignore the rest of invoice ${invoice.number}`}
                    checked={ignoreRest[invoice.id] !== undefined}
                    disabled={disabled}
                    onChange={(e) => setIgnoreRest((prev) => {
                      const next = { ...prev }
                      if (e.target.checked) next[invoice.id] = ''
                      else delete next[invoice.id]
                      return next
                    })}
                  />
                  {invoice.number} is short paid: {formatCents(restCents)} stays open to chase. Ignore the rest and mark it paid
                </label>
                {ignoreRest[invoice.id] !== undefined && (
                  <TmsInput
                    aria-label={`Reason for ignoring the rest of invoice ${invoice.number}`}
                    placeholder="Reason (required)"
                    value={ignoreRest[invoice.id]}
                    disabled={disabled}
                    onChange={(e) => setIgnoreRest((prev) => ({ ...prev, [invoice.id]: e.target.value }))}
                  />
                )}
              </div>
            ))}
            {plan.errors.map((reason) => (
              <p key={reason} className="mt-1 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{reason}</p>
            ))}
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
