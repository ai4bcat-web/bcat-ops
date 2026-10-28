/**
 * What we owe this carrier and what we have already sent them, on their own profile.
 *
 * Open money first, because that is the question anybody opens this tab to ask; the cash
 * ledger second, because it is the evidence. The figures are the profile's single
 * `useCarrierAp` read passed straight down — nothing is recomputed here except the aging
 * chip, and that comes from the same `agingBucket` the AP board and the bill row use, so
 * a carrier cannot look 31 days late in one place and current in another.
 *
 * Unapplied credit is called out on its own: it is money the carrier owes us back that no
 * bill has claimed yet, and it is the first thing a payment should spend.
 *
 * A remittance is offered on the payments that have one to send. On dev SES is denied, so
 * the dialog hands over the body and the PDF rather than claiming anything went out.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Banknote, Mail, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AGING_BUCKET_LABEL, agingBucket, type AgingBucket } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { cn } from '@/lib/utils'
import { PayCarrierDialog } from '@/features/ap/components/PayCarrierDialog'
import { ApCreditDialog } from '@/features/ap/components/ApCreditDialog'
import { SendRemittanceDialog } from '@/features/ap/components/SendRemittanceDialog'
import type { ApPaymentRecord, CarrierBillRecord } from '@/types/tms'

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, string> = {
  CURRENT: 'border-border text-muted-foreground',
  D1_30: 'border-amber-500/40 text-amber-700',
  D31_60: 'border-amber-500/40 text-amber-700',
  D61_90: 'border-destructive/40 text-destructive',
  D91_PLUS: 'border-destructive/40 text-destructive',
}

const KIND_LABEL: Record<ApPaymentRecord['kind'], string> = {
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit',
  REVERSAL: 'Reversal',
}

const STATUS_LABEL: Record<CarrierBillRecord['status'], string> = {
  IN_REVIEW: 'In review',
  TO_BE_PAID: 'To be paid',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
  VOID: 'Void',
}

/** IN_REVIEW, TO_BE_PAID and PARTIAL are open money; PAID and VOID are history. */
const OPEN: Partial<Record<CarrierBillRecord['status'], true>> = { IN_REVIEW: true, TO_BE_PAID: true, PARTIAL: true }

type ApTabDialog = { kind: 'pay' } | { kind: 'credit' } | { kind: 'remittance'; payment: ApPaymentRecord } | null

export function CarrierApTab({
  carrierId, bills, payments, openCents, unappliedCents, loading, error, onRefresh,
}: {
  carrierId: string
  bills: CarrierBillRecord[]
  payments: ApPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  error: string | null
  /** Re-read after a post; the profile owns the `useCarrierAp` call. */
  onRefresh: () => Promise<void>
}) {
  const [dialog, setDialog] = useState<ApTabDialog>(null)

  const asOf = new Date().toISOString()
  const open = bills.filter((bill) => OPEN[bill.status])
  open.sort((a, b) => a.dueAt.localeCompare(b.dueAt))

  return (
    <div className="space-y-6" data-testid="carrier-ap">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Open AP</p>
          <p className="text-lg font-semibold">{formatCents(openCents)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Unapplied credit</p>
          <p className={cn('text-lg font-semibold', unappliedCents > 0 && 'text-emerald-700')}>
            {formatCents(unappliedCents)}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" className="h-8" onClick={() => setDialog({ kind: 'pay' })}>
            <Banknote size={14} className="mr-1" />Pay carrier
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => setDialog({ kind: 'credit' })}>
            <Plus size={14} className="mr-1" />New credit
          </Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Loading AP…</p>}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Open bills</h3>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
        ) : (
          <div className="space-y-1">
            {open.map((bill) => {
              const bucket = agingBucket(bill.dueAt, asOf)
              return (
                <div key={bill.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                  <Link to={`/ap/bills/${bill.id}`} className="font-medium underline underline-offset-2">
                    {bill.billNumber ?? bill.id}
                  </Link>
                  <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[bill.status]}</Badge>
                  <Badge variant="outline" className={cn('text-[10px]', BUCKET_TONE[bucket])}>
                    {bucket === 'CURRENT' ? 'Current' : `${AGING_BUCKET_LABEL[bucket]} days late`}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {bill.shipmentNumber ? `${bill.shipmentNumber} · ` : ''}recorded {bill.billDate} · due {bill.dueAt}
                  </span>
                  <span className="ml-auto tabular-nums">{formatCents(bill.netCents)}</span>
                  <span className="w-28 text-right font-medium tabular-nums">{formatCents(bill.balanceCents)}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Payments &amp; credits</h3>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing posted yet.</p>
        ) : (
          <div className="space-y-1">
            {payments.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <Badge variant="outline" className="text-[10px]">{KIND_LABEL[row.kind]}</Badge>
                {row.reversedByPaymentId && <Badge variant="outline" className="text-[10px]">reversed</Badge>}
                <span className="text-xs text-muted-foreground">
                  {row.paidAt.slice(0, 10)}
                  {row.method ? ` · ${row.method.toLowerCase()}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''}
                </span>
                <span className="ml-auto tabular-nums">{formatCents(row.amountCents)}</span>
                <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                  applied {formatCents(row.appliedCents)}
                </span>
                <span className="w-28 text-right text-xs tabular-nums">
                  {row.unappliedCents > 0 && !row.reversedByPaymentId ? `${formatCents(row.unappliedCents)} unapplied` : ''}
                </span>
                {row.kind === 'PAYMENT' && !row.reversedByPaymentId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => setDialog({ kind: 'remittance', payment: row })}
                  >
                    <Mail size={13} className="mr-1" />
                    {row.remittanceSentAt || row.markedSentAt ? 'Remittance again' : 'Remittance'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {dialog?.kind === 'pay' && (
        <PayCarrierDialog
          open
          carrierId={carrierId}
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'credit' && (
        <ApCreditDialog
          open
          carrierId={carrierId}
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog?.kind === 'remittance' && (
        <SendRemittanceDialog
          open
          payment={dialog.payment}
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
    </div>
  )
}
