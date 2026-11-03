/**
 * `/expenses` — Ivan Cartage expenses overview (S4 §3.4).
 *
 * Three cost cards that share one D / W / M period, hours worked per time-clock driver, and
 * the recent receipts behind the numbers. Read-only: manage fuel imports and expense types
 * on `/fuel`. Every figure comes from `lib/expenseOverview` over `useFleetProfitability`.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock, Fuel, Receipt as ReceiptIcon, Users, WalletCards } from 'lucide-react'
import {
  TmsAlert, TmsBadge, TmsCard, TmsChartCard, TmsEmptyState, TmsInput, TmsScrollPage, TmsSegmentedTabs, TmsStatRow, TmsTable,
} from '@/features/tms/kit'
import type { ColumnDef, TmsPeriod, TmsStat } from '@/features/tms/kit'
import { useDrivers } from '@/hooks/useDrivers'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { formatDateShort, chicagoDateStr } from '@/lib/date'
import {
  buildReceipts, expenseCards, hoursPerDriver, periodRange, previousRange, receiptStatus,
} from '@/lib/expenseOverview'
import type { Receipt } from '@/lib/expenseOverview'
import { useAppStore } from '@/store/useAppStore'
import { formatCents } from '@/lib/invoiceBuild'
import { payPeriodEndOf, payPeriodStartOf } from '@/lib/timeClock'
import type { FleetGroup } from '@/types/equipment'
import { HoursBars } from './HoursBars'
import { ReceiptDetailDialog } from './ReceiptDetailDialog'
import { useReceiptSources, useTimeClockEntries } from './useReceipts'

const SCOPES: Array<{ key: FleetGroup; label: string }> = [
  { key: 'LOCAL', label: 'Local' },
  { key: 'BOX_TRUCK', label: 'Box trucks' },
  { key: 'AMAZON', label: 'Amazon' },
]

const DELTA_LABEL: Record<TmsPeriod, string> = {
  D: 'vs yesterday',
  W: 'vs previous 7 days',
  M: 'vs previous period',
}

const CARD_ICONS = { total: WalletCards, fuel: Fuel, salary: Users } as const
const PLACEHOLDER_LABELS = { total: 'Total expenses', fuel: 'Fuel', salary: 'Salary (driver pay)' } as const
const RECEIPT_LIMIT = 25

export function ExpensesOverviewPage() {
  const today = useMemo(() => chicagoDateStr(new Date()), [])
  const [group, setGroup] = useState<FleetGroup>('LOCAL')
  const [period, setPeriod] = useState<TmsPeriod>('M')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const range = useMemo(() => periodRange(period, today), [period, today])
  const prevRange = useMemo(() => previousRange(range), [range])

  const fleet = useFleetProfitability(range, group)
  const { data, computeForRange, members, fuelTxs, loading: fleetLoading, error: fleetError } = fleet
  const sources = useReceiptSources()
  const { drivers } = useDrivers()
  const invoices = useAppStore((s) => s.maintenanceInvoices)

  const cards = useMemo(
    () => (data ? expenseCards(data, computeForRange(prevRange)) : null),
    [data, computeForRange, prevRange],
  )

  const payStart = payPeriodStartOf(today)
  const clock = useTimeClockEntries(payStart, payPeriodEndOf(today))
  const hours = useMemo(() => hoursPerDriver(clock.entries, drivers, payStart), [clock.entries, drivers, payStart])

  const receipts = useMemo(() => buildReceipts({
    invoices,
    fuel: fuelTxs,
    deductions: sources.deductions,
    credits: sources.credits,
    payables: sources.payables,
    trucks: members.map((m) => ({ id: m.truckId, unitNumber: m.unitNumber, driverName: m.driverName })),
    drivers,
    group,
    range,
  }), [invoices, fuelTxs, sources.deductions, sources.credits, sources.payables, members, drivers, group, range])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const matches = needle
      ? receipts.filter((r) => [r.merchant, r.truckUnit, r.driverName, r.category, r.location]
        .some((v) => v?.toLowerCase().includes(needle)))
      : receipts
    return matches.slice(0, RECEIPT_LIMIT)
  }, [receipts, needle])

  const open = receipts.find((r) => r.id === openId) ?? null
  const openPayable = open?.payableId ? sources.payables.find((p) => p.id === open.payableId) ?? null : null

  const periodControl = { value: period, onChange: setPeriod }
  const stats: TmsStat[] = (cards ?? []).map((c) => ({
    key: c.key,
    label: c.label,
    icon: CARD_ICONS[c.key],
    value: formatCents(c.cents),
    delta: c.deltaPct === null ? null : { pct: c.deltaPct, label: DELTA_LABEL[period] },
    positiveIsGood: false,
    period: periodControl,
  }))
  const placeholderStats: TmsStat[] = (['total', 'fuel', 'salary'] as const).map((key) => ({
    key, label: PLACEHOLDER_LABELS[key], icon: CARD_ICONS[key], value: null, period: periodControl,
  }))

  const columns: Array<ColumnDef<Receipt>> = [
    { key: 'date', header: 'Date', width: 120, render: (r) => formatDateShort(`${r.date}T12:00:00Z`) },
    {
      key: 'merchant',
      header: 'Receipt',
      render: (r) => (
        <button type="button" className="tms-btn tms-btn-ghost tms-btn-sm" onClick={() => setOpenId(r.id)}>{r.merchant}</button>
      ),
    },
    { key: 'truck', header: 'Truck', width: 90, render: (r) => r.truckUnit ?? '—' },
    { key: 'driver', header: 'Driver', render: (r) => r.driverName ?? '—' },
    { key: 'category', header: 'Category', render: (r) => r.category },
    { key: 'amount', header: 'Amount', width: 110, render: (r) => formatCents(r.amountCents) },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      render: (r) => {
        const s = receiptStatus(r)
        return <TmsBadge tone={s.tone}>{s.label}</TmsBadge>
      },
    },
  ]

  return (
    <TmsScrollPage
      title="Expenses"
      subtitle="Ivan Cartage — fuel, driver pay and the receipts behind them"
      actions={<Link to="/fuel" className="tms-btn tms-btn-secondary">Fuel imports &amp; expense types</Link>}
      toolbar={(
        <TmsSegmentedTabs
          aria-label="Fleet"
          tabs={SCOPES.map((s) => ({ key: s.key, label: s.label }))}
          active={group}
          onSelect={(key) => setGroup(key as FleetGroup)}
        />
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {fleetError ? <TmsAlert tone="red" title="Expenses could not be loaded">{fleetError}</TmsAlert> : null}
        {sources.errors.map((message) => (
          <TmsAlert key={message} tone="orange" title="Some receipts may be missing">{message}</TmsAlert>
        ))}
        {clock.error ? <TmsAlert tone="orange" title="Hours could not be loaded">{clock.error}</TmsAlert> : null}

        <TmsStatRow
          columns={3}
          aria-label="Expense totals"
          items={fleetLoading || !cards ? placeholderStats : stats}
        />

        <TmsChartCard title="Hours driven per driver" icon={Clock}>
          {clock.loading ? (
            <p className="tms-meta-empty">Loading hours…</p>
          ) : hours.length === 0 ? (
            <TmsEmptyState compact title="No drivers are on the time clock." message="" />
          ) : (
            <>
              <p className="tms-kpi-card-sub">
                Hours worked (time clock), pay period {formatDateShort(`${payStart}T12:00:00Z`)} – {formatDateShort(`${payPeriodEndOf(today)}T12:00:00Z`)}
              </p>
              <HoursBars rows={hours} ariaLabel="Hours worked per driver this pay period" />
            </>
          )}
        </TmsChartCard>

        <TmsCard
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><ReceiptIcon size={16} aria-hidden="true" />Recent receipts</span>}
          actions={(
            <TmsInput
              type="search"
              placeholder="Search receipts"
              aria-label="Search receipts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          flush
        >
          <TmsTable
            columns={columns}
            rows={shown}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenId(r.id)}
            empty={(
              <TmsEmptyState
                compact
                title={sources.loading || fleetLoading ? 'Loading receipts…' : 'No receipts in this period.'}
                message=""
              />
            )}
          />
        </TmsCard>
      </div>

      <ReceiptDetailDialog
        receipt={open}
        payable={openPayable}
        getAttachmentUrl={sources.getAttachmentUrl}
        onClose={() => setOpenId(null)}
      />
    </TmsScrollPage>
  )
}

export default ExpensesOverviewPage
