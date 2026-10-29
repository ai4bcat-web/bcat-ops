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
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import { AGING_BUCKET_LABEL, agingBucket, type AgingBucket } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { ReceivePaymentDialog } from '@/features/ar/components/ReceivePaymentDialog'
import { CreditMemoDialog } from '@/features/ar/components/CreditMemoDialog'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, TmsTone> = {
  CURRENT: 'gray',
  D1_30: 'orange',
  D31_60: 'orange',
  D61_90: 'red',
  D91_PLUS: 'red',
}

const KIND_LABEL: Record<ArPaymentRecord['kind'], string> = {
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit memo',
  WRITE_OFF: 'Write-off',
  REVERSAL: 'Reversal',
}

/** ISSUED and PARTIAL are open money; PAID and VOID are history. */
const OPEN: Partial<Record<InvoiceRecord['status'], true>> = { ISSUED: true, PARTIAL: true }

const rowStyle: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13,
  border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8,
}

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
    <div style={{ display: 'grid', gap: 20 }} data-testid="customer-ar">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <div>
          <p className="tms-field-label">Open AR</p>
          <p style={{ fontSize: 18, fontWeight: 600 }}>{formatCents(openCents)}</p>
        </div>
        <div>
          <p className="tms-field-label">Unapplied credit</p>
          <p style={{ fontSize: 18, fontWeight: 600, color: unappliedCents > 0 ? 'var(--tms-badge-green)' : undefined }}>
            {formatCents(unappliedCents)}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <TmsButton variant="primary" size="sm" onClick={() => setDialog('payment')}>
            <Banknote size={14} />Receive payment
          </TmsButton>
          <TmsButton size="sm" onClick={() => setDialog('credit')}>
            <Plus size={14} />New credit
          </TmsButton>
        </div>
      </div>

      {error && <p className="tms-field-error">{error}</p>}
      {loading && <p className="tms-muted" style={{ fontSize: 13 }}>Loading AR…</p>}

      <section>
        <h3 style={{ marginBottom: 8 }}>Open invoices</h3>
        {open.length === 0 ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>Nothing outstanding.</p>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {open.map((inv) => {
              const bucket = agingBucket(inv.dueAt, asOf)
              return (
                <div key={inv.id} style={rowStyle}>
                  <Link to={`/tms/invoicing/invoices/${inv.id}`} style={{ fontWeight: 600 }}>{inv.number}</Link>
                  <TmsBadge tone={BUCKET_TONE[bucket]}>
                    {bucket === 'CURRENT' ? 'Current' : `${AGING_BUCKET_LABEL[bucket]} days late`}
                  </TmsBadge>
                  <span className="tms-muted" style={{ fontSize: 12 }}>
                    {inv.shipmentNumber ? `${inv.shipmentNumber} · ` : ''}issued {inv.invoiceDate} · due {inv.dueAt}
                  </span>
                  <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatCents(inv.totalCents)}</span>
                  <span style={{ width: 112, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatCents(inv.balanceCents)}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h3 style={{ marginBottom: 8 }}>Payments &amp; credits</h3>
        {payments.length === 0 ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>Nothing posted yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {payments.map((row) => (
              <div key={row.id} style={rowStyle}>
                <TmsBadge>{KIND_LABEL[row.kind]}</TmsBadge>
                <span className="tms-muted" style={{ fontSize: 12 }}>
                  {row.receivedAt.slice(0, 10)}
                  {row.method ? ` · ${row.method.toLowerCase()}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''}
                </span>
                <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatCents(row.amountCents)}</span>
                <span className="tms-muted" style={{ width: 96, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  applied {formatCents(row.appliedCents)}
                </span>
                <span style={{ width: 112, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
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
