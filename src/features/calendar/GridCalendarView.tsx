/**
 * GridCalendarView — horizontal day-column layout for 2-Week and Month views.
 * Days are columns left→right. Each load is a full-detail card.
 * Scroll right for more days; scroll down for more loads.
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Plus, CheckCircle, Circle, AlertCircle, GripVertical, PaintBucket } from 'lucide-react'
import { formatTime, formatDayHeader, addDays, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { getColor, getHighlightHex, LOAD_HIGHLIGHT_PALETTE } from '@/lib/driverColors'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import type { Load, Driver, ViewMode } from '@/types'

// ── Layout constants ──────────────────────────────────────────────────────────
const DAY_COL_W = 252   // px per day column
const HEADER_H  = 42    // sticky day-header height
const COL_PAD   = 6

// Highlight palette for card planning colors — exclude Lime (green) and Rose (red-ish)
// so they don't conflict with the TBD-red and RTI-green semantic card states.
const GRID_PALETTE = LOAD_HIGHLIGHT_PALETTE.filter(
  (p) => p.key !== 'driver-9' && p.key !== 'driver-12',
)

// ── Helpers ───────────────────────────────────────────────────────────────────

function chicagoDateStr(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

function addDaysLocal(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

function hexBg(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

type Role = 'pickup' | 'delivery' | 'same-day'
interface DayEntry { load: Load; role: Role }

function apptDisplay(iso: string | undefined | null, type: string | undefined | null, yard: boolean): string {
  if (yard) return 'Yard'
  if (type === 'tbd')  return 'NEED'
  if (type === 'fcfs') return 'FCFS'
  if (!iso) return '—'
  return formatTime(iso)
}

function apptDate(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// ── Card-move date helpers ────────────────────────────────────────────────────

// Shift an appointment to a new Chicago calendar day, preserving the original time-of-day.
function shiftApptToDay(isoAppt: string | null | undefined, newDayStr: string): string {
  const fallback = fromDateTimeInput(`${newDayStr}T08:00`)
  if (!isoAppt) return fallback
  const timeStr = formatDateTimeInput(isoAppt).slice(11) // "HH:mm" in Chicago time
  return fromDateTimeInput(`${newDayStr}T${timeStr}`)
}

// Add/subtract days from a "YYYY-MM-DD" string, returns "YYYY-MM-DD".
function offsetDay(dayStr: string, n: number): string {
  const [y, m, d] = dayStr.split('-').map(Number)
  const date = new Date(y, m - 1, d + n)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Compute the new pickupAppt + deliveryAppt for a card being moved to targetDayStr.
// same-day: both shift to targetDay
// pickup card: pickup = targetDay, delivery = targetDay+1 (next-day-delivery pattern)
// delivery card: delivery = targetDay, pickup = targetDay-1
function computeMoveDates(load: Load, role: Role, targetDayStr: string) {
  if (role === 'same-day') {
    return {
      pickupAppt:   shiftApptToDay(load.pickupAppt,   targetDayStr),
      deliveryAppt: shiftApptToDay(load.deliveryAppt, targetDayStr),
    }
  }
  if (role === 'pickup') {
    return {
      pickupAppt:   shiftApptToDay(load.pickupAppt,   targetDayStr),
      deliveryAppt: shiftApptToDay(load.deliveryAppt, offsetDay(targetDayStr, 1)),
    }
  }
  // delivery card
  return {
    pickupAppt:   shiftApptToDay(load.pickupAppt,   offsetDay(targetDayStr, -1)),
    deliveryAppt: shiftApptToDay(load.deliveryAppt, targetDayStr),
  }
}

// ── Full-detail load card ─────────────────────────────────────────────────────

function LoadCard({
  entry, drivers, selected, onSelect,
  dragging, dragOver, onDragStart, onDragEnter, onDragEnd,
}: {
  entry: DayEntry
  drivers: Driver[]
  selected: boolean
  onSelect: (loadId: string, e: React.MouseEvent) => void
  dragging: boolean
  dragOver: boolean
  onDragStart: (key: string) => void
  onDragEnter: (key: string) => void
  onDragEnd: () => void
}) {
  const { load, role } = entry
  const { updateLoad } = useLoads()

  // Color picker state
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null)
  const paintBtnRef = useRef<HTMLButtonElement>(null)

  // Inline slot-number editing
  const [slotEditing, setSlotEditing] = useState(false)
  const [slotDraft, setSlotDraft]     = useState('')

  useEffect(() => {
    if (!pickerOpen) return
    const close = () => setPickerOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [pickerOpen])

  const isDelivery  = role === 'delivery'
  const isFinalDest = role !== 'pickup'
  const isNeed      = load.pickupApptType === 'tbd' || load.deliveryApptType === 'tbd'
  const rti         = load.readyToInvoice
  const highlightHex = getHighlightHex(load.colorKey)

  // Driver for this role
  const driverId  = isDelivery ? load.deliveryDriverId : load.pickupDriverId
  const driver    = drivers.find((d) => d.id === driverId)
  const driverColor = getColor(driver?.colorKey)

  // Appt display — yard on the "other" side
  const puYard    = isDelivery
  const deYard    = role === 'pickup'
  const puTime    = apptDisplay(load.pickupAppt,  load.pickupApptType,  puYard)
  const deTime    = apptDisplay(load.deliveryAppt, load.deliveryApptType, deYard)
  const puDate    = puYard ? '' : apptDate(load.pickupAppt)
  const deDate    = deYard ? '' : apptDate(load.deliveryAppt)

  // Route
  const route = role === 'pickup'
    ? [load.originCity, 'Yard'].filter(Boolean).join(' → ')
    : role === 'delivery'
      ? ['Yard', load.destinationCity].filter(Boolean).join(' → ')
      : [load.originCity, load.destinationCity].filter(Boolean).join(' → ')

  // Rate (only meaningful on delivery/same-day)
  const rateStr = isFinalDest && load.rate != null
    ? `$${(load.rate / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`
    : null

  // TBD (isNeed) → red card. RTI takes priority over TBD; highlight color is suppressed when TBD.
  const borderHex   = rti ? '#16a34a' : isNeed ? '#ef4444' : (highlightHex ?? '#e2e8f0')
  const borderAlpha = isDelivery ? 'aa' : ''
  const bg = rti
    ? hexBg('#16a34a', isDelivery ? 0.10 : 0.18)
    : isNeed
      ? hexBg('#ef4444', selected ? 0.20 : 0.10)
      : highlightHex
        ? hexBg(highlightHex, selected ? 0.40 : isDelivery ? 0.14 : 0.26)
        : selected ? 'rgba(139,92,246,0.12)' : undefined

  const cardKey = `${load.id}:${role}`

  return (
    <div
      draggable
      style={{
        marginBottom: 4,
        borderLeft: `3px solid ${borderHex}${borderAlpha}`,
        background: bg,
        borderRadius: 4,
        padding: '8px 10px',
        cursor: dragging ? 'grabbing' : 'grab',
        outline: dragOver ? '2px solid var(--ds-blue)' : selected ? '1px solid #8b5cf6' : undefined,
        outlineOffset: -1,
        opacity: dragging ? 0.45 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        overflow: 'hidden',
        minWidth: 0,
        transition: 'opacity 0.12s',
      }}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(cardKey) }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDragEnter={() => onDragEnter(cardKey)}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { onSelect(load.id, e); return }
        useAppStore.getState().setSelectedLoad(load.id, 'edit')
      }}
    >

      {/* Row 1: grip + Pro# + TMS + PU# */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <GripVertical style={{ width: 10, height: 10, color: 'var(--ds-t3)', flexShrink: 0, opacity: 0.45 }} />
        {/* Pro# — flexShrink:0 guarantees it's always fully visible */}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t1)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {load.aljexId || '—'}
        </span>
        {/* Secondary IDs float right and truncate before touching the Pro# */}
        {load.tmsId && (
          <span style={{ fontSize: 9.5, color: 'var(--ds-t3)', whiteSpace: 'nowrap', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 'auto' }}>
            {load.tmsId}
          </span>
        )}
        {load.pickupNumber && (
          <span style={{ fontSize: 9.5, color: 'var(--ds-t3)', whiteSpace: 'nowrap', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: load.tmsId ? 4 : 'auto' }}>
            #{load.pickupNumber}
          </span>
        )}
      </div>

      {/* Route — always 14px; bold only when the load delivers that day */}
      {route && (
        <div style={{
          fontSize:      14,
          fontWeight:    isFinalDest ? 800 : 500,
          letterSpacing: isFinalDest ? '-0.02em' : 0,
          color:         isFinalDest ? 'var(--ds-t1)' : 'var(--ds-t2)',
          lineHeight:    1.25,
          margin:        '2px 0',
          overflow:      'hidden',
          textOverflow:  'ellipsis',
          whiteSpace:    'nowrap',
        }}>
          {route}
        </div>
      )}

      {/* Location names (facility / shipper names) */}
      {(load.originName || load.destinationName) && (
        <div style={{ fontSize: 9.5, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[
            !isDelivery ? load.originName : null,
            !isDelivery && !puYard && load.destinationName ? '→' : null,
            !puYard ? load.destinationName : null,
          ].filter(Boolean).join(' ')}
        </div>
      )}

      {/* Row 4: PU appt */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, color: puYard ? 'var(--ds-t3)' : 'var(--ds-blue)', width: 18, flexShrink: 0 }}>PU</span>
        {puDate && <span style={{ fontSize: 9.5, color: 'var(--ds-t3)' }}>{puDate}</span>}
        <span style={{ fontSize: 10.5, fontWeight: puTime === 'NEED' ? 700 : 500, color: puTime === 'NEED' ? '#dc2626' : puYard ? 'var(--ds-t3)' : 'var(--ds-t1)' }}>
          {puTime}
        </span>
      </div>

      {/* Row 5: DE appt */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, color: deYard ? 'var(--ds-t3)' : '#7c3aed', width: 18, flexShrink: 0 }}>DE</span>
        {deDate && <span style={{ fontSize: 9.5, color: 'var(--ds-t3)' }}>{deDate}</span>}
        <span style={{ fontSize: 10.5, fontWeight: deTime === 'NEED' ? 700 : 500, color: deTime === 'NEED' ? '#dc2626' : deYard ? 'var(--ds-t3)' : 'var(--ds-t1)' }}>
          {deTime}
        </span>
      </div>

      {/* Row 6: slot circle + driver + rate + RTI + paint bucket */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
        {/* Editable slot number — empty circle, click to edit inline */}
        {slotEditing ? (
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={slotDraft}
            style={{
              width: 20, height: 20, borderRadius: '50%',
              border: '1.5px solid #94a3b8',
              background: 'var(--ds-surface)',
              textAlign: 'center', fontSize: 9, fontWeight: 700,
              color: 'var(--ds-t1)', padding: 0, outline: 'none',
              flexShrink: 0,
            }}
            onChange={(e) => setSlotDraft(e.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const n = slotDraft === '' ? null : parseInt(slotDraft, 10)
              updateLoad(load.id, { daySlot: isNaN(n ?? 0) ? null : n })
              setSlotEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            style={{
              width: 20, height: 20, borderRadius: '50%',
              border: `1.5px solid ${load.daySlot != null ? '#64748b' : '#cbd5e1'}`,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, color: 'var(--ds-t2)',
              cursor: 'text', flexShrink: 0, background: 'transparent',
            }}
            title="Click to set slot number"
            onClick={(e) => { e.stopPropagation(); setSlotDraft(load.daySlot != null ? String(load.daySlot) : ''); setSlotEditing(true) }}
          >
            {load.daySlot ?? ''}
          </span>
        )}
        {/* Driver dot */}
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: driverId ? driverColor.border : '#cbd5e1', flexShrink: 0 }} />
        <span style={{
          fontSize: 10.5, flex: 1,
          color: driverId ? 'var(--ds-t1)' : 'var(--ds-blue)',
          fontWeight: driverId ? 500 : 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {driver?.name ?? 'Unassigned'}
        </span>
        {rateStr && (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: '#15803d', flexShrink: 0 }}>{rateStr}</span>
        )}
        {/* RTI toggle — only on final destination rows */}
        {isFinalDest && (
          <button
            style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
            title={rti ? 'Mark not ready' : 'Mark ready to invoice'}
            onClick={(e) => { e.stopPropagation(); updateLoad(load.id, { readyToInvoice: !rti }) }}
          >
            {rti
              ? <CheckCircle style={{ width: 13, height: 13, color: '#16a34a' }} />
              : <Circle     style={{ width: 13, height: 13, color: '#cbd5e1' }} />}
          </button>
        )}
        {isNeed && <AlertCircle style={{ width: 11, height: 11, color: '#dc2626', flexShrink: 0 }} />}
        {/* Paint bucket — card highlight color picker */}
        <button
          ref={paintBtnRef}
          style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
          title="Set card color"
          onClick={(e) => {
            e.stopPropagation()
            const rect = paintBtnRef.current?.getBoundingClientRect()
            if (rect) setPickerPos({ top: rect.bottom + 4, left: Math.max(4, rect.right - 148) })
            setPickerOpen((o) => !o)
          }}
        >
          <PaintBucket style={{ width: 11, height: 11, color: highlightHex ? '#000' : 'var(--ds-t3)', opacity: highlightHex ? 0.85 : 0.45 }} />
        </button>
      </div>

      {/* Row 7: notes */}
      {load.notes && (
        <div style={{ fontSize: 9.5, color: 'var(--ds-t3)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {load.notes}
        </div>
      )}

      {/* Color picker popup — fixed-position so it escapes overflow:hidden */}
      {pickerOpen && pickerPos && (
        <div
          style={{
            position: 'fixed',
            top: pickerPos.top,
            left: pickerPos.left,
            zIndex: 9999,
            background: 'var(--ds-surface)',
            border: '1px solid var(--ds-border)',
            borderRadius: 6,
            padding: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            width: 148,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Clear / no color */}
          <button
            style={{
              width: 22, height: 22, borderRadius: 3, cursor: 'pointer',
              background: '#f8fafc', border: load.colorKey == null ? '2px solid #64748b' : '1px dashed #cbd5e1',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: '#64748b', flexShrink: 0,
            }}
            title="Clear color"
            onClick={(e) => { e.stopPropagation(); updateLoad(load.id, { colorKey: null }); setPickerOpen(false) }}
          >
            ✕
          </button>
          {GRID_PALETTE.map(({ key, hex, label }) => (
            <button
              key={key}
              style={{
                width: 22, height: 22, borderRadius: 3, cursor: 'pointer',
                background: hex,
                border: load.colorKey === key ? '2.5px solid rgba(0,0,0,0.55)' : '1px solid rgba(0,0,0,0.10)',
                flexShrink: 0,
              }}
              title={label}
              onClick={(e) => { e.stopPropagation(); updateLoad(load.id, { colorKey: key }); setPickerOpen(false) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Day column ────────────────────────────────────────────────────────────────

function DayColumn({
  day, dayStr, entries, drivers, isToday, isCurrentMonth, selectedIds, onSelect,
  dragOverKey, dropTargetDay, onDragStart, onDragEnter, onDragEnd,
  onColumnDragEnter, onColumnDragLeave, onColumnDrop,
}: {
  day: Date; dayStr: string; entries: DayEntry[]; drivers: Driver[]
  isToday: boolean; isCurrentMonth: boolean; selectedIds: string[]
  onSelect: (loadId: string, e: React.MouseEvent) => void
  dragOverKey: string | null
  dropTargetDay: string | null
  onDragStart: (dayStr: string, key: string) => void
  onDragEnter: (dayStr: string, key: string) => void
  onDragEnd: () => void
  onColumnDragEnter: (dayStr: string) => void
  onColumnDragLeave: (dayStr: string) => void
  onColumnDrop: (dayStr: string) => void
}) {
  const { weekday, date } = formatDayHeader(day.toISOString())
  const loadCount = entries.filter((e) => e.role !== 'delivery').length
  const isDropTarget = dropTargetDay === dayStr

  return (
    <div
      style={{ width: DAY_COL_W, flexShrink: 0, borderRight: '1px solid var(--ds-border)', display: 'flex', flexDirection: 'column',
        outline: isDropTarget ? '2px solid var(--ds-blue)' : undefined,
        outlineOffset: -2,
        background: isDropTarget ? 'rgba(59,130,246,0.06)' : undefined,
        transition: 'background 0.1s',
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDragEnter={() => onColumnDragEnter(dayStr)}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onColumnDragLeave(dayStr) }}
      onDrop={(e) => { e.preventDefault(); onColumnDrop(dayStr) }}
    >

      {/* Sticky day header */}
      <div style={{
        height: HEADER_H, position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: `0 ${COL_PAD + 2}px`,
        borderBottom: `2px solid ${isToday ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
        background: isToday ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
          color: isToday ? 'var(--ds-blue)' : isCurrentMonth ? 'var(--ds-t2)' : 'var(--ds-t3)',
        }}>
          {weekday}
        </span>
        <span style={{ fontSize: 11, color: isToday ? 'var(--ds-blue)' : 'var(--ds-t3)', fontWeight: isToday ? 700 : 400 }}>
          {date}
        </span>
        {isToday && (
          <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--ds-blue)', color: '#fff', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>
            Today
          </span>
        )}
        {loadCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--ds-t3)', marginLeft: 'auto' }}>{loadCount}</span>
        )}
        <button
          style={{
            width: 18, height: 18, borderRadius: 4, border: 'none', cursor: 'pointer',
            background: 'var(--ds-blue)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: loadCount > 0 ? 0 : 'auto', flexShrink: 0,
          }}
          title={`Add load on ${weekday} ${date}`}
          onClick={() => useAppStore.getState().setSelectedLoad(null, 'create', { driverId: null, dateStr: dayStr })}
        >
          <Plus style={{ width: 11, height: 11 }} />
        </button>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, padding: `${COL_PAD}px ${COL_PAD}px 8px`, background: isToday ? 'rgba(59,130,246,0.03)' : undefined }}>
        {entries.length === 0 ? (
          <div style={{ fontSize: 10, color: 'var(--ds-t3)', fontStyle: 'italic', padding: '6px 2px' }}>No loads</div>
        ) : (
          entries.map((entry) => {
            const cardKey = `${entry.load.id}:${entry.role}`
            return (
              <LoadCard
                key={cardKey}
                entry={entry}
                drivers={drivers}
                selected={selectedIds.includes(entry.load.id)}
                onSelect={onSelect}
                dragging={false}
                dragOver={dragOverKey === cardKey}
                onDragStart={(key) => onDragStart(dayStr, key)}
                onDragEnter={(key) => onDragEnter(dayStr, key)}
                onDragEnd={onDragEnd}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

interface GridCalendarViewProps {
  loads:     Load[]
  drivers:   Driver[]
  startDate: Date
  viewMode:  ViewMode
}

export function GridCalendarView({ loads, drivers, startDate, viewMode }: GridCalendarViewProps) {
  const { updateLoad } = useLoads()

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onSelect = useCallback((loadId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds((prev) => prev.includes(loadId) ? prev.filter((id) => id !== loadId) : [...prev, loadId])
  }, [])

  // ── Drag state (within-day reorder + cross-column move) ───────────────────
  const [dayOrder,      setDayOrder]      = useState<Map<string, string[]>>(new Map())
  const [dragOverKey,   setDragOverKey]   = useState<string | null>(null)
  const [dropTargetDay, setDropTargetDay] = useState<string | null>(null)
  const dragKey            = useRef<string | null>(null)
  const dragDay            = useRef<string | null>(null)
  const dropTargetDayRef   = useRef<string | null>(null)  // hover highlight tracking
  const dropCommittedDay   = useRef<string | null>(null)  // set by onDrop — survives dragLeave
  const loadsRef = useRef(loads)
  loadsRef.current = loads

  const handleDragStart = useCallback((dayStr: string, key: string) => {
    dragKey.current = key
    dragDay.current = dayStr
  }, [])

  // Within-day reorder
  const handleDragEnter = useCallback((dayStr: string, key: string) => {
    if (!dragKey.current || dragKey.current === key || dragDay.current !== dayStr) return
    setDragOverKey(key)
    setDayOrder((prev) => {
      const entries = entriesByDayRef.current.get(dayStr) ?? []
      const currentOrder = prev.get(dayStr) ?? entries.map((e) => `${e.load.id}:${e.role}`)
      const fromIdx = currentOrder.indexOf(dragKey.current!)
      const toIdx   = currentOrder.indexOf(key)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...currentOrder]
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, dragKey.current!)
      const m = new Map(prev)
      m.set(dayStr, next)
      return m
    })
  }, [])

  // Cross-column: track which column the card is hovering over
  const handleColumnDragEnter = useCallback((dayStr: string) => {
    if (!dragKey.current || dragDay.current === dayStr) return
    dropTargetDayRef.current = dayStr
    setDropTargetDay(dayStr)
    setDragOverKey(null)
  }, [])

  const handleColumnDragLeave = useCallback((dayStr: string) => {
    if (dropTargetDayRef.current === dayStr) {
      dropTargetDayRef.current = null
      setDropTargetDay(null)
    }
  }, [])

  // onDrop on the column fires before dragEnd and is immune to the dragLeave-clears-ref race.
  const handleColumnDrop = useCallback((dayStr: string) => {
    dropCommittedDay.current = dayStr
  }, [])

  // Cross-column move: read from dropCommittedDay (set by onDrop), not dropTargetDayRef
  // (which can be cleared by dragLeave firing during the drop sequence).
  const handleDragEnd = useCallback(() => {
    const targetDay = dropCommittedDay.current
    if (targetDay && dragKey.current && dragDay.current && dragDay.current !== targetDay) {
      const [loadId, role] = dragKey.current.split(':') as [string, Role]
      const load = loadsRef.current.find((l) => l.id === loadId)
      if (load) {
        updateLoad(loadId, computeMoveDates(load, role, targetDay))
        setDayOrder(new Map())
      }
    }
    dragKey.current          = null
    dragDay.current          = null
    dropTargetDayRef.current = null
    dropCommittedDay.current = null
    setDragOverKey(null)
    setDropTargetDay(null)
  }, [updateLoad])

  const todayStr = useMemo(() => chicagoDateStr(new Date().toISOString()) ?? '', [])

  const gridDays = useMemo<Date[]>(() => {
    if (viewMode === 'day')      return [startDate]
    if (viewMode === 'two-week') return Array.from({ length: 14 }, (_, i) => addDays(startDate, i))
    // month
    const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate()
    return Array.from({ length: daysInMonth }, (_, i) =>
      addDaysLocal(new Date(startDate.getFullYear(), startDate.getMonth(), 1), i)
    )
  }, [startDate, viewMode])

  const entriesByDayRef = useRef<Map<string, DayEntry[]>>(new Map())

  const entriesByDay = useMemo(() => {
    const map = new Map<string, DayEntry[]>()
    const add = (key: string, e: DayEntry) => { if (!map.has(key)) map.set(key, []); map.get(key)!.push(e) }
    for (const l of loads) {
      const puDay = chicagoDateStr(l.pickupAppt)
      if (!puDay) continue
      const deDay = chicagoDateStr(l.deliveryAppt) ?? puDay
      if (puDay !== deDay) {
        add(puDay, { load: l, role: 'pickup' })
        add(deDay, { load: l, role: 'delivery' })
      } else {
        add(puDay, { load: l, role: 'same-day' })
      }
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const at = a.role === 'delivery' ? a.load.deliveryAppt : a.load.pickupAppt
        const bt = b.role === 'delivery' ? b.load.deliveryAppt : b.load.pickupAppt
        return (at ?? '').localeCompare(bt ?? '')
      })
    }
    entriesByDayRef.current = map
    return map
  }, [loads])

  const orderedEntries = useCallback((dayStr: string): DayEntry[] => {
    const entries = entriesByDay.get(dayStr) ?? []
    const order   = dayOrder.get(dayStr)
    if (!order) return entries
    const byKey = new Map(entries.map((e) => [`${e.load.id}:${e.role}`, e]))
    return order.map((k) => byKey.get(k)).filter((e): e is DayEntry => e !== undefined)
  }, [entriesByDay, dayOrder])

  const currentMonth = viewMode === 'month' ? startDate.getMonth() : -1

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'flex-start' }}>
        {gridDays.map((day) => {
          const dayStr = chicagoDateStr(day.toISOString()) ?? ''
          return (
            <DayColumn
              key={dayStr}
              day={day}
              dayStr={dayStr}
              entries={orderedEntries(dayStr)}
              drivers={drivers}
              isToday={dayStr === todayStr}
              isCurrentMonth={viewMode === 'month' ? day.getMonth() === currentMonth : true}
              selectedIds={selectedIds}
              onSelect={onSelect}
              dragOverKey={dragOverKey}
              dropTargetDay={dropTargetDay}
              onDragStart={handleDragStart}
              onDragEnter={handleDragEnter}
              onDragEnd={handleDragEnd}
              onColumnDragEnter={handleColumnDragEnter}
              onColumnDragLeave={handleColumnDragLeave}
              onColumnDrop={handleColumnDrop}
            />
          )
        })}
      </div>
    </div>
  )
}
