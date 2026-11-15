/**
 * Accounting on the Operations Dashboard: the Invoicing page's Receivables and Payables cards
 * (Ryne 2026-11-15: "display all information about ar and ap in cards… match the cards from the
 * accounting page").
 *
 * The same card components fed by the same hooks and summary functions as the Invoicing page
 * (`useArSummaryModel`, `useApSummaryModel`), with no filters and every billing, so the numbers
 * here are the page's numbers. Each half shows only on its own accounting grant; a row opens the
 * matching view, tab and filter on the Invoicing page.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { chicagoDateStr } from '@/lib/date'
import { ArSummaryStrip } from '@/features/ar/ArSummaryStrip'
import { lastThreeMonths } from '@/features/ar/arViews'
import { readyQueueUnfiltered, useArSummaryModel } from '@/features/ar/useArSummaryModel'
import { useFactorReadiness } from '@/features/ar/useFactorReadiness'
import { useDeliveredNotReady } from '@/features/ar/useDeliveredNotReady'
import { ApSummaryStrip } from '@/features/ap/components/ApSummaryStrip'
import { billsAging, billsExpected } from '@/features/ap/apViews'
import { useApSummaryModel } from '@/features/ap/useApSummaryModel'
import { ApAgingCard, ApExpectedCard, ArReadyCard, ProfitCheckCard } from '@/features/finance/AccountingCards'
import { apAgingStats, apExpectedStats, arReadyStats } from '@/features/finance/accountingStats'
import { AccountingReportsDialog } from '@/features/finance/AccountingReportsDialog'
import type { AccountingReportKind } from '@/features/finance/accountingReports'
import { useNeedsReview } from '@/features/finance/useNeedsReview'
import { payableLink, receivableLink } from '@/features/finance/accountingLinks'

/** One column on a phone, as many 300px columns as fit beyond that: a card is never narrower than its amounts. */
const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
  gap: 12,
  alignItems: 'start',
}

function SectionHead({ title, onOpen, openLabel }: { title: string; onOpen: () => void; openLabel: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>{title}</div>
      <button type="button" className="tms-link" onClick={onOpen} style={{ fontSize: 12.5 }}>{openLabel}</button>
    </div>
  )
}

export function AccountingSection() {
  const { hasPageAccess } = useAuth()
  const showAr = hasPageAccess('invoicing')
  const showAp = hasPageAccess('carrierPay')
  if (!showAr && !showAp) return null
  return (
    <section aria-label="Accounting" data-testid="dashboard-accounting" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {showAr && <ReceivablesCards />}
      {showAp && <PayablesCards />}
    </section>
  )
}

export function ReceivablesCards() {
  const navigate = useNavigate()
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  // The page's default month, so the factoring queue rows resolve their invoices the same way.
  const month = useMemo(() => lastThreeMonths(asOf)[0], [asOf])
  const m = useArSummaryModel(asOf, month)
  const ready = useMemo(() => readyQueueUnfiltered({
    unbilledRows: m.unbilled.rows, drafts: m.split.drafts, monthInvoices: m.paidInvoices,
    openInvoices: m.open.invoices, factoringItems: m.factoringItems, lookups: m.lookups,
  }), [m.unbilled.rows, m.split.drafts, m.paidInvoices, m.open.invoices, m.factoringItems, m.lookups])
  const readiness = useFactorReadiness(ready, true)
  const deliveredNotReady = useDeliveredNotReady(true)
  const [report, setReport] = useState<AccountingReportKind | null>(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="dashboard-receivables">
      <SectionHead title="Accounts receivable" openLabel="Open Invoicing" onOpen={() => navigate(receivableLink())} />
      <div style={GRID}>
        <ArSummaryStrip summary={m.cardSummary} division={null} onDivision={(key) => navigate(receivableLink({ tab: 'invoiced', division: key }))} />
        <ArReadyCard stats={arReadyStats(ready, readiness, asOf)} deliveredNotReady={deliveredNotReady} onLoadReview={() => navigate('/tms/load-review')} />
        <ProfitCheckCard asOf={asOf} onOpenReport={setReport} testId="dashboard-profit-check" />
      </div>
      {report && <AccountingReportsDialog side="AR" asOf={asOf} initialKind={report} onClose={() => setReport(null)} />}
    </div>
  )
}

export function PayablesCards() {
  const navigate = useNavigate()
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const m = useApSummaryModel(asOf)
  const needsReview = useNeedsReview()
  const reviewByShipment = useMemo(() => new Map(needsReview.rows.map((row) => [row.id, row])), [needsReview.rows])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="dashboard-payables">
      <SectionHead title="Accounts payable" openLabel="Open Payables" onOpen={() => navigate(payableLink())} />
      <div style={GRID}>
        <ApSummaryStrip
          summary={m.summaryAll}
          divisionName={m.divisionName}
          division={null}
          onDivision={(key) => navigate(payableLink({ tab: 'aging', division: key }))}
          onCashRequirements={() => navigate(payableLink({ tab: 'aging' }))}
          onTab={(tab) => navigate(payableLink({ tab }))}
        />
        <ApExpectedCard stats={apExpectedStats(billsExpected(m.totalsAll), reviewByShipment, asOf)} />
        <ApAgingCard
          stats={apAgingStats(billsAging(m.totalsAll), asOf)}
          due={null}
          onDue={(due) => navigate(payableLink({ tab: 'aging', due }))}
          parties={[]}
          onParty={(id) => navigate(payableLink({ tab: 'aging', party: id }))}
        />
      </div>
    </div>
  )
}
