import { useState, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import {
  TrendingUp, Truck, Package, DollarSign,
  ArrowUp, ArrowDown, Minus, AlertCircle, CalendarClock,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { Avatar } from '@/components/ui/avatar'
import { useDashboardMetrics, type DateRangeKey } from '@/hooks/useDashboardMetrics'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { FuelWidget } from './FuelWidget'
import { getColor } from '@/lib/driverColors'
import { formatPhone } from '@/lib/utils'
import { cn } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cents(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n / 100)
}

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string
  value: string | number
  delta?: number
  icon: React.ElementType
  iconBg: string
  iconColor: string
  sub?: React.ReactNode
}

function KpiCard({ label, value, delta, icon: Icon, iconBg, iconColor, sub }: KpiCardProps) {
  const showDelta = delta !== undefined
  return (
    <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6 space-y-3">
      <div className="flex items-start justify-between">
        <div className={cn('size-10 rounded-lg flex items-center justify-center shrink-0', iconBg)}>
          <Icon className={cn('size-5', iconColor)} />
        </div>
        {showDelta && (
          <span className={cn(
            'flex items-center gap-0.5 text-xs font-semibold',
            delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-500' : 'text-slate-400',
          )}>
            {delta > 0 ? <ArrowUp className="size-3" /> : delta < 0 ? <ArrowDown className="size-3" /> : <Minus className="size-3" />}
            {Math.abs(delta)}
          </span>
        )}
      </div>
      <div>
        <div className="text-3xl font-semibold tracking-tight text-foreground">{value}</div>
        <div className="text-sm text-slate-500 mt-0.5">{label}</div>
        {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
      </div>
    </div>
  )
}

// ── Coming Soon Card ──────────────────────────────────────────────────────────

function ComingSoonCard({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-6 relative flex flex-col items-center text-center gap-3">
      <Badge variant="secondary" className="absolute top-3 right-3 text-[10px]">Coming soon</Badge>
      <div className="size-12 rounded-full bg-slate-100 flex items-center justify-center">
        <Icon className="size-6 text-slate-400" />
      </div>
      <div>
        <p className="font-semibold text-slate-700">{title}</p>
        <p className="text-sm text-slate-400 mt-1 leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const RANGE_OPTIONS: { value: DateRangeKey; label: string }[] = [
  { value: 'this-month',   label: 'This Month'   },
  { value: 'this-quarter', label: 'This Quarter' },
  { value: 'this-year',    label: 'This Year'    },
]

export function DashboardPage() {
  const [rangeKey, setRangeKey] = useState<DateRangeKey>('this-month')
  const metrics = useDashboardMetrics(rangeKey)
  const { transactions: fuelTxs, loading: fuelLoading } = useFuelTransactions()

  const chartColors = useMemo(() =>
    metrics.loadsPerDriver.map((d) => getColor(d.colorKey as never).border),
    [metrics.loadsPerDriver]
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-8 py-8 space-y-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
            <p className="text-sm text-slate-500 mt-0.5">Operations overview</p>
          </div>
          <Select value={rangeKey} onValueChange={(v) => setRangeKey(v as DateRangeKey)}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* ── KPI strip ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <KpiCard
            label="Total Loads"
            value={metrics.totalLoads}
            delta={metrics.totalLoadsDelta}
            icon={Package}
            iconBg="bg-sky-50"
            iconColor="text-sky-600"
            sub={`vs. previous ${RANGE_OPTIONS.find((o) => o.value === rangeKey)?.label.toLowerCase()}`}
          />
          <KpiCard
            label="Needs Invoice"
            value={metrics.needsInvoice}
            icon={AlertCircle}
            iconBg={metrics.needsInvoice > 0 ? 'bg-red-50' : 'bg-slate-50'}
            iconColor={metrics.needsInvoice > 0 ? 'text-red-500' : 'text-slate-400'}
            sub={metrics.needsInvoice > 0 ? 'Past deliveries not invoiced' : 'All caught up'}
          />
          <KpiCard
            label="Appts to Book"
            value={metrics.needsAppt}
            icon={CalendarClock}
            iconBg={metrics.needsAppt > 0 ? 'bg-amber-50' : 'bg-slate-50'}
            iconColor={metrics.needsAppt > 0 ? 'text-amber-500' : 'text-slate-400'}
            sub={metrics.needsAppt > 0 ? 'Loads with NEED status' : 'All booked'}
          />
          <KpiCard
            label="Revenue"
            value={metrics.revenueConnected ? cents(metrics.revenue) : '$0'}
            icon={DollarSign}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
            sub={
              !metrics.revenueConnected
                ? <span className="text-sky-600 cursor-pointer hover:underline">Connect rates to loads</span>
                : undefined
            }
          />
        </div>

        {/* ── Charts ─────────────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-2 gap-6">

          {/* Loads per driver */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6">
            <h2 className="text-base font-semibold text-foreground mb-4">Loads per Driver</h2>
            {metrics.loadsPerDriver.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-slate-400">No loads in this period</div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(180, metrics.loadsPerDriver.length * 48)}>
                <BarChart data={metrics.loadsPerDriver} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <XAxis type="number" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                  <RTooltip
                    cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div className="rounded-lg border border-slate-200 bg-white shadow-md px-3 py-2 text-sm">
                          <span className="font-medium">{payload[0].payload.name}</span>
                          <span className="text-slate-500 ml-2">{payload[0].value} loads</span>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
                    {metrics.loadsPerDriver.map((_, i) => (
                      <Cell key={i} fill={chartColors[i] ?? '#1ea8f3'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Loads by day */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6">
            <h2 className="text-base font-semibold text-foreground mb-4">Loads by Day</h2>
            {metrics.loadsByDay.every((d) => d.count === 0) ? (
              <div className="h-48 flex items-center justify-center text-sm text-slate-400">No loads in this period</div>
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
                  <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} width={24} />
                  <RTooltip
                    cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div className="rounded-lg border border-slate-200 bg-white shadow-md px-3 py-2 text-sm">
                          <span className="font-medium">{shortDate(payload[0].payload.date)}</span>
                          <span className="text-slate-500 ml-2">{payload[0].value} loads</span>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="count" fill="#1ea8f3" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* ── Driver Performance table ────────────────────────────────────── */}
        <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-foreground">Driver Performance</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {RANGE_OPTIONS.find((o) => o.value === rangeKey)?.label} · {metrics.rangeStart} – {metrics.rangeEnd}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Driver</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Total Loads</TableHead>
                <TableHead className="text-right">RTI</TableHead>
                <TableHead className="text-right">Avg / Day</TableHead>
                <TableHead>Last Load</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.driverPerformance.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-slate-400 text-sm">
                    No driver data for this period
                  </TableCell>
                </TableRow>
              ) : (
                metrics.driverPerformance.map(({ driver, totalLoads, readyToInvoice: rti, avgLoadsPerDay, lastLoadDate }) => {
                  const color = driver.colorKey ? getColor(driver.colorKey) : undefined
                  return (
                    <TableRow key={driver.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Avatar
                            initials={initials(driver.name)}
                            src={driver.photoUrl}
                            size="sm"
                            style={color ? { background: color.avatarBg, color: '#fff' } : undefined}
                          />
                          <span className="font-medium text-foreground">{driver.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatPhone(driver.phone)}</TableCell>
                      <TableCell className="text-right font-semibold">{totalLoads}</TableCell>
                      <TableCell className="text-right">
                        {rti > 0 ? (
                          <span className="text-emerald-700 font-medium">{rti}</span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                        {avgLoadsPerDay.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {lastLoadDate ? shortDate(lastLoadDate) : <span className="text-slate-300">—</span>}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* ── Fuel widget + Coming soon ────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FuelWidget transactions={fuelTxs} loading={fuelLoading} />
          <ComingSoonCard
            icon={TrendingUp}
            title="Profitability"
            description="Track revenue minus expenses per truck, driver, and time period."
          />
          <ComingSoonCard
            icon={Truck}
            title="Truck Utilization"
            description="See miles, hours, and idle time per truck per day."
          />
        </div>

      </div>
    </div>
  )
}
