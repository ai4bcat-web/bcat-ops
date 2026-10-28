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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  graphqlErrorText,
  listArPaymentsByCustomer,
  listInvoicesByCustomer,
  recordPayment,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { planPayment, suggestAllocation, type PlanCredit, type PlanInvoice } from '@/lib/paymentApply'
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
  const [keepRemainder, setKeepRemainder] = useState(true)
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

  const planInvoices = useMemo<PlanInvoice[]>(() => invoices.map((row) => ({
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    writtenOffCents: row.writtenOffCents,
    balanceCents: row.balanceCents,
    number: row.number,
  })), [invoices])

  // Built from every row the read returned, not from the offered list: a use typed
  // before a poll revealed the reversal still reaches the planner, which refuses it by
  // name rather than reporting a credit that was "not found".
  const planCredits = useMemo<PlanCredit[]>(() => payments.map((row) => ({
    id: row.id,
    customerId: row.customerId,
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
    customerId,
    amountCents,
    applications,
    creditApplications,
    invoices: planInvoices,
    credits: planCredits,
  }), [customerId, amountCents, applications, creditApplications, planInvoices, planCredits])

  const duplicate = useMemo(() => {
    const typed = reference.trim().toLowerCase()
    if (!typed) return null
    return payments.find((row) => (row.reference ?? '').trim().toLowerCase() === typed) ?? null
  }, [reference, payments])

  const remainderBlocked = !keepRemainder && plan.unappliedCents > 0
  const disabled = busy === true || posting || loading

  const autoAllocate = () => {
    const funds = amountCents + creditApplications.reduce((sum, row) => sum + row.amountCents, 0)
    const dueAtById: Record<string, string> = {}
    for (const row of invoices) dueAtById[row.id] = row.dueAt
    const next: AmountDrafts = {}
    for (const row of suggestAllocation(funds, planInvoices, dueAtById)) {
      next[row.invoiceId] = inputFromCents(row.amountCents)
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
    })
      .then((row) => {
        toast.success(row.duplicate
          ? 'That payment was already posted'
          : `Posted ${formatCents(row.payment.amountCents)}`)
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive payment{customerName ? ` — ${customerName}` : ''}</DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the account…
          </p>
        )}

        {!loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Received</Label>
                <Input
                  aria-label="Payment date"
                  type="date"
                  value={receivedAt}
                  disabled={disabled}
                  onChange={(e) => setReceivedAt(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Method</Label>
                <select
                  aria-label="Payment method"
                  value={method}
                  disabled={disabled}
                  onChange={(e) => setMethod(e.target.value as ArPaymentMethod)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {METHODS.map((row) => <option key={row} value={row}>{row.toLowerCase()}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reference</Label>
                <Input
                  aria-label="Payment reference"
                  value={reference}
                  disabled={disabled}
                  placeholder="cheque or trace #"
                  onChange={(e) => setReference(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Amount</Label>
                <Input
                  aria-label="Payment amount"
                  inputMode="decimal"
                  value={amount}
                  disabled={disabled}
                  placeholder="0.00"
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {duplicate && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                This customer already has a {duplicate.kind.toLowerCase().replace('_', ' ')} with reference
                {' '}{duplicate.reference} for {formatCents(duplicate.amountCents)} on {duplicate.receivedAt.slice(0, 10)}.
                Post anyway if this is a different cheque.
              </p>
            )}

            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Open invoices</Label>
                <Button size="sm" variant="outline" aria-label="Auto-allocate" onClick={autoAllocate} disabled={disabled}>
                  <Wand2 size={12} className="mr-1" /> Auto-allocate
                </Button>
              </div>
              {invoices.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">Nothing is open for this customer.</p>
              ) : (
                <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
                  {invoices.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 px-2 py-1.5 text-sm">
                      <span className="w-32 shrink-0 font-medium">{row.number}</span>
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">due {row.dueAt}</span>
                      <span className="flex-1 text-right text-xs text-muted-foreground">
                        {formatCents(row.balanceCents)} open
                      </span>
                      <Input
                        aria-label={`Apply to invoice ${row.number}`}
                        inputMode="decimal"
                        value={allocations[row.id] ?? ''}
                        disabled={disabled}
                        placeholder="0.00"
                        onChange={(e) => setAllocations((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        className="h-8 w-28 text-sm"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {credits.length > 0 && (
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Available credits</Label>
                <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
                  {credits.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 px-2 py-1.5 text-sm">
                      <span className="w-32 shrink-0 font-medium">{row.reference ?? row.kind.toLowerCase()}</span>
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">{row.receivedAt.slice(0, 10)}</span>
                      <span className="flex-1 text-right text-xs text-muted-foreground">
                        {formatCents(row.unappliedCents)} left
                      </span>
                      <Input
                        aria-label={`Use credit ${row.reference ?? row.id}`}
                        inputMode="decimal"
                        value={creditUses[row.id] ?? ''}
                        disabled={disabled}
                        placeholder="0.00"
                        onChange={(e) => setCreditUses((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        className="h-8 w-28 text-sm"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Note</Label>
              <Textarea
                aria-label="Payment note"
                rows={2}
                value={note}
                disabled={disabled}
                onChange={(e) => setNote(e.target.value)}
                className="text-sm"
              />
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-2 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>Applied <strong aria-label="Applied total">{formatCents(plan.appliedCents)}</strong></span>
                <span>From credits <strong aria-label="From credits total">{formatCents(plan.fromCreditsCents)}</strong></span>
                <span>Unapplied <strong aria-label="Unapplied total">{formatCents(plan.unappliedCents)}</strong></span>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <Checkbox
                  aria-label="Keep the remainder as customer credit"
                  checked={keepRemainder}
                  disabled={disabled}
                  onCheckedChange={(v) => setKeepRemainder(v === true)}
                />
                Keep the remainder as customer credit
              </label>
              {remainderBlocked && (
                <p className="mt-1 text-xs text-destructive">
                  {formatCents(plan.unappliedCents)} is unapplied. Allocate it, or keep it as customer credit.
                </p>
              )}
              {plan.errors.map((reason) => (
                <p key={reason} className="mt-1 text-xs text-destructive">{reason}</p>
              ))}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={posting}>Cancel</Button>
          <Button onClick={submit} disabled={disabled || !plan.ok || remainderBlocked}>
            {posting ? 'Posting…' : 'Post'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
