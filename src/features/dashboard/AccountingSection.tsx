/**
 * Accounts receivable and Accounts payable on the Operations Dashboard: two high-level cards in
 * the old Factoring card's look (Ryne 2026-11-15: "only show high level details about accounts
 * receivable and accounts payable, kind of like how the factoring is shown"; "Factoring should
 * move under accounts receivable card").
 *
 * Every figure comes from the same hooks and summary functions as the Invoicing page
 * (`useArSummaryModel`, `useApSummaryModel`, `src/lib/factoredOpen.ts`), with no filters and
 * every billing, so a number here is the page's number. Each card shows only on its own
 * accounting grant; a row opens the matching tab.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Landmark, Truck } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { chicagoDateStr } from '@/lib/date'
import { FACTORED_BUCKET_LABEL, FACTORED_BUCKET_TITLE, type FactoredBucket } from '@/lib/factoredOpen'
import { lastThreeMonths } from '@/features/ar/arViews'
import { readyQueueUnfiltered, useArSummaryModel } from '@/features/ar/useArSummaryModel'
import { useApSummaryModel } from '@/features/ap/useApSummaryModel'
import { arReadyStats } from '@/features/finance/accountingStats'
import { factoredLink, payableLink, receivableLink } from '@/features/finance/accountingLinks'
import { paymentsReceivedPath } from '@/features/payments/links'
import { DashboardSummaryCard, type DashboardSummaryRow } from './DashboardSummaryCard'

const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`

export function AccountingSection() {
  const { hasPageAccess } = useAuth()
  const showAr = hasPageAccess('invoicing')
  const showAp = hasPageAccess('carrierPay')
  if (!showAr && !showAp) return null
  return (
    <section
      aria-label="Accounting"
      data-testid="dashboard-accounting"
      // As many 280px columns as fit, one on a phone: the two cards sit at the KPI cards' width.
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 12, alignItems: 'start' }}
    >
      {showAr && <ReceivablesCard />}
      {showAp && <PayablesCard />}
    </section>
  )
}

/** Factoring, by where each open factored invoice stands with OTR, and the tab it opens. */
const FACTORING_ROWS: { bucket: FactoredBucket; color: string; link: () => string; always?: boolean }[] = [
  { bucket: 'WAITING', color: 'var(--tms-badge-blue)', link: () => factoredLink('PENDING_WITH_OTR'), always: true },
  { bucket: 'APPROVED', color: 'var(--tms-badge-green)', link: () => factoredLink('FACTORED'), always: true },
  { bucket: 'NOT_SENT', color: 'var(--tms-badge-orange)', link: () => receivableLink({ tab: 'ready' }), always: true },
  { bucket: 'MANUAL', color: 'var(--tms-badge-pink)', link: () => receivableLink({ tab: 'invoiced' }), always: true },
  { bucket: 'REJECTED', color: 'var(--tms-badge-red)', link: () => factoredLink('OTR_REJECTED'), always: true },
  { bucket: 'NO_RECORD', color: 'var(--tms-chart-9)', link: () => factoredLink('ALL') },
  { bucket: 'OTHER', color: 'var(--tms-chart-9)', link: () => factoredLink('ALL') },
]

