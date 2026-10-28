/**
 * The AP corner of a shipment: what each leg of it costs us, where that cost sits on the
 * payables ladder, and the one action that moves it from here.
 *
 * Three rules shape it.
 *
 * 1. **One card per assignment, not per shipment.** AR asks one question of an order; AP
 *    asks it again of every carrier that touched the freight. A rebooked load has two
 *    rows and the bounced one is not among them — a carrier that never hauled is not
 *    owed. A TONU'd one is: truck ordered, truck arrived, nothing to load, still paid.
 * 2. **Own-fleet legs are not AP at all.** A driver on our payroll is paid on their
 *    settlement, so the own-asset card draws no ladder and offers no Record: it says
 *    where that money really is and links to the pay week it lands in.
 * 3. **Nothing here is recomputed.** The readiness reasons come from `billReadiness`,
 *    the net, the balance and the aging from `billData` — the same functions the Lambda
 *    and the AP board read, so a leg cannot look payable here and be refused there.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Banknote, CheckCircle2, FileText, Pencil, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getCarrier, getCarrierBill, voidBill } from '@/lib/apiClient'
import { billData, billLinesFor, billReadiness } from '@/lib/carrierBill'
import { AGING_BUCKET_LABEL, type AgingBucket } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { cn } from '@/lib/utils'
import { weekLabel, weekStartOfISO } from '@/features/driver-pay/week'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { RecordBillDialog } from '@/features/ap/components/RecordBillDialog'
import { ApproveBillDialog } from '@/features/ap/components/ApproveBillDialog'
import { UpdateCarrierChargesDialog } from '@/features/ap/components/UpdateCarrierChargesDialog'
import { PayCarrierDialog } from '@/features/ap/components/PayCarrierDialog'
import type {
  ApStatus, CarrierBillRecord, CarrierRecord, LoadCarrierRecord, ShipmentBundle, ShipmentLoad,
} from '@/types/tms'

/** The walk, in order — `LoadCarrier.apStatus` and nothing else. */
const RUNGS = [
  { key: 'AWAITING_INVOICE', label: 'Awaiting invoice' },
  { key: 'IN_REVIEW', label: 'In review' },
  { key: 'TO_BE_PAID', label: 'To be paid' },
  { key: 'PAID', label: 'Paid' },
] as const satisfies readonly { key: ApStatus; label: string }[]

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, string> = {
  CURRENT: 'border-border text-muted-foreground',
  D1_30: 'border-amber-500/40 text-amber-700',
  D31_60: 'border-amber-500/40 text-amber-700',
  D61_90: 'border-destructive/40 text-destructive',
  D91_PLUS: 'border-destructive/40 text-destructive',
}

type ApDialog = { kind: 'record' } | { kind: 'charges' } | { kind: 'approve' } | { kind: 'pay' } | { kind: 'void' } | null

export interface ApCardProps {
  bundle: ShipmentBundle
  /** Re-read the shipment: every write here moves the assignment's AP fields. */
  onReload: () => Promise<void>
}

export function ApCard({ bundle, onReload }: ApCardProps) {
  // A bounced carrier is owed nothing, so it has no AP card at all.
  const assignments = bundle.loadCarriers.filter((row) => row.status !== 'BOUNCED')
  const billIds = assignments.map((row) => row.invoiceId).filter((id): id is string => !!id).join(',')
  const carrierIds = [...new Set(
    assignments.filter((row) => row.kind === 'CARRIER').map((row) => row.carrierId).filter((id): id is string => !!id),
  )].join(',')

  const [bills, setBills] = useState<Record<string, CarrierBillRecord>>({})
  /** `null` until the directory answers: an unread carrier must not read as a missing one. */
  const [carriers, setCarriers] = useState<Record<string, CarrierRecord | null> | null>(null)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    const ids = billIds ? billIds.split(',') : []
    Promise.all(ids.map((id) => getCarrierBill(id).catch(() => null)))
      .then((rows) => {
        if (!live) return
        const next: Record<string, CarrierBillRecord> = {}
        for (const row of rows) if (row) next[row.id] = row
        setBills(next)
      })
      .catch(() => { /* the card falls back to the assignment's cached numbers */ })
    return () => { live = false }
  }, [billIds])

  useEffect(() => {
    let live = true
    const ids = carrierIds ? carrierIds.split(',') : []
    Promise.all(ids.map((id) => getCarrier(id).catch(() => null)))
      .then((rows) => {
        if (!live) return
        const next: Record<string, CarrierRecord | null> = {}
        ids.forEach((id, i) => { next[id] = rows[i] ?? null })
        setCarriers(next)
      })
      .catch(() => { /* the cards stay on "checking the directory" */ })
    return () => { live = false }
  }, [carrierIds])

  /**
   * Every write moves the assignment, so the shipment and its bills are both re-read.
   * Left unmemoized on purpose: `billIds` is derived from the bundle prop, and the
   * React compiler refuses to preserve a manual memo keyed on that.
   */
  const refresh = async () => {
    await onReload()
    const ids = billIds ? billIds.split(',') : []
    const rows = await Promise.all(ids.map((id) => getCarrierBill(id).catch(() => null)))
    const next: Record<string, CarrierBillRecord> = {}
    for (const row of rows) if (row) next[row.id] = row
    setBills(next)
  }

  if (assignments.length === 0) return null

  return (
    <div className="space-y-3">
      {assignments.map((loadCarrier) => (
        <AssignmentCard
          key={loadCarrier.id}
          bundle={bundle}
          loadCarrier={loadCarrier}
          bill={loadCarrier.invoiceId ? bills[loadCarrier.invoiceId] ?? null : null}
          carrier={carriers ? carriers[loadCarrier.carrierId ?? ''] ?? null : null}
          directoryRead={carriers !== null}
          onRefresh={refresh}
        />
      ))}
    </div>
  )
}

