import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Truck, Container, FileText, Wrench, ChevronRight } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { TmsStatRow } from '@/features/tms/kit/TmsStatRow'
import { useAppStore } from '@/store/useAppStore'
import { fleetCounts } from '@/lib/fleetActive'
import { useAuth } from '@/hooks/useAuth'
import { useDriverAvailability } from '@/hooks/useDriverAvailability'
import { useTruckDocAlerts } from '@/hooks/useTruckDocAlerts'
import { useIsMobile } from '@/hooks/useIsMobile'
import { RepairInvoicesWidget } from '@/features/dashboard/RepairInvoicesWidget'
import { DieselPriceWidget } from '@/features/dashboard/DieselPriceWidget'
import { RepairSpendWidget } from './RepairSpendWidget'
import { ExpiringTruckDocsWidget } from './ExpiringTruckDocsWidget'
import { MaintenanceTasksWidget } from './MaintenanceTasksWidget'
import { PmDueWidget } from './PmDueWidget'
import { FaultCodesWidget } from './FaultCodesWidget'
import { DotDueWidget } from './DotDueWidget'
import { LoadDrawer } from '@/features/loads/LoadDrawer'

// ── Time-off labels ─────────────────────────────────────────────────────────────
const TIME_OFF_META: Record<'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START', { label: string; tone: TmsTone }> = {
  FULL_DAY_OFF: { label: 'Day Off',     tone: 'red' },
  EARLY_START:  { label: 'In Early By', tone: 'orange' },
  LATE_START:   { label: 'Late Start',  tone: 'blue' },
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


function Card({ title, sub, right, children, noPad = false }: {
  title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean
}) {
  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      <div style={noPad ? undefined : { padding: '16px 20px' }}>{children}</div>
    </div>
  )
}

// ── Time-off summary ────────────────────────────────────────────────────────────
function TimeOffSummary() {
  const { hasPageAccess } = useAuth()
  const canTimeOff = hasPageAccess('timeOff')
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
      right={canTimeOff ? <Link to="/time-off" style={{ fontSize: 12, color: 'var(--tms-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>Calendar <ChevronRight size={13} /></Link> : null}
      noPad
    >
      {upcoming.length === 0 ? (
        <TmsEmptyState compact title={loading ? 'Loading…' : 'No upcoming time off'} message={null} />
      ) : (
        <div>
          {upcoming.map((a) => {
            const meta = TIME_OFF_META[a.type]
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--tms-border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {driverName.get(a.driverId) ?? 'Unknown driver'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>{prettyRange(a.startDate, a.endDate)}</div>
                </div>
                <TmsBadge tone={meta.tone} style={{ flexShrink: 0 }}>{meta.label}</TmsBadge>
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
  const { hasPageAccess } = useAuth()
  const canTrucks = hasPageAccess('trucks')
  const canTruckDocs = hasPageAccess('truckDocs')
  const canMaintenance = hasPageAccess('maintenance')
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const equipment = useAppStore((s) => s.equipment)
  const maintenanceTasks = useAppStore((s) => s.maintenanceTasks)
  const { expired, expiring } = useTruckDocAlerts()

  const stats = useMemo(() => {
    const { total, trucks, trailers } = fleetCounts(equipment)
    const openTasks = maintenanceTasks.filter((t) => t.status === 'upcoming').length
    return { total, trucks, trailers, openTasks }
  }, [equipment, maintenanceTasks])

  const docsExpiring = expired + expiring
  const twoCol = isMobile ? '1fr' : '1fr 1fr'

  return (
    <TmsScrollPage
      title="Fleet Manager Dashboard"
      subtitle="Fleet health, maintenance & driver availability at a glance"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* KPI strip */}
        <TmsStatRow
          columns={5}
          items={[
            { label: 'Total Units',   value: String(stats.total),     icon: Truck,     onClick: canTrucks ? () => navigate('/trucks') : undefined },
            { label: 'Trucks',        value: String(stats.trucks),    icon: Truck,     onClick: canTrucks ? () => navigate('/trucks') : undefined },
            { label: 'Trailers',      value: String(stats.trailers),  icon: Container, onClick: canTrucks ? () => navigate('/trucks') : undefined },
            { label: 'Docs Expiring', value: String(docsExpiring),    icon: FileText,  tone: docsExpiring > 0 ? 'bad' : 'default', onClick: canTruckDocs ? () => navigate('/truck-docs') : undefined },
            { label: 'Open Tasks',    value: String(stats.openTasks), icon: Wrench,    tone: stats.openTasks > 0 ? 'warn' : 'default', onClick: canMaintenance ? () => navigate('/maintenance') : undefined },
          ]}
        />

        {/* DOT inspections due / overdue — trucks + trailers */}
        <DotDueWidget />

        {/* Miles until next PM — Ivan fleet, every 25k mi */}
        <PmDueWidget />

        {/* Open engine fault codes from the same Motive feed the PM tracker reads */}
        <FaultCodesWidget />

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
      {/* A PRO in the ELD widget opens the load, PODs and all. */}
      <LoadDrawer />
    </TmsScrollPage>
  )
}
