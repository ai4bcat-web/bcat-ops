import { useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { TrendingUp } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { useEnsureLoadRange } from '@/hooks/useLoads'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { useOwnerOperatorProfitability, aggregateOwnerOperator } from '@/hooks/useOwnerOperatorProfitability'
import { sundayOf, shiftWeek } from '@/features/driver-pay/week'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import { weekRange } from './weekRange'
import { useTmsTokens } from '@/features/tms/tmsTokens'

type TrendTab = 'LOCAL' | 'AMAZON' | 'OWNER_OPERATOR' | 'COMBINED'
const TABS: { key: TrendTab; label: string }[] = [
  { key: 'LOCAL',          label: FLEET_GROUP_LABELS.LOCAL },
  { key: 'AMAZON',         label: FLEET_GROUP_LABELS.AMAZON },
  { key: 'OWNER_OPERATOR', label: 'Owner operators' },
  { key: 'COMBINED',       label: 'Combined' },
]

const WEEKS = 8
const CHART_TOKENS = ['--tms-chart-5', '--tms-badge-red', '--tms-chart-1', '--tms-chart-axis', '--tms-chart-grid'] as const

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

function weekTickLabel(startIso: string): string {
  return new Date(`${startIso}T12:00:00`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
}

/**
 * Week-over-week P&L trend for the Finances dashboard — revenue, expenses and profit
 * across the last {WEEKS} weeks, computed from the same engine as the P&L cards.
 */
export function FleetPLTrendChart() {
  const tok = useTmsTokens(CHART_TOKENS)
  const [tab, setTab] = useState<TrendTab>('LOCAL')
  const { computeForRange } = useFleetProfitability(weekRange(0), 'LOCAL')
  // The chart computes WEEKS weeks back from this one, so window all of them in.
  useEnsureLoadRange(weekRange(WEEKS - 1).start, weekRange(0).end)
  const { rows: amzRows } = useAmazonProfitability()
  const { rows: ownerOpRows } = useOwnerOperatorProfitability()

  const series = useMemo(() => {
    const rows: { label: string; revenue: number; expenses: number; profit: number }[] = []
    for (let i = WEEKS - 1; i >= 0; i--) {       // oldest → newest
      const range = weekRange(i)
      const r = computeForRange(range).rollup
      const local = { revenue: r.revenue, expenses: r.revenue - r.net, profit: r.net }

      const ws = shiftWeek(sundayOf(), -i)         // Sunday pay week
      const a = aggregateAmazon(amzRows, ws, ws)
      const amazon = { revenue: a.revenue, expenses: a.driverPay + a.expenses, profit: a.profit }

      const oo = aggregateOwnerOperator(ownerOpRows, ws, ws)
      const ownerOp = { revenue: oo.revenue, expenses: oo.driverPay + oo.expenses, profit: oo.profit }

      const pick = tab === 'LOCAL' ? local
        : tab === 'AMAZON' ? amazon
        : tab === 'OWNER_OPERATOR' ? ownerOp
        : {
            // Amazon always counts; a month with none contributes zero on its own.
            revenue:  local.revenue  + ownerOp.revenue  + amazon.revenue,
            expenses: local.expenses + ownerOp.expenses + amazon.expenses,
            profit:   local.profit   + ownerOp.profit   + amazon.profit,
          }
      rows.push({
        label: weekTickLabel(range.start),
        revenue: Math.round(pick.revenue),
        expenses: Math.round(pick.expenses),
        profit: Math.round(pick.profit),
      })
    }
    return rows
  }, [computeForRange, tab, amzRows, ownerOpRows])

  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={16} style={{ color: 'var(--tms-primary)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Week-over-week P&amp;L</div>
            <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>Revenue, expenses &amp; profit · last {WEEKS} weeks</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--tms-bg)', borderRadius: 8, padding: 2 }}>
          {TABS.map(({ key, label }) => {
            const active = key === tab
            return (
              <button key={key} onClick={() => setTab(key)}
                style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: active ? 'var(--tms-card)' : 'transparent', color: active ? 'var(--tms-text)' : 'var(--tms-text-2)',
                  boxShadow: active ? 'var(--tms-shadow)' : 'none' }}>
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '16px 12px 8px' }}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={series} margin={{ top: 6, right: 16, bottom: 0, left: 4 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid stroke={tok['--tms-chart-grid']} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: tok['--tms-chart-axis'], fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => usdCompact.format(v)} tick={{ fill: tok['--tms-chart-axis'], fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
            <Tooltip
              cursor={{ fill: tok['--tms-chart-grid'] }}
              formatter={(value) => usd0.format(Number(value))}
              contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
            <Bar dataKey="revenue"  name="Revenue"  fill={tok['--tms-chart-5']}   radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill={tok['--tms-badge-red']} radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit"   name="Profit"   fill={tok['--tms-chart-1']}   radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
