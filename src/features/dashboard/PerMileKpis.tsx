import { Gauge, DollarSign, TrendingUp } from 'lucide-react'
import { KpiCard } from '@/components/ui/kpi-card'
import { useProfitReview } from '@/hooks/useProfitReview'
import { monthMetrics } from '@/lib/profitReview'
import { useIsMobile } from '@/hooks/useIsMobile'

const usd2 = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/**
 * Ivan local fleet, this month to date: all-in cost, revenue and profit per odometer mile,
 * each against last month. Same math as the Profit Review (fuel, driver pay, maintenance,
 * insurance and fixed costs cut to the days elapsed; deliveries through today only).
 */
export function PerMileKpis() {
  const isMobile = useIsMobile()
  const { months, loading } = useProfitReview(2)
  const current = months[months.length - 1]
  const previous = months.length > 1 ? months[months.length - 2] : undefined
  const now = current ? monthMetrics(current) : null
  const prev = previous ? monthMetrics(previous) : null
  const sub = current ? `Ivan local · ${current.label} to date${previous ? ` · vs ${previous.label}` : ''}` : 'Ivan local'

  const delta = (a: number | null | undefined, b: number | null | undefined, lowerIsBetter = false) => {
    if (a == null || b == null) return {}
    const d = a - b
    const dir: 'up' | 'down' | 'neutral' = Math.abs(d) < 0.005 ? 'neutral' : (d > 0) !== lowerIsBetter ? 'up' : 'down'
    return { delta: `${d > 0 ? '+' : d < 0 ? '−' : ''}${usd2(Math.abs(d))}`, deltaDir: dir }
  }

  const value = (n: number | null | undefined) => (loading && !n ? '…' : usd2(n))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
      <KpiCard label="Cost per mile" value={value(now?.costPerMile)} sublabel={sub} icon={<Gauge size={15} />} {...delta(now?.costPerMile, prev?.costPerMile, true)} />
      <KpiCard label="Revenue per mile" value={value(now?.revPerMile)} sublabel={sub} icon={<DollarSign size={15} />} {...delta(now?.revPerMile, prev?.revPerMile)} />
      <KpiCard
        label="Profit per mile"
        value={<span style={{ color: now?.profitPerMile == null ? undefined : now.profitPerMile >= 0 ? '#15803d' : '#dc2626' }}>{value(now?.profitPerMile)}</span>}
        sublabel={sub}
        icon={<TrendingUp size={15} />}
        {...delta(now?.profitPerMile, prev?.profitPerMile)}
      />
    </div>
  )
}
