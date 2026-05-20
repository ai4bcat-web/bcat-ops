import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { startOfWeek, endOfWeek, subWeeks } from 'date-fns'
import { ArrowUp, ArrowDown, Minus, Fuel } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import type { FuelTransaction } from '@/hooks/useFuelTransactions'

interface Props {
  transactions: FuelTransaction[]
  loading: boolean
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function filterByRange(txs: FuelTransaction[], start: Date, end: Date) {
  return txs.filter((t) => {
    const d = new Date(`${t.transactionDate}T12:00:00`)
    return d >= start && d <= end
  })
}

export function FuelWidget({ transactions, loading }: Props) {
  const navigate = useNavigate()
  const equipment = useAppStore((s) => s.equipment)
  const trucks = useMemo(() => equipment.filter((e) => e.type === 'truck' && e.active), [equipment])

  const now = new Date()
  const thisWeekStart = startOfWeek(now, { weekStartsOn: 0 })
  const thisWeekEnd   = endOfWeek(now,   { weekStartsOn: 0 })
  const lastWeekStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 0 })
  const lastWeekEnd   = endOfWeek(subWeeks(now, 1),   { weekStartsOn: 0 })

  const thisWeekTxs = useMemo(() => filterByRange(transactions, thisWeekStart, thisWeekEnd), [transactions, thisWeekStart, thisWeekEnd])
  const lastWeekTxs = useMemo(() => filterByRange(transactions, lastWeekStart, lastWeekEnd), [transactions, lastWeekStart, lastWeekEnd])

  const thisSpend = thisWeekTxs.reduce((s, t) => s + t.amount, 0)
  const lastSpend = lastWeekTxs.reduce((s, t) => s + t.amount, 0)
  const thisGal   = thisWeekTxs.reduce((s, t) => s + t.quantity, 0)

  const pctChange = lastSpend > 0
    ? Math.round(((thisSpend - lastSpend) / lastSpend) * 100)
    : null

  // Top 3 trucks by this-week spend
  const truckSpend = useMemo(() => {
    const map: Record<string, { label: string; spend: number }> = {}
    for (const tx of thisWeekTxs) {
      if (!tx.truckId) continue
      const truck = trucks.find((t) => t.id === tx.truckId)
      if (!truck) continue
      const label = `#${truck.unitNumber}`
      if (!map[tx.truckId]) map[tx.truckId] = { label, spend: 0 }
      map[tx.truckId].spend += tx.amount
    }
    return Object.values(map)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 3)
  }, [thisWeekTxs, trucks])

  return (
    <div
      onClick={() => navigate('/expenses?range=this-week')}
      className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6 space-y-4 cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <div className="size-10 rounded-lg bg-amber-50 flex items-center justify-center">
          <Fuel className="size-5 text-amber-600" />
        </div>
        {pctChange !== null && (
          <span className={cn(
            'flex items-center gap-0.5 text-xs font-semibold',
            pctChange > 0 ? 'text-red-500' : pctChange < 0 ? 'text-emerald-600' : 'text-slate-400',
          )}>
            {pctChange > 0
              ? <ArrowUp className="size-3" />
              : pctChange < 0
              ? <ArrowDown className="size-3" />
              : <Minus className="size-3" />}
            {Math.abs(pctChange)}% vs last week
          </span>
        )}
      </div>

      <div>
        <div className="text-3xl font-semibold tracking-tight text-foreground">
          {loading ? <span className="text-slate-300">—</span> : fmtMoney(thisSpend)}
        </div>
        <div className="text-sm text-slate-500 mt-0.5">Fuel This Week</div>
        {thisGal > 0 && (
          <div className="text-xs text-slate-400 mt-0.5">
            {thisGal.toFixed(0)} gal
          </div>
        )}
      </div>

      {truckSpend.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-slate-100">
          {truckSpend.map(({ label, spend }) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">{label}</span>
              <span className="tabular-nums text-muted-foreground">{fmtMoney(spend)}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && thisSpend === 0 && (
        <p className="text-xs text-muted-foreground">No fuel data for this week.</p>
      )}
    </div>
  )
}
