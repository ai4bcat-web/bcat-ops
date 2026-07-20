import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Truck, Container, FileText, Wrench, CalendarOff, ChevronRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useDriverAvailability } from '@/hooks/useDriverAvailability'
import { useTruckDocAlerts } from '@/hooks/useTruckDocAlerts'
import { useIsMobile } from '@/hooks/useIsMobile'
import { RepairInvoicesWidget } from '@/features/dashboard/RepairInvoicesWidget'
import { DieselPriceWidget } from '@/features/dashboard/DieselPriceWidget'
import { RepairSpendWidget } from './RepairSpendWidget'
import { ExpiringTruckDocsWidget } from './ExpiringTruckDocsWidget'
import { MaintenanceTasksWidget } from './MaintenanceTasksWidget'
import { PmDueWidget } from './PmDueWidget'
import { DotDueWidget } from './DotDueWidget'

// ── Time-off labels ─────────────────────────────────────────────────────────────
const TIME_OFF_META: Record<'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START', { label: string; bg: string; fg: string }> = {
  FULL_DAY_OFF: { label: 'Day Off',     bg: '#fef2f2', fg: '#b91c1c' },
  EARLY_START:  { label: 'Early Start', bg: '#fffbeb', fg: '#b45309' },
  LATE_START:   { label: 'Late Start',  bg: '#eff6ff', fg: '#1d4ed8' },
}

const todayStr = () => {
  const n = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

function prettyRange(startDate: string, endDate: string): string {
  const fmt = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return startDate === endDate ? fmt(startDate) : `${fmt(startDate)} – ${fmt(endDate)}`
}

// ── Local primitives ────────────────────────────────────────────────────────────
function StatCard({ label, value, color, icon, to }: {
  label: string; value: string | number; color: string; icon: React.ReactNode; to?: string
}) {
  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--ds-t1)', marginTop: 8, fontFamily: 'var(--font-mono)' }}>{value}</div>
    </>
  )
  const style: React.CSSProperties = {
    background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12,
    boxShadow: 'var(--sh-sm)', padding: '14px 16px', textDecoration: 'none', display: 'block',
  }
  return to ? <Link to={to} style={style}>{inner}</Link> : <div style={style}>{inner}</div>
}

function Card({ title, sub, right, children, noPad = false }: {
  title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean
}) {
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

// ── Time-off summary ────────────────────────────────────────────────────────────
function TimeOffSummary() {
  const drivers = useAppStore((s) => s.drivers)
  const { availabilities, loading } = useDriverAvailability()
  const driverName = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])
  const today = todayStr()

  const upcoming = useMemo(
    () => availabilities
      .filter((a) => a.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .slice(0, 6),
    [availabilities, today],
  )

  return (
    <Card
      title="Time Off"
      sub={loading ? 'Loading…' : `${upcoming.length} upcoming`}
      right={<Link to="/time-off" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>Calendar <ChevronRight size={13} /></Link>}
      noPad
    >
      {upcoming.length === 0 ? (
        <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <CalendarOff size={22} style={{ opacity: 0.35 }} />
          {loading ? 'Loading…' : 'No upcoming time off'}
        </div>
      ) : (
        <div>
          {upcoming.map((a) => {
            const meta = TIME_OFF_META[a.type]
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--ds-border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {driverName.get(a.driverId) ?? 'Unknown driver'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{prettyRange(a.startDate, a.endDate)}</div>
                </div>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: meta.bg, color: meta.fg }}>{meta.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────
export function FleetManagerDashboardPage() {
  const isMobile = useIsMobile()
  const equipment = useAppStore((s) => s.equipment)
  const maintenanceTasks = useAppStore((s) => s.maintenanceTasks)
  const { expired, expiring } = useTruckDocAlerts()

  const stats = useMemo(() => {
    const trucks = equipment.filter((e) => e.type === 'truck').length
    const trailers = equipment.filter((e) => e.type === 'trailer').length
    const openTasks = maintenanceTasks.filter((t) => t.status === 'upcoming').length
    return { total: equipment.length, trucks, trailers, openTasks }
  }, [equipment, maintenanceTasks])

  const docsExpiring = expired + expiring
  const twoCol = isMobile ? '1fr' : '1fr 1fr'

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, color: 'var(--ds-t1)', letterSpacing: '-0.01em' }}>Fleet Manager Dashboard</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Fleet health, maintenance &amp; driver availability at a glance</p>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 12 }}>
          <StatCard label="Total Units"   value={stats.total}     color="#1ea8f3" icon={<Truck size={14} />}     to="/trucks" />
          <StatCard label="Trucks"        value={stats.trucks}    color="#0369a1" icon={<Truck size={14} />}     to="/trucks" />
          <StatCard label="Trailers"      value={stats.trailers}  color="#a78bfa" icon={<Container size={14} />} to="/trucks" />
          <StatCard label="Docs Expiring" value={docsExpiring}    color="#ef4444" icon={<FileText size={14} />}  to="/truck-docs" />
          <StatCard label="Open Tasks"    value={stats.openTasks} color="#f59e0b" icon={<Wrench size={14} />}    to="/maintenance" />
        </div>

        {/* DOT inspections due / overdue — trucks + trailers */}
        <DotDueWidget />

        {/* Miles until next PM — Ivan fleet, every 25k mi */}
        <PmDueWidget />

        {/* Repair spend by month (filterable by equipment + date) */}
        <RepairSpendWidget />

        {/* Expiring truck documents + repair invoices */}
        <div style={{ display: 'grid', gridTemplateColumns: twoCol, gap: 16 }}>
          <ExpiringTruckDocsWidget />
          <RepairInvoicesWidget />
        </div>

        {/* Open maintenance tasks + time off */}
        <div style={{ display: 'grid', gridTemplateColumns: twoCol, gap: 16 }}>
          <MaintenanceTasksWidget />
          <TimeOffSummary />
        </div>

        {/* Fuel / diesel price — filterable by truck */}
        <DieselPriceWidget perTruck />
      </div>
    </div>
  )
}
