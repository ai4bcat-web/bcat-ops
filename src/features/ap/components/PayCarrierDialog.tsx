/**
 * Paying a carrier: cash and held credits against their approved bills.
 *
 * The AR twin of this form keeps an unapplied remainder as customer credit. AP does
 * not: money leaves the bank here, and a payment that is not fully allocated is a
 * figure nobody can tie to a bill. Post therefore stays disabled until the plan's
 * unallocated is exactly zero — the same rule `RECORD_AP_PAYMENT` enforces.
 *
 * None of the arithmetic happens in this file. `planPayment` from `@/lib/paymentApply`
 * — run on every keystroke with `{ party: 'carrier', document: 'bill' }` — is the same
 * function the Lambda runs, so the refusals read here are the refusals the server would
 * give afterwards, in the carrier's nouns.
 *
 * `clientRequestId` is generated once per mount and sent on every attempt. A Post that
 * times out can be pressed again without any risk of paying the carrier twice: the
 * Lambda recognises the id and returns the row it already wrote.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import {
  graphqlErrorText,
  listApPaymentsByCarrier,
  listBillsByCarrier,
  recordApPayment,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import {
  planPayment, suggestAllocation, type PlanCredit, type PlanDocument,
} from '@/lib/paymentApply'
import { formatDateInput } from '@/lib/date'
import { centsFromInput, inputFromCents } from '@/features/ar/components/money'
import type {
  ApPaymentApplication, ApPaymentMethod, ApPaymentRecord, CarrierBillRecord, CarrierBillStatus,
  CreditApplication,
} from '@/types/tms'

const METHODS: ApPaymentMethod[] = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT', 'OTHER']

/** Approved bills are payable; one in review has not been agreed to yet. */
const PAYABLE: Partial<Record<CarrierBillStatus, true>> = { TO_BE_PAID: true, PARTIAL: true }

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

/** What the carrier will match the money against: their own invoice number first. */
function billName(bill: CarrierBillRecord): string {
  return bill.billNumber?.trim() || bill.loadNumber?.trim() || bill.shipmentNumber?.trim() || bill.id
}

