/**
 * PlannerView — dense spreadsheet-style weekly view
 *
 * Editable per row:
 *   • Color   — small swatch → palette popover → saves load.colorKey to DB
 *   • Slot    — numbered badge → 1-5 picker → saves load.daySlot to DB
 *   • Driver  — driver cell → search popover → saves load.pickupDriverId to DB
 *   • Order   — drag handle → reorders rows within day (local session state)
 */

import { useState, useRef, useCallback, useMemo } from 'react'
import { GripVertical, X } from 'lucide-react'
import { addDays, formatDayHeader, formatTime, formatDateShort } from '@/lib/date'
import { getColor, UNASSIGNED_COLOR, COLOR_MAP } from '@/lib/driverColors'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { cn } from '@/lib/utils'
import type { Load, Driver, ColorKey } from '@/types'

// ── Column widths ─────────────────────────────────────────────────────────────
const COL = { slot: 22, color: 20, aljex: 60, tms: 60, pu: 72, puAppt: 72, deAppt: 72, driver: 96 } as const
const ROW_H = 28

// ── Color palette entries ─────────────────────────────────────────────────────
const PALETTE: { key: ColorKey; hex: string }[] = (
  Object.entries(COLOR_MAP) as [ColorKey, { border: string }][]
).map(([key, v]) => ({ key, hex: v.border }))

// ── Chicago date string ───────────────────────────────────────────────────────
function chicagoDateStr(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso)).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

// ── Appt cell ─────────────────────────────────────────────────────────────────
function ApptCell({ iso, type, colorCls }: { iso?: string; type?: string; colorCls: string }) {
  const w = COL.puAppt
  if (!iso) return <div className="px-1.5 text-[11px] text-slate-300" style={{ width: w }}>—</div>
  const isSpecial = type === 'fcfs' || type === 'tbd'
  return (
    <div className={`flex flex-col justify-center px-1.5 leading-tight ${colorCls}`} style={{ width: w }}>
      <span className="text-[10px] text-slate-400 truncate">{formatDateShort(iso)}</span>
      <span className="text-[11px] font-medium truncate">
        {isSpecial ? type!.toUpperCase() : formatTime(iso)}
      </span>
    </div>
  )
}

// ── Color picker popover ──────────────────────────────────────────────────────
function ColorPicker({ loadId, current, onClose }: { loadId: string; current?: ColorKey | null; onClose: () => void }) {
  const { updateLoad } = useLoads()
  const pick = async (key: ColorKey | null) => {
    await updateLoad(loadId, { colorKey: key })
    onClose()
  }
  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 p-2 rounded-lg border border-slate-200 bg-white shadow-xl flex flex-wrap gap-1.5"
      style={{ width: 160 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Clear option */}
      <button
        className="size-5 rounded-full border-2 border-slate-200 flex items-center justify-center hover:bg-slate-100"
        title="No color"
        onClick={() => pick(null)}
      >
        <X className="size-2.5 text-slate-400" />
      </button>
      {PALETTE.map(({ key, hex }) => (
        <button
          key={key}
          className={cn('size-5 rounded-full transition-transform hover:scale-110', key === current && 'ring-2 ring-offset-1 ring-slate-400')}
          style={{ background: hex }}
          title={key}
          onClick={() => pick(key)}
        />
      ))}
    </div>
  )
}

// ── Driver picker popover ─────────────────────────────────────────────────────
function DriverPicker({ loadId, currentId, drivers, onClose }: {
  loadId: string; currentId: string | null; drivers: Driver[]; onClose: () => void
}) {
  const { updateLoad } = useLoads()
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = drivers.filter((d) => d.active && d.name.toLowerCase().includes(query.toLowerCase()))

  const pick = useCallback(async (driverId: string | null) => {
    setSaving(true)
    try { await updateLoad(loadId, { pickupDriverId: driverId }) } finally { setSaving(false) }
    onClose()
  }, [updateLoad, loadId, onClose])

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
              className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50', d.id === currentId && 'font-semibold')}
              onClick={() => pick(d.id)}
              disabled={saving}
            >
              <span className="size-2 rounded-full shrink-0" style={{ background: c.border }} />
              {d.name}
            </button>
          )
        })}
        {filtered.length === 0 && <div className="px-3 py-2 text-[11px] text-slate-400">No drivers found</div>}
      </div>
    </div>
  )
}

// ── Planner row ───────────────────────────────────────────────────────────────
interface PlannerRowProps {
  load:        Load
  drivers:     Driver[]
  dragging:    boolean
  dragOver:    boolean
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDragEnd:   () => void
}

