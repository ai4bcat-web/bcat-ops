import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads, useEnsureLoadRange } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useDriverAvailability } from '@/hooks/useDriverAvailability'
import { CalendarToolbar } from './CalendarToolbar'
import { PlannerView } from './PlannerView'
import { CapacityBoard } from './CapacityBoard'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useLoadReviewMarks } from './useLoadReviewMarks'
import { CalendarErrorBoundary } from './CalendarErrorBoundary'
import { CalendarPaperworkProvider } from './CalendarPaperwork'
import { DriverAvailabilityModal } from './DriverAvailabilityModal'
import { OwnFleetSwitchDialog } from './OwnFleetSwitchDialog'
import { MobileLoadAgenda } from './MobileLoadAgenda'
import { initialCalendarView, rememberPhoneView, type CalendarView } from './calendarView'
import { usePhoneWidth, PHONE_MAX_WIDTH } from '@/features/tms/grid/denseCardLayout'
import { formatDateShort, addDays } from '@/lib/date'
import { useAuth } from '@/hooks/useAuth'
import { isFleetProfilesOnly } from '@/lib/profileAccess'
import { addDaysYmd, defaultCapacityRange, daysBetweenYmd, todayChicagoYmd } from '@/lib/capacityBoard'
import { buildLoadHaystack, loadMatchesQuery } from '@/lib/loadSearch'
import {
  defaultVisibleDriverIds, loadVisibleForDrivers,
  readStoredDriverIds, writeStoredDriverIds, DRIVER_FILTER_KEYS,
} from '@/lib/driverFilter'
import type { Load } from '@/types'

const CAPACITY_LEGEND = [
  { label: 'Open truck', color: 'var(--tms-badge-orange)' },
  { label: 'Covered',    color: 'var(--tms-badge-green)' },
]

const STATUS_LEGEND = [
  { label: 'Ready',       color: 'var(--tms-primary)' },
  { label: 'In Progress', color: 'var(--tms-primary)' },
  { label: 'Needs Action',color: 'var(--tms-badge-orange)' },
]

