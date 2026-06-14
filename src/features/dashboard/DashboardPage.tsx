import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import {
  Package, DollarSign, AlertCircle, CalendarClock,
  RefreshCw, Plus, MoreHorizontal, ChevronRight,
} from 'lucide-react'
import { KpiCard } from '@/components/ui/kpi-card'
import { Avatar } from '@/components/ui/avatar'
import { useDashboardMetrics, type DateRangeKey } from '@/hooks/useDashboardMetrics'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { useAppStore } from '@/store/useAppStore'
import { FuelWidget } from './FuelWidget'
import { OpenTasksWidget } from './OpenTasksWidget'
import { ComplianceAlertsWidget } from './ComplianceAlertsWidget'
import { TruckMapWidget } from './TruckMapWidget'
import { TruckMilesWidget } from './TruckMilesWidget'
import { FleetProfitabilitySection } from '@/features/fleet-profitability/FleetProfitabilitySection'
import { getColor } from '@/lib/driverColors'
import { formatPhone } from '@/lib/utils'
import { useIsMobile } from '@/hooks/useIsMobile'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cents(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n / 100)
}

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ── Internal primitives ───────────────────────────────────────────────────────

interface CardProps {
  title: string
  sub?: string
  right?: React.ReactNode
  children: React.ReactNode
  noPad?: boolean
}

function Card({ title, sub, right, children, noPad = false }: CardProps) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      <div style={noPad ? undefined : { padding: '16px 20px' }}>{children}</div>
    </div>
  )
}

interface DonutSegment { v: number; color: string }

function Donut({ data, size = 150, thickness = 18, centerLabel, centerValue }: {
  data: DonutSegment[]
  size?: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
}) {
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  const total = data.reduce((s, d) => s + d.v, 0) || 1
  let offset = 0
  const cx = size / 2
  const cy = size / 2

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      {data.map((seg, i) => {
        const dash = (seg.v / total) * circ
        const gap = circ - dash
        const el = (
          <circle
            key={i}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={seg.color}
            strokeWidth={thickness}
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-offset}
          />
        )
        offset += dash
        return el
      })}
      {centerValue && (
        <g style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%' }}>
          <text x={cx} y={cy - 6} textAnchor="middle" style={{ fontSize: 20, fontWeight: 700, fill: 'var(--ds-t1)', fontFamily: 'inherit' }}>
            {centerValue}
          </text>
          {centerLabel && (
            <text x={cx} y={cy + 12} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--ds-t3)', fontFamily: 'inherit' }}>
              {centerLabel}
            </text>
          )}
        </g>
      )}
    </svg>
  )
}

function IconBtn({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <button title={label} style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
      background: 'var(--ds-bg)', border: '1px solid var(--ds-border)',
      fontSize: 12.5, color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
    }}>
      {children}
    </button>
  )
}

// ── Range chips ───────────────────────────────────────────────────────────────