function PlannerRow({ load, drivers, dragging, dragOver, onDragStart, onDragEnter, onDragEnd }: PlannerRowProps) {
  const { updateLoad } = useLoads()
  const [showColor,  setShowColor]  = useState(false)
  const [showSlot,   setShowSlot]   = useState(false)
  const [showDriver, setShowDriver] = useState(false)

  const color      = load.colorKey ? getColor(load.colorKey) : UNASSIGNED_COLOR
  const puDriver   = drivers.find((d) => d.id === load.pickupDriverId)
  const deDriver   = drivers.find((d) => d.id === load.deliveryDriverId)
  const isSplit    = load.pickupDriverId !== load.deliveryDriverId && !!load.deliveryDriverId
  const driverName = isSplit
    ? `${puDriver?.name ?? '—'} / ${deDriver?.name ?? '—'}`
    : (puDriver?.name ?? '—')

  const slotNum = load.daySlot ?? null

  const closeOnBlur = (fn: () => void) => () => setTimeout(fn, 150)

  return (
    <div
      className={cn(
        'group flex items-center border-b border-slate-100 transition-colors',
        dragging && 'opacity-40',
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

      {/* ── Slot badge ───────────────────────────────────────────────────── */}
      <div
        className="relative flex items-center justify-center shrink-0"
        style={{ width: COL.slot }}
        tabIndex={0}
        onFocus={() => setShowSlot(true)}
        onBlur={closeOnBlur(() => setShowSlot(false))}
      >
        <span
          className="text-[9px] font-black rounded-full flex items-center justify-center cursor-pointer hover:opacity-75 leading-none"
          style={{ background: color.border, color: '#fff', minWidth: 14, minHeight: 14, padding: '0 2px' }}
        >
          {slotNum ?? '·'}
        </span>
        {showSlot && (
          <div
            className="absolute z-50 top-full left-0 mt-0.5 flex gap-1 p-1.5 rounded-lg border border-slate-200 bg-white shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className="size-5 text-[10px] font-black rounded-full flex items-center justify-center hover:opacity-80"
                style={{ background: n === slotNum ? color.border : '#94a3b8', color: '#fff' }}
                onClick={() => { updateLoad(load.id, { daySlot: n }); setShowSlot(false) }}
              >
                {n}
              </button>
            ))}
            <button
              className="size-5 text-[10px] font-black rounded-full flex items-center justify-center hover:opacity-80 bg-slate-200"
              title="Clear"
              onClick={() => { updateLoad(load.id, { daySlot: null }); setShowSlot(false) }}
            >
              <X className="size-2.5 text-slate-500" />
            </button>
          </div>
        )}
      </div>

      {/* ── Color swatch ─────────────────────────────────────────────────── */}
      <div
        className="relative flex items-center justify-center shrink-0"
        style={{ width: COL.color }}
        tabIndex={0}
        onFocus={() => setShowColor(true)}
        onBlur={closeOnBlur(() => setShowColor(false))}
      >
        <span
          className="size-3 rounded-full cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-slate-300 transition-all"
          style={{ background: color.border }}
        />
        {showColor && (
          <ColorPicker
            loadId={load.id}
            current={load.colorKey}
            onClose={() => setShowColor(false)}
          />
        )}
      </div>

      {/* ── Drag handle ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-center w-4 shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing">
        <GripVertical className="size-3 text-slate-400" />
      </div>

      {/* ── Data cells ───────────────────────────────────────────────────── */}
      <Cell width={COL.aljex} bold onClick={() => useAppStore.getState().setSelectedLoad(load.id, 'edit')}>
        {load.aljexId || '—'}
      </Cell>
      <Cell width={COL.tms}>{load.tmsId || '—'}</Cell>
      <Cell width={COL.pu}>{load.pickupNumber || '—'}</Cell>

      <ApptCell iso={load.pickupAppt}   type={load.pickupApptType}   colorCls="text-blue-600" />
      <ApptCell iso={load.deliveryAppt} type={load.deliveryApptType} colorCls="text-violet-600" />

      <Cell flex className="text-slate-500">
        {[load.originCity, load.destinationCity].filter(Boolean).join(' → ') || '—'}
      </Cell>

      {/* Driver — editable */}
      <div
        className="relative shrink-0 flex items-center"
        style={{ width: COL.driver }}
        tabIndex={0}
        onFocus={() => setShowDriver(true)}
        onBlur={closeOnBlur(() => setShowDriver(false))}
      >
        <div className={cn(
          'w-full h-full flex items-center px-1.5 text-[11px] font-medium text-slate-800 truncate cursor-pointer rounded hover:bg-black/5',
          showDriver && 'ring-1 ring-blue-400 bg-blue-50',
        )}>
          {driverName}
        </div>
        {showDriver && (
          <DriverPicker
            loadId={load.id}
            currentId={load.pickupDriverId}
            drivers={drivers}
            onClose={() => setShowDriver(false)}
          />
        )}
      </div>
    </div>
  )
}

