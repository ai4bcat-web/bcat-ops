import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import FullCalendar from '@fullcalendar/react'
import resourceTimelinePlugin from '@fullcalendar/resource-timeline'
import interactionPlugin from '@fullcalendar/interaction'
import type { EventContentArg, EventDropArg, EventClickArg, DatesSetArg } from '@fullcalendar/core'
import type { EventResizeDoneArg as EventResizeArg } from '@fullcalendar/interaction'
import { toast } from 'sonner'
import { UserCheck, Trash2, Copy, X } from 'lucide-react'
import { useLoads } from '@/hooks/useLoads'
import { useAppStore } from '@/store/useAppStore'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { EventCard } from './EventCard'
import type { Load, Driver, ViewMode } from '@/types'
import { formatTime } from '@/lib/date'
import { formatPhone } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'

// ── Constants ─────────────────────────────────────────────────────────────────

const LICENSE = import.meta.env.VITE_FULLCALENDAR_LICENSE ?? 'GPL-My-Project-Is-Open-Source'

const FC_VIEWS: Record<ViewMode, string> = {
  'day':      'resourceTimelineDay',
  'week':     'resourceTimelineWorkWeek',
  'compact':  'resourceTimelineDay',   // SchedulerView is never shown in compact mode; fallback only
  'planner':  'resourceTimelineDay',   // SchedulerView is never shown in planner mode; fallback only
  'two-week': 'resourceTimeline2Weeks',
  'month':    'resourceTimelineMonth',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shiftDays(isoUtc: string, days: number): string {
  const d = new Date(isoUtc)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SchedulerViewProps {
  calendarRef: React.RefObject<FullCalendar | null>
  loads: Load[]
  drivers: Driver[]
  conflictIds: Set<string>
  filterDriverId: string | null
  viewMode: ViewMode
  weekStart: string
  onDatesSet: (info: DatesSetArg) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SchedulerView({
  calendarRef, loads, drivers, conflictIds, filterDriverId, viewMode, weekStart, onDatesSet,
}: SchedulerViewProps) {
  const { updateLoad, addLoad, deleteLoad } = useLoads()
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const dragModifierRef = useRef<'none' | 'shift' | 'alt'>('none')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; load: Load
  } | null>(null)
  const contextMenuTriggerRef = useRef<HTMLDivElement>(null)

  // ── Modifier + snap tracking ──────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      dragModifierRef.current = e.shiftKey ? 'shift' : e.altKey ? 'alt' : 'none'
      const api = calendarRef.current?.getApi()
      if (!api) return
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey)) {
        api.setOption('snapDuration', '01:00:00')
      } else if (e.type === 'keyup' && !e.metaKey && !e.ctrlKey) {
        api.setOption('snapDuration', { days: 1 })
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  }, [calendarRef])

  // ── Resources (driver rows) ───────────────────────────────────────────────

  const resources = useMemo(() => {
    const active = [...drivers]
      .filter((d) => d.active)
      .sort((a, b) => {
        if ((a.type === 'broker') !== (b.type === 'broker')) return a.type === 'broker' ? 1 : -1
        return a.name.localeCompare(b.name)
      })
    const filtered = filterDriverId
      ? active.filter((d) => d.id === filterDriverId)
      : active
    return [
      { id: 'unassigned', title: 'Unassigned', sortOrder: -1, extendedProps: { isUnassigned: true, driver: null } },
      ...filtered.map((d, i) => ({
        id: d.id, title: d.name, sortOrder: i,
        extendedProps: { isUnassigned: false, driver: d },
      })),
    ]
  }, [drivers, filterDriverId])

  // ── Events (load blocks) ──────────────────────────────────────────────────

  const events = useMemo(() => {
    return loads.map((load) => ({
      id: load.id,
      resourceId: load.pickupDriverId ?? 'unassigned',
      start: load.pickupAppt,
      end: load.deliveryAppt,
      editable: true,
      extendedProps: { load },
    }))
  }, [loads])

  // ── Load order map (sequence # per driver per day) ───────────────────────

  const loadOrderMap = useMemo(() => {
    const map = new Map<string, number>()
    const groups = new Map<string, Load[]>()
    loads.forEach((l) => {
      const date = l.pickupAppt.slice(0, 10)
      const key = `${l.pickupDriverId ?? 'unassigned'}-${date}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(l)
    })
    groups.forEach((group) => {
      group
        .sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
        .forEach((l, i) => map.set(l.id, i + 1))
    })
    return map
  }, [loads])

  // ── Event content renderer ────────────────────────────────────────────────

  const renderEventContent = useCallback((info: EventContentArg) => {
    const load = info.event.extendedProps.load as Load
    const driver = drivers.find((d) => d.id === load.pickupDriverId)
    const color = driver?.colorKey ? getColor(driver.colorKey) : UNASSIGNED_COLOR
    return (
      <EventCard
        load={load}
        drivers={drivers}
        color={color}
        isConflict={conflictIds.has(load.id)}
        isSelected={selectedIds.has(load.id)}
        orderNumber={loadOrderMap.get(load.id) ?? 1}
        onEdit={() => setSelectedLoad(load.id, 'edit')}
        onContextMenu={(e) => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, load })
        }}
      />
    )
  }, [drivers, conflictIds, selectedIds, loadOrderMap])

  // ── Resource label renderer ───────────────────────────────────────────────

  const renderResourceLabel = useCallback((info: { resource: { id: string; extendedProps: Record<string, unknown> } }) => {
    const { driver, isUnassigned } = info.resource.extendedProps as {
      driver: Driver | null; isUnassigned: boolean
    }
    const resourceId = info.resource.id
    const loadCount = loads.filter((l) =>
      l.pickupDriverId === (isUnassigned ? null : resourceId)
    ).length

    if (isUnassigned) {
      return (
        <div className="flex items-center gap-2.5 px-3 py-2.5 w-full h-full">
          <div className="size-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: 'rgba(251,191,36,0.2)', border: '1px solid rgba(251,191,36,0.4)' }}>
            <span className="text-sm font-bold" style={{ color: '#fbbf24' }}>?</span>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: '#fbbf24' }}>Unassigned</div>
            <div className="text-xs" style={{ color: '#94a3b8' }}>{loadCount} load{loadCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      )
    }

    if (!driver) return null
    const color = driver.colorKey ? getColor(driver.colorKey) : UNASSIGNED_COLOR
    const initials = driver.name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()
    const isBroker = driver.type === 'broker'

    return (
      <button
        className="flex items-center gap-2.5 px-3 py-2.5 w-full h-full text-left transition-colors"
        style={{ background: 'transparent' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(74,142,239,0.06)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        onClick={() => useAppStore.getState().setFilterDriver(
          useAppStore.getState().filterDriverId === driver.id ? null : driver.id
        )}
      >
        <div
          className="size-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
          style={{ backgroundColor: color.avatarBg, color: color.border, border: `1px solid ${color.border}` }}
        >
          {initials}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate text-white" title={driver.name}>{driver.name}</div>
          <div className="text-xs" style={{ color: '#94a3b8' }}>
            {isBroker ? (
              <span className="font-medium uppercase tracking-wide text-[10px]" style={{ color: '#64748b' }}>Broker · {loadCount} load{loadCount !== 1 ? 's' : ''}</span>
            ) : (
              <span>{formatPhone(driver.phone)} · {loadCount}</span>
            )}
          </div>
        </div>
      </button>
    )
  }, [loads])

  // ── Drag / drop ───────────────────────────────────────────────────────────

  const handleEventDrop = useCallback((info: EventDropArg) => {
    const load = info.event.extendedProps.load as Load
    const modifier = dragModifierRef.current
    const infoAny = info as unknown as { newResource?: { id: string } }
    const newDriverId = infoAny.newResource
      ? (infoAny.newResource.id === 'unassigned' ? null : infoAny.newResource.id)
      : load.pickupDriverId
    const deltaDays = Math.round(info.delta.milliseconds / 86_400_000)
    const snapshot = { ...load }
    const patch: Partial<Omit<Load, 'id' | 'createdAt'>> = {}

    if (modifier === 'shift') {
      patch.pickupDriverId = newDriverId
    } else if (modifier === 'alt') {
      patch.deliveryDriverId = newDriverId
    } else {
      patch.pickupDriverId = newDriverId
      patch.deliveryDriverId = newDriverId
      if (deltaDays !== 0) {
        patch.pickupAppt = shiftDays(load.pickupAppt, deltaDays)
        patch.deliveryAppt = shiftDays(load.deliveryAppt, deltaDays)
      }
    }

    updateLoad(load.id, patch)
    const dest = drivers.find((d) => d.id === newDriverId)?.name ?? 'Unassigned'
    const label = modifier === 'shift' ? 'Pickup driver updated'
      : modifier === 'alt' ? 'Delivery driver updated' : 'Load reassigned'
    toast(label, {
      description: `${load.aljexId} → ${dest}`,
      action: { label: 'Undo', onClick: () => updateLoad(load.id, snapshot) },
      duration: 5000,
    })
  }, [drivers, updateLoad])

  // ── Resize ────────────────────────────────────────────────────────────────

  const handleEventResize = useCallback((info: EventResizeArg) => {
    const load = info.event.extendedProps.load as Load
    const snapshot = { ...load }
    const newEnd = info.event.end?.toISOString() ?? load.deliveryAppt
    updateLoad(load.id, { deliveryAppt: newEnd })
    toast('Delivery time updated', {
      description: `${load.aljexId} → ${formatTime(newEnd)}`,
      action: { label: 'Undo', onClick: () => updateLoad(load.id, snapshot) },
      duration: 5000,
    })
  }, [updateLoad])

  // ── Click ─────────────────────────────────────────────────────────────────

  const handleEventClick = useCallback((info: EventClickArg) => {
    const load = info.event.extendedProps.load as Load
    if (info.jsEvent.metaKey || info.jsEvent.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(load.id)) { next.delete(load.id) } else { next.add(load.id) }
        return next
      })
    } else {
      setSelectedIds(new Set())
      setSelectedLoad(load.id, 'view')
    }
  }, [setSelectedLoad])

  // ── Slot label renderer (+ button on each day column) ────────────────────

  const renderSlotLabel = useCallback((info: { level: number; date: Date; text: string }) => {
    const plusBtn = (dateStr: string) => (
      <button
        style={{
          width: '18px', height: '18px', borderRadius: '4px', border: '1px solid rgba(74,142,239,0.4)',
          background: 'rgba(74,142,239,0.12)', color: '#5b9bff', display: 'flex',
          alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          fontSize: '14px', lineHeight: 1, padding: 0,
        }}
        onClick={(e) => { e.stopPropagation(); setSelectedLoad(null, 'create', { driverId: null, dateStr }) }}
        title={`Add load for ${dateStr}`}
      >+</button>
    )

    if (viewMode === 'day') {
      // Day view has single-level hour slots — show hour text + "+"
      const dateStr = info.date.toISOString().slice(0, 10)
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '0 4px', gap: '4px' }}>
          <span style={{ fontSize: '11px' }}>{info.text}</span>
          {plusBtn(dateStr)}
        </div>
      )
    }

    // Multi-day views: level 0 = weekday name (no button), level 1 = date (show button)
    if (info.level !== 1) return <span>{info.text}</span>
    const dateStr = info.date.toISOString().slice(0, 10)
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '0 4px', gap: '4px' }}>
        <span style={{ fontSize: '11px' }}>{info.text}</span>
        {plusBtn(dateStr)}
      </div>
    )
  }, [viewMode, setSelectedLoad])

  // ── Date click (add load) ─────────────────────────────────────────────────

  const handleDateClick = useCallback((info: { resource?: { id: string }; dateStr: string }) => {
    const driverId = info.resource
      ? (info.resource.id === 'unassigned' ? null : info.resource.id)
      : null
    const dateStr = info.dateStr.slice(0, 10)
    setSelectedLoad(null, 'create', { driverId, dateStr })
  }, [setSelectedLoad])

  // ── Bulk actions ──────────────────────────────────────────────────────────

  const selectedLoads = loads.filter((l) => selectedIds.has(l.id))

  const bulkMarkRTI = () => {
    selectedLoads.forEach((l) => updateLoad(l.id, { readyToInvoice: true }))
    toast(`${selectedLoads.length} load(s) marked Ready to Invoice`)
    setSelectedIds(new Set())
  }

  const bulkDelete = () => {
    if (!confirm(`Delete ${selectedLoads.length} load(s)?`)) return
    selectedLoads.forEach((l) => deleteLoad(l.id))
    toast(`${selectedLoads.length} load(s) deleted`)
    setSelectedIds(new Set())
  }

  // ── Context menu actions ──────────────────────────────────────────────────

  const ctxLoad = contextMenu?.load

  const ctxMarkRTI = () => {
    if (!ctxLoad) return
    updateLoad(ctxLoad.id, { readyToInvoice: !ctxLoad.readyToInvoice })
    toast(ctxLoad.readyToInvoice ? 'Marked not ready' : 'Marked ready to invoice')
    setContextMenu(null)
  }

  const ctxDuplicate = () => {
    if (!ctxLoad) return
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = ctxLoad
    addLoad({ ...rest, aljexId: `${rest.aljexId}-copy` })
    toast(`Duplicated ${ctxLoad.aljexId}`)
    setContextMenu(null)
  }

  const ctxDelete = () => {
    if (!ctxLoad) return
    if (!confirm(`Delete ${ctxLoad.aljexId}?`)) return
    deleteLoad(ctxLoad.id)
    toast(`Deleted ${ctxLoad.aljexId}`)
    setContextMenu(null)
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    setTimeout(() => window.addEventListener('click', close), 0)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex-1 overflow-hidden h-full">
      <FullCalendar
        ref={calendarRef}
        schedulerLicenseKey={LICENSE}
        plugins={[resourceTimelinePlugin, interactionPlugin]}
        initialView={FC_VIEWS[viewMode]}
        initialDate={weekStart}
        headerToolbar={false}
        firstDay={1}
        timeZone="America/Chicago"
        height="100%"
        resourceAreaWidth="240px"
        resourceOrder="sortOrder"
        resourceAreaHeaderContent="Driver"
        resources={resources}
        events={events}
        editable
        droppable
        eventResizableFromStart={false}
        eventOverlap
        nowIndicator
        snapDuration={{ days: 1 }}
        slotDuration={{ days: 1 }}
        slotLabelFormat={[
          { weekday: 'short' },
          { day: 'numeric', month: 'short' },
        ]}
        views={{
          resourceTimelineWorkWeek: {
            type: 'resourceTimeline',
            duration: { weeks: 1 },
            hiddenDays: [0, 6],
            slotDuration: { days: 1 },
          },
          resourceTimeline2Weeks: {
            type: 'resourceTimeline',
            duration: { weeks: 2 },
            slotDuration: { days: 1 },
          },
          resourceTimelineDay: {
            slotDuration: '01:00:00',
            slotLabelFormat: [{ hour: 'numeric', meridiem: 'short' }],
            snapDuration: '01:00:00',
            scrollTime: '06:00:00',
          },
        }}
        resourceLabelContent={renderResourceLabel as never}
        slotLabelContent={renderSlotLabel as never}
        eventContent={renderEventContent}
        eventDrop={handleEventDrop}
        eventResize={handleEventResize}
        eventClick={handleEventClick}
        dateClick={handleDateClick as never}
        datesSet={onDatesSet}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          ref={contextMenuTriggerRef}
        >
          <DropdownMenu open onOpenChange={(open) => !open && setContextMenu(null)}>
            <DropdownMenuTrigger asChild>
              <div className="size-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={() => { setSelectedLoad(ctxLoad!.id, 'edit'); setContextMenu(null) }}>
                Edit load
              </DropdownMenuItem>

              {/* Assign Pickup Driver submenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Assign Pickup Driver</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44 max-h-64 overflow-y-auto">
                  <DropdownMenuItem
                    onClick={() => { updateLoad(ctxLoad!.id, { pickupDriverId: null, deliveryDriverId: null }); setContextMenu(null) }}
                  >
                    Unassigned
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {drivers.filter((d) => d.active).map((d) => (
                    <DropdownMenuItem
                      key={d.id}
                      onClick={() => { updateLoad(ctxLoad!.id, { pickupDriverId: d.id, deliveryDriverId: d.id }); setContextMenu(null) }}
                    >
                      {d.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem onClick={ctxMarkRTI}>
                {ctxLoad?.readyToInvoice ? 'Mark not ready' : 'Mark ready to invoice'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ctxDuplicate}>
                <Copy className="size-3.5 mr-2" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={ctxDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-slate-900 text-white rounded-full px-4 py-2.5 shadow-2xl text-sm">
          <span className="font-semibold">{selectedIds.size} selected</span>
          <div className="w-px h-4 bg-slate-600 mx-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-white hover:bg-slate-700 hover:text-white text-xs gap-1"
            onClick={bulkMarkRTI}
          >
            <UserCheck className="size-3.5" /> Mark RTI
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-red-400 hover:bg-red-900/40 hover:text-red-300 text-xs gap-1"
            onClick={bulkDelete}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
          <button
            className="ml-1 text-slate-400 hover:text-white"
            onClick={() => setSelectedIds(new Set())}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}
