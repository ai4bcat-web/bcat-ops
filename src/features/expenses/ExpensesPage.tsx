import { useState, useMemo, useEffect, useRef } from 'react'
import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, startOfYear, endOfYear,
  subDays, addWeeks, format, isAfter,
} from 'date-fns'
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { Upload, RefreshCw, ArrowLeft, Fuel, ChevronRight, ChevronDown, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { useExpenseData } from '@/hooks/useExpenseData'
import { getExpensesByTruck } from '@/lib/expenseAllocation'
import { cleanupDuplicateFuelTransactions } from '@/lib/apiClient'
import { FuelUploadModal } from './FuelUploadModal'
import { ExpenseManageView } from './ExpenseManageView'
import type { FuelTransaction } from '@/hooks/useFuelTransactions'
import type { Equipment } from '@/types/equipment'
import type { TruckExpenseSummary } from '@/lib/expenseAllocation'

// ── Date range ────────────────────────────────────────────────────────────────

type RangeKey = 'yesterday' | 'this-week' | 'this-month' | 'last-30' | 'last-4-weeks' | 'this-year' | 'custom'

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'yesterday',    label: 'Yesterday'    },
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
    case 'yesterday':    return [startOfDay(subDays(now, 1)), endOfDay(subDays(now, 1))]
    case 'this-week':    return [startOfWeek(now, { weekStartsOn: 0 }), endOfWeek(now, { weekStartsOn: 0 })]
    case 'this-month':   return [startOfMonth(now), endOfMonth(now)]
    case 'last-30':      return [startOfDay(subDays(now, 30)), endOfDay(now)]
    case 'last-4-weeks': return [startOfWeek(subDays(now, 27), { weekStartsOn: 0 }), endOfWeek(now, { weekStartsOn: 0 })]
    case 'this-year':    return [startOfYear(now), endOfYear(now)]
    case 'custom':       return [startOfDay(customStart), endOfDay(customEnd)]
  }
}

// ── Week buckets ──────────────────────────────────────────────────────────────

interface WeekBucket { wStart: Date; wEnd: Date; label: string }

