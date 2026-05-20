import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import FullCalendar from '@fullcalendar/react'
import type { DatesSetArg } from '@fullcalendar/core'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useConflictDetection } from '@/hooks/useConflictDetection'
import { CalendarToolbar } from './CalendarToolbar'
import { SchedulerView } from './SchedulerView'
import { PlannerView } from './PlannerView'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { CalendarErrorBoundary } from './CalendarErrorBoundary'
import { formatDateShort, getMondayOf, addDays } from '@/lib/date'
import type { ViewMode } from '@/types'

type FCViewMode = Exclude<ViewMode, 'planner'>

const FC_VIEW_NAMES: Record<FCViewMode, string> = {
  'day':      'resourceTimelineDay',
  'week':     'resourceTimelineWorkWeek',
  'two-week': 'resourceTimeline2Weeks',
}

export function CalendarPage() {
  const weekStart = useAppStore((s) => s.weekStart)
  const viewMode = useAppStore((s) => s.viewMode)
  const filterDriverId = useAppStore((s) => s.filterDriverId)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const filters = useAppStore((s) => s.filters)

  const { loads } = useLoads()
  const { drivers } = useDrivers()

  const calendarRef = useRef<FullCalendar>(null)

  // Local state for toolbar — FC is the source of truth for dates/view after init
  const [currentView, setCurrentView] = useState<ViewMode>('planner')
  const [dateLabel, setDateLabel] = useState('')

  // Compact view has its own week state (not driven by FullCalendar)
  const [compactWeek, setCompactWeek] = useState<Date>(() => getMondayOf(new Date()))

  const compactDateLabel = useMemo(() => {
    const end = addDays(compactWeek, 6)
    return `${formatDateShort(compactWeek.toISOString())} – ${formatDateShort(end.toISOString())}`
  }, [compactWeek])

  const isCustomView = currentView === 'planner'
  const effectiveDateLabel = isCustomView ? compactDateLabel : dateLabel

  // ── Calendar API helpers ──────────────────────────────────────────────────

  const getApi = useCallback(() => calendarRef.current?.getApi(), [])

  const onPrev = useCallback(() => {
    if (isCustomView) setCompactWeek((w) => addDays(w, -7))
    else getApi()?.prev()
  }, [isCustomView, getApi])

  const onNext = useCallback(() => {
    if (isCustomView) setCompactWeek((w) => addDays(w, 7))
    else getApi()?.next()
  }, [isCustomView, getApi])

  const onToday = useCallback(() => {
    if (isCustomView) setCompactWeek(getMondayOf(new Date()))
    else getApi()?.today()
  }, [isCustomView, getApi])

  const onViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view)
    if (view !== 'planner') {
      getApi()?.changeView(FC_VIEW_NAMES[view as FCViewMode])
    }
  }, [getApi])

  const onDatesSet = useCallback((info: DatesSetArg) => {
    const start = info.start
    const end = new Date(info.end)
    end.setDate(end.getDate() - 1) // FC's end is exclusive
    const label = start.toDateString() === end.toDateString()
      ? formatDateShort(start.toISOString())
      : `${formatDateShort(start.toISOString())} – ${formatDateShort(end.toISOString())}`
    setDateLabel(label)
  }, [])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        useAppStore.getState().setSelectedLoad(null, 'create')
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); getApi()?.prev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); getApi()?.next() }
      if (e.key === 'Escape') { useAppStore.getState().setFilterDriver(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [getApi])

  // ── Filter loads ──────────────────────────────────────────────────────────

  const visibleLoads = loads.filter((l) => {
    if (filters.readyToInvoice && !l.readyToInvoice) return false
    if (filters.split && l.pickupDriverId === l.deliveryDriverId) return false
    if (filters.unassigned && l.pickupDriverId !== null) return false
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

  const conflictIds = useConflictDetection(visibleLoads, drivers)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <CalendarToolbar
        currentView={currentView}
        dateLabel={effectiveDateLabel}
        onPrev={onPrev}
        onNext={onNext}
        onToday={onToday}
        onViewChange={onViewChange}
      />

      <div className="flex-1 overflow-hidden mx-4 mb-4 mt-3 rounded-xl border border-slate-200 shadow-sm">
        <CalendarErrorBoundary>
          {currentView === 'planner' ? (
            <PlannerView loads={visibleLoads} drivers={drivers} weekStart={compactWeek} />
          ) : (
            <SchedulerView
              calendarRef={calendarRef}
              loads={visibleLoads}
              drivers={drivers}
              conflictIds={conflictIds}
              filterDriverId={filterDriverId}
              viewMode={viewMode}
              weekStart={weekStart}
              onDatesSet={onDatesSet}
            />
          )}
        </CalendarErrorBoundary>
      </div>

      <LoadDrawer />
    </div>
  )
}