function AssignmentCard({ bundle, loadCarrier, bill, carrier, directoryRead, onRefresh }: {
  bundle: ShipmentBundle
  loadCarrier: LoadCarrierRecord
  bill: CarrierBillRecord | null
  carrier: CarrierRecord | null
  directoryRead: boolean
  onRefresh: () => Promise<void>
}) {
  const [dialog, setDialog] = useState<ApDialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = bundle.loads.find((row) => row.id === loadCarrier.loadId) ?? null
  const legName = load?.loadNumber ?? bundle.shipment.number

  if (loadCarrier.kind === 'OWN_ASSET') {
    return <OwnAssetCard loadCarrier={loadCarrier} load={load} legName={legName} />
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onRefresh()
      toast.success(label)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`)
    } finally {
      setBusy(false)
    }
  }

  const apStatus: ApStatus = loadCarrier.apStatus ?? 'AWAITING_INVOICE'
  const view = bill
    ? billData({ bill, bundle: { shipment: bundle.shipment, loads: bundle.loads }, carrier })
    : null
  const readiness = bill
    ? null
    : billReadiness({
        loadCarrier,
        load,
        carrier,
        charges: bundle.charges,
        existingBills: [],
      })
  const grossCents = bill ? view?.totals.grossCents ?? 0 : billLinesFor(bundle.charges, loadCarrier.id).grossCents
  const voided = view?.status === 'VOID'
  const payee = view
    ? view.payee.kind === 'FACTOR'
      ? `${view.payee.factorName ?? view.payee.name} (factor)`
      : view.payee.name
    : null

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="ap-card" data-assignment={loadCarrier.id}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Accounts payable</p>
        <span className="text-xs text-muted-foreground">
          {legName} · {loadCarrier.carrierName ?? 'Carrier'}
        </span>
        {loadCarrier.status === 'TONU' && (
          <Badge variant="outline" className="text-[10px]" data-testid="ap-tonu">TONU — owed anyway</Badge>
        )}
        <ol className="ml-auto flex flex-wrap items-center gap-1" data-testid="ap-ladder">
          {RUNGS.map((rung) => {
            const lit = rung.key === apStatus
            return (
              <li
                key={rung.key}
                data-testid={`ap-rung-${rung.key}`}
                aria-current={lit ? 'step' : undefined}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  lit ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground',
                )}
              >
                {rung.label}
              </li>
            )
          })}
        </ol>
      </div>

      {view ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Bill</dt>
            <dd>
              <Link to={`/ap/bills/${view.id}`} className="underline underline-offset-2">
                {view.billNumber ?? view.id}
              </Link>
              {voided && <Badge variant="outline" className="ml-1 text-[10px]">void</Badge>}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Net</dt>
            <dd className="tabular-nums">{formatCents(view.totals.netCents)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Balance</dt>
            <dd className="tabular-nums">{formatCents(view.totals.balanceCents)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Due</dt>
            <dd className="flex flex-wrap items-center gap-1">
              {view.aging.dueAt}
              {view.aging.open && (
                <Badge variant="outline" className={cn('text-[10px]', BUCKET_TONE[view.aging.bucket])}>
                  {view.aging.bucket === 'CURRENT'
                    ? AGING_BUCKET_LABEL[view.aging.bucket]
                    : `${AGING_BUCKET_LABEL[view.aging.bucket]} days late`}
                </Badge>
              )}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Paid to</dt>
            <dd data-testid="ap-payee">
              {payee || '—'}
              {view.totals.quickPayFeeCents > 0 && (
                <span className="ml-1 text-xs text-muted-foreground">
                  quick pay · {formatCents(view.totals.quickPayFeeCents)} deducted
                </span>
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <div className="space-y-1 text-sm" data-testid="ap-readiness">
          <p className="text-muted-foreground">
            Carrier charges {formatCents(grossCents)} · no bill recorded yet.
          </p>
          {!directoryRead && <p className="text-xs text-muted-foreground">Checking the carrier directory…</p>}
          {directoryRead && readiness && !readiness.ready && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!bill && (
          <>
            <Button
              size="sm"
              className="h-8"
              disabled={busy || !directoryRead || !readiness?.ready}
              onClick={() => setDialog({ kind: 'record' })}
            >
              <FileText size={13} className="mr-1" />Record bill
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setDialog({ kind: 'charges' })}>
              <Pencil size={13} className="mr-1" />Edit carrier charges
            </Button>
          </>
        )}
        {view && !voided && (
          <>
            {view.status === 'IN_REVIEW' && (
              <Button size="sm" className="h-8" disabled={busy} onClick={() => setDialog({ kind: 'approve' })}>
                <CheckCircle2 size={13} className="mr-1" />Approve
              </Button>
            )}
            {(view.status === 'TO_BE_PAID' || view.status === 'PARTIAL') && view.totals.balanceCents > 0 && (
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setDialog({ kind: 'pay' })}>
                <Banknote size={13} className="mr-1" />Pay carrier
              </Button>
            )}
            {view.status !== 'PAID' && (
              <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={busy} onClick={() => setDialog({ kind: 'void' })}>
                <Ban size={13} className="mr-1" />Void
              </Button>
            )}
          </>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {dialog?.kind === 'record' && (
        <RecordBillDialog
          open
          loadCarrierId={loadCarrier.id}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'charges' && (
        <UpdateCarrierChargesDialog
          open
          loadCarrierId={loadCarrier.id}
          shipmentId={bundle.shipment.id}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'approve' && bill && (
        <ApproveBillDialog
          open
          bill={bill}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'pay' && bill && (
        <PayCarrierDialog
          open
          carrierId={bill.carrierId}
          preselectBillIds={[bill.id]}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'void' && bill && (
        <ReasonDialog
          title={`Void bill ${bill.billNumber ?? bill.id}`}
          description="The assignment goes back to Awaiting invoice and its charges unfreeze. A voided bill is never edited or reused."
          label="Reason"
          confirmLabel="Void bill"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => {
            void run('Bill voided', () => voidBill({ billId: bill.id, reason })).then(() => setDialog(null))
          }}
        />
      )}
    </div>
  )
}

/**
 * An own-fleet leg has no bill, no rungs and no Record: the driver is paid on their
 * settlement, so the only honest thing this card can do is say so and point at the pay
 * week the leg lands in.
 */
function OwnAssetCard({ loadCarrier, load, legName }: {
  loadCarrier: LoadCarrierRecord
  load: ShipmentLoad | null
  legName: string | undefined
}) {
  const settledOn = load?.deliveredAt ?? load?.deliveryAppt ?? load?.pickupAppt ?? loadCarrier.bookedAt ?? null
  const week = settledOn ? weekStartOfISO(settledOn.slice(0, 10)) : null
  const query = new URLSearchParams()
  if (week) query.set('week', week)
  if (loadCarrier.driverId) query.set('driver', loadCarrier.driverId)
  const search = query.toString()
  const href = search ? `/driver-pay?${search}` : '/driver-pay'

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="ap-card" data-assignment={loadCarrier.id}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Accounts payable</p>
        <span className="text-xs text-muted-foreground">
          {legName} · {loadCarrier.driverName ?? 'Own asset'}
        </span>
        <Badge variant="outline" className="ml-auto text-[10px]" data-testid="ap-own-asset">
          <Truck size={11} className="mr-1" />Settled through driver pay
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        An own-fleet leg never enters AP — there is no carrier bill to record and nothing to approve.{' '}
        <Link to={href} className="underline underline-offset-2" data-testid="ap-settlement-link">
          {week ? `Pay week ${weekLabel(week)}` : 'Driver pay'}
        </Link>
        {loadCarrier.driverName ? ` is where ${loadCarrier.driverName} is paid for it.` : ' is where the driver is paid for it.'}
      </p>
    </div>
  )
}