// ── Cell helper ───────────────────────────────────────────────────────────────
function Cell({ children, width, flex, bold, className, onClick }: {
  children: React.ReactNode; width?: number; flex?: boolean
  bold?: boolean; className?: string; onClick?: () => void
}) {
  return (
    <div
      className={cn('px-1.5 text-[11px] truncate', bold ? 'font-medium text-slate-800' : 'text-slate-600', onClick && 'cursor-pointer hover:underline', className)}
      style={flex ? { flex: 1 } : { width }}
      onClick={onClick}
    >
      {children}
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

// ── Main view ─────────────────────────────────────────────────────────────────
interface PlannerViewProps {
  loads:     Load[]
  drivers:   Driver[]
  weekStart: Date
}

export function PlannerView({ loads, drivers, weekStart }: PlannerViewProps) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  // Group loads by pickup date
  const loadsByDay = useMemo(() => {
    const map = new Map<string, Load[]>()
    for (const l of loads) {
      const d = chicagoDateStr(l.pickupAppt)
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push(l)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
    }
    return map
  }, [loads])

  // Per-day local order override (drag-to-reorder, session only)
  const [dayOrder, setDayOrder] = useState<Map<string, string[]>>(new Map())
  const dragId = useRef<string | null>(null)
  const dragDay = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const handleDragStart = useCallback((day: string, id: string) => {
    dragId.current = id; dragDay.current = day
  }, [])

  const handleDragEnter = useCallback((day: string, id: string) => {
    if (dragId.current === id || dragDay.current !== day) return
    setDragOverId(id)
    setDayOrder((prev) => {
      const base  = loadsByDay.get(day) ?? []
      const order = prev.get(day) ?? base.map((l) => l.id)
      const from  = order.indexOf(dragId.current!)
      const to    = order.indexOf(id)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...order]; next.splice(from, 1); next.splice(to, 0, dragId.current!)
      return new Map(prev).set(day, next)
    })
  }, [loadsByDay])

  const handleDragEnd = useCallback(() => {
    dragId.current = null; dragDay.current = null; setDragOverId(null)
  }, [])

  function orderedLoads(day: string): Load[] {
    const base  = loadsByDay.get(day) ?? []
    const order = dayOrder.get(day)
    if (!order) return base
    const byId = new Map(base.map((l) => [l.id, l]))
    return order.map((id) => byId.get(id)).filter(Boolean) as Load[]
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-slate-50 select-none">

      {/* Sticky column header */}
      <div
        className="flex items-center border-b-2 border-slate-300 bg-white sticky top-0 z-20 shrink-0"
        style={{ height: ROW_H, paddingLeft: 3 + COL.slot + COL.color + 16 }}
      >
        <ColHeader width={COL.aljex}>#</ColHeader>
        <ColHeader width={COL.tms}>TMS</ColHeader>
        <ColHeader width={COL.pu}>PU #</ColHeader>
        <ColHeader width={COL.puAppt}>PU Appt</ColHeader>
        <ColHeader width={COL.deAppt}>DE Appt</ColHeader>
        <ColHeader flex>Route</ColHeader>
        <ColHeader width={COL.driver}>Driver</ColHeader>
      </div>

      {/* Day sections */}
      {days.map((day, di) => {
        const dayStr = chicagoDateStr(day.toISOString())
        const { weekday, date } = formatDayHeader(day.toISOString())
        const rows = orderedLoads(dayStr)

        return (
          <div key={di} className="border-b border-slate-200 shrink-0">
            <div
              className="flex items-center gap-2 px-2 bg-slate-100 border-b border-slate-200 sticky z-10"
              style={{ top: ROW_H, height: 22 }}
            >
              <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">{weekday}</span>
              <span className="text-[11px] text-slate-500">{date}</span>
              {rows.length > 0 && (
                <span className="text-[10px] text-slate-400">· {rows.length} load{rows.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {rows.length === 0 ? (
              <div className="flex items-center px-6 text-[11px] text-slate-300 italic" style={{ height: ROW_H }}>
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
