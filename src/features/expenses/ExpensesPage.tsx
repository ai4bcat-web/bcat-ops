import { useState, useMemo } from 'react'
import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, startOfYear, endOfYear,
  subDays, addWeeks, format, isAfter,
} from 'date-fns'
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { Upload, RefreshCw, ArrowLeft, Fuel, ChevronRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { FuelUploadModal } from './FuelUploadModal'
import type { FuelTransaction } from '@/hooks/useFuelTransactions'
import type { Equipment } from '@/types/equipment'

// ── Date range ────────────────────────────────────────────────────────────────

type RangeKey = 'today' | 'this-week' | 'this-month' | 'last-30' | 'last-4-weeks' | 'this-year' | 'custom'

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'today',        label: 'Today'        },
  { value: 'this-week',    label: 'This Week'    },
  { value: 'this-month',   label: 'This Month'   },
  { value: 'last-30',      label: 'Last 30 Days' },
  { value: 'last-4-weeks', label: 'Last 4 Weeks' },
  { value: 'this-year',    label: 'This Year'    },
  { value: 'custom',       label: 'Custom'       },
]

function getRange(key: RangeKey, customStart: Date, customEnd: Date): [Date, Date] {
  const now = new Date()
  switch (key) {
    case 'today':        return [startOfDay(now), endOfDay(now)]
    case 'this-week':    return [startOfWeek(now, { weekStartsOn: 0 }), endOfWeek(now, { weekStartsOn: 0 })]
    case 'this-month':   return [startOfMonth(now), endOfMonth(now)]
    case 'last-30':      return [startOfDay(subDays(now, 30)), endOfDay(now)]
    case 'last-4-weeks': return [startOfWeek(subDays(now, 27), { weekStartsOn: 0 }), endOfWeek(now, { weekStartsOn: 0 })]
    case 'this-year':    return [startOfYear(now), endOfYear(now)]
    case 'custom':       return [startOfDay(customStart), endOfDay(customEnd)]
  }
}

// ── Week buckets (Sun–Sat) ────────────────────────────────────────────────────

interface WeekBucket { wStart: Date; wEnd: Date; label: string }

function getWeeksInRange(start: Date, end: Date): WeekBucket[] {
  const weeks: WeekBucket[] = []
  let wStart = startOfWeek(start, { weekStartsOn: 0 })
  while (!isAfter(wStart, end)) {
    const wEnd = endOfWeek(wStart, { weekStartsOn: 0 })
    weeks.push({ wStart, wEnd, label: `${format(wStart, 'M/d')}–${format(wEnd, 'M/d')}` })
    wStart = addWeeks(wStart, 1)
  }
  return weeks
}

// ── Category helpers ──────────────────────────────────────────────────────────