const RANGES: { value: DateRangeKey; label: string }[] = [
  { value: 'today',        label: 'Today'      },
  { value: 'this-week',    label: 'This Week'  },
  { value: 'this-month',   label: 'This Month' },
  { value: 'this-quarter', label: 'Quarter'    },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [rangeKey, setRangeKey] = useState<DateRangeKey>('this-month')
  const metrics = useDashboardMetrics(rangeKey)
  const { transactions: fuelTxs, loading: fuelLoading } = useFuelTransactions()
  const loads = useAppStore((s) => s.loads)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const col1 = isMobile ? '1fr' : undefined   // stack any multi-col row on mobile

  const chartColors = useMemo(
    () => metrics.loadsPerDriver.map((d) => getColor(d.colorKey as never).border),
    [metrics.loadsPerDriver],
  )

  // Sparklines from real load-by-day data
  const loadsSpark = useMemo(() => metrics.loadsByDay.map((d) => d.count), [metrics.loadsByDay])

  // Load status counts from store (for donut)
  const statusCounts = useMemo(() => {
    const ready      = loads.filter((l) => l.readyToInvoice).length
    const inProgress = loads.filter((l) => !l.readyToInvoice && !!l.pickupDriverId).length
    const unassigned = loads.filter((l) => !l.pickupDriverId).length
    return { ready, inProgress, unassigned, total: loads.length }
  }, [loads])

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Page header ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
              Operations Dashboard
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              Live snapshot · {dateLabel}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Range chips */}
            <div style={{ display: 'flex', gap: 4, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3 }}>
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRangeKey(r.value)}
                  style={{
                    padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontSize: 12.5, fontWeight: rangeKey === r.value ? 600 : 500,
                    fontFamily: 'inherit',
                    background: rangeKey === r.value ? '#fff' : 'transparent',
                    color: rangeKey === r.value ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: rangeKey === r.value ? 'var(--sh-sm)' : 'none',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <IconBtn label="Refresh"><RefreshCw size={13} /> Refresh</IconBtn>
            <button
              onClick={() => navigate('/loads')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7,
                background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <Plus size={13} /> New Load
            </button>
          </div>
        </div>

        {/* ── KPI strip ────────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
          <KpiCard
            label="Total Loads"
            value={metrics.totalLoads}
            sublabel={`vs. previous ${RANGES.find((r) => r.value === rangeKey)?.label.toLowerCase()}`}
            delta={metrics.totalLoadsDelta > 0 ? `+${metrics.totalLoadsDelta}` : String(metrics.totalLoadsDelta)}
            deltaDir={metrics.totalLoadsDelta > 0 ? 'up' : metrics.totalLoadsDelta < 0 ? 'down' : 'neutral'}
            spark={loadsSpark.length >= 2 ? loadsSpark : undefined}
            sparkColor="#1ea8f3"
            accent="#1ea8f3"
            icon={<Package size={15} />}
          />
          <KpiCard
            label="Needs Invoice"
            value={metrics.needsInvoice}
            sublabel={metrics.needsInvoice > 0 ? 'Past deliveries not invoiced' : 'All caught up'}
            accent={metrics.needsInvoice > 0 ? '#dc2626' : '#22c55e'}
            sparkColor="#22c55e"
            icon={<AlertCircle size={15} />}
          />
          <KpiCard
            label="Appts to Book"
            value={metrics.needsAppt}
            sublabel={metrics.needsAppt > 0 ? 'Loads with NEED status' : 'All booked'}
            accent={metrics.needsAppt > 0 ? '#f59e0b' : undefined}
            sparkColor="#f59e0b"
            icon={<CalendarClock size={15} />}
          />
          <KpiCard
            label="Revenue This Month"
            value={metrics.revenueConnected ? cents(metrics.revenue) : '$0'}
            sublabel={metrics.revenueConnected ? `from ${metrics.totalLoads} loads` : 'Connect rates to loads'}
            accent="#1ea8f3"
            sparkColor="#1ea8f3"
            icon={<DollarSign size={15} />}
          />
        </div>

        {/* ── Fleet tracking (Motive ELD) ──────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? '1.6fr 1fr', gap: 16 }}>
          <TruckMapWidget />
          <TruckMilesWidget />
        </div>

        {/* ── Charts row ───────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? '1fr 1.4fr', gap: 16 }}>

          {/* Loads per driver */}
          <Card
            title="Loads per Driver"
            sub={`${RANGES.find((r) => r.value === rangeKey)?.label} · by assigned driver`}
            right={<button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', padding: 4 }}><MoreHorizontal size={15} /></button>}
          >
            {metrics.loadsPerDriver.length === 0 ? (
              <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>
                No loads in this period
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={Math.max(160, metrics.loadsPerDriver.length * 44)}>
                  <BarChart data={metrics.loadsPerDriver} layout="vertical" margin={{ left: 4, right: 24, top: 4, bottom: 4 }}>
                    <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                    <RTooltip
                      cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                      content={({ active, payload }) =>
                        active && payload?.[0] ? (
                          <div style={{ background: '#fff', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '7px 12px', fontSize: 13, boxShadow: 'var(--sh-md)' }}>
                            <span style={{ fontWeight: 600 }}>{payload[0].payload.name}</span>
                            <span style={{ color: 'var(--ds-t3)', marginLeft: 8 }}>{payload[0].value} loads</span>
                          </div>
                        ) : null
                      }
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={26}>
                      {metrics.loadsPerDriver.map((_, i) => (
                        <Cell key={i} fill={chartColors[i] ?? '#1ea8f3'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ds-t3)' }}>
                  <div>
                    Avg <span style={{ color: 'var(--ds-t1)', fontFamily: 'var(--font-mono)' }}>
                      {metrics.loadsPerDriver.length > 0
                        ? (metrics.loadsPerDriver.reduce((s, d) => s + d.count, 0) / metrics.loadsPerDriver.length).toFixed(1)
                        : '0.0'}
                    </span> loads/driver
                  </div>
                </div>
              </>
            )}
          </Card>

          {/* Loads by day */}
          <Card
            title="Loads by Day"
            sub={`Daily volume · ${metrics.rangeStart} – ${metrics.rangeEnd}`}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ds-t2)' }}>
                  <span style={{ width: 8, height: 8, background: '#1ea8f3', borderRadius: 2, display: 'inline-block' }} />
                  Loads
                </span>
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', padding: 4 }}><MoreHorizontal size={15} /></button>
              </div>
            }
          >
            {metrics.loadsByDay.every((d) => d.count === 0) ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>
                No loads in this period
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics.loadsByDay} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => shortDate(v)}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={24} />
                  <RTooltip
                    cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div style={{ background: '#fff', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '7px 12px', fontSize: 13, boxShadow: 'var(--sh-md)' }}>
                          <span style={{ fontWeight: 600 }}>{shortDate(payload[0].payload.date)}</span>
                          <span style={{ color: 'var(--ds-t3)', marginLeft: 8 }}>{payload[0].value} loads</span>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="count" fill="#1ea8f3" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        {/* ── Mid row: Driver Performance + Donut cards ─────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? '1.6fr 1fr 1fr', gap: 16 }}>

          {/* Driver Performance */}
          <Card
            title="Driver Performance"
            sub={`${RANGES.find((r) => r.value === rangeKey)?.label} · ${metrics.rangeStart} – ${metrics.rangeEnd}`}
            right={
              <button onClick={() => navigate('/drivers')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                View all <ChevronRight size={12} />
              </button>
            }
            noPad
          >
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    {['Driver', 'Phone', 'Total Loads', 'RTI', 'Avg / Day', 'Last Load'].map((h, i) => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: i > 1 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.driverPerformance.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>
                        No driver data for this period
                      </td>
                    </tr>
                  ) : metrics.driverPerformance.map(({ driver, totalLoads, readyToInvoice: rti, avgLoadsPerDay, lastLoadDate }) => {
                    const color = driver.colorKey ? getColor(driver.colorKey as never) : undefined
                    return (
                      <tr key={driver.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                        <td style={{ padding: '9px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <Avatar
                              initials={initials(driver.name)}
                              src={driver.photoUrl}
                              size="sm"
                              style={color ? { background: color.avatarBg, color: '#fff' } : undefined}
                            />
                            <span style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{driver.name}</span>
                          </div>
                        </td>
                        <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)' }}>
                          {formatPhone(driver.phone)}
                        </td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                          {totalLoads}
                        </td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: rti > 0 ? '#16a34a' : 'var(--ds-t3)' }}>
                          {rti}
                        </td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)' }}>
                          {avgLoadsPerDay.toFixed(2)}
                        </td>
                        <td style={{ padding: '9px 16px', fontSize: 12.5, color: lastLoadDate ? 'var(--ds-t2)' : 'var(--ds-t3)' }}>
                          {lastLoadDate ? shortDate(lastLoadDate) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Load Status Mix */}
          <Card title="Load Status Mix" sub={`${statusCounts.total} active loads`}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0 16px' }}>
              <Donut
                data={[
                  { v: statusCounts.ready,      color: '#22c55e' },
                  { v: statusCounts.inProgress, color: '#1ea8f3' },
                  { v: statusCounts.unassigned, color: '#f59e0b' },
                ]}
                size={150}
                thickness={18}
                centerLabel="Total"
                centerValue={String(statusCounts.total)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Ready to invoice', v: statusCounts.ready,      color: '#22c55e' },
                { label: 'In progress',      v: statusCounts.inProgress, color: '#1ea8f3' },
                { label: 'Unassigned',       v: statusCounts.unassigned, color: '#f59e0b' },
              ].map((d) => (
                <div key={d.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, background: d.color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ color: 'var(--ds-t2)' }}>{d.label}</span>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)' }}>{d.v}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* On-Time Performance */}
          <Card title="On-Time Performance" sub="Last 30 days">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0 16px' }}>
              <Donut
                data={[
                  { v: 92, color: '#1ea8f3' },
                  { v: 8,  color: 'rgba(15,23,42,0.07)' },
                ]}
                size={150}
                thickness={18}
                centerLabel="On-time"
                centerValue="92%"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingTop: 12, borderTop: '1px solid var(--ds-border)' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Avg Delivery</div>
                <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>2d 4h</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Delayed</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#dc2626', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>3</div>
              </div>
            </div>
          </Card>
        </div>

        {/* ── Bottom row: Compliance · Fuel · Open Tasks ────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
          <ComplianceAlertsWidget />
          <FuelWidget transactions={fuelTxs} loading={fuelLoading} />
          <OpenTasksWidget />
        </div>

        {/* ── Weekly fleet profitability (replaces the Profitability placeholder) ── */}
        <FleetProfitabilitySection />

      </div>
    </div>
  )
}
