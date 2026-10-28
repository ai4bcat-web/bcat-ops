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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { graphqlErrorText, previewBill, recordBill, type BillPreview } from '@/lib/apiClient'
import { billDueDate, billTotals } from '@/lib/carrierBill'
import { formatCents } from '@/lib/invoiceBuild'
import { centsFromInput, inputFromCents } from '@/features/ar/components/money'

const TH = 'px-2 py-1 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-1 align-top'
const MONEY = 'px-2 py-1 text-right tabular-nums align-top'

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Record carrier bill{snapshot?.carrierName ? ` — ${snapshot.carrierName}` : ''}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the assignment…
          </p>
        )}

        {!loading && preview && snapshot && (
          <div className="space-y-4">
            {!ready && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
                  This assignment cannot be billed yet.
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                  {preview.readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            )}

            {missing.length > 0 && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                Carrier paperwork still missing: {missing.join(', ')}. A bill can be recorded
                without it; approving it needs the paperwork or an admin's override.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Their invoice #</Label>
                <Input
                  aria-label="Carrier invoice number"
                  value={billNumber}
                  disabled={disabled}
                  placeholder="as printed"
                  onChange={(e) => setBillNumber(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Bill date</Label>
                <Input
                  aria-label="Bill date"
                  type="date"
                  value={billDate}
                  disabled={disabled}
                  onChange={(e) => changeBillDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Due</Label>
                <Input
                  aria-label="Due date"
                  type="date"
                  value={dueAt}
                  disabled={disabled}
                  onChange={(e) => { setDueAtTouched(true); setDueAt(e.target.value) }}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Terms</Label>
                <p className="mt-2 text-sm">
                  {snapshot.quickPay
                    ? `Quick pay, net ${snapshot.termsDays}`
                    : `Net ${snapshot.termsDays}`}
                </p>
              </div>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Charge lines</Label>
              <table className="mt-1 w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH} scope="col">Code</th>
                    <th className={TH} scope="col">Description</th>
                    <th className={`${TH} text-right`} scope="col">Rate</th>
                    <th className={`${TH} text-right`} scope="col">Count</th>
                    <th className={`${TH} text-right`} scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-center text-xs text-muted-foreground">
                        This assignment has no carrier charges.
                      </td>
                    </tr>
                  )}
                  {lines.map((line) => (
                    <tr key={line.chargeId} className="border-b border-border/60">
                      <td className={TD}>{line.code}</td>
                      <td className={TD}>{line.label ?? line.code}</td>
                      <td className={MONEY}>{formatCents(line.rateCents)}</td>
                      <td className={MONEY}>{line.count}</td>
                      <td className={MONEY}>{formatCents(line.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  What their invoice says
                </Label>
                <Input
                  aria-label="Billed amount"
                  inputMode="decimal"
                  value={billed}
                  disabled={disabled}
                  placeholder="0.00"
                  onChange={(e) => setBilled(e.target.value)}
                  className="h-9 text-sm"
                />
                {varianceCents !== 0 && (
                  <p className="mt-1 text-xs text-destructive" aria-label="Variance">
                    {formatCents(varianceCents)} away from the lines. A bill that does not match
                    its lines cannot be approved — fix the charges first.
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-border bg-muted/30 p-2 text-sm">
                <div className="flex justify-between"><span>Lines</span><span aria-label="Gross">{formatCents(grossCents)}</span></div>
                {totals.quickPayFeeCents > 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Quick-pay fee</span>
                    <span aria-label="Quick-pay fee">−{formatCents(totals.quickPayFeeCents)}</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                  <span>To pay</span><span aria-label="Net">{formatCents(totals.netCents)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paid to {preview.payee.remitTo?.name ?? snapshot.carrierName ?? 'the carrier'}
                  {preview.payee.kind === 'FACTOR' ? ' (factor)' : ''}
                  {preview.payee.remitTo?.method ? ` by ${preview.payee.remitTo.method.toLowerCase()}` : ''}.
                </p>
              </div>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Their invoice document</Label>
              <select
                aria-label="Carrier invoice document"
                value={documentId}
                disabled={disabled}
                onChange={(e) => setDocumentId(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Not linked</option>
                {preview.documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name} · {Math.round(doc.sizeBytes / 1024)} KB
                  </option>
                ))}
              </select>
              {preview.documents.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No accepted carrier invoice is on this shipment yet. One can be attached later.
                </p>
              )}
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Note</Label>
              <Textarea
                aria-label="Bill note"
                rows={2}
                value={note}
                disabled={disabled}
                onChange={(e) => setNote(e.target.value)}
                className="text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {!loading && !preview && error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={disabled || !ready}>
            {saving ? 'Recording…' : 'Record'}
          </Button>
          <Button onClick={() => submit(true)} disabled={disabled || !ready || varianceCents !== 0}>
            Record and approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