const FUEL_TYPES_SET = new Set(['ULSD', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

function isFuel(tx: FuelTransaction): boolean {
  // Prefer explicit itemCategory (set on new records); fall back to fuelType lookup
  if (tx.itemCategory) return tx.itemCategory === 'FUEL'
  return FUEL_TYPES_SET.has((tx.fuelType ?? '').toUpperCase())
}

function categoryLabel(tx: FuelTransaction): string {
  const cat = tx.itemCategory
  if (cat === 'SCALE') return 'Scale Fee'
  if (cat === 'CASH_ADVANCE') return 'Cash Advance'
  if (cat === 'OTHER') return 'Other'
  return tx.fuelType
}

// ── Colors / formatters ───────────────────────────────────────────────────────

const TRUCK_COLORS = [
  '#1ea8f3', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899',
]
function truckColor(idx: number) { return TRUCK_COLORS[idx % TRUCK_COLORS.length] }

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

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm px-6 py-5" title={title}>
      <div className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-1">{label}</div>
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Transaction detail ────────────────────────────────────────────────────────

function TxDetail({
  truck, txs, rangeLabel, onBack,
}: {
  truck: Equipment
  txs: FuelTransaction[]
  rangeLabel: string
  onBack: () => void
}) {
  const sorted = [...txs].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back
        </button>
        <span className="text-sm font-semibold text-foreground">
          Unit #{truck.unitNumber} · {rangeLabel} · {txs.length} transaction{txs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Date', 'Category', 'Location', 'City', 'St', 'Qty', '$/unit', 'Fees', 'Total', 'Driver', 'Odo'].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => {
              const fuel = isFuel(tx)
              return (
                <tr key={tx.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{tx.transactionDate}</td>
                  <td className="px-3 py-2">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap',
                      fuel && tx.fuelType === 'ULSD' ? 'bg-sky-50 text-sky-700'
                        : fuel ? 'bg-violet-50 text-violet-700'
                        : tx.itemCategory === 'SCALE' ? 'bg-amber-50 text-amber-700'
                        : tx.itemCategory === 'CASH_ADVANCE' ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-600',
                    )}>
                      {tx.fuelType}
                    </span>
                    {!fuel && (
                      <span className="ml-1 text-[10px] text-muted-foreground">{categoryLabel(tx)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-[140px] truncate">{tx.locationName}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{tx.city}</td>
                  <td className="px-3 py-2">{tx.state}</td>
                  <td className="px-3 py-2 tabular-nums text-right">{tx.quantity.toFixed(2)}</td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {tx.pricePerUnit > 0 ? fmtMoney(tx.pricePerUnit) : <span className="text-muted-foreground/30">—</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {(tx.fees ?? 0) > 0 ? fmtMoney(tx.fees!) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right font-medium">{fmtMoney(tx.amount)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{tx.driverName || <span className="text-muted-foreground/40">—</span>}</td>
                  <td className="px-3 py-2 tabular-nums text-right text-muted-foreground">
                    {tx.odometer ? tx.odometer.toLocaleString() : <span className="text-muted-foreground/40">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ExpensesPage() {
  const equipment = useAppStore((s) => s.equipment)
  const trucks = useMemo(
    () => equipment.filter((e) => e.type === 'truck' && e.active && (e.fuelCardNumbers ?? []).length > 0),
    [equipment],
  )

  const { transactions, loading, refresh, addTransactions } = useFuelTransactions()
  const [showUpload, setShowUpload]   = useState(false)
  const [rangeKey, setRangeKey]       = useState<RangeKey>('last-4-weeks')
  const [customStart, setCustomStart] = useState(new Date())
  const [customEnd, setCustomEnd]     = useState(new Date())
  const [drillTruck, setDrillTruck]   = useState<Equipment | null>(null)
  const [drillWeek, setDrillWeek]     = useState<WeekBucket | null>(null)
  const [chartMode, setChartMode]     = useState<'$' | 'gal'>('$')
  const [breakdownOpen, setBreakdownOpen] = useState(false)

  const [rangeStart, rangeEnd] = getRange(rangeKey, customStart, customEnd)

  // All txs in date range (all categories)
  const filteredTxs = useMemo(
    () => filterByDate(transactions, rangeStart, rangeEnd),
    [transactions, rangeStart, rangeEnd],
  )

  // Fuel-only txs for pivot, chart, KPIs
  const fuelTxs = useMemo(() => filteredTxs.filter(isFuel), [filteredTxs])

  // Non-fuel txs (scale fees, cash, other)
  const otherTxs = useMemo(() => filteredTxs.filter((t) => !isFuel(t)), [filteredTxs])

  // ── Summary KPIs ──────────────────────────────────────────────────────────
  const totalFuelSpend = sumAmt(fuelTxs)
  const totalGal       = sumQty(fuelTxs)
  const avgPpg         = totalGal > 0 ? totalFuelSpend / totalGal : 0
  const fuelTxCount    = fuelTxs.length

  const otherSpend = sumAmt(otherTxs)
  const otherBreakdownTitle = useMemo(() => {
    if (otherTxs.length === 0) return undefined
    const bycat: Record<string, number> = {}
    for (const tx of otherTxs) {
      const cat = tx.itemCategory ?? 'Other'
      bycat[cat] = (bycat[cat] ?? 0) + tx.amount
    }
    return Object.entries(bycat)
      .map(([k, v]) => `${k}: ${fmtMoney(v)}`)
      .join(' · ')
  }, [otherTxs])

  // ── Weekly pivot ──────────────────────────────────────────────────────────
  const weeks = useMemo(() => getWeeksInRange(rangeStart, rangeEnd), [rangeStart, rangeEnd])

  const pivotRows = useMemo(() => {
    return trucks.map((truck) => {
      const truckFuelTxs = fuelTxs.filter((t) => t.truckId === truck.id)
      const weekAmts = weeks.map(({ wStart, wEnd }) =>
        sumAmt(filterByDate(truckFuelTxs, wStart, wEnd)),
      )
      const total = sumAmt(truckFuelTxs)
      return { truck, label: `#${truck.unitNumber}`, weekAmts, total }
    }).sort((a, b) => b.total - a.total)
  }, [trucks, fuelTxs, weeks])

  const weekTotals = weeks.map((_, wi) => pivotRows.reduce((s, r) => s + r.weekAmts[wi], 0))
  const grandTotal = pivotRows.reduce((s, r) => s + r.total, 0)

  // ── Fuel type breakdown (ULSD vs DEF) ─────────────────────────────────────
  const fuelBreakdown = useMemo(() => {
    return pivotRows
      .filter((r) => r.total > 0)
      .map(({ truck, label, total }) => {
        const truckTxs = fuelTxs.filter((t) => t.truckId === truck.id)
        const ulsd = truckTxs.filter((t) => t.fuelType === 'ULSD').reduce((s, t) => s + t.amount, 0)
        const defd = truckTxs.filter((t) => t.fuelType === 'DEFD').reduce((s, t) => s + t.amount, 0)
        return { label, ulsd, defd, total }
      })
  }, [pivotRows, fuelTxs])

  // ── Chart (fuel-only, weekly or daily) ───────────────────────────────────
  const rangeDays  = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000)
  const groupByWeek = rangeDays > 14

  const chartData = useMemo(() => {
    const buckets: Record<string, Record<string, number>> = {}
    for (const tx of fuelTxs) {
      const truck = trucks.find((t) => t.id === tx.truckId)
      if (!truck) continue
      const label = `#${truck.unitNumber}`
      const d     = new Date(`${tx.transactionDate}T12:00:00`)
      const key   = groupByWeek
        ? format(startOfWeek(d, { weekStartsOn: 0 }), 'yyyy-MM-dd')
        : tx.transactionDate
      if (!buckets[key]) buckets[key] = {}
      buckets[key][label] = (buckets[key][label] ?? 0) + (chartMode === '$' ? tx.amount : tx.quantity)
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date, ...vals }))
  }, [fuelTxs, trucks, groupByWeek, chartMode])

  const truckLabels = useMemo(() => trucks.map((t) => `#${t.unitNumber}`), [trucks])

  // ── Drill-down (shows ALL transaction types) ──────────────────────────────
  const drillTxs = useMemo(() => {
    if (!drillTruck) return []
    const base = transactions.filter((t) => t.truckId === drillTruck.id)
    return drillWeek
      ? filterByDate(base, drillWeek.wStart, drillWeek.wEnd)
      : filterByDate(base, rangeStart, rangeEnd)
  }, [drillTruck, drillWeek, transactions, rangeStart, rangeEnd])

  const drillLabel = drillWeek
    ? drillWeek.label
    : (RANGE_OPTIONS.find((o) => o.value === rangeKey)?.label ?? 'Selected Range')

  return (
    <div className="h-full overflow-y-auto">
      {/* ── Header ── */}
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

        {/* Range presets */}
        <div className="flex items-center gap-3 px-8 pb-4 flex-wrap">
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
              <input type="date" value={format(customStart, 'yyyy-MM-dd')}
                onChange={(e) => setCustomStart(new Date(e.target.value))}
                className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
              <span className="text-muted-foreground">to</span>
              <input type="date" value={format(customEnd, 'yyyy-MM-dd')}
                onChange={(e) => setCustomEnd(new Date(e.target.value))}
                className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
            </div>
          )}
        </div>
      </div>

      {drillTruck ? (
        <TxDetail
          truck={drillTruck}
          txs={drillTxs}
          rangeLabel={drillLabel}
          onBack={() => { setDrillTruck(null); setDrillWeek(null) }}
        />
      ) : (
        <div className="p-8 space-y-6">

          {/* ── KPI strip ── */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <KpiCard label="Total Fuel Spend"  value={fmtMoney(totalFuelSpend)} sub={`${fuelTxCount} fuel transaction${fuelTxCount !== 1 ? 's' : ''}`} />
            <KpiCard label="Total Gallons" value={fmtGal(totalGal)} />
            <KpiCard label="Avg $/Gallon"  value={avgPpg > 0 ? fmtMoney(avgPpg) : '—'} />
            <KpiCard label="Fuel Transactions" value={fuelTxCount.toLocaleString()} />
            <KpiCard
              label="Other Charges"
              value={otherSpend > 0 ? fmtMoney(otherSpend) : '—'}
              sub={otherTxs.length > 0 ? `${otherTxs.length} non-fuel item${otherTxs.length !== 1 ? 's' : ''}` : undefined}
              title={otherBreakdownTitle}
            />
          </div>

          {/* ── Weekly Spend by Truck (fuel only) ── */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm">
            <div className="px-5 py-3 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-foreground">Weekly Fuel Spend by Truck</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Sunday–Saturday weeks · fuel only · click a cell to see transactions</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="sticky left-0 bg-slate-50 z-10 text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
                      Truck
                    </th>
                    {weeks.map((w) => (
                      <th key={w.label} className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
                        {w.label}
                      </th>
                    ))}
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && transactions.length === 0 ? (
                    <tr>
                      <td colSpan={weeks.length + 2} className="py-12 text-center text-sm text-muted-foreground">
                        <RefreshCw className="size-4 animate-spin inline mr-2" />Loading…
                      </td>
                    </tr>
                  ) : pivotRows.length === 0 ? (
                    <tr>
                      <td colSpan={weeks.length + 2} className="py-12 text-center">
                        <Fuel className="size-8 text-muted-foreground/20 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No fuel data yet. Upload an EFS report to get started.</p>
                      </td>
                    </tr>
                  ) : pivotRows.map((row, i) => (
                    <tr key={row.truck.id} className="border-t border-slate-100">
                      <td
                        className="sticky left-0 bg-white z-10 px-4 py-2 font-bold whitespace-nowrap cursor-pointer hover:underline"
                        style={{ color: truckColor(i) }}
                        onClick={() => { setDrillTruck(row.truck); setDrillWeek(null) }}
                      >
                        {row.label}
                      </td>
                      {row.weekAmts.map((amt, wi) => (
                        <td
                          key={wi}
                          className={cn(
                            'px-4 py-2 tabular-nums text-right',
                            amt > 0 ? 'cursor-pointer hover:bg-sky-50/60' : 'text-muted-foreground/30',
                          )}
                          onClick={() => {
                            if (amt > 0) { setDrillTruck(row.truck); setDrillWeek(weeks[wi]) }
                          }}
                        >
                          {amt > 0 ? fmtMoney(amt) : '—'}
                        </td>
                      ))}
                      <td
                        className="px-4 py-2 tabular-nums text-right font-semibold cursor-pointer hover:bg-sky-50/60"
                        onClick={() => { setDrillTruck(row.truck); setDrillWeek(null) }}
                      >
                        {row.total > 0 ? fmtMoney(row.total) : '—'}
                      </td>
                    </tr>
                  ))}

                  {!loading && pivotRows.length > 0 && (
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <td className="sticky left-0 bg-slate-50 z-10 px-4 py-2 text-xs text-muted-foreground uppercase tracking-wider">
                        Total
                      </td>
                      {weekTotals.map((v, wi) => (
                        <td key={wi} className="px-4 py-2 tabular-nums text-right">
                          {v > 0 ? fmtMoney(v) : '—'}
                        </td>
                      ))}
                      <td className="px-4 py-2 tabular-nums text-right">{grandTotal > 0 ? fmtMoney(grandTotal) : '—'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Breakdown by Fuel Type (collapsible) ── */}
          {fuelBreakdown.length > 0 && (
            <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm">
              <button
                className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-slate-50/60 transition-colors"
                onClick={() => setBreakdownOpen((o) => !o)}
              >
                {breakdownOpen
                  ? <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                  : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
                <span className="text-sm font-semibold text-foreground">Breakdown by Fuel Type</span>
                <span className="text-xs text-muted-foreground">(ULSD vs DEF per truck)</span>
              </button>
              {breakdownOpen && (
                <div className="border-t border-slate-100 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Truck</th>
                        <th className="text-right px-4 py-2.5 font-medium text-sky-600">ULSD $</th>
                        <th className="text-right px-4 py-2.5 font-medium text-violet-600">DEF $</th>
                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Total $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fuelBreakdown.map((r) => (
                        <tr key={r.label} className="border-t border-slate-100">
                          <td className="px-4 py-2 font-medium">{r.label}</td>
                          <td className="px-4 py-2 tabular-nums text-right">
                            {r.ulsd > 0 ? fmtMoney(r.ulsd) : <span className="text-muted-foreground/30">—</span>}
                          </td>
                          <td className="px-4 py-2 tabular-nums text-right">
                            {r.defd > 0 ? fmtMoney(r.defd) : <span className="text-muted-foreground/30">—</span>}
                          </td>
                          <td className="px-4 py-2 tabular-nums text-right font-semibold">{fmtMoney(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Fuel Over Time chart (fuel-only) ── */}
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
                    tickFormatter={(v) => format(new Date(`${v}T12:00:00`), groupByWeek ? 'M/d' : 'MMM d')}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(v) => chartMode === '$' ? `$${v}` : `${v}`}
                  />
                  <RTooltip
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="rounded-lg border border-slate-200 bg-white shadow-md px-3 py-2 text-xs space-y-1">
                          <p className="font-medium">
                            {groupByWeek
                              ? `Week of ${format(new Date(`${label}T12:00:00`), 'M/d/yyyy')}`
                              : format(new Date(`${label}T12:00:00`), 'MMM d, yyyy')
                            }
                          </p>
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
