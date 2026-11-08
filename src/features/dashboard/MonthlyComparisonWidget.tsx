import { useState, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell, CartesianGrid,
} from 'recharts'
import { Package, DollarSign, CheckCircle2, Truck, Gauge, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useMonthlyMetrics, type MonthBucket } from '@/hooks/useMonthlyMetrics'
import { useIsMobile } from '@/hooks/useIsMobile'

// ── Helpers ───────────────────────────────────────────────────────────────────

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)
}

function num(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

/** dollars-and-cents, e.g. $2.15 — for rev/mile */
function moneyDec(dollars: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars)
}

/** percent change a→b, or null when there's no baseline to compare against */
function pctDelta(prev: number, cur: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null
  return Math.round(((cur - prev) / prev) * 100)
}

// ── Metric definitions ──────────────────────────────────────────────────────────

type MetricKey = 'loads' | 'revenue' | 'revPerMile' | 'readyToInvoice' | 'trucks'

interface MetricDef {
  key: MetricKey
  label: string
  color: string
  icon: React.ReactNode
  get: (m: MonthBucket) => number
  fmt: (n: number) => string
  axisWidth: number
}

const METRICS: MetricDef[] = [
  { key: 'loads',          label: 'Loads',      color: 'var(--tms-chart-5)', icon: <Package size={13} />,      get: (m) => m.loads,          fmt: num,      axisWidth: 28 },
  { key: 'revenue',        label: 'Revenue',    color: 'var(--tms-badge-green)', icon: <DollarSign size={13} />,   get: (m) => m.revenue,        fmt: money,    axisWidth: 52 },
  { key: 'revPerMile',     label: 'Rev / Mile', color: 'var(--tms-chart-8)', icon: <Gauge size={13} />,        get: (m) => m.revenuePerMile, fmt: moneyDec, axisWidth: 44 },
  { key: 'readyToInvoice', label: 'Invoiced',   color: 'var(--tms-chart-6)', icon: <CheckCircle2 size={13} />, get: (m) => m.readyToInvoice, fmt: num,      axisWidth: 28 },
  { key: 'trucks',         label: 'Trucks',     color: 'var(--tms-chart-4)', icon: <Truck size={13} />,        get: (m) => m.trucks,         fmt: num,      axisWidth: 28 },
]

// Segments for the stacked Revenue view — who covered the load, by driver type.
// Metrics that break down by who covered the load (driver type). Each renders as a
// stacked bar; the Unassigned segment (optional) is hidden when no month has any.
interface StackSeg { key: keyof MonthBucket; label: string; color: string; optional?: boolean }
interface StackDef { fmt: (n: number) => string; segments: StackSeg[] }

const STACKS: Partial<Record<MetricKey, StackDef>> = {
  loads: {
    fmt: num,
    segments: [
      { key: 'loadsBroker',     label: 'Broker covered', color: 'var(--tms-chart-4)' },
      { key: 'loadsIvan',       label: 'Ivan drivers',   color: 'var(--tms-primary)' },
      { key: 'loadsUnassigned', label: 'Unassigned',     color: 'var(--tms-chart-9)', optional: true },
    ],
  },
  revenue: {
    fmt: money,
    segments: [
      { key: 'revenueBroker',     label: 'Broker covered', color: 'var(--tms-chart-4)' },
      { key: 'revenueIvan',       label: 'Ivan drivers',   color: 'var(--tms-badge-green)' },
      { key: 'revenueUnassigned', label: 'Unassigned',     color: 'var(--tms-chart-9)', optional: true },
    ],
  },
  trucks: {
    fmt: num,
    segments: [
      { key: 'trucksAmazon', label: 'Amazon',     color: 'var(--tms-chart-12)' },
      { key: 'trucksIvan',   label: 'Ivan Fleet', color: 'var(--tms-chart-4)' },
    ],
  },
}

/** Segments to actually draw for a stack, dropping an empty optional (Unassigned). */
function visibleSegments(stack: StackDef, months: MonthBucket[]): StackSeg[] {
  return stack.segments.filter((s) => !s.optional || months.some((m) => (m[s.key] as number) > 0))
}

// ── Little bits ─────────────────────────────────────────────────────────────────

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) {
    return <span style={{ fontSize: 12, color: 'var(--tms-muted)', fontWeight: 500 }}>—</span>
  }
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const color = dir === 'up' ? 'var(--tms-badge-green)' : dir === 'down' ? 'var(--tms-badge-red)' : 'var(--tms-muted)'
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      <Icon size={12} /> {delta > 0 ? '+' : ''}{delta}%
    </span>
  )
}

