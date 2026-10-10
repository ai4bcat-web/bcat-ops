import { useMemo } from 'react'
import { Receipt } from 'lucide-react'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import { vendorApTotals } from '@/lib/vendorApTotals'
import { toLocalDateString } from '@/lib/payPeriod'

function cents(n: number): string {
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** The vendor AP queue as money: what we owe, what is late, what is due this week. */
export function VendorApCard({ onOpen }: { onOpen: () => void }) {
  const { items, loading } = useVendorPayables()
  const totals = useMemo(() => vendorApTotals(items, toLocalDateString(new Date())), [items])
  const accent = totals.overdue.count > 0 ? '#dc2626' : totals.outstandingCount > 0 ? '#b45309' : '#22c55e'
  const rows = [
    { label: 'Overdue', count: totals.overdue.count, amount: totals.overdue.amount, color: '#dc2626' },
    { label: 'Due this week', count: totals.dueThisWeek.count, amount: totals.dueThisWeek.amount, color: '#b45309' },
    { label: 'Paid last 30 days', count: null, amount: totals.paidLast30, color: '#15803d' },
  ]
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen() }}
      style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', boxShadow: 'var(--sh-sm)', position: 'relative', overflow: 'hidden', cursor: 'pointer' }}
    >
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%', background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>Vendor AP</div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-t2)' }}>
            <Receipt size={15} />
          </div>
        </div>
        <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
          {loading && items.length === 0 ? '—' : cents(totals.outstandingAmount)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginBottom: 12 }}>
          to pay · {totals.outstandingCount} invoice{totals.outstandingCount === 1 ? '' : 's'}
          {totals.unvalued ? ` · ${totals.unvalued} without an amount yet` : ''}
          {totals.nextDue ? ` · next due ${totals.nextDue}` : ''}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                {r.label}
                {r.count != null ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ds-t3)' }}>{r.count}</span> : null}
              </span>
              <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{cents(r.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
