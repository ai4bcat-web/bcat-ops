/**
 * PlannerView — dense spreadsheet-style weekly view
 *
 * Multi-day loads appear on BOTH their pickup and delivery day:
 *   Pickup day  : PU Appt = real time,  DE Appt = "Yard",  Route = Origin → Yard
 *   Delivery day: PU Appt = "Yard",     DE Appt = real time, Route = Yard → Destination
 *
 * Column widths are computed dynamically from the widest value in each column
 * across all visible loads, with per-column min/max bounds.
 */

import { useState, useRef, useCallback, useMemo } from 'react'
import { GripVertical, X, Plus, Pencil, CheckCircle, Circle } from 'lucide-react'
import { addDays, formatDayHeader, formatTime, formatDateShort } from '@/lib/date'
import { getColor, UNASSIGNED_COLOR, COLOR_MAP } from '@/lib/driverColors'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { cn } from '@/lib/utils'
import type { Load, Driver, ColorKey, ApptType } from '@/types'

// ── Fixed-size UI elements ────────────────────────────────────────────────────
const ROW_H       = 28
const DRAG_W      = 16
const COLOR_W     = 20
const RTI_W       = 32

// ── Dynamic column sizing ─────────────────────────────────────────────────────
// Approx px per character at text-[11px] sans-serif + column padding
const CHAR_W = 7.0
const PAD    = 14   // px-1.5 each side = 12 + 2 buffer

const MIN_COL = { aljex: 52, tms: 56, pu: 52, loc: 120, route: 100, appt: 110, driver: 90, notes: 60, rate: 52 } as const
const MAX_COL = { aljex: 120, tms: 150, pu: 120, loc: 300, route: 320, appt: 155, driver: 200, notes: 260, rate: 92 } as const

type ColKey = keyof typeof MIN_COL

function clamp(n: number, key: ColKey) {
  return Math.min(MAX_COL[key], Math.max(MIN_COL[key], Math.ceil(n)))
}

export interface ColWidths {
  aljex: number; tms: number; pu: number; loc: number
  route: number; appt: number; driver: number; notes: number; rate: number
}

// ── Color palette (all non-broker colors available) ──────────────────────────
const PALETTE: { key: ColorKey; hex: string }[] = (
  Object.entries(COLOR_MAP) as [ColorKey, { border: string }][]
).filter(([key]) => key !== 'broker')
 .map(([key, v]) => ({ key, hex: v.border }))

// ── Day entry type ────────────────────────────────────────────────────────────
type Role = 'pickup' | 'delivery' | 'same-day'

interface DayEntry {
  load: Load
  role: Role
  /** Stable key for ordering/dragging: `${loadId}:${role}` */
  key:  string
}

