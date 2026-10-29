/**
 * Recording the carrier's invoice against one assignment.
 *
 * Everything on this form comes off `PREVIEW_BILL`, which writes nothing and runs the
 * same `billReadiness` the write runs: the refusals read here are the refusals
 * `RECORD_BILL` would give. The line snapshot is shown and never edited — carrier
 * charges are changed on the shipment, which is what "Update carrier charges" is for —
 * and the totals come from `billTotals`, the one place the quick-pay deduction lives.
 *
 * The number that *is* typed is the carrier's own invoice total. It is compared against
 * the lines on the spot, because a variance cannot be approved later: the lines get
 * fixed or the bill gets voided, and finding that out now is cheaper than finding it
 * out at the approval desk.
 *
 * Only an accepted CARRIER_INVOICE can be linked, so only those are offered.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, previewBill, recordBill, type BillPreview } from '@/lib/apiClient'
import { billDueDate, billTotals } from '@/lib/carrierBill'
import { formatCents } from '@/lib/invoiceBuild'
import { centsFromInput, inputFromCents } from '@/features/ar/components/money'

const RED = { color: 'var(--tms-badge-red)' }
const BOX = { border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }

export function RecordBillDialog({ loadCarrierId, open, onOpenChange, onDone }: {
  loadCarrierId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [preview, setPreview] = useState<BillPreview | null>(null)
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState('')
  const [dueAt, setDueAt] = useState('')
  // Once the due date has been typed over, a later change of bill date leaves it alone.
  const [dueAtTouched, setDueAtTouched] = useState(false)
  const [billed, setBilled] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    previewBill({ loadCarrierId })
      .then((result) => {
        setPreview(result)
        setBillDate(result.snapshot.billDate)
        setDueAt(result.snapshot.dueAt)
        setBilled(inputFromCents(result.snapshot.grossCents))
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [loadCarrierId])

  useEffect(() => { load() }, [load])

  const snapshot = preview?.snapshot ?? null
  const lines = snapshot?.lines ?? []
  const grossCents = snapshot?.grossCents ?? 0
  const totals = billTotals({
    grossCents,
    loadCarrier: snapshot ? { quickPay: snapshot.quickPay, quickPayFeeCents: snapshot.quickPayFeeCents } : null,
    payeeKind: preview?.payee.kind ?? 'CARRIER',
  })
  const billedCents = centsFromInput(billed)
  // The definition of the column: what the carrier invoiced less what the lines total.
  const varianceCents = (billedCents ?? grossCents) - grossCents
  const ready = preview?.readiness.ready === true
  const missing = preview?.gate.missing ?? []
  const disabled = saving || loading

  const changeBillDate = (value: string) => {
    setBillDate(value)
    if (!dueAtTouched && snapshot && value) setDueAt(billDueDate(value, snapshot.termsDays))
  }

  const submit = (approve: boolean) => {
    setSaving(true)
    setError(null)
    recordBill({
      loadCarrierId,
      billNumber: billNumber.trim() || undefined,
      billDate: billDate || undefined,
      billedCents: billedCents ?? undefined,
      dueAt: dueAt || undefined,
      documentId: documentId || undefined,
      note: note.trim() || undefined,
      approve: approve || undefined,
    })
      .then((result) => {
        toast.success(result.bill.status === 'TO_BE_PAID'
          ? `Bill recorded and approved — ${formatCents(result.bill.netCents)} to pay`
          : `Bill recorded — ${formatCents(result.bill.netCents)} in review`)
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
      title={`Record carrier bill${snapshot?.carrierName ? ` — ${snapshot.carrierName}` : ''}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</TmsButton>
          <TmsButton onClick={() => submit(false)} disabled={disabled || !ready}>
            {saving ? 'Recording…' : 'Record'}
          </TmsButton>
          <TmsButton variant="primary" onClick={() => submit(true)} disabled={disabled || !ready || varianceCents !== 0}>
            Record and approve
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the assignment…
        </p>
      )}

      {!loading && preview && snapshot && (
        <div className="flex flex-col gap-4">
          {!ready && (
            <div className="p-2" style={{ border: '1px solid var(--tms-badge-red)', borderRadius: 'var(--tms-radius)' }}>
              <p className="flex items-start gap-2 text-xs font-medium">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" style={RED} />
                This assignment cannot be billed yet.
              </p>
              <ul className="mt-1 text-xs" style={RED}>
                {preview.readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          )}

          {missing.length > 0 && (
            <p
              className="p-2 text-xs"
              style={{ border: '1px solid var(--tms-badge-orange)', borderRadius: 'var(--tms-radius)' }}
            >
              Carrier paperwork still missing: {missing.join(', ')}. A bill can be recorded
              without it; approving it needs the paperwork or an admin's override.
            </p>
          )}

          <div className="tms-grid tms-grid-4">
            <TmsField label="Their invoice #">
              <TmsInput
                aria-label="Carrier invoice number"
                value={billNumber}
                disabled={disabled}
                placeholder="as printed"
                onChange={(e) => setBillNumber(e.target.value)}
              />
            </TmsField>
            <TmsField label="Bill date">
              <TmsInput
                aria-label="Bill date"
                type="date"
                value={billDate}
                disabled={disabled}
                onChange={(e) => changeBillDate(e.target.value)}
              />
            </TmsField>
            <TmsField label="Due">
              <TmsInput
                aria-label="Due date"
                type="date"
                value={dueAt}
                disabled={disabled}
                onChange={(e) => { setDueAtTouched(true); setDueAt(e.target.value) }}
              />
            </TmsField>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Terms</p>
              <p className="mt-2">
                {snapshot.quickPay ? `Quick pay, net ${snapshot.termsDays}` : `Net ${snapshot.termsDays}`}
              </p>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Charge lines</p>
            <div className="tms-table-wrap mt-1">
              <table className="tms-table">
                <thead>
                  <tr>
                    <th scope="col">CODE</th>
                    <th scope="col">DESCRIPTION</th>
                    <th scope="col">RATE</th>
                    <th scope="col">COUNT</th>
                    <th scope="col">AMOUNT</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="tms-muted">This assignment has no carrier charges.</td>
                    </tr>
                  )}
                  {lines.map((line) => (
                    <tr key={line.chargeId}>
                      <td>{line.code}</td>
                      <td>{line.label ?? line.code}</td>
                      <td className="text-right tabular-nums">{formatCents(line.rateCents)}</td>
                      <td className="text-right tabular-nums">{line.count}</td>
                      <td className="text-right tabular-nums">{formatCents(line.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="tms-grid tms-grid-2">
            <div>
              <TmsField label="What their invoice says">
                <TmsInput
                  aria-label="Billed amount"
                  inputMode="decimal"
                  value={billed}
                  disabled={disabled}
                  placeholder="0.00"
                  onChange={(e) => setBilled(e.target.value)}
                />
              </TmsField>
              {varianceCents !== 0 && (
                <p className="mt-1 text-xs" style={RED} aria-label="Variance">
                  {formatCents(varianceCents)} away from the lines. A bill that does not match
                  its lines cannot be approved — fix the charges first.
                </p>
              )}
            </div>

            <div className="p-2" style={BOX}>
              <div className="flex justify-between"><span>Lines</span><span aria-label="Gross">{formatCents(grossCents)}</span></div>
              {totals.quickPayFeeCents > 0 && (
                <div className="flex justify-between tms-muted">
                  <span>Quick-pay fee</span>
                  <span aria-label="Quick-pay fee">−{formatCents(totals.quickPayFeeCents)}</span>
                </div>
              )}
              <div
                className="mt-1 flex justify-between pt-1 font-semibold"
                style={{ borderTop: '1px solid var(--tms-border)' }}
              >
                <span>To pay</span><span aria-label="Net">{formatCents(totals.netCents)}</span>
              </div>
              <p className="mt-1 text-xs tms-muted">
                Paid to {preview.payee.remitTo?.name ?? snapshot.carrierName ?? 'the carrier'}
                {preview.payee.kind === 'FACTOR' ? ' (factor)' : ''}
                {preview.payee.remitTo?.method ? ` by ${preview.payee.remitTo.method.toLowerCase()}` : ''}.
              </p>
            </div>
          </div>

          <div>
            <TmsField label="Their invoice document">
              <TmsSelect
                aria-label="Carrier invoice document"
                value={documentId}
                disabled={disabled}
                onChange={(e) => setDocumentId(e.target.value)}
              >
                <option value="">Not linked</option>
                {preview.documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name} · {Math.round(doc.sizeBytes / 1024)} KB
                  </option>
                ))}
              </TmsSelect>
            </TmsField>
            {preview.documents.length === 0 && (
              <p className="mt-1 text-xs tms-muted">
                No accepted carrier invoice is on this shipment yet. One can be attached later.
              </p>
            )}
          </div>

          <TmsField label="Note">
            <TmsTextarea
              aria-label="Bill note"
              rows={2}
              value={note}
              disabled={disabled}
              onChange={(e) => setNote(e.target.value)}
            />
          </TmsField>

          {error && <p className="text-xs" style={RED}>{error}</p>}
        </div>
      )}

      {!loading && !preview && error && <p className="text-xs" style={RED}>{error}</p>}
    </TmsDialog>
  )
}
