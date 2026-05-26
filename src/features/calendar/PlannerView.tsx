/**
 * PlannerView — dense spreadsheet-style weekly view
 *
 * Multi-day loads appear on BOTH their pickup and delivery day:
 *   Pickup day  : PU Appt = real time,  DE Appt = "Yard",  Route = Origin → Yard
 *   Delivery day: PU Appt = "Yard",     DE Appt = real time, Route = Yard → Destination
 *
 * Editable per row:
 *   • Color  — dot → palette popover → saves load.colorKey to DB
 *   • Slot   — badge → 1-5 picker   → saves load.daySlot to DB
 *   • Driver — driver cell → search → saves load.pickupDriverId to DB
 *   • Order  — drag handle → reorders within day (session state)
 */

import { useState, useRef, useCallback, useMemo } from 'react'
import { GripVertical, X, Plus, Pencil, CheckCircle, Circle, AlertCircle } from 'lucide-react'
import { addDays, formatDayHeader, formatTime, formatDateShort, formatDateTimeInput } from '@/lib/date'
import { getColor, LOAD_HIGHLIGHT_PALETTE, getHighlightHex } from '@/lib/driverColors'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { cn } from '@/lib/utils'
import type { Load, Driver, ColorKey, ApptType } from '@/types'

// ── Column widths ─────────────────────────────────────────────────────────────
const COL = { color: 20, aljex: 60, tms: 80, pu: 72, puAppt: 168, deAppt: 168, route: 260, driver: 160, notes: 200, rate: 68, locations: 220 } as const
const ROW_H = 28
const DRAG_HANDLE_W = 16

