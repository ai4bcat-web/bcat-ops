import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Wallet } from 'lucide-react'
import { useFleetMonthlyNet } from '@/hooks/useFleetMonthlyNet'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { monthRange, monthLabel } from '@/features/fleet-profitability/monthRange'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const netColor = (n: number) => (n > 0 ? '#15803d' : n < 0 ? '#dc2626' : 'var(--ds-t2)')
const navBtn: React.CSSProperties = { width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7, cursor: 'pointer', color: 'var(--ds-t2)' }

/**
 * Combined monthly profitability — Ivan (LOCAL fleet net) + Amazon (driver profit to
 * the company), summed for the month. Uses the same math as the Monthly P&L cards.
 */
export function CombinedMonthlyProfit() {
  const [monthOffset, setMonthOffset] = useState(0)
  const range = monthRange(monthOffset)
  const ivan = useFleetMonthlyNet(range)
  const { rows, loading: amzLoading } = useAmazonProfitability()
  const amazon = useMemo(() => aggregateAmazon(rows, range.start, range.end), [rows, range.start, range.end])
  const combined = ivan.net + amazon.profit
  const loading = ivan.loading && amzLoading

  const Part = ({ label, value }: { label: string; value: number }) => (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: netColor(value), fontVariantNumeric: 'tabular-nums' }}>{money(value)}</div>
    </div>
  )

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wallet size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Total monthly profitability</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Ivan + Amazon combined · {monthLabel(range)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={() => setMonthOffset((o) => o + 1)} style={navBtn} aria-label="Previous month"><ChevronLeft size={15} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', minWidth: 120, textAlign: 'center' }}>
            {monthOffset === 0 ? 'This month' : monthLabel(range)}
          </span>
          <button onClick={() => setMonthOffset((o) => Math.max(0, o - 1))} disabled={monthOffset === 0} style={{ ...navBtn, opacity: monthOffset === 0 ? 0.4 : 1 }} aria-label="Next month"><ChevronRight size={15} /></button>
        </div>
      </div>

      <div style={{ padding: '20px' }}>
        {loading ? (
          <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 200 }}>
              <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Combined profit</div>
              <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.1, marginTop: 2, color: netColor(combined), fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{money(combined)}</div>
            </div>
            <div style={{ display: 'flex', gap: 24, flex: 1, minWidth: 260, borderLeft: '1px solid var(--ds-border)', paddingLeft: 24 }}>
              <Part label="Ivan (fleet net)" value={ivan.net} />
              <Part label="Amazon (profit)" value={amazon.profit} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
