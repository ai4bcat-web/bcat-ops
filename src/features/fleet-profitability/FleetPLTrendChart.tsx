import { useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { TrendingUp } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { sundayOf, shiftWeek } from '@/features/driver-pay/week'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'
import { weekRange } from './weekRange'

const WEEKS = 8
const COLORS = { revenue: '#1ea8f3', expenses: '#dc2626', profit: '#15803d' }

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
  const [group, setGroup] = useState<FleetGroup>('LOCAL')
  const { computeForRange } = useFleetProfitability(weekRange(0), group)
  const { rows: amzRows } = useAmazonProfitability()

  const series = useMemo(() => {
    const rows: { label: string; revenue: number; expenses: number; profit: number }[] = []
    for (let i = WEEKS - 1; i >= 0; i--) {       // oldest → newest
      if (group === 'AMAZON') {
        const ws = shiftWeek(sundayOf(), -i)       // Sunday pay week
        const a = aggregateAmazon(amzRows, ws, ws)
        rows.push({
          label: weekTickLabel(ws),
          revenue: Math.round(a.revenue),
          expenses: Math.round(a.driverPay + a.expenses), // driver pay + operating costs
          profit: Math.round(a.profit),
        })
      } else {
        const range = weekRange(i)
        const r = computeForRange(range).rollup
        rows.push({
          label: weekTickLabel(range.start),
          revenue: Math.round(r.revenue),
          expenses: Math.round(r.revenue - r.net),
          profit: Math.round(r.net),
        })
      }
    }
    return rows
  }, [computeForRange, group, amzRows])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Week-over-week P&amp;L</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Revenue, expenses &amp; profit · last {WEEKS} weeks</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
          {FLEET_GROUPS.map((g) => {
            const active = g === group
            return (
              <button key={g} onClick={() => setGroup(g)}
                style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)',
                  boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                {FLEET_GROUP_LABELS[g]}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '16px 12px 8px' }}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={series} margin={{ top: 6, right: 16, bottom: 0, left: 4 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => usdCompact.format(v)} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
            <Tooltip
              cursor={{ fill: 'rgba(15,23,42,0.04)' }}
              formatter={(value) => usd0.format(Number(value))}
              contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
            <Bar dataKey="revenue"  name="Revenue"  fill={COLORS.revenue}  radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill={COLORS.expenses} radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit"   name="Profit"   fill={COLORS.profit}   radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