function RecapTile({ def, lastMonth, monthBefore }: { def: MetricDef; lastMonth: MonthBucket; monthBefore: MonthBucket | null }) {
  const cur = def.get(lastMonth)
  const prev = monthBefore ? def.get(monthBefore) : 0
  return (
    <div style={{ padding: '12px 14px', background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
        <span style={{ color: def.color, display: 'inline-flex' }}>{def.icon}</span>
        {def.label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums', marginTop: 6, lineHeight: 1.1 }}>
        {def.fmt(cur)}
      </div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <DeltaBadge delta={pctDelta(prev, cur)} />
        {monthBefore && <span style={{ fontSize: 11, color: 'var(--tms-muted)' }}>vs {monthBefore.label}</span>}
      </div>
      {(() => {
        const stack = STACKS[def.key]
        if (!stack) return null
        return (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--tms-border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {visibleSegments(stack, [lastMonth]).map((s) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--tms-text-2)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                  {s.label}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--tms-text)' }}>{stack.fmt(lastMonth[s.key] as number)}</span>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

// ── Widget ──────────────────────────────────────────────────────────────────────

export function MonthlyComparisonWidget() {
  const [metricKey, setMetricKey] = useState<MetricKey>('loads')
  const { months, lastMonth, monthBefore } = useMonthlyMetrics(6)
  const isMobile = useIsMobile()

  const metric = METRICS.find((m) => m.key === metricKey)!

  const chartData = useMemo(
    () => months.map((m) => ({ ...m, value: metric.get(m) })),
    [months, metric],
  )
  const hasData = chartData.some((d) => d.value > 0)

  // Loads & Revenue render as stacked bars split by who covered the load (driver type).
  const stack = STACKS[metricKey]
  const isStacked = !!stack
  const stackSegments = useMemo(
    () => (stack ? visibleSegments(stack, months) : []),
    [stack, months],
  )

  return (
    <div className="tms-card">
      {/* Header + metric toggle */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Monthly Comparison</div>
          <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 2 }}>
            Last {months.length} months · current month to date
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3 }}>
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetricKey(m.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '4px 11px', borderRadius: 7,
                border: 'none', cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
                fontWeight: metricKey === m.key ? 600 : 500,
                background: metricKey === m.key ? 'var(--tms-card)' : 'transparent',
                color: metricKey === m.key ? 'var(--tms-text)' : 'var(--tms-muted)',
                boxShadow: metricKey === m.key ? 'var(--tms-shadow)' : 'none',
              }}
            >
              <span style={{ color: metricKey === m.key ? m.color : 'var(--tms-muted)', display: 'inline-flex' }}>{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Last-month recap */}
      {lastMonth && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--tms-muted)', marginBottom: 10 }}>
            Last Month · {lastMonth.fullLabel}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : `repeat(${METRICS.length}, minmax(0, 1fr))`, gap: 12 }}>
            {METRICS.map((def) => (
              <RecapTile key={def.key} def={def} lastMonth={lastMonth} monthBefore={monthBefore} />
            ))}
          </div>
        </div>
      )}

      {/* Comparison chart */}
      <div style={{ padding: '16px 20px' }}>
        {!hasData ? (
          <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--tms-muted)' }}>
            No {metric.label.toLowerCase()} data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--tms-border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={metric.axisWidth}
                allowDecimals={metricKey === 'revPerMile'}
                tickFormatter={(v) => metric.fmt(v as number)}
              />
              <RTooltip
                cursor={{ fill: 'var(--tms-surface-hover)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null
                  const row = payload[0].payload as (typeof chartData)[number]
                  return (
                    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, boxShadow: 'var(--tms-shadow-pop)', minWidth: 150 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {row.fullLabel}
                        {row.isCurrent && <span style={{ color: 'var(--tms-muted)', fontWeight: 500 }}> · to date</span>}
                      </div>
                      {isStacked && stack ? (
                        <>
                          {stackSegments.map((s) => (
                            <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--tms-text-2)' }}>
                                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                                {s.label}
                              </span>
                              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{stack.fmt(row[s.key] as number)}</span>
                            </div>
                          ))}
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--tms-border)' }}>
                            <span style={{ color: 'var(--tms-muted)' }}>Total</span>
                            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{metric.fmt(row.value)}</span>
                          </div>
                        </>
                      ) : (
                        <div style={{ color: metric.color, fontWeight: 600 }}>
                          {metric.fmt(row.value)} {metric.label.toLowerCase()}
                        </div>
                      )}
                    </div>
                  )
                }}
              />
              {isStacked
                ? stackSegments.map((s, si) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      stackId="stack"
                      radius={si === stackSegments.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                      maxBarSize={54}
                    >
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={s.color} fillOpacity={d.isCurrent ? 0.45 : 1} />
                      ))}
                    </Bar>
                  ))
                : (
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={54}>
                    {chartData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={metric.color}
                        fillOpacity={d.isCurrent ? 0.4 : 1}
                        stroke={d.isCurrent ? metric.color : undefined}
                        strokeWidth={d.isCurrent ? 1.5 : 0}
                        strokeDasharray={d.isCurrent ? '4 3' : undefined}
                      />
                    ))}
                  </Bar>
                )}
            </BarChart>
          </ResponsiveContainer>
        )}
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--tms-muted)' }}>
          {isStacked ? (
            <>
              {stackSegments.map((s) => (
                <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2, display: 'inline-block' }} />
                  {s.label}
                </span>
              ))}
              <span style={{ color: 'var(--tms-muted)', opacity: 0.75 }}>· faded bar = current month (to date)</span>
            </>
          ) : (
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, background: metric.color, borderRadius: 2, display: 'inline-block' }} />
                Completed month
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, background: metric.color, opacity: 0.4, border: `1.5px dashed ${metric.color}`, borderRadius: 2, display: 'inline-block' }} />
                Current month (to date)
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