// ── Hex bg helper ─────────────────────────────────────────────────────────────
function hexBg(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

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
function ApptCell({ iso, type, colorCls, yard, city }: {
  iso?: string; type?: string; colorCls: string; yard?: boolean; city?: string
}) {
  const w = COL.puAppt

  if (yard) {
    return (
      <div className="flex items-center px-1.5 gap-1 leading-tight text-slate-400" style={{ width: w }}>
        <span className="text-[11px] font-medium shrink-0">Yard</span>
        {city && <span className="text-[10px] italic truncate">{city}</span>}
      </div>
    )
  }

  if (!iso) return <div className="px-1.5 text-[11px] text-slate-300" style={{ width: w }}>—</div>

  const isSpecial = type === 'fcfs' || type === 'tbd'
  const specialLabel = type === 'tbd' ? 'NEED' : type!.toUpperCase()
  return (
    <div className={`flex flex-col justify-center px-1.5 leading-tight ${colorCls}`} style={{ width: w }}>
      <span className="text-[10px] text-slate-400 truncate">{formatDateShort(iso)}</span>
      <span className="text-[11px] font-medium truncate">
        {isSpecial ? specialLabel : formatTime(iso)}
      </span>
    </div>
  )
}

// ── Color picker popover ──────────────────────────────────────────────────────
function ColorPicker({
  loadId, current, onClose, extraIds,
}: {
  loadId: string; current?: ColorKey | null; onClose: () => void
  extraIds?: string[]
}) {
  const { updateLoad } = useLoads()
  const pick = async (key: ColorKey | null) => {
    const ids = [loadId, ...(extraIds ?? [])]
    await Promise.all(ids.map((id) => updateLoad(id, { colorKey: key })))
    onClose()
  }
  const multiCount = (extraIds?.length ?? 0) + 1
  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-xl flex flex-col gap-2"
      style={{ width: 196, padding: '10px 10px 8px' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {multiCount > 1 && (
        <div className="text-[10px] font-semibold text-slate-400">Apply to {multiCount} loads</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-lg border-2 border-dashed border-slate-300 flex items-center justify-center hover:bg-slate-50 transition-colors"
          style={{ width: 26, height: 26 }}
          title="Remove color"
          onClick={() => pick(null)}
        >
          <X className="size-3 text-slate-400" />
        </button>
        {LOAD_HIGHLIGHT_PALETTE.map(({ key, hex, label }) => (
          <button
            key={key}
            className={cn(
              'rounded-lg transition-transform hover:scale-110 hover:shadow-md',
              key === current && 'ring-2 ring-offset-1 ring-slate-500 scale-110',
            )}
            style={{ width: 26, height: 26, background: hex, border: '1px solid rgba(0,0,0,0.08)' }}
            title={label}
            onClick={() => pick(key)}
          />
        ))}
      </div>
    </div>
  )
}

// ── Driver picker popover ─────────────────────────────────────────────────────
function DriverPicker({ loadId, currentId, field, drivers, onClose }: {
  loadId: string; currentId: string | null; field: 'pickupDriverId' | 'deliveryDriverId'; drivers: Driver[]; onClose: () => void
}) {
  const { updateLoad } = useLoads()
  const [query, setQuery]   = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = drivers.filter((d) => d.active && d.name.toLowerCase().includes(query.toLowerCase()))

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

  const initVal = load[apptField] ? formatDateTimeInput(load[apptField]!) : ''

  const [dateVal, setDateVal] = useState(initVal)
  const [typeVal, setTypeVal] = useState<ApptType>(load[typeField] ?? 'exact')
  const [saving,  setSaving]  = useState(false)

  const datePart = dateVal.slice(0, 10)
  const timePart = dateVal.slice(11, 16)
  const combineDateTime = (d: string, t: string) => (d && t ? `${d}T${t}` : d || '')

  const commit = async () => {
    setSaving(true)
    const patch: Partial<Load> = { [typeField]: typeVal }
    if (dateVal) patch[apptField] = new Date(dateVal).toISOString()
    try { await updateLoad(load.id, patch) } finally { setSaving(false) }
    onClose()
  }

  const inputCls = "h-7 px-2 text-[11px] rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"

  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 p-2.5 rounded-lg border border-slate-200 bg-white shadow-xl flex flex-col gap-2"
      style={{ width: 215 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex gap-1">
        <input
          autoFocus
          type="date"
          className={inputCls}
          style={{ flex: '1 1 0', minWidth: 0 }}
          value={datePart}
          onChange={(e) => setDateVal(combineDateTime(e.target.value, timePart))}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
        />
        <input
          type="time"
          className={inputCls}
          style={{ width: 70, flexShrink: 0 }}
          value={timePart}
          onChange={(e) => setDateVal(combineDateTime(datePart, e.target.value))}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
        />
      </div>
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
function NotesCell({ load }: { load: Load }) {
  const { updateLoad } = useLoads()
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState('')

  const commit = () => {
    updateLoad(load.id, { notes: val.trim() || null })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="shrink-0 flex items-center px-1" style={{ width: COL.notes }}>
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
      style={{ width: COL.notes }}
      onClick={() => { setVal(load.notes ?? ''); setEditing(true) }}
    >
      <span className="text-[11px] text-slate-500 truncate flex-1 italic">{load.notes || ''}</span>
      <Pencil className="size-2 text-slate-300 opacity-0 group-hover/notes:opacity-100 shrink-0" />
    </div>
  )
}

// ── Rate cell (inline edit) ───────────────────────────────────────────────────
function RateCell({ load }: { load: Load }) {
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
      <div className="shrink-0 flex items-center px-1" style={{ width: COL.rate }}>
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
      style={{ width: COL.rate, color: load.rate ? '#15803d' : '#2563eb' }}
      onClick={() => { setVal(load.rate != null ? String(load.rate / 100) : ''); setEditing(true) }}
    >
      {load.rate != null ? display : <span className="underline underline-offset-2">Add Rate</span>}
    </div>
  )
}

// ── Editable slot badge ───────────────────────────────────────────────────────
function EditableSlotBadge({ load, hex, readOnly }: { load: Load; hex: string; readOnly?: boolean }) {
  const { updateLoad } = useLoads()
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState('')

  const commit = () => {
    const n = parseInt(val, 10)
    if (!isNaN(n) && n > 0) updateLoad(load.id, { daySlot: n })
    else if (val.trim() === '') updateLoad(load.id, { daySlot: null })
    setEditing(false)
  }

  const display = load.daySlot != null ? String(load.daySlot) : '–'

  if (editing && !readOnly) {
    return (
      <input
        autoFocus
        type="text"
        inputMode="numeric"
        className="text-[9px] font-black rounded-full text-center leading-none shrink-0 border border-blue-400 focus:outline-none"
        style={{ background: hex, color: '#000', width: 18, height: 18, padding: 0 }}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        onMouseDown={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className="text-[9px] font-black rounded-full flex items-center justify-center leading-none shrink-0"
      style={{ background: hex, color: '#000', minWidth: 14, minHeight: 14, padding: '0 2px', cursor: readOnly ? 'default' : 'pointer' }}
      onClick={readOnly ? undefined : (e) => { e.stopPropagation(); setVal(load.daySlot != null ? String(load.daySlot) : ''); setEditing(true) }}
      title={readOnly ? undefined : 'Click to set slot number'}
    >
      {display}
    </span>
  )
}

// ── Planner row ───────────────────────────────────────────────────────────────
interface PlannerRowProps {
  entry:       DayEntry
  drivers:     Driver[]
  dragging:    boolean
  dragOver:    boolean
  selected:    boolean
  onDragStart: (key: string) => void
  onDragEnter: (key: string) => void
  onDragEnd:   () => void
  onSelect:    (loadId: string, e: React.MouseEvent) => void
  selectedIds: string[]
}

function PlannerRow({ entry, drivers, dragging, dragOver, selected, onDragStart, onDragEnter, onDragEnd, onSelect, selectedIds }: PlannerRowProps) {
  const { load, role } = entry
  const { updateLoad } = useLoads()
  const [showColor,   setShowColor]   = useState(false)
  const [showDriver,  setShowDriver]  = useState(false)
  const [editingAppt, setEditingAppt] = useState<'pu' | 'de' | null>(null)

  const highlightHex  = getHighlightHex(load.colorKey)
  const driverField   = role === 'delivery' ? 'deliveryDriverId' : 'pickupDriverId'
  const relevantDriverId = load[driverField] as string | null
  const relevantDriver   = drivers.find((d) => d.id === relevantDriverId)
  const driverName       = relevantDriver?.name ?? '—'
  const isDeliveryDay = role === 'delivery'
  const isFinalDest   = role !== 'pickup'  // delivery or same-day — load ends here
  const isNeed = load.pickupApptType === 'tbd' || load.deliveryApptType === 'tbd'

  // Route text
  const route = (() => {
    if (role === 'pickup')   return [load.originCity, 'Yard'].filter(Boolean).join(' → ') || '—'
    if (role === 'delivery') return ['Yard', load.destinationCity].filter(Boolean).join(' → ') || '—'
    return [load.originCity, load.destinationCity].filter(Boolean).join(' → ') || '—'
  })()

  // Only close if focus left the container entirely (not moved to a child element)
  const closeOnBlur = (fn: () => void) => (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setTimeout(fn, 150)
  }

  return (
    <div
      className={cn(
        'group flex items-center border-b border-slate-100 transition-colors',
        dragging && 'opacity-40',
        dragOver && 'ring-1 ring-inset ring-blue-400',
        selected && 'ring-1 ring-inset ring-violet-400',
      )}
      style={{
        height: ROW_H,
        background: load.readyToInvoice
          ? (dragOver ? '#16a34a' : '#22c55e')
          : dragOver    ? hexBg(highlightHex ?? '#94a3b8', 0.30)
          : selected    ? hexBg(highlightHex ?? '#8b5cf6', 0.28)
          : highlightHex
            ? hexBg(highlightHex, isDeliveryDay ? 0.14 : 0.28)
            : undefined,
        borderLeft: load.readyToInvoice
          ? '3px solid #15803d'
          : highlightHex
            ? `3px solid ${highlightHex}${isDeliveryDay ? 'aa' : ''}`
            : '3px solid #e2e8f0',
        borderRight: isNeed ? '3px solid #dc2626' : undefined,
      }}
      draggable
      onDragStart={() => onDragStart(entry.key)}
      onDragEnter={() => onDragEnter(entry.key)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onClick={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) onSelect(load.id, e) }}
    >

      {/* Drag handle — first column */}
      <div className="flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing" style={{ width: DRAG_HANDLE_W }}>
        <GripVertical className="size-3 text-slate-400" />
      </div>

      {/* Color swatch — always editable */}
      <div
        className="relative flex items-center justify-center shrink-0"
        style={{ width: COL.color }}
        tabIndex={0}
        onClick={(e) => { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setShowColor((v) => !v) }}
        onBlur={(e) => closeOnBlur(() => setShowColor(false))(e)}
      >
        <span
          className="size-3 rounded transition-all cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-slate-300"
          style={{ background: highlightHex ?? '#e2e8f0', border: '1px solid rgba(0,0,0,0.1)' }}
        />
        {showColor && (
          <ColorPicker
            loadId={load.id}
            current={load.colorKey}
            onClose={() => setShowColor(false)}
            extraIds={selectedIds.filter((id) => id !== load.id)}
          />
        )}
      </div>

      {/* Pro # */}
      <Cell width={COL.aljex} bold onClick={() => useAppStore.getState().setSelectedLoad(load.id, 'edit')}>
        {load.aljexId || '—'}
      </Cell>

      {/* TMS + PU# — editable inline */}
      <EditableTextCell load={load} field="tmsId"        width={COL.tms} dimmed={isDeliveryDay} />
      <EditableTextCell load={load} field="pickupNumber" width={COL.pu}  dimmed={isDeliveryDay} />

      {/* PU / DE location names */}
      <div className="shrink-0 flex flex-col justify-center px-1.5 leading-tight" style={{ width: COL.locations }}>
        {load.originName && (
          <span className="text-[10px] text-slate-500 truncate" title={load.originName}>{load.originName}</span>
        )}
        {load.destinationName && (
          <span className="text-[10px] text-slate-400 truncate" title={load.destinationName}>{load.destinationName}</span>
        )}
      </div>

      {/* Route — bold when this is the final destination day */}
      <Cell width={COL.route} bold={isFinalDest} className={isFinalDest ? 'text-slate-800' : 'text-slate-500'}>{route}</Cell>

      {/* PU Appt */}
      <div className="relative group/appt shrink-0">
        <ApptCell
          iso={load.pickupAppt}
          type={load.pickupApptType}
          colorCls="text-blue-600"
          yard={isDeliveryDay}
          city={isDeliveryDay ? load.destinationCity : undefined}
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

      {/* Driver (with slot badge) — pickup row sets pickupDriverId, delivery row sets deliveryDriverId */}
      <div
        className="relative shrink-0 flex items-center gap-1 px-1"
        style={{ width: COL.driver }}
        tabIndex={0}
        onClick={() => setShowDriver((v) => !v)}
        onBlur={(e) => closeOnBlur(() => setShowDriver(false))(e)}
      >
        {/* Slot badge — manually set, editable on pickup/same-day row */}
        <EditableSlotBadge load={load} hex={highlightHex ?? '#cbd5e1'} readOnly={isDeliveryDay} />

        {/* Driver name */}
        <div className={cn(
          'flex-1 h-full flex items-center text-[11px] font-medium truncate rounded cursor-pointer hover:bg-black/5',
          !relevantDriverId ? 'text-blue-600' : isDeliveryDay ? 'text-slate-500' : 'text-slate-800',
          showDriver && 'ring-1 ring-blue-400 bg-blue-50',
        )}>
          {!relevantDriverId
            ? <span className="underline underline-offset-2">{isDeliveryDay ? 'DE Driver' : 'Assign Driver'}</span>
            : driverName}
        </div>
        {showDriver && (
          <DriverPicker
            loadId={load.id}
            currentId={relevantDriverId}
            field={driverField}
            drivers={drivers}
            onClose={() => setShowDriver(false)}
          />
        )}
      </div>

      {/* NEED indicator icon */}
      {isNeed && (
        <div className="shrink-0 flex items-center justify-center" style={{ width: 16 }} title="Needs appointment">
          <AlertCircle className="size-3 text-red-500" />
        </div>
      )}
      {!isNeed && <div className="shrink-0" style={{ width: 16 }} />}

      {/* Notes */}
      <NotesCell load={load} />

      {/* Rate — only for loads delivering to a real destination (not ending at yard) */}
      {role !== 'pickup' ? <RateCell load={load} /> : <div style={{ width: COL.rate }} className="shrink-0" />}

      {/* Ready-to-invoice checkmark — only on final-destination rows */}
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
        <div className="shrink-0 px-2" style={{ width: 32 }} />
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
      style={flex ? { flex: 1, minWidth: 0 } : { width, flexShrink: 0 }}
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
      style={flex ? { flex: 1, minWidth: 0 } : { width, flexShrink: 0 }}
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
  numDays?:  number
}

export function PlannerView({ loads, drivers, weekStart, numDays = 7 }: PlannerViewProps) {
  const days = useMemo(() => Array.from({ length: numDays }, (_, i) => addDays(weekStart, i)), [weekStart, numDays])

  // Multi-select state — shift/ctrl-click to toggle load selection
  const [selectedLoadIds, setSelectedLoadIds] = useState<string[]>([])

  const handleSelect = useCallback((loadId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedLoadIds((prev) =>
      prev.includes(loadId) ? prev.filter((id) => id !== loadId) : [...prev, loadId]
    )
  }, [])

  // Group loads into day entries — multi-day loads appear on BOTH pickup and delivery day
  const entriesByDay = useMemo(() => {
    const map = new Map<string, DayEntry[]>()

    const add = (dayStr: string, entry: DayEntry) => {
      if (!map.has(dayStr)) map.set(dayStr, [])
      map.get(dayStr)!.push(entry)
    }

    for (const l of loads) {
      const puDay = chicagoDateStr(l.pickupAppt)
      if (!puDay) continue  // skip loads with invalid pickup date
      const deDay = chicagoDateStr(l.deliveryAppt) ?? puDay
      const isMultiDay = puDay !== deDay

      if (isMultiDay) {
        add(puDay, { load: l, role: 'pickup',   key: `${l.id}:pickup` })
        add(deDay, { load: l, role: 'delivery', key: `${l.id}:delivery` })
      } else {
        add(puDay, { load: l, role: 'same-day', key: `${l.id}:same-day` })
      }
    }

    // Sort each day: same-day and pickup entries by pickupAppt, delivery entries at the end by deliveryAppt
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const aTime = a.role === 'delivery' ? (a.load.deliveryAppt ?? a.load.pickupAppt ?? '') : (a.load.pickupAppt ?? '')
        const bTime = b.role === 'delivery' ? (b.load.deliveryAppt ?? b.load.pickupAppt ?? '') : (b.load.pickupAppt ?? '')
        return aTime.localeCompare(bTime)
      })
    }

    return map
  }, [loads])

  // Per-day local drag-to-reorder (session state, keys are DayEntry.key)
  const [dayOrder, setDayOrder]     = useState<Map<string, string[]>>(new Map())
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

  const headerPad = 3 + COL.color + DRAG_HANDLE_W
  const todayStr  = chicagoDateStr(new Date().toISOString())

  return (
    <div className="flex flex-col h-full overflow-auto select-none" style={{ background: 'var(--ds-bg)' }}>

      {/* Sticky column header */}
      <div
        className="flex items-center sticky top-0 z-20 shrink-0"
        style={{ height: ROW_H, paddingLeft: headerPad, background: 'var(--ds-surface)', borderBottom: '2px solid var(--ds-border-strong)' }}
      >
        <ColHeader width={COL.aljex}>Pro #</ColHeader>
        <ColHeader width={COL.tms}>TMS</ColHeader>
        <ColHeader width={COL.pu}>PU #</ColHeader>
        <ColHeader width={COL.locations}>PU / DE Location</ColHeader>
        <ColHeader width={COL.route}>Route</ColHeader>
        <ColHeader width={COL.puAppt}>PU Appt</ColHeader>
        <ColHeader width={COL.deAppt}>DE Appt</ColHeader>
        <ColHeader width={COL.driver}>Driver</ColHeader>
        <ColHeader width={16}>{''}</ColHeader>
        <ColHeader width={COL.notes}>Notes</ColHeader>
        <ColHeader width={COL.rate}>Rate</ColHeader>
        <ColHeader width={32}>RTI</ColHeader>
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

        const isToday = dayStr === todayStr
        return (
          <div key={di} className="shrink-0" style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <div
              className="flex items-center gap-2 px-2 sticky z-10"
              style={{
                top: ROW_H, height: 22,
                background: isToday ? 'var(--ds-blue-bg)' : 'var(--ds-bg-2)',
                borderBottom: '1px solid var(--ds-border)',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: isToday ? 'var(--ds-blue-dark)' : 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{weekday}</span>
              <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{date}</span>
              {isToday && (
                <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--ds-blue)', color: '#fff', padding: '1px 6px', borderRadius: 4 }}>Today</span>
              )}
              {loadCount > 0 && (
                <span style={{ fontSize: 10, color: 'var(--ds-t3)' }}>· {loadCount} load{loadCount !== 1 ? 's' : ''}</span>
              )}
              {tbdCount > 0 && (
                <span style={{ fontSize: 10, fontWeight: 600, color: '#b45309', background: 'var(--ds-amber-bg)', border: '1px solid rgba(217,119,6,0.25)', borderRadius: 4, padding: '1px 6px', lineHeight: 1 }}>
                  {tbdCount} NEED appt{tbdCount !== 1 ? 's' : ''}
                </span>
              )}
              {needsInvoiceCount > 0 && (
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-red)', background: 'var(--ds-red-bg)', border: '1px solid rgba(185,28,28,0.2)', borderRadius: 4, padding: '1px 6px', lineHeight: 1 }}>
                  {needsInvoiceCount} uninvoiced
                </span>
              )}
              <button
                className="ml-auto flex items-center justify-center size-4 rounded text-white transition-colors"
                style={{ background: 'var(--ds-blue)', border: 'none', cursor: 'pointer' }}
                title={`Add load for ${weekday}`}
                onClick={() => useAppStore.getState().setSelectedLoad(null, 'create', { driverId: null, dateStr: dayStr! })}
              >
                <Plus className="size-3" />
              </button>
            </div>

            {entries.length === 0 ? (
              <div className="flex items-center px-6 italic" style={{ height: ROW_H, fontSize: 11, color: 'var(--ds-t3)' }}>
                No loads
              </div>
            ) : (
              entries.map((entry) => (
                <PlannerRow
                  key={entry.key}
                  entry={entry}
                  drivers={drivers}
                  dragging={dragKey.current === entry.key}
                  dragOver={dragOverKey === entry.key}
                  selected={selectedLoadIds.includes(entry.load.id)}
                  selectedIds={selectedLoadIds}
                  onDragStart={(k) => handleDragStart(dayStr ?? '', k)}
                  onDragEnter={(k) => handleDragEnter(dayStr ?? '', k)}
                  onDragEnd={handleDragEnd}
                  onSelect={handleSelect}
                />
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}