/** Local calendar day as 'YYYY-MM-DD' (the board navigates in the system timezone). */
function ymd(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function CalendarPage() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const filters     = useAppStore((s) => s.filters)

  const navigate = useNavigate()
  const { loads: rawLoads } = useLoads()
  // Green = the shipment is in Load Review (or released), straight from the Shipments page's state.
  const loads = useLoadReviewMarks(rawLoads)
  const { drivers } = useDrivers()
  const equipment   = useAppStore((s) => s.equipment)
  const { availabilities, refresh: refreshAvailability, createAvailability, deleteAvailability } = useDriverAvailability()

  const [showAvailModal, setShowAvailModal] = useState(false)

  /**
   * null means "nothing chosen", which is NOT the same as "chosen nothing" — the default
   * is derived below rather than written into state, so an empty selection can only ever
   * be something a person asked for.
   */
  const [chosenDriverIds, setChosenDriverIds] = useState<string[] | null>(() => readStoredDriverIds(DRIVER_FILTER_KEYS.calendar))

  const phone = usePhoneWidth()
  const [currentView, setCurrentView] = useState<CalendarView>(() =>
    initialCalendarView(typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches))
  const [startDate, setStartDate]     = useState<Date>(() => new Date())
  // The Capacity board's range: today through Sunday to start, then whatever the office picks (at most two weeks).
  const [capRange, setCapRange] = useState(() => defaultCapacityRange(todayChicagoYmd()))
  const auth = useAuth()
  // Someone limited to the fleet profiles does not get the Capacity tab: it carries the rates the office is asking for.
  const capacityAllowed = !isFleetProfilesOnly(auth.user?.email, auth.user?.groups)

  const setVisibleDrivers = useCallback((ids: string[]) => {
    setChosenDriverIds(ids)
    writeStoredDriverIds(DRIVER_FILTER_KEYS.calendar, ids)
  }, [])

  /** The selection in force: whatever was chosen, else Ivan's own drivers. */
  const visibleDriverIdSet = useMemo(
    () => new Set(chosenDriverIds ?? defaultVisibleDriverIds(drivers)),
    [chosenDriverIds, drivers],
  )

  /**
   * Until the roster arrives there is no way to tell an Ivan driver from an
   * owner-operator, so nothing is filtered by driver and the board never flashes empty
   * on the way in.
   */
  const rosterReady = drivers.length > 0

  // A phone that last used Capacity, or a saved view, only counts while the person may have it.
  const view: CalendarView = currentView === 'capacity' && !capacityAllowed ? 'day' : currentView
  const capacityDays = daysBetweenYmd(capRange.from, capRange.to) + 1

  // The Day board's one column (PlannerView). The Capacity board lays out its own days.
  const cols = useMemo<Date[]>(() => [startDate], [startDate])
  const phoneDays = cols

  // The days the board shows; the store windows these (±1 month) in and the poll refreshes only them.
  const visibleFrom = ymd(cols[0])
  const visibleTo   = ymd(cols[cols.length - 1])
  useEnsureLoadRange(visibleFrom, visibleTo)

  const dateLabel = useMemo(() => {
    if (view === 'capacity') {
      const short = (day: string) => formatDateShort(new Date(`${day}T12:00:00Z`).toISOString())
      return capRange.from === capRange.to ? short(capRange.from) : `${short(capRange.from)} – ${short(capRange.to)}`
    }
    return formatDateShort(startDate.toISOString())
  }, [startDate, view, capRange])

  // Previous / Next: a day on the Day board; on Capacity, the range's own length (today through Sunday steps a week-ish at a time).
  const step = useCallback((dir: 1 | -1) => {
    if (view === 'capacity') {
      setCapRange((r) => ({ from: addDaysYmd(r.from, dir * capacityDays), to: addDaysYmd(r.to, dir * capacityDays) }))
    } else {
      setStartDate((d) => addDays(d, dir))
    }
  }, [view, capacityDays])
  const onPrev  = useCallback(() => step(-1), [step])
  const onNext  = useCallback(() => step(1), [step])

  const onToday = useCallback(() => {
    if (view === 'capacity') setCapRange(defaultCapacityRange(todayChicagoYmd()))
    else setStartDate(new Date())
  }, [view])

  const onViewChange = useCallback((next: CalendarView) => {
    setCurrentView(next)
    if (phone) rememberPhoneView(next)
    if (next === 'capacity') setCapRange(defaultCapacityRange(todayChicagoYmd()))
    else setStartDate(new Date())
  }, [phone])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigate('/tms/shipments/new') }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1)  }
      if (e.key === 'Escape')     { useAppStore.getState().setFilterDriver(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [step, navigate])

  // ── Periodic refresh ────────────────────────────────────────────────────────
  // Real-time subscriptions keep clients in sync, but a periodic refetch of the visible window is a
  // safety net so every open calendar converges on the current server state even if a
  // subscription event was missed (sleep/wake, dropped socket, etc.). Pauses while the
  // tab is hidden and does an immediate catch-up refresh when it becomes visible again.
  useEffect(() => {
    const REFRESH_MS = 60_000
    const refreshAll = () => { void useAppStore.getState().refreshCalendarData({ from: visibleFrom, to: visibleTo }); void refreshAvailability() }
    let timer = window.setInterval(refreshAll, REFRESH_MS)
    const onVisibility = () => {
      window.clearInterval(timer)
      if (document.visibilityState === 'visible') {
        refreshAll()
        timer = window.setInterval(refreshAll, REFRESH_MS)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [refreshAvailability, visibleFrom, visibleTo])

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
  const loadHaystack = useCallback(
    (l: Load): string => buildLoadHaystack(l, { driverName: (id) => driverNameById.get(id), truckUnit: (id) => truckUnitById.get(id) }),
    [driverNameById, truckUnitById],
  )

  const visibleLoads = loads.filter((l) => {
    if (rosterReady && !loadVisibleForDrivers(l, visibleDriverIdSet)) return false
    if (filters.readyToInvoice && !l.readyToInvoice) return false
    if (filters.notReadyToInvoice && l.readyToInvoice) return false
    if (filters.split && l.pickupDriverId === l.deliveryDriverId) return false
    if (filters.unassigned && l.pickupDriverId !== null) return false
    if (filters.waitingDetention && !l.detentionFlag) return false
    if (filters.waitingTonu && !l.tonuFlag) return false
    if (filters.needsAppt && l.pickupApptType !== 'tbd' && l.deliveryApptType !== 'tbd') return false
    if (searchQuery.trim() && !loadMatchesQuery(loadHaystack(l), searchQuery)) return false
    return true
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Page header ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: phone ? '10px 12px' : '14px 24px', borderBottom: '1px solid var(--tms-border)',
        background: 'var(--tms-card)', flexShrink: 0, gap: phone ? 8 : 16, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--tms-text)', margin: 0 }}>
            Calendar
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--tms-muted)', marginTop: 2 }}>
            {dateLabel} · {view === 'capacity' ? 'Trucks to fill' : 'BCAT freight movements'}
          </p>
        </div>

        {/* Status legend + availability button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: phone ? 10 : 16, ...(phone ? { flexWrap: 'wrap' as const, rowGap: 6 } : {}) }}>
          {(view === 'capacity' ? CAPACITY_LEGEND : STATUS_LEGEND).map(({ label, color }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-muted)' }}>
              <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
              {label}
            </span>
          ))}
          <button
            onClick={() => setShowAvailModal(true)}
            style={{ height: phone ? 40 : 30, padding: '0 12px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text-2)', fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0 }}
          >
            Driver Availability
          </button>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <CalendarToolbar
        currentView={view}
        dateLabel={dateLabel}
        onPrev={onPrev}
        onNext={onNext}
        onToday={onToday}
        onViewChange={onViewChange}
        drivers={drivers}
        visibleDriverIds={visibleDriverIdSet}
        onVisibleDriversChange={setVisibleDrivers}
        phone={phone}
        capacityEnabled={capacityAllowed}
      />

      {/* ── Planner ─────────────────────────────────────────────────────────── */}
      <div style={{
        flex: 1, overflow: 'hidden',
        margin: phone ? '8px' : '12px 16px 16px',
        borderRadius: phone ? 10 : 12,
        border: '1px solid var(--tms-border)',
        boxShadow: 'var(--tms-shadow)',
        background: 'var(--tms-card)',
      }}>
        <CalendarErrorBoundary>
          {/* The Capacity board is its own calendar: one column per day of trucks to fill. A phone's Day is a card list per day;
              a desktop's is the board. */}
          {view === 'capacity' ? (
            <CapacityBoard
              from={capRange.from}
              to={capRange.to}
              onRangeChange={(from, to) => setCapRange({ from, to })}
              drivers={drivers}
              phone={phone}
              userEmail={auth.user?.email ?? 'dispatch'}
            />
          ) : (
          <CalendarPaperworkProvider loads={visibleLoads}>
          {phone ? (
            <MobileLoadAgenda loads={visibleLoads} drivers={drivers} days={phoneDays} />
          ) : (
            <PlannerView
              loads={visibleLoads}
              drivers={drivers}
              weekStart={startDate}
              days={cols}
              availabilities={availabilities}
            />
          )}
          </CalendarPaperworkProvider>
          )}
        </CalendarErrorBoundary>
      </div>

      <LoadDrawer />

      {/*
        Every "+" on this page — the toolbar button, the day columns, the 'n' key and the
        scheduler's drag-create — raises this form. It writes nothing until Save, which is
        the point: a shipment number is permanent and can only be voided.
      */}
      <OwnFleetSwitchDialog />

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