function getWeeksInRange(start: Date, end: Date): WeekBucket[] {
  const weeks: WeekBucket[] = []
  let wStart = startOfWeek(start, { weekStartsOn: 0 })
  while (!isAfter(wStart, end)) {
    const wEnd = endOfWeek(wStart, { weekStartsOn: 0 })
    const labelFrom = wStart < start ? start : wStart
    const labelTo   = wEnd > end ? end : wEnd
    const fromStr   = format(labelFrom, 'M/d')
    const toStr     = format(labelTo, 'M/d')
    const label     = fromStr === toStr ? fromStr : `${fromStr}–${toStr}`
    weeks.push({ wStart, wEnd, label })
    wStart = addWeeks(wStart, 1)
  }
  return weeks
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fuel = ULSD + FUEL (generic diesel) + DEFD (DEF) everywhere in the app — permanent definition.
const FUEL_TYPES_SET = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

function isFuel(tx: FuelTransaction): boolean {
  if (tx.itemCategory === 'FUEL') return true
  if (tx.itemCategory === 'SCALE' || tx.itemCategory === 'CASH_ADVANCE') return false
  // itemCategory absent OR 'OTHER' (legacy records stored before FUEL type was in FUEL_ITEM_TYPES):
  // fall back to fuelType. CDSL/SCLE are NOT in the set so they stay excluded.
  return FUEL_TYPES_SET.has((tx.fuelType ?? '').toUpperCase())
}

function categoryLabel(tx: FuelTransaction): string {
  if (tx.itemCategory === 'SCALE') return 'Scale Fee'
  if (tx.itemCategory === 'CASH_ADVANCE') return 'Cash Advance'
  if (tx.itemCategory === 'OTHER') return 'Other'
  return tx.fuelType
}

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

function filterByDate(txs: FuelTransaction[], start: Date, end: Date): FuelTransaction[] {
  return txs.filter((t) => {
    const d = new Date(`${t.transactionDate}T12:00:00`)
    return d >= start && d <= end
  })
}

function sumAmt(txs: FuelTransaction[]) { return txs.reduce((s, t) => s + t.amount, 0) }
function sumQty(txs: FuelTransaction[]) { return txs.reduce((s, t) => s + t.quantity, 0) }

// ── Category display config ───────────────────────────────────────────────────

const CATEGORIES: { key: keyof Omit<TruckExpenseSummary, 'total'>; label: string; color: string }[] = [
  { key: 'fuel',        label: 'Fuel',        color: '#1ea8f3' },
  { key: 'insurance',   label: 'Insurance',   color: '#8b5cf6' },
  { key: 'financing',   label: 'Financing',   color: '#f59e0b' },
  { key: 'lease',       label: 'Lease',       color: '#06b6d4' },
  { key: 'maintenance', label: 'Maintenance', color: '#ef4444' },
  { key: 'permits',     label: 'Permits',     color: '#10b981' },
  { key: 'tolls',       label: 'Tolls',       color: '#f97316' },
  { key: 'other',       label: 'Other',       color: '#84cc16' },
]

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '16px 20px', boxShadow: 'var(--sh-sm)' }} title={title}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Fuel transaction detail ───────────────────────────────────────────────────

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
      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflowX: 'auto' }}>
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Date', 'Category', 'Location', 'City', 'St', 'Qty', '$/unit', 'Fees', 'Total', 'Driver', 'Odo'].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => {
              const fuel = isFuel(tx)
              return (
                <tr key={tx.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono whitespace-nowrap">{tx.transactionDate}</td>
                  <td className="px-4 py-3">
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
                  <td className="px-4 py-3 max-w-[140px] truncate">{tx.locationName}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{tx.city}</td>
                  <td className="px-4 py-3">{tx.state}</td>
                  <td className="px-4 py-3 tabular-nums text-right">{tx.quantity.toFixed(2)}</td>
                  <td className="px-4 py-3 tabular-nums text-right">
                    {tx.pricePerUnit > 0 ? fmtMoney(tx.pricePerUnit) : <span className="text-muted-foreground/30">—</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-right">
                    {(tx.fees ?? 0) > 0 ? fmtMoney(tx.fees!) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-right font-medium">{fmtMoney(tx.amount)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{tx.driverName || <span className="text-muted-foreground/40">—</span>}</td>
                  <td className="px-4 py-3 tabular-nums text-right text-muted-foreground">
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

// ── Overview tab — per-truck × category matrix ────────────────────────────────

function OverviewTab({
  trucks, fuelTxs, expenseData, rangeStart, rangeEnd,
}: {
  trucks: Equipment[]
  fuelTxs: FuelTransaction[]
  expenseData: ReturnType<typeof useExpenseData>
  rangeStart: Date
  rangeEnd: Date
}) {
  const startStr = format(rangeStart, 'yyyy-MM-dd')
  const endStr   = format(rangeEnd, 'yyyy-MM-dd')

  // Build inputs for allocation engine
  const fuelInputs = useMemo(() =>
    fuelTxs.map((t) => ({
      truckId:         t.truckId,
      transactionDate: t.transactionDate,
      amount:          t.amount,
      itemCategory:    isFuel(t) ? 'FUEL' : (t.itemCategory ?? 'OTHER'),
    })),
    [fuelTxs],
  )

  const recordInputs = useMemo(() =>
    expenseData.records.map((r) => ({
      expenseTypeId:   r.expenseTypeId,
      allocationId:    r.allocationId,
      amount:          r.amount,
      periodMonth:     r.periodMonth,
      transactionDate: r.transactionDate,
      directTruckId:   r.directTruckId,
    })),
    [expenseData.records],
  )

  // Expand recurring expenses into one virtual record per month in the date range.
  // RecurringExpense rows are never stored as ExpenseRecords — they must be projected
  // here before being passed to the allocation engine.
  const recurringInputs = useMemo(() => {
    const startMonth = startStr.slice(0, 7)   // "2026-05"
    const endMonth   = endStr.slice(0, 7)
    const virtual: Array<{
      expenseTypeId: string; allocationId: string | null
      amount: number; periodMonth: string
      transactionDate: null; directTruckId: null
    }> = []

    for (const r of expenseData.recurring) {
      if (!r.active) continue
      // Normalize YYYY-M → YYYY-MM so string comparisons work correctly
      const rStart = r.startMonth.replace(/^(\d{4})-(\d)$/, '$1-0$2')
      const rEnd   = r.endMonth ? r.endMonth.replace(/^(\d{4})-(\d)$/, '$1-0$2') : null
      // clamp to the date range
      const lo = rStart > startMonth ? rStart : startMonth
      const hi = rEnd && rEnd < endMonth ? rEnd : endMonth
      let month = lo
      while (month <= hi) {
        virtual.push({
          expenseTypeId: r.expenseTypeId,
          allocationId:  r.allocationId,
          amount:        r.monthlyAmount,
          periodMonth:   month,
          transactionDate: null,
          directTruckId:   null,
        })
        // advance by one month
        const [y, m] = month.split('-').map(Number)
        month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
      }
    }
    return virtual
  }, [expenseData.recurring, startStr, endStr])

  const allocInputs = useMemo(() =>
    expenseData.allocations.map((a) => ({
      id:               a.id,
      expenseTypeId:    a.expenseTypeId,
      allocationMethod: a.allocationMethod,
      truckIds:         a.truckIds ?? [],
    })),
    [expenseData.allocations],
  )

  const typeInputs = useMemo(() =>
    expenseData.expenseTypes.map((t) => ({
      id:       t.id,
      category: t.category,
    })),
    [expenseData.expenseTypes],
  )

  const matrix = useMemo(
    () => getExpensesByTruck(startStr, endStr, fuelInputs, [...recordInputs, ...recurringInputs], allocInputs, typeInputs),
    [startStr, endStr, fuelInputs, recordInputs, recurringInputs, allocInputs, typeInputs],
  )

  // KPIs
  const fleetTotals = useMemo((): Record<string, number> => {
    const agg: Record<string, number> = {}
    let grand = 0
    for (const truckId of Object.keys(matrix)) {
      const summary = matrix[truckId]
      for (const { key } of CATEGORIES) {
        agg[key] = (agg[key] ?? 0) + summary[key]
      }
      grand += summary.total
    }
    return { ...agg, total: grand }
  }, [matrix])

  // Sort trucks by total descending, only those with any expense
  const matrixRows = useMemo(() => {
    return trucks
      .map((truck) => ({ truck, summary: matrix[truck.id] }))
      .filter((r) => r.summary && r.summary.total > 0)
      .sort((a, b) => b.summary.total - a.summary.total)
  }, [trucks, matrix])

  const allTrucks = trucks.filter((t) => t.type === 'truck' && t.active)

  const loading = expenseData.loading
  const hasData = matrixRows.length > 0

  return (
    <div className="space-y-5">
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label="Total Fleet Cost" value={fmtMoney(fleetTotals.total || 0)} sub={`${matrixRows.length} truck${matrixRows.length !== 1 ? 's' : ''} with expenses`} />
        <KpiCard label="Fuel"             value={fmtMoney(fleetTotals['fuel'] || 0)} />
        <KpiCard label="Insurance"        value={fmtMoney(fleetTotals['insurance'] || 0)} />
        <KpiCard label="Other"            value={fmtMoney(((fleetTotals.total || 0) - (fleetTotals['fuel'] || 0) - (fleetTotals['insurance'] || 0)))} />
      </div>

      {/* Matrix */}
      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-foreground">Per-Truck Cost Matrix</h2>
          <p className="text-xs text-muted-foreground mt-0.5">All expense categories · fuel from EFS · other from expense records</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="sticky left-0 bg-slate-50 z-10 text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Truck</th>
                {CATEGORIES.map(({ label }) => (
                  <th key={label} className="text-right px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{label}</th>
                ))}
                <th className="text-right px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Total</th>
              </tr>
            </thead>
            <tbody>
              {loading && !hasData ? (
                <tr>
                  <td colSpan={CATEGORIES.length + 2} className="py-12 text-center text-sm text-muted-foreground">
                    <RefreshCw className="size-4 animate-spin inline mr-2" />Loading…
                  </td>
                </tr>
              ) : !hasData ? (
                <tr>
                  <td colSpan={CATEGORIES.length + 2} className="py-12 text-center">
                    <p className="text-sm text-muted-foreground">No expense data for this period.</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Upload fuel reports and add expense records in the Manage tab.</p>
                  </td>
                </tr>
              ) : (
                matrixRows.map(({ truck, summary }) => (
                  <tr key={truck.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="sticky left-0 bg-white z-10 px-4 py-3 font-bold whitespace-nowrap" style={{ color: truckColor(allTrucks.findIndex((t) => t.id === truck.id)) }}>
                      #{truck.unitNumber}
                    </td>
                    {CATEGORIES.map(({ key }) => (
                      <td key={key} className="px-4 py-3 tabular-nums text-right">
                        {summary[key] > 0 ? fmtMoney(summary[key]) : <span className="text-muted-foreground/25">—</span>}
                      </td>
                    ))}
                    <td className="px-4 py-3 tabular-nums text-right font-semibold">{fmtMoney(summary.total)}</td>
                  </tr>
                ))
              )}

              {hasData && (
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td className="sticky left-0 bg-slate-50 z-10 px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider">Total</td>
                  {CATEGORIES.map(({ key }) => (
                    <td key={key} className="px-4 py-3 tabular-nums text-right">
                      {(fleetTotals[key] ?? 0) > 0 ? fmtMoney(fleetTotals[key]) : <span className="text-muted-foreground/25">—</span>}
                    </td>
                  ))}
                  <td className="px-4 py-3 tabular-nums text-right">{fmtMoney(fleetTotals.total || 0)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Fuel tab — weekly pivot + chart ───────────────────────────────────────────

function FuelTab({
  trucks, transactions, loading, refresh, addTransactions, rangeStart, rangeEnd, rangeKey, equipment,
}: {
  trucks: Equipment[]
  transactions: FuelTransaction[]
  loading: boolean
  refresh: () => void
  addTransactions: (added: FuelTransaction[]) => void
  rangeStart: Date
  rangeEnd: Date
  rangeKey: RangeKey
  equipment: Equipment[]
}) {
  const [showUpload,     setShowUpload]     = useState(false)
  const [drillTruck,    setDrillTruck]    = useState<Equipment | null>(null)
  const [drillWeek,     setDrillWeek]     = useState<WeekBucket | null>(null)
  const [chartMode,     setChartMode]     = useState<'$' | 'gal'>('$')
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const [deduping,      setDeduping]      = useState(false)

  const filteredTxs = useMemo(() => filterByDate(transactions, rangeStart, rangeEnd), [transactions, rangeStart, rangeEnd])
  const fuelTxs     = useMemo(() => filteredTxs.filter(isFuel), [filteredTxs])
  const otherTxs    = useMemo(() => filteredTxs.filter((t) => !isFuel(t)), [filteredTxs])

  const pivotTruckIds = useMemo(() => new Set(trucks.map((t) => t.id)), [trucks])

  // KPIs reflect ALL fuel txs in range, not just pivot-truck-assigned ones
  const totalFuelSpend    = sumAmt(fuelTxs)
  const totalGal          = sumQty(fuelTxs)
  const avgPpg            = totalGal > 0 ? totalFuelSpend / totalGal : 0
  const fuelTxCount       = fuelTxs.length
  const unassignedFuelAmt = sumAmt(fuelTxs.filter((t) => !t.truckId || !pivotTruckIds.has(t.truckId!)))
  const otherSpend        = sumAmt(otherTxs)

  // Diagnostic: log fuel breakdown by fuelType/itemCategory so discrepancies are visible
  useEffect(() => {
    if (fuelTxs.length === 0) return
    const byType: Record<string, number> = {}
    for (const tx of fuelTxs) {
      const k = tx.fuelType ?? '(null)'
      byType[k] = (byType[k] ?? 0) + tx.amount
    }
    const unassigned = fuelTxs.filter((t) => !t.truckId).length
    console.log(
      `[fuel diag] range=${rangeStart}–${rangeEnd} total=${totalFuelSpend.toFixed(2)} txs=${fuelTxs.length} unassigned=${unassigned}`,
      '\n  by fuelType:', byType,
    )
  }, [fuelTxs, rangeStart, rangeEnd, totalFuelSpend])

  const otherBreakdownTitle = useMemo(() => {
    if (otherTxs.length === 0) return undefined
    const bycat: Record<string, number> = {}
    for (const tx of otherTxs) {
      const cat = tx.itemCategory ?? 'Other'
      bycat[cat] = (bycat[cat] ?? 0) + tx.amount
    }
    return Object.entries(bycat).map(([k, v]) => `${k}: ${fmtMoney(v)}`).join(' · ')
  }, [otherTxs])

  const weeks = useMemo(() => getWeeksInRange(rangeStart, rangeEnd), [rangeStart, rangeEnd])

  const pivotRows = useMemo(() => {
    return trucks
      .map((truck) => {
        const truckFuelTxs = fuelTxs.filter((t) => t.truckId === truck.id)
        const weekAmts = weeks.map(({ wStart, wEnd }) => sumAmt(filterByDate(truckFuelTxs, wStart, wEnd)))
        const total = sumAmt(truckFuelTxs)
        return { truck, label: `#${truck.unitNumber}`, weekAmts, total }
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
  }, [trucks, fuelTxs, weeks])

  const weekTotals = weeks.map((_, wi) => pivotRows.reduce((s, r) => s + r.weekAmts[wi], 0))
  const grandTotal = pivotRows.reduce((s, r) => s + r.total, 0)

  const fuelBreakdown = useMemo(() =>
    pivotRows.filter((r) => r.total > 0).map(({ truck, label, total }) => {
      const truckTxs = fuelTxs.filter((t) => t.truckId === truck.id)
      const ulsd = truckTxs.filter((t) => t.fuelType === 'ULSD').reduce((s, t) => s + t.amount, 0)
      const defd = truckTxs.filter((t) => t.fuelType === 'DEFD').reduce((s, t) => s + t.amount, 0)
      return { label, ulsd, defd, total }
    }),
    [pivotRows, fuelTxs],
  )

  const rangeDays   = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000)
  const groupByWeek = rangeDays > 14

  const chartData = useMemo(() => {
    const buckets: Record<string, Record<string, number>> = {}
    for (const tx of fuelTxs) {
      const truck = trucks.find((t) => t.id === tx.truckId)
      if (!truck) continue
      const label = `#${truck.unitNumber}`
      const d     = new Date(`${tx.transactionDate}T12:00:00`)
      const key   = groupByWeek ? format(startOfWeek(d, { weekStartsOn: 0 }), 'yyyy-MM-dd') : tx.transactionDate
      if (!buckets[key]) buckets[key] = {}
      buckets[key][label] = (buckets[key][label] ?? 0) + (chartMode === '$' ? tx.amount : tx.quantity)
    }
    return Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([date, vals]) => ({ date, ...vals }))
  }, [fuelTxs, trucks, groupByWeek, chartMode])

  const truckLabels = useMemo(() => trucks.map((t) => `#${t.unitNumber}`), [trucks])

  const drillTxs = useMemo(() => {
    if (!drillTruck) return []
    const base = transactions.filter((t) => t.truckId === drillTruck.id)
    return drillWeek ? filterByDate(base, drillWeek.wStart, drillWeek.wEnd) : filterByDate(base, rangeStart, rangeEnd)
  }, [drillTruck, drillWeek, transactions, rangeStart, rangeEnd])

  const drillLabel = drillWeek ? drillWeek.label : (RANGE_OPTIONS.find((o) => o.value === rangeKey)?.label ?? 'Selected Range')

  if (drillTruck) {
    return (
      <TxDetail
        truck={drillTruck}
        txs={drillTxs}
        rangeLabel={drillLabel}
        onBack={() => { setDrillTruck(null); setDrillWeek(null) }}
      />
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">EFS Fuel Transactions</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Weekly fuel spend by truck · click a cell to drill down</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Refresh
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setShowUpload(true)}>
            <Upload className="size-3.5" /> Upload Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
            disabled={deduping}
            onClick={async () => {
              setDeduping(true)
              try {
                const result = await cleanupDuplicateFuelTransactions()
                if (result.removed > 0) {
                  toast.success(`Removed ${result.removed} duplicate transaction${result.removed !== 1 ? 's' : ''}`)
                  refresh()
                } else {
                  toast.success('No duplicates found')
                }
              } catch (e) {
                toast.error('Cleanup failed: ' + (e instanceof Error ? e.message : String(e)))
              } finally {
                setDeduping(false)
              }
            }}
          >
            <Trash2 className={cn('size-3.5', deduping && 'animate-pulse')} />
            {deduping ? 'Cleaning…' : 'Clean Duplicates'}
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Total Fuel Spend"    value={fmtMoney(totalFuelSpend)} sub={unassignedFuelAmt > 0 ? `${fmtMoney(unassignedFuelAmt)} unassigned` : `${fuelTxCount} transactions`} />
        <KpiCard label="Total Gallons"       value={fmtGal(totalGal)} />
        <KpiCard label="Avg $/Gallon"        value={avgPpg > 0 ? fmtMoney(avgPpg) : '—'} />
        <KpiCard label="Fuel Transactions"   value={fuelTxCount.toLocaleString()} />
        <KpiCard label="Other Charges"       value={otherSpend > 0 ? fmtMoney(otherSpend) : '—'} sub={otherTxs.length > 0 ? `${otherTxs.length} non-fuel item${otherTxs.length !== 1 ? 's' : ''}` : undefined} title={otherBreakdownTitle} />
      </div>

      {/* Weekly pivot */}
      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-foreground">Weekly Fuel Spend by Truck</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Sunday–Saturday weeks · fuel only</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="sticky left-0 bg-slate-50 z-10 text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Truck</th>
                {weeks.map((w) => (
                  <th key={w.label} className="text-right px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{w.label}</th>
                ))}
                <th className="text-right px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Total</th>
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
                    <p className="text-sm text-muted-foreground">No fuel data. Upload an EFS report to get started.</p>
                  </td>
                </tr>
              ) : pivotRows.map((row, i) => (
                <tr key={row.truck.id} className="border-t border-slate-100">
                  <td
                    className="sticky left-0 bg-white z-10 px-4 py-3 font-bold whitespace-nowrap cursor-pointer hover:underline"
                    style={{ color: truckColor(i) }}
                    onClick={() => { setDrillTruck(row.truck); setDrillWeek(null) }}
                  >
                    {row.label}
                  </td>
                  {row.weekAmts.map((amt, wi) => (
                    <td
                      key={wi}
                      className={cn('px-4 py-3 tabular-nums text-right', amt > 0 ? 'cursor-pointer hover:bg-sky-50/60' : 'text-muted-foreground/30')}
                      onClick={() => { if (amt > 0) { setDrillTruck(row.truck); setDrillWeek(weeks[wi]) } }}
                    >
                      {amt > 0 ? fmtMoney(amt) : '—'}
                    </td>
                  ))}
                  <td
                    className="px-4 py-3 tabular-nums text-right font-semibold cursor-pointer hover:bg-sky-50/60"
                    onClick={() => { setDrillTruck(row.truck); setDrillWeek(null) }}
                  >
                    {row.total > 0 ? fmtMoney(row.total) : '—'}
                  </td>
                </tr>
              ))}
              {!loading && pivotRows.length > 0 && (
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td className="sticky left-0 bg-slate-50 z-10 px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider">Total</td>
                  {weekTotals.map((v, wi) => (
                    <td key={wi} className="px-4 py-3 tabular-nums text-right">{v > 0 ? fmtMoney(v) : '—'}</td>
                  ))}
                  <td className="px-4 py-3 tabular-nums text-right">{grandTotal > 0 ? fmtMoney(grandTotal) : '—'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fuel type breakdown */}
      {fuelBreakdown.length > 0 && (
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
          <button
            className="w-full flex items-center gap-2 px-6 py-4 text-left hover:bg-slate-50/60 transition-colors"
            onClick={() => setBreakdownOpen((o) => !o)}
          >
            {breakdownOpen ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
            <span className="text-sm font-semibold text-foreground">Breakdown by Fuel Type</span>
            <span className="text-xs text-muted-foreground">(ULSD vs DEF per truck)</span>
          </button>
          {breakdownOpen && (
            <div className="border-t border-slate-100 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Truck</th>
                    <th className="text-right px-4 py-3 font-medium text-sky-600">ULSD $</th>
                    <th className="text-right px-4 py-3 font-medium text-violet-600">DEF $</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total $</th>
                  </tr>
                </thead>
                <tbody>
                  {fuelBreakdown.map((r) => (
                    <tr key={r.label} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium">{r.label}</td>
                      <td className="px-4 py-3 tabular-nums text-right">{r.ulsd > 0 ? fmtMoney(r.ulsd) : <span className="text-muted-foreground/30">—</span>}</td>
                      <td className="px-4 py-3 tabular-nums text-right">{r.defd > 0 ? fmtMoney(r.defd) : <span className="text-muted-foreground/30">—</span>}</td>
                      <td className="px-4 py-3 tabular-nums text-right font-semibold">{fmtMoney(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Chart */}
      {chartData.length > 0 && (
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>Fuel Over Time</h2>
            <div style={{ display: 'flex', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, gap: 2 }}>
              {(['$', 'gal'] as const).map((m) => {
                const active = chartMode === m
                return (
                  <button
                    key={m}
                    onClick={() => setChartMode(m)}
                    style={{
                      padding: '3px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                      fontSize: 12, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                      background: active ? '#fff' : 'transparent',
                      color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                      boxShadow: active ? 'var(--sh-sm)' : 'none',
                    }}
                  >
                    {m === '$' ? '$ Spend' : 'Gallons'}
                  </button>
                )
              })}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={(v) => format(new Date(`${v}T12:00:00`), groupByWeek ? 'M/d' : 'MMM d')}
                interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48}
                tickFormatter={(v) => chartMode === '$' ? `$${v}` : `${v}`} />
              <RTooltip
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-lg border border-slate-200 bg-white shadow-md px-3 py-2 text-xs space-y-1">
                      <p className="font-medium">
                        {groupByWeek ? `Week of ${format(new Date(`${label}T12:00:00`), 'M/d/yyyy')}` : format(new Date(`${label}T12:00:00`), 'MMM d, yyyy')}
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
                <Line key={label} type="monotone" dataKey={label} stroke={truckColor(i)} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
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

// ── Page ──────────────────────────────────────────────────────────────────────

type PageTab = 'overview' | 'fuel' | 'manage'

const PAGE_TABS: { value: PageTab; label: string }[] = [
  { value: 'overview', label: 'Overview'  },
  { value: 'fuel',     label: 'Fuel'      },
  { value: 'manage',   label: 'Manage'    },
]

export function ExpensesPage() {
  const equipment = useAppStore((s) => s.equipment)
  // All active trucks — used by both Overview and Fuel tab
  const allActiveTrucks = useMemo(
    () => equipment.filter((e) => e.type === 'truck' && e.active),
    [equipment],
  )

  const { transactions, loading, refresh, addTransactions, patchTransaction } = useFuelTransactions()
  const expenseData = useExpenseData()

  // Auto-repair transactions that were uploaded without a truckId (e.g. due to stale
  // localStorage equipment lacking fuelCardNumbers — see onRehydrateStorage in store).
  // Use a ref to track which IDs are already being patched so each record is only
  // sent once even if the effect re-fires while async patches are in flight.
  const repairingIds = useRef(new Set<string>())
  useEffect(() => {
    if (loading || transactions.length === 0 || allActiveTrucks.length === 0) return
    const unmapped = transactions.filter((t) => !t.truckId && !repairingIds.current.has(t.id))
    if (unmapped.length === 0) return
    for (const tx of unmapped) {
      const truck = allActiveTrucks.find((e) => (e.fuelCardNumbers ?? []).includes(tx.cardNumber))
      if (truck) {
        repairingIds.current.add(tx.id)
        void patchTransaction(tx.id, { truckId: truck.id }).finally(() => {
          repairingIds.current.delete(tx.id)
        })
      }
    }
  }, [loading, transactions, allActiveTrucks, patchTransaction])

  const [tab,         setTab]         = useState<PageTab>('overview')
  const [rangeKey,    setRangeKey]    = useState<RangeKey>('this-month')
  const [customStart, setCustomStart] = useState(new Date())
  const [customEnd,   setCustomEnd]   = useState(new Date())

  const [rangeStart, rangeEnd] = getRange(rangeKey, customStart, customEnd)

  // All fuel txs in range (for Overview matrix + FuelTab)
  const filteredFuelTxs = useMemo(
    () => filterByDate(transactions, rangeStart, rangeEnd).filter(isFuel),
    [transactions, rangeStart, rangeEnd],
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 12px' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Expenses</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Fuel, insurance, financing, maintenance — per truck</p>
          </div>
        </div>

        {/* Tab bar + range presets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 32px 16px', flexWrap: 'wrap' }}>
          {/* Page tabs — pill group */}
          <div style={{ display: 'flex', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, gap: 2, flexShrink: 0 }}>
            {PAGE_TABS.map((t) => {
              const active = tab === t.value
              return (
                <button
                  key={t.value}
                  onClick={() => setTab(t.value)}
                  style={{
                    padding: '4px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                    background: active ? '#fff' : 'transparent',
                    color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>

          {tab !== 'manage' && (
            <>
              {/* Date range chips */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {RANGE_OPTIONS.map((o) => {
                  const active = rangeKey === o.value
                  return (
                    <button
                      key={o.value}
                      onClick={() => setRangeKey(o.value)}
                      style={{
                        height: 28, padding: '0 10px', borderRadius: 20, border: '1px solid',
                        fontSize: 11.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                        background: active ? 'var(--ds-blue-bg)' : 'var(--ds-bg)',
                        borderColor: active ? 'var(--ds-blue)' : 'var(--ds-border)',
                        color: active ? 'var(--ds-blue)' : 'var(--ds-t3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>

              {rangeKey === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="date" value={format(customStart, 'yyyy-MM-dd')}
                    onChange={(e) => setCustomStart(new Date(e.target.value + 'T00:00:00'))}
                    style={{ height: 32, borderRadius: 7, border: '1px solid var(--ds-border)', padding: '0 8px', fontSize: 12, background: 'var(--ds-surface)', outline: 'none' }} />
                  <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>to</span>
                  <input type="date" value={format(customEnd, 'yyyy-MM-dd')}
                    onChange={(e) => setCustomEnd(new Date(e.target.value + 'T00:00:00'))}
                    style={{ height: 32, borderRadius: 7, border: '1px solid var(--ds-border)', padding: '0 8px', fontSize: 12, background: 'var(--ds-surface)', outline: 'none' }} />
                </div>
              )}

              <span style={{ fontSize: 12, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>
                {format(rangeStart, 'MMM d, yyyy')} – {format(rangeEnd, 'MMM d, yyyy')}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: '24px 32px' }}>
        {tab === 'overview' && (
          <OverviewTab
            trucks={allActiveTrucks}
            fuelTxs={filteredFuelTxs}
            expenseData={expenseData}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
          />
        )}

        {tab === 'fuel' && (
          <FuelTab
            trucks={allActiveTrucks}
            transactions={transactions}
            loading={loading}
            refresh={refresh}
            addTransactions={addTransactions}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            rangeKey={rangeKey}
            equipment={equipment}
          />
        )}

        {tab === 'manage' && (
          <ExpenseManageView data={expenseData} trucks={equipment} />
        )}
      </div>
    </div>
  )
}
