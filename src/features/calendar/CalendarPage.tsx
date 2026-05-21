import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { CalendarToolbar } from './CalendarToolbar'
import { PlannerView } from './PlannerView'
import { GridCalendarView } from './GridCalendarView'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { CalendarErrorBoundary } from './CalendarErrorBoundary'
import { formatDateShort, getMondayOf, addDays } from '@/lib/date'
import type { ViewMode } from '@/types'

const VIEW_CONFIG: Record<ViewMode, { numDays: number; navDays: number }> = {
  'planner':  { numDays: 7,  navDays: 7  },
  'day':      { numDays: 1,  navDays: 1  },
  'two-week': { numDays: 14, navDays: 14 },
  'month':    { numDays: -1, navDays: -1 }, // numDays computed dynamically
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

  const [currentView, setCurrentView] = useState<ViewMode>('two-week')
  const [startDate, setStartDate]     = useState<Date>(() => getMondayOf(new Date()))

  const { navDays } = VIEW_CONFIG[currentView]

  // For month view, numDays = days in the displayed month
  const numDays = useMemo(() => {
    if (currentView === 'month') {
      return new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate()
    }
    return VIEW_CONFIG[currentView].numDays
  }, [currentView, startDate])

  const dateLabel = useMemo(() => {
    if (currentView === 'month') {
      return startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }
    const end = addDays(startDate, numDays - 1)
    return numDays === 1
      ? formatDateShort(startDate.toISOString())
      : `${formatDateShort(startDate.toISOString())} – ${formatDateShort(end.toISOString())}`
  }, [startDate, numDays, currentView])

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

  const visibleLoads = loads.filter((l) => {
    if (filters.readyToInvoice && !l.readyToInvoice) return false
    if (filters.split && l.pickupDriverId === l.deliveryDriverId) return false
    if (filters.unassigned && l.pickupDriverId !== null) return false
    if (filters.needsAppt && l.pickupApptType !== 'tbd' && l.deliveryApptType !== 'tbd') return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !l.aljexId.toLowerCase().includes(q) &&
        !l.tmsId.toLowerCase().includes(q) &&
        !l.pickupNumber.toLowerCase().includes(q)
      ) return false
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

        {/* Status legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {STATUS_LEGEND.map(({ label, color }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t3)' }}>
              <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
              {label}
            </span>
          ))}
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
          {(currentView === 'two-week' || currentView === 'month') ? (
            <GridCalendarView
              loads={visibleLoads}
              drivers={drivers}
              startDate={startDate}
              viewMode={currentView}
            />
          ) : (
            <PlannerView
              loads={visibleLoads}
              drivers={drivers}
              weekStart={startDate}
              numDays={numDays}
            />
          )}
        </CalendarErrorBoundary>
      </div>

      <LoadDrawer />
    </div>
  )
}
