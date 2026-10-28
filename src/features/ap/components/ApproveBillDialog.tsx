/**
 * The review stage, which is the whole reason AP has one.
 *
 * `approvalReadiness` splits what stands in the way into two kinds, and the split is
 * the point: a **block** is a mistake to fix — a bill that does not match its lines, a
 * leg that has not delivered, a carrier with nowhere to send money — and nothing on
 * this form can wave it through. A **warning** is a decision somebody has to own: the
 * truck hauled the freight and is owed for it even though we have since blacklisted
 * them. Each warning is acknowledged by key, and the keys are kept on the bill as the
 * record of who waved what through.
 *
 * The same pure function runs server-side inside `APPROVE_BILL`, over a live paperwork
 * gate read here through `PREVIEW_BILL`, so this form and the Lambda cannot disagree.
 *
 * The paperwork override is an admin act with a reason on it. It is applied to the bill
 * *before* the gate is judged — exactly as the Lambda does — otherwise the override
 * could never clear the block it exists for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAuth } from '@/hooks/useAuth'
import { approveBill, getCarrier, getShipmentBundle, getTmsSettings, graphqlErrorText, previewBill } from '@/lib/apiClient'
import { approvalReadiness } from '@/lib/carrierBill'
import { formatCents } from '@/lib/invoiceBuild'
import type {
  CarrierBillRecord, CarrierRecord, DocGateResult, ShipmentBundle, TmsSettings,
} from '@/types/tms'

export function ApproveBillDialog({ bill, open, onOpenChange, onDone }: {
  bill: CarrierBillRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { isAdmin } = useAuth()
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [gate, setGate] = useState<DocGateResult | null>(null)
  const [carrier, setCarrier] = useState<CarrierRecord | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [acked, setAcked] = useState<string[]>([])
  const [overrideNote, setOverrideNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { shipmentId, loadCarrierId, carrierId } = bill

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  // `PREVIEW_BILL` writes nothing; it is read here only for its live paperwork gate,
  // which is the one the Lambda will judge against rather than the stale cache.
  const load = useCallback(() =>
    Promise.all([
      getShipmentBundle(shipmentId),
      previewBill({ loadCarrierId }),
      getCarrier(carrierId),
      getTmsSettings(),
    ])
      .then(([shipmentBundle, preview, carrierRow, tmsSettings]) => {
        setBundle(shipmentBundle)
        setGate(preview.gate)
        setCarrier(carrierRow)
        setSettings(tmsSettings)
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [shipmentId, loadCarrierId, carrierId])

  useEffect(() => { load() }, [load])

  const assignment = bundle?.loadCarriers.find((row) => row.id === loadCarrierId) ?? null
  const leg = bundle?.loads.find((row) => row.id === bill.loadId) ?? null
  const missing = gate?.missing ?? []
  const note = overrideNote.trim()
  const overriding = isAdmin && note.length > 0 && missing.length > 0

  const readiness = useMemo(() => {
    if (!assignment) return { blocks: [], warnings: [] }
    return approvalReadiness({
      // The override is judged as if it were already on the bill, the way the Lambda
      // applies it before evaluating the gate.
      bill: overriding ? { ...bill, docsOverrideAt: new Date().toISOString() } : bill,
      loadCarrier: assignment,
      load: leg,
      gate,
      payee: { kind: bill.payeeKind, paymentMethodId: bill.paymentMethodId ?? null, remitTo: bill.remitTo ?? null },
      carrier,
      settings,
      isAdmin,
    })
  }, [assignment, leg, gate, bill, carrier, settings, isAdmin, overriding])

  const unacknowledged = readiness.warnings.filter((warning) => !acked.includes(warning.key))
  const disabled = saving || loading
  const blocked = !assignment || readiness.blocks.length > 0 || unacknowledged.length > 0

  const submit = () => {
    setSaving(true)
    setError(null)
    approveBill({
      billId: bill.id,
      acknowledgeWarnings: readiness.warnings.map((warning) => warning.key),
      docsOverrideNote: overriding ? note : undefined,
    })
      .then(() => {
        toast.success(`Approved — ${formatCents(bill.netCents)} to pay`)
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Approve {bill.billNumber ? `bill ${bill.billNumber}` : 'carrier bill'} — {formatCents(bill.netCents)}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the assignment and its paperwork…
          </p>
        )}

        {!loading && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Approving moves this bill to To be paid. {bill.carrierName ?? 'The carrier'} is owed
              {' '}{formatCents(bill.netCents)}
              {bill.quickPayFeeCents > 0
                ? ` — ${formatCents(bill.grossCents)} billed less a ${formatCents(bill.quickPayFeeCents)} quick-pay fee.`
                : '.'}
            </p>

            {!assignment && !error && (
              <p className="text-xs text-destructive">
                The assignment behind this bill could not be read, so nothing can be judged yet.
              </p>
            )}

            {readiness.blocks.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
                  This bill cannot be approved.
                </p>
                <ul className="mt-1 space-y-1 text-xs text-destructive">
                  {readiness.blocks.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            )}

            {readiness.warnings.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  Read these and say so; the acknowledgement is kept on the bill.
                </p>
                {readiness.warnings.map((warning) => (
                  <label key={warning.key} className="flex items-start gap-2 text-xs">
                    <Checkbox
                      aria-label={`Acknowledge ${warning.key}`}
                      checked={acked.includes(warning.key)}
                      disabled={disabled}
                      onCheckedChange={(v) => setAcked((prev) => (
                        v === true ? [...prev, warning.key] : prev.filter((key) => key !== warning.key)
                      ))}
                      className="mt-0.5"
                    />
                    {warning.message}
                  </label>
                ))}
              </div>
            )}

            {missing.length > 0 && isAdmin && (
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Paperwork override — {missing.join(', ')} still missing
                </Label>
                <Textarea
                  aria-label="Paperwork override note"
                  rows={2}
                  value={overrideNote}
                  disabled={disabled}
                  placeholder="why this bill is approved without the paperwork"
                  onChange={(e) => setOverrideNote(e.target.value)}
                  className="text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The note is the only record of why. Leave it blank and the gate stands.
                </p>
              </div>
            )}

            {missing.length > 0 && !isAdmin && (
              <p className="text-xs text-muted-foreground">
                Only an owner or admin can approve past missing paperwork.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={disabled || blocked}>
            {saving ? 'Approving…' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
