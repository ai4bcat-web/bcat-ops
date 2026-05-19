/**
 * PlannerView — dense spreadsheet-style weekly view
 *
 * Editable cells:
 *   • Driver   — click → popover picker, saves to DB via updateLoad
 *   • Order    — drag handle on left, reorders rows within the day (local state)
 */

import { useState, useRef, useCallback, useMemo } from 'react'
import { GripVertical, X } from 'lucide-react'
import { addDays, formatDayHeader, formatTime, formatDateShort } from '@/lib/date'
import { getColor } from '@/lib/driverColors'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/utils'
import type { Load, Driver } from '@/types'

// ── Column widths ─────────────────────────────────────────────────────────────
const COL = { aljex: 60, tms: 60, pu: 72, puAppt: 72, deAppt: 72, driver: 96 } as const
const ROW_H = 28

// ── Chicago date string ───────────────────────────────────────────────────────
function chicagoDateStr(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso)).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

// ── Appt display ──────────────────────────────────────────────────────────────
function ApptCell({ iso, type, color }: { iso?: string; type?: string; color: string }) {
  if (!iso) return <div className="px-1.5 text-[11px] text-slate-300" style={{ width: COL.puAppt }}>—</div>
  const isSpecial = type === 'fcfs' || type === 'tbd'
  return (
    <div className={`flex flex-col justify-center px-1.5 leading-tight ${color}`} style={{ width: COL.puAppt }}>
      <span className="text-[10px] text-slate-400 truncate">{formatDateShort(iso)}</span>
      <span className="text-[11px] font-medium truncate">
        {isSpecial ? type!.toUpperCase() : formatTime(iso)}
      </span>
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface PlannerViewProps {
  loads:   Load[]
  drivers: Driver[]
  weekStart: Date
}

// ── Driver picker popover ─────────────────────────────────────────────────────
interface DriverPickerProps {
  loadId:    string
  field:     'pickupDriverId' | 'deliveryDriverId'
  currentId: string | null
  drivers:   Driver[]
  onClose:   () => void
}

function DriverPicker({ loadId, field, currentId, drivers, onClose }: DriverPickerProps) {
  const updateLoad = useAppStore((s) => s.updateLoad)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = drivers.filter((d) =>
    d.active && d.name.toLowerCase().includes(query.toLowerCase()),
  )

  const pick = useCallback(async (driverId: string | null) => {
    setSaving(true)
    try { await updateLoad(loadId, { [field]: driverId }) } finally { setSaving(false) }
    onClose()
  }, [updateLoad, loadId, field, onClose])

  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 w-52 rounded-lg border border-slate-200 bg-white shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="p-2 border-b border-slate-100">
        <input
          autoFocus
          type="text"
          placeholder="Search driver…"
          className="w-full h-7 px-2 text-[12px] rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        <button
          className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-slate-400 hover:bg-slate-50"
          onClick={() => pick(null)}
        >
          <X className="size-3" /> Unassigned
        </button>
        {filtered.map((d) => {
          const c = getColor(d.colorKey)
          return (
            <button
              key={d.id}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50',
                d.id === currentId && 'font-semibold',
              )}
              onClick={() => pick(d.id)}
              disabled={saving}
            >
              <span className="size-2 rounded-full shrink-0" style={{ background: c.border }} />
              {d.name}
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-slate-400">No drivers found</div>
        )}
      </div>
    </div>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────
interface PlannerRowProps {
  load:         Load
  drivers:      Driver[]
  dragging:     boolean
  dragOver:     boolean
  onDragStart:  (id: string) => void
  onDragEnter:  (id: string) => void
  onDragEnd:    () => void
}

function PlannerRow({
  load, drivers, dragging, dragOver, onDragStart, onDragEnter, onDragEnd,
}: PlannerRowProps) {
  const [pickerField, setPickerField] = useState<'pickupDriverId' | 'deliveryDriverId' | null>(null)

  const puDriver  = drivers.find((d) => d.id === load.pickupDriverId)
  const deDriver  = drivers.find((d) => d.id === load.deliveryDriverId)
  const isSplit   = load.pickupDriverId !== load.deliveryDriverId && load.deliveryDriverId
  const driverDisplay = isSplit
    ? `${puDriver?.name ?? '—'} / ${deDriver?.name ?? '—'}`
    : (puDriver?.name ?? '—')

  // Color from pickup driver
  const color = getColor(puDriver?.colorKey)

  const closePickerOnBlur = useCallback(() => {
    setTimeout(() => setPickerField(null), 150)
  }, [])

  return (
    <div
      className={cn(
        'group flex items-center border-b border-slate-100 transition-colors cursor-default',
        dragging  && 'opacity-40',
        dragOver  && 'ring-1 ring-inset ring-blue-400 bg-blue-50',
        !dragOver && !dragging && 'hover:bg-white',
      )}
      style={{ height: ROW_H, borderLeft: `3px solid ${color.border}`, background: dragOver ? undefined : color.bg }}
      draggable
      onDragStart={() => onDragStart(load.id)}
      onDragEnter={() => onDragEnter(load.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Drag handle */}
      <div className="flex items-center justify-center w-5 shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing">
        <GripVertical className="size-3 text-slate-400" />
      </div>

      {/* ALJEX */}
      <Cell width={COL.aljex - 20} bold onClick={() => useAppStore.getState().setSelectedLoad(load.id, 'edit')}>
        {load.aljexId || '—'}
      </Cell>

      {/* TMS */}
      <Cell width={COL.tms}>{load.tmsId || '—'}</Cell>

      {/* PU # */}
      <Cell width={COL.pu}>{load.pickupNumber || '—'}</Cell>

      {/* PU Appt */}
      <ApptCell iso={load.pickupAppt} type={load.pickupApptType} color="text-blue-600" />

      {/* DE Appt */}
      <ApptCell iso={load.deliveryAppt} type={load.deliveryApptType} color="text-violet-600" />

      {/* Route */}
      <Cell flex className="text-slate-500">
        {[load.originCity, load.destinationCity].filter(Boolean).join(' → ') || '—'}
      </Cell>

      {/* Driver — editable */}
      <div
        className="relative shrink-0 flex items-center"
        style={{ width: COL.driver }}
        tabIndex={0}
        onFocus={() => setPickerField('pickupDriverId')}
        onBlur={closePickerOnBlur}
      >
        <div
          className={cn(
            'w-full h-full flex items-center px-1.5 text-[11px] font-medium text-slate-800 truncate cursor-pointer rounded hover:bg-black/5',
            pickerField && 'ring-1 ring-blue-400 bg-blue-50',
          )}
        >
          {driverDisplay}
        </div>
        {pickerField && (
          <DriverPicker
            loadId={load.id}
            field={pickerField}
            currentId={load.pickupDriverId}
            drivers={drivers}
            onClose={() => setPickerField(null)}
          />
        )}
      </div>
    </div>
  )
}

// ── Cell helper ───────────────────────────────────────────────────────────────
function Cell({
  children, width, flex, bold, color, className, onClick,
}: {
  children: React.ReactNode
  width?: number
  flex?: boolean
  bold?: boolean
  color?: string
  className?: string
  onClick?: () => void
}) {
  return (
    <div
      className={cn(
        'px-1.5 text-[11px] truncate',
        bold      ? 'font-medium text-slate-800' : 'text-slate-600',
        color,
        onClick   && 'cursor-pointer hover:underline',
        className,
      )}
      style={flex ? { flex: 1 } : { width }}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function PlannerView({ loads, drivers, weekStart }: PlannerViewProps) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  )

  // Group loads by pickup date (Chicago tz)
  const loadsByDay = useMemo(() => {
    const map = new Map<string, Load[]>()
    for (const l of loads) {
      const d = chicagoDateStr(l.pickupAppt)
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push(l)
    }
    // Sort each day by pickupAppt time
    for (const arr of map.values()) {
      arr.sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
    }
    return map
  }, [loads])

  // Per-day local order override (drag-to-reorder)
  const [dayOrder, setDayOrder] = useState<Map<string, string[]>>(new Map())

  // Drag state
  const dragId  = useRef<string | null>(null)
  const dayKey  = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const handleDragStart = useCallback((day: string, id: string) => {
    dragId.current = id
    dayKey.current = day
  }, [])

  const handleDragEnter = useCallback((day: string, id: string) => {
    if (dragId.current === id || dayKey.current !== day) return
    setDragOverId(id)
    setDayOrder((prev) => {
      const baseLoads = loadsByDay.get(day) ?? []
      const existing  = prev.get(day) ?? baseLoads.map((l) => l.id)
      const from = existing.indexOf(dragId.current!)
      const to   = existing.indexOf(id)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...existing]
      next.splice(from, 1)
      next.splice(to, 0, dragId.current!)
      return new Map(prev).set(day, next)
    })
  }, [loadsByDay])

  const handleDragEnd = useCallback(() => {
    dragId.current = null
    dayKey.current = null
    setDragOverId(null)
  }, [])

  function orderedLoads(day: string): Load[] {
    const base  = loadsByDay.get(day) ?? []
    const order = dayOrder.get(day)
    if (!order) return base
    const byId  = new Map(base.map((l) => [l.id, l]))
    return order.map((id) => byId.get(id)).filter(Boolean) as Load[]
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-slate-50 select-none">

      {/* ── Sticky column header ─────────────────────────────────────────── */}
      <div
        className="flex items-center border-b-2 border-slate-300 bg-white sticky top-0 z-20 shrink-0"
        style={{ height: ROW_H, paddingLeft: 23 /* drag handle + border */ }}
      >
        <ColHeader width={COL.aljex - 20}>ALJEX</ColHeader>
        <ColHeader width={COL.tms}>TMS</ColHeader>
        <ColHeader width={COL.pu}>PU #</ColHeader>
        <ColHeader width={COL.puAppt}>PU Appt</ColHeader>
        <ColHeader width={COL.deAppt}>DE Appt</ColHeader>
        <ColHeader flex>Route</ColHeader>
        <ColHeader width={COL.driver}>Driver</ColHeader>
      </div>

      {/* ── Day sections ─────────────────────────────────────────────────── */}
      {days.map((day, di) => {
        const dayStr = chicagoDateStr(day.toISOString())
        const { weekday, date } = formatDayHeader(day.toISOString())
        const rows = orderedLoads(dayStr)

        return (
          <div key={di} className="border-b border-slate-200 shrink-0">

            {/* Day header */}
            <div
              className="flex items-center gap-2 px-2 bg-slate-100 border-b border-slate-200 sticky z-10"
              style={{ top: ROW_H, height: 22 }}
            >
              <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                {weekday}
              </span>
              <span className="text-[11px] text-slate-500">{date}</span>
              {rows.length > 0 && (
                <span className="text-[10px] text-slate-400">
                  · {rows.length} load{rows.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Rows */}
            {rows.length === 0 ? (
              <div
                className="flex items-center px-6 text-[11px] text-slate-300 italic"
                style={{ height: ROW_H }}
              >
                No loads
              </div>
            ) : (
              rows.map((load) => (
                <PlannerRow
                  key={load.id}
                  load={load}
                  drivers={drivers}
                  dragging={dragId.current === load.id}
                  dragOver={dragOverId === load.id}
                  onDragStart={(id) => handleDragStart(dayStr, id)}
                  onDragEnter={(id) => handleDragEnter(dayStr, id)}
                  onDragEnd={handleDragEnd}
                />
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ColHeader ─────────────────────────────────────────────────────────────────
function ColHeader({ children, width, flex }: { children: React.ReactNode; width?: number; flex?: boolean }) {
  return (
    <div
      className="px-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide truncate"
      style={flex ? { flex: 1 } : { width }}
    >
      {children}
    </div>
  )
}
