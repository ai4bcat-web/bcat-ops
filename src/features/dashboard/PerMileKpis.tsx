import { Gauge } from 'lucide-react'
import { useProfitReview } from '@/hooks/useProfitReview'
import { groupPerMile, type GroupPerMile } from '@/lib/profitReview'
import { useIsMobile } from '@/hooks/useIsMobile'

const usd2 = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const usd0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const num0 = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const GOOD = '#15803d', BAD = '#dc2626'

/**
 * Ivan fleet, this month to date, per odometer mile: miles, revenue, fuel, total cost and
 * profit for the semis, the box truck and the fleet, with the fleet row against last month.
 * Same math as the Profit Review: deliveries through today; driver pay, maintenance,
 * insurance and fixed costs cut to the days elapsed and spread evenly over every mile.
 */
export function PerMileKpis({ embedded = false }: { embedded?: boolean } = {}) {
  const isMobile = useIsMobile()
  const { months, loading } = useProfitReview(2)
  const current = months[months.length - 1]
  const previous = months.length > 1 ? months[months.length - 2] : undefined
  const rows = current ? groupPerMile(current) : []
  const prevFleet = previous ? groupPerMile(previous).find((g) => g.key === 'FLEET') : undefined

  const delta = (now: number | null, was: number | null | undefined, lowerIsBetter = false) => {
    if (now == null || was == null) return null
    const d = now - was
    if (Math.abs(d) < 0.005) return <span style={{ color: 'var(--ds-t3)', fontSize: 11 }}>· same</span>
    const good = (d > 0) !== lowerIsBetter
    return <span style={{ color: good ? GOOD : BAD, fontSize: 11, marginLeft: 6 }}>{d > 0 ? '+' : '−'}{usd2(Math.abs(d))}</span>
  }

  const cell = (g: GroupPerMile, key: 'revPerMile' | 'fuelPerMile' | 'costPerMile' | 'profitPerMile', lowerIsBetter = false) => {
    const v = g[key]
    const color = key === 'profitPerMile' && v != null ? (v >= 0 ? GOOD : BAD) : key === 'fuelPerMile' ? BAD : key === 'revPerMile' ? GOOD : 'var(--ds-t1)'
    return (
      <td style={{ ...TD, fontWeight: g.key === 'FLEET' ? 700 : 500, color }}>
        {usd2(v)}{g.key === 'FLEET' && prevFleet ? delta(v, prevFleet[key], lowerIsBetter) : null}
      </td>
    )
  }

  // Embedded (inside the driver leaderboard) it drops its own card chrome and reads as a section.
  return (
    <div style={embedded ? { borderTop: '1px solid var(--ds-border)' } : { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: embedded ? '12px 20px 6px' : '14px 20px', borderBottom: embedded ? undefined : '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Gauge size={embedded ? 14 : 16} style={{ color: 'var(--ds-blue)' }} />
        <div>
          <div style={{ fontSize: embedded ? 12 : 14, fontWeight: 700, color: 'var(--ds-t1)' }}>Per mile</div>
          <div style={{ fontSize: embedded ? 11 : 12, color: 'var(--ds-t3)' }}>Ivan fleet · {current ? `${current.label} to date` : 'this month'}{previous ? ` · fleet row vs ${previous.label}` : ''}</div>
        </div>
      </div>
      {loading && rows.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Group</th>
                {!isMobile && <th style={{ ...TH, textAlign: 'left' }}>Trucks</th>}
                <th style={TH}>Miles</th>
                {!isMobile && <th style={TH}>Revenue</th>}
                <th style={TH}>Rev / mi</th>
                <th style={TH}>Fuel / mi</th>
                <th style={TH}>Cost / mi</th>
                <th style={TH}>Profit / mi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.key} style={{ borderBottom: '1px solid var(--ds-border)', background: g.key === 'FLEET' ? 'var(--ds-bg)' : undefined }}>
                  <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{g.label}</td>
                  {!isMobile && <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t3)', fontFamily: 'monospace', fontSize: 12 }}>{g.units.map((u) => `#${u}`).join('  ')}</td>}
                  <td style={{ ...TD, fontWeight: g.key === 'FLEET' ? 700 : 500 }}>{num0(g.miles)}</td>
                  {!isMobile && <td style={{ ...TD, fontWeight: g.key === 'FLEET' ? 700 : 500 }}>{usd0(g.revenue)}</td>}
                  {cell(g, 'revPerMile')}
                  {cell(g, 'fuelPerMile', true)}
                  {cell(g, 'costPerMile', true)}
                  {cell(g, 'profitPerMile')}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ padding: '8px 20px', fontSize: 11.5, color: 'var(--ds-t3)' }}>
        Each group carries its own trucks' fuel, insurance, loan, maintenance and allocated fixed costs. The combined Ivan driver pay and trailer maintenance go to the semis; the box truck carries its driver's pay from the settlement rule. Deliveries through today; monthly costs cut to the days elapsed; odometer miles.
      </div>
    </div>
  )
}
