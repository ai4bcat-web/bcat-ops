/**
 * The Vendors page header strip: totals, the source filter, the Bills / By vendor toggle
 * and the pointer card for what is deliberately not in this queue. Display only — the
 * numbers come from `vendorApTotals` and the page owns every piece of state.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TmsAlert, TmsSegmentedTabs, TmsStatRow } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { formatCents } from '@/features/maintenance/maintenanceUi'
import type { VendorApTotals, VendorSourceFilter } from '@/lib/vendorApSources'

export type VendorView = 'bills' | 'vendors'

const SOURCE_TABS: Array<{ key: VendorSourceFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'MAINTENANCE', label: 'Maintenance' },
  { key: 'EMAIL', label: 'E-mail' },
]

const VIEW_TABS: Array<{ key: VendorView; label: string }> = [
  { key: 'bills', label: 'Bills' },
  { key: 'vendors', label: 'By vendor' },
]

function billsLabel(n: number): string {
  return `${n} bill${n === 1 ? '' : 's'}`
}

export function VendorSourceStrip({
  totals,
  sourceCounts,
  source,
  onSource,
  view,
  onView,
}: {
  totals: VendorApTotals
  sourceCounts: Record<VendorSourceFilter, number>
  source: VendorSourceFilter
  onSource: (source: VendorSourceFilter) => void
  view: VendorView
  onView: (view: VendorView) => void
}) {
  const { hasPageAccess } = useAuth()
  // A link only for a viewer who can open the page; plain text otherwise.
  const pointer = (to: string, label: string, ...pages: string[]): ReactNode =>
    pages.some((p) => hasPageAccess(p)) ? <Link to={to}>{label}</Link> : <strong>{label}</strong>

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <TmsStatRow
        aria-label="Vendor payables"
        columns={5}
        compact
        items={[
          { key: 'outstanding', label: 'Outstanding', value: formatCents(totals.outstandingCents), sub: billsLabel(totals.outstandingCount) },
          { key: 'overdue', label: 'Overdue', value: String(totals.overdueCount), tone: totals.overdueCount > 0 ? 'bad' : undefined },
          { key: 'week', label: 'Due this week', value: String(totals.dueThisWeekCount) },
          { key: 'paid', label: 'Paid last 30 days', value: formatCents(totals.paidLast30Cents) },
          { key: 'unvalued', label: 'Unvalued', value: String(totals.unvaluedCount), sub: 'no amount yet' },
        ]}
      />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <TmsSegmentedTabs
          size="sm"
          aria-label="Source"
          tabs={SOURCE_TABS.map(({ key, label }) => ({ key, label, count: sourceCounts[key] }))}
          active={source}
          onSelect={(key) => onSource(key as VendorSourceFilter)}
        />
        <TmsSegmentedTabs
          size="sm"
          aria-label="View"
          tabs={VIEW_TABS}
          active={view}
          onSelect={(key) => onView(key as VendorView)}
        />
      </div>
      <TmsAlert tone="blue" icon={false} title="Not in this queue">
        Carrier bills → {pointer('/tms/invoicing/payable', 'Accounts Payable', 'carrierPay', 'tms')}. Driver settlements and
        payroll (every Wednesday) → {pointer('/driver-pay', 'Assets › settlements', 'driverPay', 'tms')}. Fuel-card
        statements → {pointer('/fuel', 'Assets › Fuel', 'fuel', 'tms')} (they reconcile in Expenses; they are not payable here).
      </TmsAlert>
    </div>
  )
}
