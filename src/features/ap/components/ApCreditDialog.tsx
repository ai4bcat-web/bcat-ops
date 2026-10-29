/**
 * Money a carrier owes us back, held against them until a payment spends it.
 *
 * A credit is raised unapplied — the planner refuses a credit memo that arrives with
 * allocations on it — and is spent on the pay run, where somebody decides which bill it
 * comes off. The reason is required because a credit is a claim against a trading
 * partner: a TONU adjustment, a lumper we paid twice, damage. Six months later the
 * reason is the only thing that explains the deduction on their statement.
 *
 * Naming the assignment is optional and worth doing: it is what lets the leg show what
 * it owes back before anybody has spent the credit.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { createApCredit, graphqlErrorText, listBillsByCarrier } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateInput } from '@/lib/date'
import { centsFromInput } from '@/features/ar/components/money'
import type { CarrierBillRecord } from '@/types/tms'

export function ApCreditDialog({ carrierId, loadCarrierId, open, onOpenChange, onDone }: {
  carrierId: string
  /** Raised from one leg — a TONU adjustment, a claim — rather than against the account. */
  loadCarrierId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  // One id for the life of this dialog: a retried save is the same credit, not a second.
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [memoDate, setMemoDate] = useState(() => formatDateInput(new Date().toISOString()))
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [assignment, setAssignment] = useState(loadCarrierId ?? '')
  const [bills, setBills] = useState<CarrierBillRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    listBillsByCarrier(carrierId)
      .then((rows) => { setBills(rows.filter((row) => row.status !== 'VOID')); setError(null) })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [carrierId])

  useEffect(() => { load() }, [load])

  const amountCents = centsFromInput(amount)
  const disabled = saving || loading
  const ready = amountCents !== null && amountCents > 0 && reason.trim().length > 0

  const submit = () => {
    if (amountCents === null) return
    setSaving(true)
    setError(null)
    createApCredit({
      carrierId,
      memoDate,
      amountCents,
      reason: reason.trim(),
      reference: reference.trim() || undefined,
      loadCarrierId: assignment || undefined,
      clientRequestId,
    })
      .then((row) => {
        toast.success(row.duplicate
          ? 'That credit was already raised'
          : `${formatCents(row.payment.amountCents)} held against this carrier`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Hold a credit${bills[0]?.carrierName ? ` — ${bills[0].carrierName}` : ''}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !ready}>
            {saving ? 'Saving…' : 'Hold credit'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading this carrier…
        </p>
      )}

      {!loading && (
        <div className="flex flex-col gap-3">
          <p className="tms-muted">
            Nothing is deducted now. The credit sits against this carrier until a payment
            spends it, and the pay run decides which bill it comes off.
          </p>

          <div className="tms-grid tms-grid-3">
            <TmsField label="Memo date">
              <TmsInput
                aria-label="Credit memo date"
                type="date"
                value={memoDate}
                disabled={disabled}
                onChange={(e) => setMemoDate(e.target.value)}
              />
            </TmsField>
            <TmsField label="Reference">
              <TmsInput
                aria-label="Credit reference"
                value={reference}
                disabled={disabled}
                placeholder="claim or TONU #"
                onChange={(e) => setReference(e.target.value)}
              />
            </TmsField>
            <TmsField label="Amount">
              <TmsInput
                aria-label="Credit amount"
                inputMode="decimal"
                value={amount}
                disabled={disabled}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
              />
            </TmsField>
          </div>

          <TmsField label="Against a leg">
            <TmsSelect
              aria-label="Credit assignment"
              value={assignment}
              disabled={disabled}
              onChange={(e) => setAssignment(e.target.value)}
            >
              <option value="">The account — no particular leg</option>
              {bills.map((row) => (
                <option key={row.id} value={row.loadCarrierId}>
                  {row.billNumber ?? row.id} · {row.loadNumber ?? row.shipmentNumber ?? row.shipmentId}
                  {' '}· {formatCents(row.netCents)}
                </option>
              ))}
            </TmsSelect>
          </TmsField>

          <TmsField label="Why">
            <TmsTextarea
              aria-label="Credit reason"
              rows={2}
              value={reason}
              disabled={disabled}
              placeholder="what this credit is for — the carrier will ask"
              onChange={(e) => setReason(e.target.value)}
            />
          </TmsField>

          {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
