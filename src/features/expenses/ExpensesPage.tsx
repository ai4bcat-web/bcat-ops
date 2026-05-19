import { useState, useMemo, useCallback } from 'react'
import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, startOfYear, endOfYear,
  subDays, format,
} from 'date-fns'
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import {
  Upload, RefreshCw, ChevronUp, ChevronDown, Minus, ArrowLeft, Fuel,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { FuelUploadModal } from './FuelUploadModal'
import type { FuelTransaction } from '@/hooks/useFuelTransactions'
import type { Equipment } from '@/types/equipment'

// ── Date range helpers ────────────────────────────────────────────────────────

type RangeKey = 'today' | 'this-week' | 'this-month' | 'last-30' | 'this-year' | 'custom'

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'today',      label: 'Today'        },
  { value: 'this-week',  label: 'This Week'    },
  { value: 'this-month', label: 'This Month'   },
  { value: 'last-30',    label: 'Last 30 Days' },
  { value: 'this-year',  label: 'This Year'    },
]

function getRange(key: RangeKey, customStart: Date, customEnd: Date): [Date, Date] {
  const now = new Date()
  switch (key) {
    case 'today':      return [startOfDay(now), endOfDay(now)]
    case 'this-week':  return [startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 })]
    case 'this-month': return [startOfMonth(now), endOfMonth(now)]
    case 'last-30':    return [startOfDay(subDays(now, 30)), endOfDay(now)]
    case 'this-year':  return [startOfYear(now), endOfYear(now)]
    case 'custom':     return [startOfDay(customStart), endOfDay(customEnd)]
  }
}

// ── Fuel type colors ──────────────────────────────────────────────────────────

const TRUCK_COLORS = [
  '#1ea8f3', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899',
]

