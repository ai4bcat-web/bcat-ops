/**
 * What this customer owes and what they have paid, on their own profile.
 *
 * Open money first, because that is the question anybody opens this tab to ask; the cash
 * ledger second, because it is the evidence. The figures are the profile's single
 * `useCustomerAr` read passed straight down — nothing is recomputed here except the
 * aging chip, and that comes from the same `agingBucket` the AR page and the invoice
 * row use, so a customer cannot look 31 days late in one place and current in another.
 *
 * Unapplied credit is called out on its own: it is money we are holding that no invoice
 * has claimed, and it is the first thing a payment should spend.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Banknote, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AGING_BUCKET_LABEL, agingBucket, type AgingBucket } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { cn } from '@/lib/utils'
import { ReceivePaymentDialog } from '@/features/ar/components/ReceivePaymentDialog'
import { CreditMemoDialog } from '@/features/ar/components/CreditMemoDialog'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, string> = {
  CURRENT: 'border-border text-muted-foreground',
  D1_30: 'border-amber-500/40 text-amber-700',
  D31_60: 'border-amber-500/40 text-amber-700',
  D61_90: 'border-destructive/40 text-destructive',
  D91_PLUS: 'border-destructive/40 text-destructive',
}

const KIND_LABEL: Record<ArPaymentRecord['kind'], string> = {
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit memo',
  WRITE_OFF: 'Write-off',
  REVERSAL: 'Reversal',
}

/** ISSUED and PARTIAL are open money; PAID and VOID are history. */
const OPEN: Partial<Record<InvoiceRecord['status'], true>> = { ISSUED: true, PARTIAL: true }

export function CustomerArTab({
  customerId, customerName, invoices, payments, openCents, unappliedCents, loading, error, onRefresh,
}: {
  customerId: string
  customerName: string
  invoices: InvoiceRecord[]
  payments: ArPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  error: string | null
  /** Re-read after a post; the profile owns the `useCustomerAr` call. */
  onRefresh: () => Promise<void>
}) {
  const [dialog, setDialog] = useState<'payment' | 'credit' | null>(null)

  const asOf = new Date().toISOString()
  const open = invoices.filter((inv) => OPEN[inv.status])
  open.sort((a, b) => a.dueAt.localeCompare(b.dueAt))

  return (
    <div className="space-y-6" data-testid="customer-ar">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Open AR</p>
          <p className="text-lg font-semibold">{formatCents(openCents)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Unapplied credit</p>
          <p className={cn('text-lg font-semibold', unappliedCents > 0 && 'text-emerald-700')}>
            {formatCents(unappliedCents)}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" className="h-8" onClick={() => setDialog('payment')}>
            <Banknote size={14} className="mr-1" />Receive payment
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => setDialog('credit')}>
            <Plus size={14} className="mr-1" />New credit
          </Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Loading AR…</p>}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Open invoices</h3>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
        ) : (
          <div className="space-y-1">
            {open.map((inv) => {
              const bucket = agingBucket(inv.dueAt, asOf)
              return (
                <div key={inv.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                  <Link to={`/ar/invoices/${inv.id}`} className="font-medium underline underline-offset-2">{inv.number}</Link>
                  <Badge variant="outline" className={cn('text-[10px]', BUCKET_TONE[bucket])}>
                    {bucket === 'CURRENT' ? 'Current' : `${AGING_BUCKET_LABEL[bucket]} days late`}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {inv.shipmentNumber ? `${inv.shipmentNumber} · ` : ''}issued {inv.invoiceDate} · due {inv.dueAt}
                  </span>
                  <span className="ml-auto tabular-nums">{formatCents(inv.totalCents)}</span>
                  <span className="w-28 text-right font-medium tabular-nums">{formatCents(inv.balanceCents)}</span>
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
                <span className="text-xs text-muted-foreground">
                  {row.receivedAt.slice(0, 10)}
                  {row.method ? ` · ${row.method.toLowerCase()}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''}
                </span>
                <span className="ml-auto tabular-nums">{formatCents(row.amountCents)}</span>
                <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                  applied {formatCents(row.appliedCents)}
                </span>
                <span className="w-28 text-right text-xs tabular-nums">
                  {row.unappliedCents > 0 ? `${formatCents(row.unappliedCents)} unapplied` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {dialog === 'payment' && (
        <ReceivePaymentDialog
          customerId={customerId}
          customerName={customerName}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
      {dialog === 'credit' && (
        <CreditMemoDialog
          customerId={customerId}
          customerName={customerName}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void onRefresh() }}
        />
      )}
    </div>
  )
}
