import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { CalendarToolbar } from './CalendarToolbar'
import { PlannerView } from './PlannerView'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { CalendarErrorBoundary } from './CalendarErrorBoundary'
import { formatDateShort, getMondayOf, addDays } from '@/lib/date'
import type { ViewMode } from '@/types'

const VIEW_CONFIG: Record<ViewMode, { numDays: number; navDays: number }> = {
  'planner':  { numDays: 7,  navDays: 7  },
  'day':      { numDays: 1,  navDays: 1  },
  'two-week': { numDays: 14, navDays: 14 },
}

export function CalendarPage() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const filters     = useAppStore((s) => s.filters)

  const { loads }   = useLoads()
  const { drivers } = useDrivers()

  const [currentView, setCurrentView] = useState<ViewMode>('planner')
  const [startDate, setStartDate]     = useState<Date>(() => getMondayOf(new Date()))

  const { numDays, navDays } = VIEW_CONFIG[currentView]

  const dateLabel = useMemo(() => {
    const end = addDays(startDate, numDays - 1)
    return numDays === 1
      ? formatDateShort(startDate.toISOString())
      : `${formatDateShort(startDate.toISOString())} – ${formatDateShort(end.toISOString())}`
  }, [startDate, numDays])

  const onPrev  = useCallback(() => setStartDate((d) => addDays(d, -navDays)), [navDays])
  const onNext  = useCallback(() => setStartDate((d) => addDays(d, navDays)),  [navDays])
  const onToday = useCallback(() => {
    const today = new Date()
    setStartDate(currentView === 'day' ? today : getMondayOf(today))
  }, [currentView])

  const onViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view)
    const today = new Date()
    // Reset to today's week (or today for day view) on view switch
    setStartDate(view === 'day' ? today : getMondayOf(today))
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
    <div className="flex flex-col h-full overflow-hidden">
      <CalendarToolbar
        currentView={currentView}
        dateLabel={dateLabel}
        onPrev={onPrev}
        onNext={onNext}
        onToday={onToday}
        onViewChange={onViewChange}
      />

      <div className="flex-1 overflow-hidden mx-4 mb-4 mt-3 rounded-xl border border-slate-200 shadow-sm">
        <CalendarErrorBoundary>
          <PlannerView
            loads={visibleLoads}
            drivers={drivers}
            weekStart={startDate}
            numDays={numDays}
          />
        </CalendarErrorBoundary>
      </div>

      <LoadDrawer />
    </div>
  )
}