export function ReceivablesCard() {
  const navigate = useNavigate()
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  // The page's default month, so the factoring queue rows resolve their invoices the same way.
  const month = useMemo(() => lastThreeMonths(asOf)[0], [asOf])
  const m = useArSummaryModel(asOf, month)
  const ready = useMemo(() => arReadyStats(readyQueueUnfiltered({
    unbilledRows: m.unbilled.rows, drafts: m.split.drafts, monthInvoices: m.paidInvoices,
    openInvoices: m.open.invoices, factoringItems: m.factoringItems, lookups: m.lookups,
  }), new Map(), asOf).total, [m.unbilled.rows, m.split.drafts, m.paidInvoices, m.open.invoices, m.factoringItems, m.lookups, asOf])
  const s = m.cardSummary
  const loading = m.open.loading

  const rows: DashboardSummaryRow[] = [
    { key: 'shippers', label: 'Pending with shippers', count: s.pendingShippersCount, cents: s.pendingShippersCents, color: 'var(--tms-primary)', onOpen: () => navigate(receivableLink({ tab: 'invoiced' })) },
    { key: 'late', label: 'Late', count: s.lateCount, cents: s.lateCents, color: 'var(--tms-badge-red)', title: 'Past due, every billing', onOpen: () => navigate(receivableLink({ tab: 'invoiced', due: 'past' })) },
    { key: 'collected', label: 'Collected this month', count: s.collectedMonthCount, cents: s.collectedMonthCents, color: 'var(--tms-badge-green)', title: 'Paid in full this month, by paid date. Opens Payments Received.', onOpen: () => navigate(paymentsReceivedPath('month')) },
    { key: 'ready', label: 'Ready to invoice', count: ready.count, cents: ready.cents, color: 'var(--tms-badge-orange)', onOpen: () => navigate(receivableLink({ tab: 'ready' })) },
  ]
  const factoring: DashboardSummaryRow[] = FACTORING_ROWS
    .filter((r) => r.always || s.factored[r.bucket].count > 0)
    .map((r) => ({
      key: `factored-${r.bucket}`,
      label: FACTORED_BUCKET_LABEL[r.bucket],
      title: FACTORED_BUCKET_TITLE[r.bucket],
      count: s.factored[r.bucket].count,
      cents: s.factored[r.bucket].cents,
      color: r.color,
      onOpen: () => navigate(r.link()),
    }))

  return (
    <DashboardSummaryCard
      title="Accounts receivable"
      icon={<Landmark size={15} />}
      headline={loading ? null : s.openCents}
      sublabel={`open · ${n(s.openCount, 'invoice')}`}
      rows={rows}
      groups={[{ key: 'factoring', label: `Factoring · ${n(s.pendingOtrCount, 'open invoice')}`, rows: factoring }]}
      groupsBeside
      accent={s.lateCents > 0 ? 'var(--tms-badge-red)' : 'var(--tms-primary)'}
      onOpen={() => navigate(receivableLink())}
      testId="dashboard-ar-card"
    />
  )
}

export function PayablesCard() {
  const navigate = useNavigate()
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const m = useApSummaryModel(asOf)
  const s = m.summaryAll
  const rows: DashboardSummaryRow[] = [
    { key: 'expected', label: 'Expected', count: s.expected.count, cents: s.expected.cents, color: 'var(--tms-badge-orange)', title: 'Waiting on the carrier invoice date', onOpen: () => navigate(payableLink({ tab: 'expected' })) },
    { key: 'aging', label: 'Aging', count: s.aging.count, cents: s.aging.cents, color: 'var(--tms-primary)', onOpen: () => navigate(payableLink({ tab: 'aging' })) },
    { key: 'past-due', label: 'Past due', count: s.pastDue.count, cents: s.pastDue.cents, color: 'var(--tms-badge-red)', onOpen: () => navigate(payableLink({ tab: 'aging', due: 'past' })) },
    { key: 'next7', label: 'Due next 7 days', count: s.dueNext7.count, cents: s.dueNext7.cents, color: 'var(--tms-badge-blue)', onOpen: () => navigate(payableLink({ tab: 'aging', due: 'week' })) },
  ]
  return (
    <DashboardSummaryCard
      title="Accounts payable"
      icon={<Truck size={15} />}
      headline={m.open.loading ? null : s.open.cents}
      sublabel={`open · ${n(s.open.count, 'bill')}`}
      rows={rows}
      accent={s.pastDue.cents > 0 ? 'var(--tms-badge-red)' : 'var(--tms-primary)'}
      onOpen={() => navigate(payableLink())}
      testId="dashboard-ap-card"
    />
  )
}
