/**
 * `/financial-operations` — the company's money at a glance: margin, deliveries, payouts,
 * credits, revenue by division against its trailing average, the weekly trend and the
 * payment ledger. Read-only. Every figure is computed in `lib/financeOps` (via
 * `useFinancialOps`); this component formats and lays out, nothing more.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, CircleDollarSign, Download, RefreshCw, Truck, Wallet } from 'lucide-react'
import {
  TmsAlert, TmsButton, TmsCard, TmsChartCard, TmsGauge, TmsPillBarChart, TmsScrollPage, TmsSegmentedBar,
  TmsSegmentedTabs, TmsStatRow,
} from '@/features/tms/kit'
import type { TmsStat } from '@/features/tms/kit'
import { monthLabel } from '@/lib/dashboardCharts'
import { saveBlob } from '@/lib/download'
import {
  FINANCE_PERIODS, compactDollars, ownFleetCaption, revenueGauge, weeklyRevenueCsv, type FinancePeriod,
} from '@/lib/financeOps'
import { formatCents } from '@/lib/invoiceBuild'
import { PaymentsTable } from './PaymentsTable'
import { useFinancialOps } from './useFinancialOps'

const STACK = { display: 'flex', flexDirection: 'column', gap: 16 } as const
const TWO_UP = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 } as const
const NOTE = { margin: 0, fontSize: 12, color: 'var(--tms-muted)' } as const

export function FinancialOperationsPage() {
  const [period, setPeriod] = useState<FinancePeriod>('THIS_MONTH')
  const ops = useFinancialOps(period)
  const { kpis, deltas } = ops

  const tabs = FINANCE_PERIODS.map((p) => ({ key: p.key, label: p.label }))
  const compare = 'vs previous period'

  const stats: TmsStat[] = [
    {
      key: 'margin',
      label: 'Avg margin per shipment',
      icon: CircleDollarSign,
      value: kpis?.avgMarginCents != null ? formatCents(kpis.avgMarginCents) : null,
      sub: kpis?.marginBps != null ? `${(kpis.marginBps / 100).toFixed(1)}% margin` : 'No priced brokered loads',
      delta: deltas?.avgMargin != null
        ? { pct: deltas.avgMargin, label: `${kpis?.marginBps != null ? `${(kpis.marginBps / 100).toFixed(1)}% margin · ` : ''}${compare}` }
        : null,
    },
    {
      key: 'completed',
      label: 'Shipments completed',
      icon: Truck,
      value: kpis ? String(kpis.shipmentsCompleted) : null,
      sub: 'Delivered in this window',
      delta: deltas?.completed != null ? { pct: deltas.completed, label: compare } : null,
    },
    {
      key: 'payouts',
      label: 'Pending payouts',
      icon: Wallet,
      value: kpis?.pendingPayoutsCents != null ? formatCents(kpis.pendingPayoutsCents) : null,
      sub: kpis && kpis.pendingBillCount > 0
        ? `${kpis.pendingBillCount} bill${kpis.pendingBillCount === 1 ? '' : 's'} to be paid`
        : 'No open carrier bills',
      positiveIsGood: false,
    },
    {
      key: 'credits',
      label: 'Refunds & credits',
      icon: RefreshCw,
      value: kpis && ops.paymentsLoaded ? formatCents(kpis.creditsCents ?? 0) : null,
      sub: kpis && ops.paymentsLoaded ? `Write-offs ${formatCents(kpis.writeOffsCents)}` : 'Payments unavailable',
      positiveIsGood: false,
      delta: deltas?.credits != null ? { pct: deltas.credits, label: compare } : null,
    },
  ]

  const gauge = ops.target ? revenueGauge(kpis?.revenueCents ?? null, ops.target) : null
  const ownFleetNote = kpis ? ownFleetCaption(kpis.ownFleetCount) : null
  const failed = ops.failedMonths.map((m) => monthLabel(m.month)).join(', ')

  return (
    <TmsScrollPage
      title="Financial operations"
      subtitle={`${ops.window.from} → ${ops.window.to}`}
      actions={
        <>
          <Link className="tms-btn tms-btn-secondary" to="/finances">
            <BarChart3 size={14} /> Own-fleet profit
          </Link>
          <TmsButton onClick={ops.refresh}>
            <RefreshCw size={14} /> Refresh
          </TmsButton>
        </>
      }
      toolbar={<TmsSegmentedTabs aria-label="Window" tabs={tabs} active={period} onSelect={(k) => setPeriod(k as FinancePeriod)} />}
    >
      <div style={STACK}>
        {ops.errors.map((message) => (
          <TmsAlert key={message} tone="red">{message}</TmsAlert>
        ))}
        {ops.failedMonths.length > 0 ? (
          <TmsAlert tone="orange" title="Some months could not be read">
            {failed} {ops.failedMonths.length === 1 ? 'is' : 'are'} missing from the numbers on this page.
          </TmsAlert>
        ) : null}

        <TmsStatRow columns={4} items={stats} aria-label="Key figures" />
        {ownFleetNote ? <p style={NOTE}>{ownFleetNote}</p> : null}

        {ops.loading && !kpis ? <p style={NOTE}>Loading…</p> : null}

        <div style={TWO_UP}>
          <TmsCard title="Revenue by division">
            <TmsSegmentedBar
              ariaLabel="Revenue by division"
              segments={ops.divisions.map((d) => ({ key: d.key, label: d.label, value: d.revenueCents }))}
            />
            <p style={NOTE}>
              Priced brokerage and own-fleet loads. Best Care Auto Transport vehicle quotes are not shipments and are
              not in this figure.
            </p>
          </TmsCard>
          <TmsCard title="Total revenue">
            <TmsGauge
              ariaLabel="Total revenue against its trailing average"
              value={gauge?.value ?? null}
              label={gauge?.label ?? '—'}
              sub={gauge?.sub}
            />
          </TmsCard>
        </div>

        <TmsChartCard
          title="Weekly revenue"
          icon={BarChart3}
          action={
            <TmsButton
              size="sm"
              disabled={!ops.weekly}
              onClick={() => ops.weekly && saveBlob(new Blob([weeklyRevenueCsv(ops.weekly)], { type: 'text/csv' }), 'weekly-revenue.csv')}
            >
              <Download size={14} /> Download
            </TmsButton>
          }
        >
          <TmsPillBarChart
            ariaLabel="Weekly revenue by division, last 8 weeks"
            series={ops.weekly?.series ?? []}
            data={(ops.weekly?.weeks ?? []).map((w) => ({ label: w.label, values: w.values }))}
            format={compactDollars}
            highlightIndex={ops.weekly?.currentIndex ?? null}
            emptyText="No priced revenue in the last 8 weeks."
          />
        </TmsChartCard>

        {ops.paymentsLoaded ? <PaymentsTable rows={ops.payments} windowLabel={`${ops.window.from}_${ops.window.to}`} /> : null}
      </div>
    </TmsScrollPage>
  )
}
