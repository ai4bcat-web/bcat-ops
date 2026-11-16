import { useMemo } from 'react'
import { Receipt } from 'lucide-react'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import { vendorApTotals } from '@/lib/vendorApTotals'
import { toLocalDateString } from '@/lib/payPeriod'
import { DashCard, DashRow, DashRows, Headline } from './DashCard'

function cents(n: number): string {
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * The vendor AP queue as money: what we owe, what is late, what is due this week. These are vendor
 * (non-carrier) bills from Vendors — repairs, maintenance, fuel, parts — not carrier pay, which is the
 * Accounts payable card.
 */
export function VendorApCard({ onOpen }: { onOpen: () => void }) {
  const { items, loading } = useVendorPayables()
  const totals = useMemo(() => vendorApTotals(items, toLocalDateString(new Date())), [items])
  const rows = [
    { label: 'Overdue', count: totals.overdue.count, amount: totals.overdue.amount, color: 'var(--tms-badge-red)' },
    { label: 'Due this week', count: totals.dueThisWeek.count, amount: totals.dueThisWeek.amount, color: 'var(--tms-badge-orange)' },
    { label: 'Paid last 30 days', count: null, amount: totals.paidLast30, color: 'var(--tms-badge-green)' },
  ]
  return (
    <DashCard label="Vendor bills" hint="Vendor (non-carrier) bills from Vendors. Carrier pay is Accounts payable." icon={<Receipt size={15} />} onOpen={onOpen}>
      <Headline
        value={loading && items.length === 0 ? '—' : cents(totals.outstandingAmount)}
        caption={`to pay · ${totals.outstandingCount} invoice${totals.outstandingCount === 1 ? '' : 's'}${totals.unvalued ? ` · ${totals.unvalued} without an amount` : ''}${totals.nextDue ? ` · next due ${totals.nextDue}` : ''}`}
      />
      <DashRows>
        {rows.map((r) => <DashRow key={r.label} color={r.color} label={r.label} count={r.count} value={cents(r.amount)} />)}
      </DashRows>
    </DashCard>
  )
}
