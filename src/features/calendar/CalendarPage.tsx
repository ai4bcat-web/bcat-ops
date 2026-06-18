import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useDriverAvailability } from '@/hooks/useDriverAvailability'
import { CalendarToolbar } from './CalendarToolbar'
import { PlannerView } from './PlannerView'
import { GridCalendarView } from './GridCalendarView'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { CalendarErrorBoundary } from './CalendarErrorBoundary'
import { DriverAvailabilityModal } from './DriverAvailabilityModal'
import { formatDateShort, getMondayOf, addDays } from '@/lib/date'
import { getStops } from '@/lib/stops'
import type { ViewMode, Load } from '@/types'

const VIEW_CONFIG: Record<ViewMode, { navDays: number }> = {
  'day':   { navDays: 1  }, // single current day
  'week':  { navDays: 7  }, // Monday-started week, weekends included
  'month': { navDays: -1 }, // month nav handled separately
}

const STATUS_LEGEND = [
  { label: 'Ready',       color: '#22c55e' },
  { label: 'In Progress', color: '#1ea8f3' },
  { label: 'Needs Action',color: '#f59e0b' },
]

export function CalendarPage() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const filters     = useAppStore((s) => s.filters)

  const { loads }   = useLoads()
  const { drivers } = useDrivers()
  const equipment   = useAppStore((s) => s.equipment)
  const { availabilities, createAvailability, deleteAvailability } = useDriverAvailability()

  const [showAvailModal, setShowAvailModal] = useState(false)

  const [currentView, setCurrentView] = useState<ViewMode>('day')
  const [startDate, setStartDate]     = useState<Date>(() => new Date())

  const { navDays } = VIEW_CONFIG[currentView]

  // Day/Week board columns (PlannerView): Day = the single current day; Week = Monday
  // through Sunday, weekends included. Month is rendered by GridCalendarView instead.
  const cols = useMemo<Date[]>(() => {
    if (currentView === 'day')  return [startDate]
    // Week = Monday through the following Monday inclusive (8 days, weekends included).
    if (currentView === 'week') return Array.from({ length: 8 }, (_, i) => addDays(startDate, i))
    return []
  }, [currentView, startDate])

  const dateLabel = useMemo(() => {
    if (currentView === 'month') {
      return startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }
    if (cols.length <= 1) return formatDateShort(startDate.toISOString())
    return `${formatDateShort(cols[0].toISOString())} – ${formatDateShort(cols[cols.length - 1].toISOString())}`
  }, [startDate, currentView, cols])

  const onPrev  = useCallback(() => {
    if (currentView === 'month') {
      setStartDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
    } else {
      setStartDate((d) => addDays(d, -navDays))
    }
  }, [currentView, navDays])

  const onNext  = useCallback(() => {
    if (currentView === 'month') {
      setStartDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
    } else {
      setStartDate((d) => addDays(d, navDays))
    }
  }, [currentView, navDays])

  const onToday = useCallback(() => {
    const today = new Date()
    if (currentView === 'month') setStartDate(new Date(today.getFullYear(), today.getMonth(), 1))
    else if (currentView === 'day') setStartDate(today)
    else setStartDate(getMondayOf(today))
  }, [currentView])

  const onViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view)
    const today = new Date()
    if (view === 'month') setStartDate(new Date(today.getFullYear(), today.getMonth(), 1))
    else if (view === 'day') setStartDate(today)
    else setStartDate(getMondayOf(today))
  }, [])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); useAppStore.getState().setSelectedLoad(null, 'create') }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); setStartDate((d) => addDays(d, -navDays)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setStartDate((d) => addDays(d, navDays))  }
      if (e.key === 'Escape')     { useAppStore.getState().setFilterDriver(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navDays])

  // ── Filter loads ──────────────────────────────────────────────────────────

  // Lookup maps so search can match driver names and truck unit numbers, not just ids.
  const driverNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of drivers) m.set(d.id, d.name)
    return m
  }, [drivers])
  const truckUnitById = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of equipment) if (e.unitNumber) m.set(e.id, e.unitNumber)
    return m
  }, [equipment])

  // Everything typed in the search box matches against ANY load detail (null-safe).
  const loadHaystack = useCallback((l: Load): string => {
    const parts: (string | null | undefined)[] = [
      l.aljexId, l.tmsId, l.pickupNumber, l.customer, l.notes,
      l.originName, l.originCity, l.destinationName, l.destinationCity,
      l.truckId ? truckUnitById.get(l.truckId) : null,
      l.pickupDriverId ? driverNameById.get(l.pickupDriverId) : null,
      l.deliveryDriverId ? driverNameById.get(l.deliveryDriverId) : null,
    ]
    for (const s of getStops(l)) {
      parts.push(s.name, s.city)
      if (s.driverId) parts.push(driverNameById.get(s.driverId))
    }
    return parts.filter(Boolean).join(' ').toLowerCase()
  }, [driverNameById, truckUnitById])

  const visibleLoads = loads.filter((l) => {
    if (filters.readyToInvoice && !l.readyToInvoice) return false
    if (filters.notReadyToInvoice && l.readyToInvoice) return false
    if (filters.split && l.pickupDriverId === l.deliveryDriverId) return false
    if (filters.unassigned && l.pickupDriverId !== null) return false
    if (filters.needsAppt && l.pickupApptType !== 'tbd' && l.deliveryApptType !== 'tbd') return false
    if (searchQuery.trim()) {
      const hay = loadHaystack(l)
      // Multi-word: every term must match somewhere (e.g. "ivan chicago").
      const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
      if (!terms.every((t) => hay.includes(t))) return false
    }
    return true
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Page header ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px', borderBottom: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)', flexShrink: 0, gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
            Calendar
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            {dateLabel} · BCAT freight movements
          </p>
        </div>

        {/* Status legend + availability button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {STATUS_LEGEND.map(({ label, color }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t3)' }}>
              <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
              {label}
            </span>
          ))}
          <button
            onClick={() => setShowAvailModal(true)}
            style={{ height: 30, padding: '0 12px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0 }}
          >
            Driver Availability
          </button>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <CalendarToolbar
        currentView={currentView}
        dateLabel={dateLabel}
        onPrev={onPrev}
        onNext={onNext}
        onToday={onToday}
        onViewChange={onViewChange}
      />

      {/* ── Planner ─────────────────────────────────────────────────────────── */}
      <div style={{
        flex: 1, overflow: 'hidden',
        margin: '12px 16px 16px',
        borderRadius: 12,
        border: '1px solid var(--ds-border)',
        boxShadow: 'var(--sh-sm)',
        background: 'var(--ds-surface)',
      }}>
        <CalendarErrorBoundary>
          {/* Mobile uses the SAME day/week/month views as desktop (they scroll
              horizontally on narrow screens) so it looks and populates identically. */}
          {currentView === 'day' ? (
            <PlannerView
              loads={visibleLoads}
              drivers={drivers}
              weekStart={startDate}
              days={cols}
              availabilities={availabilities}
            />
          ) : (
            <GridCalendarView
              loads={visibleLoads}
              drivers={drivers}
              startDate={startDate}
              viewMode={currentView}
              availabilities={availabilities}
            />
          )}
        </CalendarErrorBoundary>
      </div>

      <LoadDrawer />

      {showAvailModal && (
        <DriverAvailabilityModal
          drivers={drivers}
          availabilities={availabilities}
          onClose={() => setShowAvailModal(false)}
          onCreate={createAvailability}
          onDelete={deleteAvailability}
        />
      )}
    </div>
  )
}