// ── Chicago date string ───────────────────────────────────────────────────────
function chicagoDateStr(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

// ── Appt cell (date + time stacked) ──────────────────────────────────────────
function ApptCell({ iso, type, colorCls, yard, city, width }: {
  iso?: string; type?: string; colorCls: string; yard?: boolean; city?: string; width: number
}) {
  if (yard) {
    return (
      <div className="flex items-center px-1.5 gap-1 leading-tight text-slate-400" style={{ width }}>
        <span className="text-[11px] font-medium shrink-0">Yard</span>
        {city && <span className="text-[10px] italic truncate">{city}</span>}
      </div>
    )
  }

  if (!iso) return <div className="px-1.5 text-[11px] text-slate-300" style={{ width }}>—</div>

  const isSpecial = type === 'fcfs' || type === 'tbd'
  const specialLabel = type === 'tbd' ? 'NEED' : type!.toUpperCase()
  return (
    <div className={`flex flex-col justify-center px-1.5 leading-tight ${colorCls}`} style={{ width }}>
      <span className="text-[10px] text-slate-400 truncate">{formatDateShort(iso)}</span>
      <span className="text-[11px] font-medium truncate">
        {isSpecial ? specialLabel : formatTime(iso)}
      </span>
    </div>
  )
}

// ── Color picker popover ──────────────────────────────────────────────────────
function ColorPicker({ loadId, current, onClose }: { loadId: string; current?: ColorKey | null; onClose: () => void }) {
  const { updateLoad } = useLoads()
  const pick = async (key: ColorKey | null) => { await updateLoad(loadId, { colorKey: key }); onClose() }
  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 p-2 rounded-lg border border-slate-200 bg-white shadow-xl flex flex-wrap gap-1.5"
      style={{ width: 160 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
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
  const [query, setQuery]   = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = drivers.filter((d) => d.active && d.name.toLowerCase().includes(query.toLowerCase()))

  const pick = useCallback(async (driverId: string | null) => {
    setSaving(true)
    try { await updateLoad(loadId, { pickupDriverId: driverId, deliveryDriverId: driverId }) } finally { setSaving(false) }
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
              disabled={saving}
              className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50', d.id === currentId && 'font-semibold')}
              onClick={() => pick(d.id)}
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

// ── Editable text cell (TMS, PU#) ────────────────────────────────────────────
function EditableTextCell({ load, field, width, dimmed }: {
  load: Load; field: 'tmsId' | 'pickupNumber'; width: number; dimmed?: boolean
}) {
  const { updateLoad } = useLoads()
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState('')
  const current               = load[field]

  const commit = () => {
    const trimmed = val.trim()
    updateLoad(load.id, { [field]: trimmed || null })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="shrink-0 flex items-center px-1" style={{ width }}>
        <input
          autoFocus
          type="text"
          className="w-full h-5 px-1 text-[11px] rounded border border-blue-400 focus:outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    )
  }

  return (
    <div
      className={cn('group/cell shrink-0 flex items-center gap-0.5 px-1.5 cursor-pointer hover:bg-black/5 rounded', dimmed ? 'text-slate-300' : 'text-slate-600')}
      style={{ width }}
      onClick={() => { setVal(current ?? ''); setEditing(true) }}
    >
      <span className="text-[11px] truncate flex-1">{dimmed ? '↳' : (current || '—')}</span>
      {!dimmed && <Pencil className="size-2 text-slate-300 opacity-0 group-hover/cell:opacity-100 shrink-0" />}
    </div>
  )
}

// ── Appt edit popover ─────────────────────────────────────────────────────────
function ApptEditPopover({ load, apptField, typeField, onClose }: {
  load: Load
  apptField: 'pickupAppt' | 'deliveryAppt'
  typeField: 'pickupApptType' | 'deliveryApptType'
  onClose: () => void
}) {
  const { updateLoad } = useLoads()

  const toInputVal = (iso: string | undefined | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const [dateVal, setDateVal] = useState(toInputVal(load[apptField]))
  const [typeVal, setTypeVal] = useState<ApptType>(load[typeField] ?? 'exact')
  const [saving,  setSaving]  = useState(false)

  const commit = async () => {
    setSaving(true)
    const patch: Partial<Load> = { [typeField]: typeVal }
    if (dateVal) patch[apptField] = new Date(dateVal).toISOString()
    try { await updateLoad(load.id, patch) } finally { setSaving(false) }
    onClose()
  }

  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 p-2.5 rounded-lg border border-slate-200 bg-white shadow-xl flex flex-col gap-2"
      style={{ width: 215 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        type="datetime-local"
        className="w-full h-7 px-2 text-[11px] rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
        value={dateVal}
        onChange={(e) => setDateVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
      />
      <select
        className="w-full h-7 px-2 text-[11px] rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
        value={typeVal}
        onChange={(e) => setTypeVal(e.target.value as ApptType)}
      >
        <option value="exact">Exact Time</option>
        <option value="fcfs">FCFS</option>
        <option value="tbd">NEED (TBD)</option>
      </select>
      <div className="flex gap-1.5">
        <button
          disabled={saving}
          className="flex-1 h-6 text-[11px] font-medium rounded bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
          onClick={commit}
        >Save</button>
        <button
          className="flex-1 h-6 text-[11px] rounded border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
          onClick={onClose}
        >Cancel</button>
      </div>
    </div>
  )
}

// ── Notes cell (inline edit) ──────────────────────────────────────────────────
function NotesCell({ load, width }: { load: Load; width: number }) {
  const { updateLoad } = useLoads()
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState('')

  const commit = () => {
    updateLoad(load.id, { notes: val.trim() || null })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="shrink-0 flex items-center px-1" style={{ width }}>
        <input
          autoFocus
          type="text"
          className="w-full h-5 px-1 text-[11px] rounded border border-blue-400 focus:outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    )
  }

  return (
    <div
      className="group/notes shrink-0 flex items-center gap-0.5 px-1.5 cursor-pointer hover:bg-black/5 rounded"
      style={{ width }}
      onClick={() => { setVal(load.notes ?? ''); setEditing(true) }}
    >
      <span className="text-[11px] text-slate-500 truncate flex-1 italic">{load.notes || ''}</span>
      <Pencil className="size-2 text-slate-300 opacity-0 group-hover/notes:opacity-100 shrink-0" />
    </div>
  )
}

// ── Rate cell (inline edit) ───────────────────────────────────────────────────
function RateCell({ load, width }: { load: Load; width: number }) {
  const { updateLoad } = useLoads()
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')

  const display = load.rate != null
    ? `$${(load.rate / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '—'

  const commit = () => {
    const dollars = parseFloat(val.replace(/[^0-9.]/g, ''))
    if (!isNaN(dollars) && dollars >= 0) updateLoad(load.id, { rate: Math.round(dollars * 100) })
    else if (val.trim() === '') updateLoad(load.id, { rate: null })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="shrink-0 flex items-center px-1" style={{ width }}>
        <input
          autoFocus
          type="text"
          className="w-full h-5 px-1 text-[11px] rounded border border-blue-400 focus:outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    )
  }

  return (
    <div
      className="shrink-0 flex items-center px-1.5 text-[11px] cursor-pointer hover:bg-black/5 rounded truncate"
      style={{ width, color: load.rate ? '#15803d' : '#2563eb' }}
      onClick={() => { setVal(load.rate != null ? String(load.rate / 100) : ''); setEditing(true) }}
    >
      {load.rate != null ? display : <span className="underline underline-offset-2">Add Rate</span>}
    </div>
  )
}

// ── Planner row ───────────────────────────────────────────────────────────────
interface PlannerRowProps {
  entry:       DayEntry
  drivers:     Driver[]
  colW:        ColWidths
  slotNum:     number
  dragging:    boolean
  dragOver:    boolean
  onDragStart: (key: string) => void
  onDragEnter: (key: string) => void
  onDragEnd:   () => void
}

function PlannerRow({ entry, drivers, colW, slotNum, dragging, dragOver, onDragStart, onDragEnter, onDragEnd }: PlannerRowProps) {
  const { load, role } = entry
  const { updateLoad } = useLoads()
  const [showColor,   setShowColor]   = useState(false)
  const [showDriver,  setShowDriver]  = useState(false)
  const [editingAppt, setEditingAppt] = useState<'pu' | 'de' | null>(null)

  const color    = load.colorKey ? getColor(load.colorKey) : UNASSIGNED_COLOR
  const puDriver   = drivers.find((d) => d.id === load.pickupDriverId)
  const driverName = puDriver?.name ?? '—'
  const isDeliveryDay = role === 'delivery'
  const isFinalDest   = role !== 'pickup'

  const route = (() => {
    if (role === 'pickup')   return [load.originCity, 'Yard'].filter(Boolean).join(' → ') || '—'
    if (role === 'delivery') return ['Yard', load.destinationCity].filter(Boolean).join(' → ') || '—'
    return [load.originCity, load.destinationCity].filter(Boolean).join(' → ') || '—'
  })()

  const closeOnBlur = (fn: () => void) => (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setTimeout(fn, 150)
  }

  return (
    <div
      className={cn(
        'group flex items-center border-b border-slate-100 transition-colors',
        dragging && 'opacity-40',
        dragOver && 'ring-1 ring-inset ring-blue-400',
      )}
      style={{
        height: ROW_H,
        background: load.readyToInvoice
          ? dragOver ? '#16a34a' : '#22c55e'
          : dragOver
            ? `${color.border}44`
            : `${color.border}${isDeliveryDay ? '18' : '30'}`,
        borderLeft: load.readyToInvoice
          ? '3px solid #15803d'
          : `3px solid ${color.border}${isDeliveryDay ? '80' : 'ff'}`,
      }}
      draggable
      onDragStart={() => onDragStart(entry.key)}
      onDragEnter={() => onDragEnter(entry.key)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Drag handle */}
      <div className="flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing" style={{ width: DRAG_W }}>
        <GripVertical className="size-3 text-slate-400" />
      </div>

      {/* Color swatch */}
      <div
        className="relative flex items-center justify-center shrink-0"
        style={{ width: COLOR_W }}
        tabIndex={0}
        onClick={() => setShowColor((v) => !v)}
        onBlur={(e) => closeOnBlur(() => setShowColor(false))(e)}
      >
        <span
          className="size-3 rounded-full transition-all cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-slate-300"
          style={{ background: color.border }}
        />
        {showColor && (
          <ColorPicker loadId={load.id} current={load.colorKey} onClose={() => setShowColor(false)} />
        )}
      </div>

      {/* Pro # */}
      <Cell width={colW.aljex} bold onClick={() => useAppStore.getState().setSelectedLoad(load.id, 'edit')}>
        {load.aljexId || '—'}
      </Cell>

      {/* TMS + PU# */}
      <EditableTextCell load={load} field="tmsId"        width={colW.tms} dimmed={isDeliveryDay} />
      <EditableTextCell load={load} field="pickupNumber" width={colW.pu}  dimmed={isDeliveryDay} />

      {/* PU / DE location names */}
      <div className="shrink-0 flex flex-col justify-center px-1.5 leading-tight" style={{ width: colW.loc }}>
        {load.originName && (
          <span className="text-[10px] text-slate-500 truncate" title={load.originName}>{load.originName}</span>
        )}
        {load.destinationName && (
          <span className="text-[10px] text-slate-400 truncate" title={load.destinationName}>{load.destinationName}</span>
        )}
      </div>

      {/* Route */}
      <Cell width={colW.route} bold={isFinalDest} className={isFinalDest ? 'text-slate-800' : 'text-slate-500'}>{route}</Cell>

      {/* PU Appt */}
      <div className="relative group/appt shrink-0">
        <ApptCell
          iso={load.pickupAppt}
          type={load.pickupApptType}
          colorCls="text-blue-600"
          yard={isDeliveryDay}
          city={isDeliveryDay ? load.destinationCity : undefined}
          width={colW.appt}
        />
        <button
          className="absolute top-0.5 right-0.5 size-3.5 flex items-center justify-center rounded opacity-0 group-hover/appt:opacity-100 hover:bg-black/10 text-slate-400 transition-opacity"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setEditingAppt('pu') }}
        >
          <Pencil className="size-2" />
        </button>
        {editingAppt === 'pu' && (
          <ApptEditPopover load={load} apptField="pickupAppt" typeField="pickupApptType" onClose={() => setEditingAppt(null)} />
        )}
      </div>

      {/* DE Appt */}
      <div className="relative group/appt shrink-0">
        <ApptCell
          iso={load.deliveryAppt}
          type={load.deliveryApptType}
          colorCls="text-violet-600"
          yard={role === 'pickup'}
          city={role === 'pickup' ? load.destinationCity : undefined}
          width={colW.appt}
        />
        <button
          className="absolute top-0.5 right-0.5 size-3.5 flex items-center justify-center rounded opacity-0 group-hover/appt:opacity-100 hover:bg-black/10 text-slate-400 transition-opacity"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setEditingAppt('de') }}
        >
          <Pencil className="size-2" />
        </button>
        {editingAppt === 'de' && (
          <ApptEditPopover load={load} apptField="deliveryAppt" typeField="deliveryApptType" onClose={() => setEditingAppt(null)} />
        )}
      </div>

      {/* Driver */}
      <div
        className="relative shrink-0 flex items-center gap-1 px-1"
        style={{ width: colW.driver }}
        tabIndex={isDeliveryDay ? -1 : 0}
        onClick={() => !isDeliveryDay && setShowDriver((v) => !v)}
        onBlur={(e) => closeOnBlur(() => setShowDriver(false))(e)}
      >
        <span
          className="text-[9px] font-black rounded-full flex items-center justify-center leading-none shrink-0"
          style={{ background: color.border, color: '#fff', minWidth: 14, minHeight: 14, padding: '0 2px' }}
        >
          {slotNum}
        </span>
        <div className={cn(
          'flex-1 h-full flex items-center text-[11px] font-medium truncate rounded',
          isDeliveryDay ? 'text-slate-400' : 'cursor-pointer hover:bg-black/5',
          !isDeliveryDay && !load.pickupDriverId ? 'text-blue-600' : 'text-slate-800',
          showDriver && 'ring-1 ring-blue-400 bg-blue-50',
        )}>
          {!isDeliveryDay && !load.pickupDriverId
            ? <span className="underline underline-offset-2">Assign Driver</span>
            : driverName}
        </div>
        {showDriver && !isDeliveryDay && (
          <DriverPicker
            loadId={load.id}
            currentId={load.pickupDriverId}
            drivers={drivers}
            onClose={() => setShowDriver(false)}
          />
        )}
      </div>

      {/* Notes */}
      <NotesCell load={load} width={colW.notes} />

      {/* Rate */}
      {role !== 'pickup' ? <RateCell load={load} width={colW.rate} /> : <div style={{ width: colW.rate }} className="shrink-0" />}

      {/* RTI */}
      {isFinalDest ? (
        <button
          className="shrink-0 flex items-center justify-center px-2 hover:opacity-75 transition-opacity"
          title={load.readyToInvoice ? 'Mark as not ready' : 'Mark as ready to invoice'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); updateLoad(load.id, { readyToInvoice: !load.readyToInvoice }) }}
        >
          {load.readyToInvoice
            ? <CheckCircle className="size-4 text-green-600" />
            : <Circle className="size-4 text-slate-300" />}
        </button>
      ) : (
        <div className="shrink-0 px-2" style={{ width: RTI_W }} />
      )}
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

// ── Width computation ─────────────────────────────────────────────────────────
function computeColWidths(loads: Load[], drivers: Driver[]): ColWidths {
  const len = (s: string | null | undefined) => (s ?? '').length

  // Measure the widest content in each column, seeded with the header label length
  let maxAljex  = len('Pro #')
  let maxTms    = len('TMS')
  let maxPu     = len('PU #')
  let maxLoc    = len('PU / DE Location')
  let maxRoute  = len('Route')
  let maxAppt   = 13  // "May 20, 2026" ≈ 13 chars — nearly uniform; time below is shorter
  let maxDriver = len('Driver')
  let maxNotes  = len('Notes')
  let maxRate   = len('Rate')

  for (const l of loads) {
    maxAljex  = Math.max(maxAljex,  len(l.aljexId))
    maxTms    = Math.max(maxTms,    len(l.tmsId))
    maxPu     = Math.max(maxPu,     len(l.pickupNumber))
    maxLoc    = Math.max(maxLoc,    len(l.originName), len(l.destinationName))
    // Route shows "City → Yard" or "City → City"
    const r1  = len(l.originCity) + 4 + 4            // "Org → Yard"
    const r2  = len(l.destinationCity) + 4 + 4        // "Yard → Dst"
    const r3  = len(l.originCity) + 4 + len(l.destinationCity)
    maxRoute  = Math.max(maxRoute,  r1, r2, r3)
    maxNotes  = Math.max(maxNotes,  len(l.notes))
    if (l.rate != null) {
      // "$1,234" format: dollar sign + commas
      const rateStr = '$' + Math.round(l.rate / 100).toLocaleString()
      maxRate = Math.max(maxRate, len(rateStr))
    }
  }

  for (const d of drivers) {
    maxDriver = Math.max(maxDriver, len(d.name))
  }

  const w = (chars: number, key: ColKey) => clamp(chars * CHAR_W + PAD, key)

  return {
    aljex:  w(maxAljex,  'aljex'),
    tms:    w(maxTms,    'tms'),
    pu:     w(maxPu,     'pu'),
    loc:    w(maxLoc,    'loc'),
    route:  w(maxRoute,  'route'),
    appt:   w(maxAppt,   'appt'),
    driver: w(maxDriver + 2, 'driver'),   // +2 for slot badge
    notes:  w(maxNotes,  'notes'),
    rate:   w(maxRate,   'rate'),
  }
}

// ── Main view ─────────────────────────────────────────────────────────────────
interface PlannerViewProps {
  loads:     Load[]
  drivers:   Driver[]
  weekStart: Date
  numDays?:  number
}

export function PlannerView({ loads, drivers, weekStart, numDays = 7 }: PlannerViewProps) {
  const days   = useMemo(() => Array.from({ length: numDays }, (_, i) => addDays(weekStart, i)), [weekStart, numDays])
  const colW   = useMemo(() => computeColWidths(loads, drivers), [loads, drivers])

  // Group loads into day entries — multi-day loads appear on BOTH pickup and delivery day
  const entriesByDay = useMemo(() => {
    const map = new Map<string, DayEntry[]>()
    const add = (dayStr: string, entry: DayEntry) => {
      if (!map.has(dayStr)) map.set(dayStr, [])
      map.get(dayStr)!.push(entry)
    }

    for (const l of loads) {
      const puDay = chicagoDateStr(l.pickupAppt)
      if (!puDay) continue
      const deDay = chicagoDateStr(l.deliveryAppt) ?? puDay
      const isMultiDay = puDay !== deDay

      if (isMultiDay) {
        add(puDay, { load: l, role: 'pickup',   key: `${l.id}:pickup` })
        add(deDay, { load: l, role: 'delivery', key: `${l.id}:delivery` })
      } else {
        add(puDay, { load: l, role: 'same-day', key: `${l.id}:same-day` })
      }
    }

    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const aTime = a.role === 'delivery' ? (a.load.deliveryAppt ?? a.load.pickupAppt ?? '') : (a.load.pickupAppt ?? '')
        const bTime = b.role === 'delivery' ? (b.load.deliveryAppt ?? b.load.pickupAppt ?? '') : (b.load.pickupAppt ?? '')
        return aTime.localeCompare(bTime)
      })
    }

    return map
  }, [loads])

  const [dayOrder, setDayOrder]       = useState<Map<string, string[]>>(new Map())
  const dragKey  = useRef<string | null>(null)
  const dragDay  = useRef<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const handleDragStart = useCallback((day: string, key: string) => {
    dragKey.current = key; dragDay.current = day
  }, [])

  const handleDragEnter = useCallback((day: string, key: string) => {
    if (dragKey.current === key || dragDay.current !== day) return
    setDragOverKey(key)
    setDayOrder((prev) => {
      const base  = (entriesByDay.get(day) ?? []).map((e) => e.key)
      const order = prev.get(day) ?? base
      const from  = order.indexOf(dragKey.current!)
      const to    = order.indexOf(key)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...order]; next.splice(from, 1); next.splice(to, 0, dragKey.current!)
      return new Map(prev).set(day, next)
    })
  }, [entriesByDay])

  const handleDragEnd = useCallback(() => {
    dragKey.current = null; dragDay.current = null; setDragOverKey(null)
  }, [])

  function orderedEntries(dayStr: string): DayEntry[] {
    const base  = entriesByDay.get(dayStr) ?? []
    const order = dayOrder.get(dayStr)
    if (!order) return base
    const byKey = new Map(base.map((e) => [e.key, e]))
    return order.map((k) => byKey.get(k)).filter(Boolean) as DayEntry[]
  }

  const headerPad = 3 + COLOR_W + DRAG_W
  const todayStr  = chicagoDateStr(new Date().toISOString())

  return (
    <div className="flex flex-col h-full overflow-auto bg-slate-50 select-none">

      {/* Sticky column header */}
      <div
        className="flex items-center border-b-2 border-slate-300 bg-white sticky top-0 z-20 shrink-0"
        style={{ height: ROW_H, paddingLeft: headerPad }}
      >
        <ColHeader width={colW.aljex}>Pro #</ColHeader>
        <ColHeader width={colW.tms}>TMS</ColHeader>
        <ColHeader width={colW.pu}>PU #</ColHeader>
        <ColHeader width={colW.loc}>PU / DE Location</ColHeader>
        <ColHeader width={colW.route}>Route</ColHeader>
        <ColHeader width={colW.appt}>PU Appt</ColHeader>
        <ColHeader width={colW.appt}>DE Appt</ColHeader>
        <ColHeader width={colW.driver}>Driver</ColHeader>
        <ColHeader width={colW.notes}>Notes</ColHeader>
        <ColHeader width={colW.rate}>Rate</ColHeader>
        <ColHeader width={RTI_W}>RTI</ColHeader>
      </div>

      {/* Day sections */}
      {days.map((day, di) => {
        const dayStr = chicagoDateStr(day.toISOString())
        const isPast = !!dayStr && !!todayStr && dayStr < todayStr
        const { weekday, date } = formatDayHeader(day.toISOString())
        const entries = orderedEntries(dayStr ?? '')
        const loadCount = entries.filter((e) => e.role !== 'delivery').length
        const tbdCount = entries.filter((e) => {
          if (e.role === 'delivery') return e.load.deliveryApptType === 'tbd'
          return e.load.pickupApptType === 'tbd'
        }).length
        const needsInvoiceCount = isPast
          ? entries.filter((e) => e.role !== 'pickup' && !e.load.readyToInvoice).length
          : 0

        return (
          <div key={di} className="border-b border-slate-200 shrink-0">
            <div
              className="flex items-center gap-2 px-2 bg-slate-100 border-b border-slate-200 sticky z-10"
              style={{ top: ROW_H, height: 22 }}
            >
              <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">{weekday}</span>
              <span className="text-[11px] text-slate-500">{date}</span>
              {loadCount > 0 && (
                <span className="text-[10px] text-slate-400">· {loadCount} load{loadCount !== 1 ? 's' : ''}</span>
              )}
              {tbdCount > 0 && (
                <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-px leading-none">
                  {tbdCount} NEED appt{tbdCount !== 1 ? 's' : ''}
                </span>
              )}
              {needsInvoiceCount > 0 && (
                <span className="text-[10px] font-semibold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-px leading-none">
                  {needsInvoiceCount} uninvoiced
                </span>
              )}
              <button
                className="ml-auto flex items-center justify-center size-4 rounded bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                title={`Add load for ${weekday}`}
                onClick={() => useAppStore.getState().setSelectedLoad(null, 'create', { driverId: null, dateStr: dayStr! })}
              >
                <Plus className="size-3" />
              </button>
            </div>

            {entries.length === 0 ? (
              <div className="flex items-center px-6 text-[11px] text-slate-300 italic" style={{ height: ROW_H }}>
                No loads
              </div>
            ) : (
              entries.map((entry) => {
                const driverId  = entry.load.pickupDriverId
                const sameDriver = entries.filter((e) => e.load.pickupDriverId === driverId)
                const slotNum   = sameDriver.indexOf(entry) + 1
                return (
                  <PlannerRow
                    key={entry.key}
                    entry={entry}
                    drivers={drivers}
                    colW={colW}
                    slotNum={slotNum}
                    dragging={dragKey.current === entry.key}
                    dragOver={dragOverKey === entry.key}
                    onDragStart={(k) => handleDragStart(dayStr ?? '', k)}
                    onDragEnter={(k) => handleDragEnter(dayStr ?? '', k)}
                    onDragEnd={handleDragEnd}
                  />
                )
              })
            )}
          </div>
        )
      })}
    </div>
  )
}