export function PayCarrierDialog({ carrierId, preselectBillIds, open, onOpenChange, onDone }: {
  carrierId: string
  /** Bills the board was looking at when Pay was pressed; filled in at their balance. */
  preselectBillIds?: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  // One id for the life of this dialog: a retried Post is the same request, not a
  // second payment.
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [paidAt, setPaidAt] = useState(() => formatDateInput(new Date().toISOString()))
  const [method, setMethod] = useState<ApPaymentMethod | null>(null)
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [allocations, setAllocations] = useState<AmountDrafts>({})
  const [creditUses, setCreditUses] = useState<AmountDrafts>({})
  const [bills, setBills] = useState<CarrierBillRecord[]>([])
  const [payments, setPayments] = useState<ApPaymentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preselect = preselectBillIds?.join(',') ?? ''

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([listBillsByCarrier(carrierId), listApPaymentsByCarrier(carrierId)])
      .then(([billRows, paymentRows]) => {
        const payable = billRows.filter((row) => PAYABLE[row.status] === true && row.balanceCents > 0)
        setBills(payable)
        setPayments(paymentRows)

        // The method the bill's payee is set up for: paying by cheque a factor who is
        // on ACH is the mistake this default exists to prevent.
        const chosen = preselect ? payable.filter((row) => preselect.split(',').includes(row.id)) : []
        const lead = chosen[0] ?? payable[0] ?? null
        setMethod(lead?.remitTo?.method ?? 'ACH')

        if (chosen.length > 0) {
          const next: AmountDrafts = {}
          let total = 0
          for (const row of chosen) {
            next[row.id] = inputFromCents(row.balanceCents)
            total += row.balanceCents
          }
          setAllocations(next)
          setAmount(inputFromCents(total))
        }
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [carrierId, preselect])

  useEffect(() => { load() }, [load])

  // Rows that carry money we hold against this carrier: a credit memo raised for a
  // TONU or a claim, and an overpayment kept back. A REVERSAL took its row's credit
  // away, so offering it would spend money that no longer exists.
  const credits = useMemo(
    () => payments.filter((row) => row.unappliedCents > 0 && row.kind !== 'REVERSAL' && !row.reversedByPaymentId),
    [payments],
  )

  const planDocuments = useMemo<PlanDocument[]>(() => bills.map((row) => ({
    id: row.id,
    partyId: row.carrierId,
    // What we owe is the net of the quick-pay fee, never the gross the carrier billed.
    totalCents: row.netCents,
    paidCents: row.paidCents,
    offsetCents: row.creditedCents,
    balanceCents: row.balanceCents,
    voided: row.status === 'VOID',
    number: billName(row),
  })), [bills])

  // Built from every row the read returned rather than from the offered list: a use
  // typed before a poll revealed the reversal still reaches the planner, which refuses
  // it by name rather than reporting a credit that was "not found".
  const planCredits = useMemo<PlanCredit[]>(() => payments.map((row) => ({
    id: row.id,
    partyId: row.carrierId,
    kind: row.kind,
    unappliedCents: row.unappliedCents,
    reference: row.reference,
    reversed: Boolean(row.reversedByPaymentId),
  })), [payments])

  const amountCents = centsFromInput(amount) ?? 0
  const applications = useMemo<ApPaymentApplication[]>(
    () => appliedRows(allocations).map((row) => ({ billId: row.id, amountCents: row.amountCents })),
    [allocations],
  )
  const creditApplications = useMemo<CreditApplication[]>(
    () => appliedRows(creditUses).map((row) => ({ paymentId: row.id, amountCents: row.amountCents })),
    [creditUses],
  )

  const plan = useMemo(() => planPayment({
    kind: 'PAYMENT',
    partyId: carrierId,
    amountCents,
    // The dialog posts and reads the AP shape; only the planner speaks `documentId`.
    applications: applications.map((row) => ({ documentId: row.billId, amountCents: row.amountCents })),
    creditApplications,
    documents: planDocuments,
    credits: planCredits,
    vocabulary: { party: 'carrier', document: 'bill' },
  }), [carrierId, amountCents, applications, creditApplications, planDocuments, planCredits])

  const duplicate = useMemo(() => {
    const typed = reference.trim().toLowerCase()
    if (!typed) return null
    return payments.find((row) => (row.reference ?? '').trim().toLowerCase() === typed) ?? null
  }, [reference, payments])

  const unallocated = plan.unappliedCents > 0
  const disabled = posting || loading

  const autoAllocate = () => {
    const funds = amountCents + creditApplications.reduce((sum, row) => sum + row.amountCents, 0)
    const dueAtById: Record<string, string> = {}
    for (const row of bills) dueAtById[row.id] = row.dueAt
    const next: AmountDrafts = {}
    for (const row of suggestAllocation(funds, planDocuments, dueAtById)) {
      next[row.documentId] = inputFromCents(row.amountCents)
    }
    setAllocations(next)
  }

  const submit = () => {
    if (!method) return
    setPosting(true)
    setError(null)
    recordApPayment({
      carrierId,
      paidAt,
      method,
      amountCents,
      applications,
      creditApplications,
      clientRequestId,
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
    })
      .then((row) => {
        toast.success(row.duplicate
          ? 'That payment was already posted'
          : `Paid ${formatCents(row.payment.amountCents)}`)
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
      open={open}
      onOpenChange={onOpenChange}
      title={`Pay carrier${bills[0]?.carrierName ? ` — ${bills[0].carrierName}` : ''}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !plan.ok || unallocated}>
            {posting ? 'Posting…' : 'Post'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading what this carrier is owed…
        </p>
      )}

      {!loading && (
        <div className="flex flex-col gap-4">
          <div className="tms-grid tms-grid-4">
            <TmsField label="Paid">
              <TmsInput
                aria-label="Payment date"
                type="date"
                value={paidAt}
                disabled={disabled}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </TmsField>
            <TmsField label="Method">
              <TmsSelect
                aria-label="Payment method"
                value={method ?? 'ACH'}
                disabled={disabled}
                onChange={(e) => setMethod(e.target.value as ApPaymentMethod)}
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
              className="flex items-start gap-2 p-2 text-xs"
              style={{ border: '1px solid var(--tms-badge-orange)', borderRadius: 'var(--tms-radius)' }}
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
              This carrier already has a {duplicate.kind.toLowerCase().replace('_', ' ')} with reference
              {' '}{duplicate.reference} for {formatCents(duplicate.amountCents)} on {duplicate.paidAt.slice(0, 10)}.
              Post anyway if this is a different payment.
            </p>
          )}

          <div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Approved bills</p>
              <TmsButton size="sm" aria-label="Auto-allocate" onClick={autoAllocate} disabled={disabled}>
                <Wand2 size={12} /> Auto-allocate
              </TmsButton>
            </div>
            {bills.length === 0 ? (
              <p className="mt-1 text-xs tms-muted">
                Nothing is approved for this carrier. A bill is paid once it has been through review.
              </p>
            ) : (
              <ul className="mt-1" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
                {bills.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-2 py-1.5">
                    <span className="w-32 shrink-0 truncate font-medium">{billName(row)}</span>
                    <span className="w-24 shrink-0 text-xs tms-muted">due {row.dueAt}</span>
                    <span className="flex-1 text-right text-xs tms-muted">{formatCents(row.balanceCents)} open</span>
                    <TmsInput
                      aria-label={`Apply to bill ${billName(row)}`}
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
              <ul className="mt-1" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
                {credits.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-2 py-1.5">
                    <span className="w-32 shrink-0 truncate font-medium">{row.reference ?? row.kind.toLowerCase()}</span>
                    <span className="w-24 shrink-0 text-xs tms-muted">{row.paidAt.slice(0, 10)}</span>
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
              <span>Unallocated <strong aria-label="Unallocated total">{formatCents(plan.unappliedCents)}</strong></span>
            </div>
            {unallocated && (
              <p className="mt-1 text-xs" style={{ color: 'var(--tms-badge-red)' }}>
                {formatCents(plan.unappliedCents)} is unallocated. A payment to a carrier goes against
                bills — allocate it, or lower the amount.
              </p>
            )}
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
