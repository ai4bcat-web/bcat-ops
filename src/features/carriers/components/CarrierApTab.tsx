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
import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { AGING_BUCKET_LABEL, agingBucket, type AgingBucket } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { PayCarrierDialog } from '@/features/ap/components/PayCarrierDialog'
import { ApCreditDialog } from '@/features/ap/components/ApCreditDialog'
import { SendRemittanceDialog } from '@/features/ap/components/SendRemittanceDialog'
import type { TmsTone } from '@/features/tms/kit'
import type { ApPaymentRecord, CarrierBillRecord } from '@/types/tms'

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, TmsTone> = {
  CURRENT: 'gray',
  D1_30: 'orange',
  D31_60: 'orange',
  D61_90: 'red',
  D91_PLUS: 'red',
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
    <div className="flex flex-col gap-4" data-testid="carrier-ap">
      <TmsCard
        title="Carrier AP"
        actions={
          <>
            <TmsButton variant="primary" size="sm" onClick={() => setDialog({ kind: 'pay' })}>
              <Banknote size={14} />Pay carrier
            </TmsButton>
            <TmsButton size="sm" onClick={() => setDialog({ kind: 'credit' })}>
              <Plus size={14} />New credit
            </TmsButton>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Open AP</p>
            <p className="text-lg font-semibold">{formatCents(openCents)}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Unapplied credit</p>
            <p
              className="text-lg font-semibold"
              style={unappliedCents > 0 ? { color: 'var(--tms-badge-green)' } : undefined}
            >
              {formatCents(unappliedCents)}
            </p>
          </div>
        </div>

        {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        {loading && <p className="mt-2 tms-muted">Loading AP…</p>}
      </TmsCard>

      <TmsCard title="Open bills">
        {open.length === 0 ? (
          <p className="tms-muted">Nothing outstanding.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {open.map((bill) => {
              const bucket = agingBucket(bill.dueAt, asOf)
              return (
                <div
                  key={bill.id}
                  className="flex flex-wrap items-center gap-2 p-2"
                  style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
                >
                  <Link to={`/tms/invoicing/payable/bills/${bill.id}`} className="font-medium">
                    {bill.billNumber ?? bill.id}
                  </Link>
                  <TmsBadge tone="gray">{STATUS_LABEL[bill.status]}</TmsBadge>
                  <TmsBadge tone={BUCKET_TONE[bucket]}>
                    {bucket === 'CURRENT' ? 'Current' : `${AGING_BUCKET_LABEL[bucket]} days late`}
                  </TmsBadge>
                  <span className="text-xs tms-muted">
                    {bill.shipmentNumber ? `${bill.shipmentNumber} · ` : ''}recorded {bill.billDate} · due {bill.dueAt}
                  </span>
                  <span className="ml-auto tabular-nums">{formatCents(bill.netCents)}</span>
                  <span className="w-28 text-right font-medium tabular-nums">{formatCents(bill.balanceCents)}</span>
                </div>
              )
            })}
          </div>
        )}
      </TmsCard>

      <TmsCard title="Payments & credits">
        {payments.length === 0 ? (
          <p className="tms-muted">Nothing posted yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {payments.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-2 p-2"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              >
                <TmsBadge tone="gray">{KIND_LABEL[row.kind]}</TmsBadge>
                {row.reversedByPaymentId && <TmsBadge tone="gray">reversed</TmsBadge>}
                <span className="text-xs tms-muted">
                  {row.paidAt.slice(0, 10)}
                  {row.method ? ` · ${row.method.toLowerCase()}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''}
                </span>
                <span className="ml-auto tabular-nums">{formatCents(row.amountCents)}</span>
                <span className="w-24 text-right text-xs tms-muted tabular-nums">
                  applied {formatCents(row.appliedCents)}
                </span>
                <span className="w-28 text-right text-xs tabular-nums">
                  {row.unappliedCents > 0 && !row.reversedByPaymentId ? `${formatCents(row.unappliedCents)} unapplied` : ''}
                </span>
                {row.kind === 'PAYMENT' && !row.reversedByPaymentId && (
                  <TmsButton variant="ghost" size="sm" onClick={() => setDialog({ kind: 'remittance', payment: row })}>
                    <Mail size={13} />
                    {row.remittanceSentAt || row.markedSentAt ? 'Remittance again' : 'Remittance'}
                  </TmsButton>
                )}
              </div>
            ))}
          </div>
        )}
      </TmsCard>

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