function truckColor(idx: number) { return TRUCK_COLORS[idx % TRUCK_COLORS.length] }

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}
function fmtGal(n: number) {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} gal`
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

function filterByDate(txs: FuelTransaction[], start: Date, end: Date): FuelTransaction[] {
  return txs.filter((t) => {
    const d = new Date(`${t.transactionDate}T12:00:00`)
    return d >= start && d <= end
  })
}

function sumAmt(txs: FuelTransaction[]) { return txs.reduce((s, t) => s + t.amount, 0) }
function sumQty(txs: FuelTransaction[]) { return txs.reduce((s, t) => s + t.quantity, 0) }

interface TruckRow {
  truck:       Equipment
  truckId:     string
  label:       string
  dailyAmt:    number
  weeklyAmt:   number
  monthlyAmt:  number
  yearlyAmt:   number
  dailyGal:    number
  weeklyGal:   number
  monthlyGal:  number
  yearlyGal:   number
}

type SortKey = 'label' | 'dailyAmt' | 'weeklyAmt' | 'monthlyAmt' | 'yearlyAmt' | 'dailyGal' | 'weeklyGal' | 'monthlyGal' | 'yearlyGal'

// ── Summary KPI card ──────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm px-5 py-4">
      <div className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-1">{label}</div>
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Transaction detail table ───────────────────────────────────────────────────

function TxDetail({
  truck,
  txs,
  onBack,
}: {
  truck: Equipment
  txs: FuelTransaction[]
  onBack: () => void
}) {
  const sorted = [...txs].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back
        </button>
        <span className="text-sm font-semibold text-foreground">Unit #{truck.unitNumber} — {txs.length} transactions</span>
      </div>
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Date', 'Location', 'City', 'State', 'Type', 'Gal', '$/gal', 'Fees', 'Total', 'Driver', 'Odometer'].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => (
              <tr key={tx.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 font-mono whitespace-nowrap">{tx.transactionDate}</td>
                <td className="px-3 py-2 max-w-[140px] truncate">{tx.locationName}</td>
                <td className="px-3 py-2 whitespace-nowrap">{tx.city}</td>
                <td className="px-3 py-2">{tx.state}</td>
                <td className="px-3 py-2">
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-medium',
                    tx.fuelType === 'ULSD' ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700',
                  )}>
                    {tx.fuelType}
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums text-right">{tx.quantity.toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums text-right">{fmtMoney(tx.pricePerUnit)}</td>
                <td className="px-3 py-2 tabular-nums text-right">
                  {(tx.fees ?? 0) > 0 ? fmtMoney(tx.fees!) : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="px-3 py-2 tabular-nums text-right font-medium">{fmtMoney(tx.amount)}</td>
                <td className="px-3 py-2 text-muted-foreground">{tx.driverName || <span className="text-muted-foreground/40">—</span>}</td>
                <td className="px-3 py-2 tabular-nums text-right text-muted-foreground">
                  {tx.odometer ? tx.odometer.toLocaleString() : <span className="text-muted-foreground/40">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ExpensesPage() {
  const equipment = useAppStore((s) => s.equipment)
  const trucks = useMemo(() => equipment.filter((e) => e.type === 'truck' && e.active && (e.fuelCardNumbers ?? []).length > 0), [equipment])

  const { transactions, loading, refresh, addTransactions } = useFuelTransactions()
  const [showUpload, setShowUpload] = useState(false)
  const [rangeKey, setRangeKey] = useState<RangeKey>('this-month')
  const [customStart, setCustomStart] = useState(new Date())
  const [customEnd, setCustomEnd]   = useState(new Date())
  const [fuelFilter, setFuelFilter] = useState<'ALL' | 'ULSD' | 'DEFD'>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('monthlyAmt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [drillTruck, setDrillTruck] = useState<Equipment | null>(null)
  const [chartMode, setChartMode] = useState<'$' | 'gal'>('$')

  const [rangeStart, rangeEnd] = getRange(rangeKey, customStart, customEnd)

  const now = new Date()
  const [todayStart, todayEnd]     = [startOfDay(now), endOfDay(now)]
  const [weekStart, weekEnd]       = [startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 })]
  const [monthStart, monthEnd]     = [startOfMonth(now), endOfMonth(now)]
  const [yearStart, yearEnd]       = [startOfYear(now), endOfYear(now)]

  const filteredTxs = useMemo(() => {
    let txs = filterByDate(transactions, rangeStart, rangeEnd)
    if (fuelFilter !== 'ALL') txs = txs.filter((t) => t.fuelType === fuelFilter)
    return txs
  }, [transactions, rangeStart, rangeEnd, fuelFilter])

  // Summary KPIs (from filtered range)
  const totalSpend = useMemo(() => sumAmt(filteredTxs), [filteredTxs])
  const totalGal   = useMemo(() => sumQty(filteredTxs), [filteredTxs])
  const avgPpg     = totalGal > 0 ? totalSpend / totalGal : 0
  const txCount    = filteredTxs.length

  // Fuel by truck table rows
  const truckRows = useMemo((): TruckRow[] => {
    return trucks.map((truck) => {
      const forTruck = (txs: FuelTransaction[]) =>
        txs.filter((t) => t.truckId === truck.id && (fuelFilter === 'ALL' || t.fuelType === fuelFilter))

      return {
        truck,
        truckId:    truck.id,
        label:      `#${truck.unitNumber}`,
        dailyAmt:   sumAmt(forTruck(filterByDate(transactions, todayStart, todayEnd))),
        weeklyAmt:  sumAmt(forTruck(filterByDate(transactions, weekStart, weekEnd))),
        monthlyAmt: sumAmt(forTruck(filterByDate(transactions, monthStart, monthEnd))),
        yearlyAmt:  sumAmt(forTruck(filterByDate(transactions, yearStart, yearEnd))),
        dailyGal:   sumQty(forTruck(filterByDate(transactions, todayStart, todayEnd))),
        weeklyGal:  sumQty(forTruck(filterByDate(transactions, weekStart, weekEnd))),
        monthlyGal: sumQty(forTruck(filterByDate(transactions, monthStart, monthEnd))),
        yearlyGal:  sumQty(forTruck(filterByDate(transactions, yearStart, yearEnd))),
      }
    })
  }, [trucks, transactions, fuelFilter, todayStart, todayEnd, weekStart, weekEnd, monthStart, monthEnd, yearStart, yearEnd])

  const sortedRows = useMemo(() => {
    return [...truckRows].sort((a, b) => {
      const va = a[sortKey] as number | string
      const vb = b[sortKey] as number | string
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
  }, [truckRows, sortKey, sortDir])

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => d === 'asc' ? 'desc' : 'asc') }
      else { setSortDir('desc') }
      return key
    })
  }, [])

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <Minus className="size-3 text-muted-foreground/40 inline ml-0.5" />
    return sortDir === 'asc'
      ? <ChevronUp className="size-3 text-primary inline ml-0.5" />
      : <ChevronDown className="size-3 text-primary inline ml-0.5" />
  }

  // Chart data: spend/gal per truck per day in the selected range
  const chartData = useMemo(() => {
    const days: Record<string, Record<string, number>> = {}
    const inRange = filterByDate(transactions, rangeStart, rangeEnd)
    for (const tx of inRange) {
      if (fuelFilter !== 'ALL' && tx.fuelType !== fuelFilter) continue
      const truck = trucks.find((t) => t.id === tx.truckId)
      if (!truck) continue
      const label = `#${truck.unitNumber}`
      if (!days[tx.transactionDate]) days[tx.transactionDate] = {}
      days[tx.transactionDate][label] = (days[tx.transactionDate][label] ?? 0) + (chartMode === '$' ? tx.amount : tx.quantity)
    }
    return Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, values]) => ({ date, ...values }))
  }, [transactions, rangeStart, rangeEnd, fuelFilter, trucks, chartMode])

  const truckLabels = useMemo(() => trucks.map((t) => `#${t.unitNumber}`), [trucks])

  // Drill-down txs
  const drillTxs = useMemo(() => {
    if (!drillTruck) return []
    return filterByDate(
      transactions.filter((t) => t.truckId === drillTruck.id && (fuelFilter === 'ALL' || t.fuelType === fuelFilter)),
      rangeStart, rangeEnd,
    )
  }, [drillTruck, transactions, rangeStart, rangeEnd, fuelFilter])

  // Totals row
  const totalsRow = {
    dailyAmt:   truckRows.reduce((s, r) => s + r.dailyAmt, 0),
    weeklyAmt:  truckRows.reduce((s, r) => s + r.weeklyAmt, 0),
    monthlyAmt: truckRows.reduce((s, r) => s + r.monthlyAmt, 0),
    yearlyAmt:  truckRows.reduce((s, r) => s + r.yearlyAmt, 0),
    dailyGal:   truckRows.reduce((s, r) => s + r.dailyGal, 0),
    weeklyGal:  truckRows.reduce((s, r) => s + r.weeklyGal, 0),
    monthlyGal: truckRows.reduce((s, r) => s + r.monthlyGal, 0),
    yearlyGal:  truckRows.reduce((s, r) => s + r.yearlyGal, 0),
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between px-8 pt-5 pb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Fuel Expenses</h1>
            <p className="text-sm text-slate-500 mt-0.5">EFS transaction data by truck</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refresh} disabled={loading}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Refresh
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setShowUpload(true)}>
              <Upload className="size-3.5" /> Upload Report
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 px-8 pb-4 flex-wrap">
          {/* Range selector */}
          <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden shrink-0">
            {RANGE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setRangeKey(o.value)}
                className={cn('px-3 py-1.5 text-xs font-medium transition-colors',
                  rangeKey === o.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          {rangeKey === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <input type="date" value={format(customStart, 'yyyy-MM-dd')} onChange={(e) => setCustomStart(new Date(e.target.value))}
                className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
              <span className="text-muted-foreground">to</span>
              <input type="date" value={format(customEnd, 'yyyy-MM-dd')} onChange={(e) => setCustomEnd(new Date(e.target.value))}
                className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
            </div>
          )}

          {/* Fuel type filter */}
          <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden shrink-0">
            {(['ALL', 'ULSD', 'DEFD'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFuelFilter(f)}
                className={cn('px-3 py-1.5 text-xs font-medium transition-colors',
                  fuelFilter === f ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50',
                )}
              >
                {f === 'ALL' ? 'All Types' : f}
              </button>
            ))}
          </div>
        </div>
      </div>

      {drillTruck ? (
        <TxDetail truck={drillTruck} txs={drillTxs} onBack={() => setDrillTruck(null)} />
      ) : (
        <div className="p-8 space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="Total Spend" value={fmtMoney(totalSpend)} sub={`${txCount} transaction${txCount !== 1 ? 's' : ''}`} />
            <KpiCard label="Total Gallons" value={fmtGal(totalGal)} />
            <KpiCard label="Avg $/Gallon" value={avgPpg > 0 ? fmtMoney(avgPpg) : '—'} />
            <KpiCard label="Transactions" value={txCount.toLocaleString()} />
          </div>

          {/* Fuel by Truck table */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-foreground">Fuel by Truck</h2>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th
                    className="text-left px-4 py-2.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground whitespace-nowrap"
                    onClick={() => handleSort('label')}
                  >
                    Unit <SortIcon col="label" />
                  </th>
                  {([
                    ['dailyAmt',   'Daily $'],
                    ['weeklyAmt',  'Weekly $'],
                    ['monthlyAmt', 'Monthly $'],
                    ['yearlyAmt',  'Yearly $'],
                    ['dailyGal',   'Daily Gal'],
                    ['weeklyGal',  'Weekly Gal'],
                    ['monthlyGal', 'Monthly Gal'],
                    ['yearlyGal',  'Yearly Gal'],
                  ] as [SortKey, string][]).map(([col, label]) => (
                    <th
                      key={col}
                      className="text-right px-4 py-2.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground whitespace-nowrap"
                      onClick={() => handleSort(col)}
                    >
                      {label} <SortIcon col={col} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && transactions.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-sm text-muted-foreground">
                      <RefreshCw className="size-4 animate-spin inline mr-2" />Loading…
                    </td>
                  </tr>
                ) : sortedRows.map((row, i) => (
                  <tr
                    key={row.truckId}
                    className="border-t border-slate-100 hover:bg-sky-50/40 cursor-pointer"
                    onClick={() => setDrillTruck(row.truck)}
                  >
                    <td className="px-4 py-2 font-bold" style={{ color: truckColor(i) }}>{row.label}</td>
                    {([row.dailyAmt, row.weeklyAmt, row.monthlyAmt, row.yearlyAmt] as number[]).map((v, j) => (
                      <td key={j} className="px-4 py-2 tabular-nums text-right">
                        {v > 0 ? fmtMoney(v) : <span className="text-muted-foreground/30">—</span>}
                      </td>
                    ))}
                    {([row.dailyGal, row.weeklyGal, row.monthlyGal, row.yearlyGal] as number[]).map((v, j) => (
                      <td key={j} className="px-4 py-2 tabular-nums text-right text-muted-foreground">
                        {v > 0 ? v.toFixed(2) : <span className="text-muted-foreground/30">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}

                {/* Totals row */}
                {!loading && sortedRows.length > 0 && (
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <td className="px-4 py-2 text-xs text-muted-foreground uppercase tracking-wider">Total</td>
                    {([totalsRow.dailyAmt, totalsRow.weeklyAmt, totalsRow.monthlyAmt, totalsRow.yearlyAmt] as number[]).map((v, j) => (
                      <td key={j} className="px-4 py-2 tabular-nums text-right">{v > 0 ? fmtMoney(v) : '—'}</td>
                    ))}
                    {([totalsRow.dailyGal, totalsRow.weeklyGal, totalsRow.monthlyGal, totalsRow.yearlyGal] as number[]).map((v, j) => (
                      <td key={j} className="px-4 py-2 tabular-nums text-right text-muted-foreground">{v > 0 ? v.toFixed(2) : '—'}</td>
                    ))}
                  </tr>
                )}

                {!loading && sortedRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-12 text-center">
                      <Fuel className="size-8 text-muted-foreground/20 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No fuel data yet. Upload an EFS report to get started.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-foreground">Fuel Over Time</h2>
                <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                  {(['$', 'gal'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setChartMode(m)}
                      className={cn('px-3 py-1 text-xs font-medium transition-colors',
                        chartMode === m ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {m === '$' ? '$ Spend' : 'Gallons'}
                    </button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => format(new Date(`${v}T12:00:00`), 'MMM d')}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48}
                    tickFormatter={(v) => chartMode === '$' ? `$${v}` : `${v}`} />
                  <RTooltip
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="rounded-lg border border-slate-200 bg-white shadow-md px-3 py-2 text-xs space-y-1">
                          <p className="font-medium">{format(new Date(`${label}T12:00:00`), 'MMM d, yyyy')}</p>
                          {payload.map((p) => (
                            <p key={String(p.dataKey)} style={{ color: p.color }}>
                              {String(p.dataKey)}: {chartMode === '$' ? fmtMoney(p.value as number) : `${(p.value as number).toFixed(2)} gal`}
                            </p>
                          ))}
                        </div>
                      ) : null
                    }
                  />
                  <Legend />
                  {truckLabels.map((label, i) => (
                    <Line
                      key={label}
                      type="monotone"
                      dataKey={label}
                      stroke={truckColor(i)}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {showUpload && (
        <FuelUploadModal
          trucks={equipment.filter((e) => e.type === 'truck')}
          onImported={(added) => { addTransactions(added); setShowUpload(false) }}
          onClose={() => setShowUpload(false)}
        />
      )}
    </div>
  )
}
