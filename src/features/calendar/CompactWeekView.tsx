import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import type { Load, Driver } from '@/types'
import {
  getFullWeek, chicagoDateStr, formatApptTime, formatDateTime, formatDayHeader,
} from '@/lib/date'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { Avatar } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckCircle2, ArrowRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { cn } from '@/lib/utils'

// ── Appointment type badge ─────────────────────────────────────────────────────

const APPT_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  exact: { label: 'APPT',  cls: 'bg-blue-50 text-blue-600 border-blue-200' },
  fcfs:  { label: 'FCFS',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  tbd:   { label: 'TBD',   cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  range: { label: 'RANGE', cls: 'bg-violet-50 text-violet-600 border-violet-200' },
}

function ApptBadge({ type }: { type?: string }) {
  const cfg = APPT_TYPE_CONFIG[type ?? 'exact'] ?? APPT_TYPE_CONFIG.exact
  return (
    <span className={cn('text-[8px] font-bold px-0.5 rounded border leading-none shrink-0', cfg.cls)}>
      {cfg.label}
    </span>
  )
}

// ── Compact card ──────────────────────────────────────────────────────────────

interface CompactCardProps {
  load: Load
  drivers: Driver[]
  conflictIds: Set<string>
  slotLabel: number
  isContinuation: boolean
  onSetSlot: (loadId: string, slot: number) => void
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, slotLabel, isContinuation, onSetSlot }: CompactCardProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { updateLoad } = useLoads()
  const [pickingSlot, setPickingSlot] = useState(false)
  const [pickingDriver, setPickingDriver] = useState(false)
  const driverPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickingDriver) return
    const handler = (e: MouseEvent) => {
      if (driverPickerRef.current && !driverPickerRef.current.contains(e.target as Node)) {
        setPickingDriver(false)
      }
    }
    setTimeout(() => window.addEventListener('mousedown', handler), 0)
    return () => window.removeEventListener('mousedown', handler)
  }, [pickingDriver])

  const assignDriver = (driverId: string | null) => {
    updateLoad(load.id, { pickupDriverId: driverId, deliveryDriverId: driverId })
    setPickingDriver(false)
  }

  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))

  const isRTI      = load.readyToInvoice
  const isConflict = conflictIds.has(load.id)
  const isAssigned = !!load.pickupDriverId
  const isSplit    = load.pickupDriverId !== load.deliveryDriverId && load.deliveryDriverId !== null

  const pickupDriver   = drivers.find((d) => d.id === load.pickupDriverId)
  const deliveryDriver = drivers.find((d) => d.id === load.deliveryDriverId)
  const pickupDriverName   = pickupDriver?.name  ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  const color         = pickupDriver?.colorKey  ? getColor(pickupDriver.colorKey)  : UNASSIGNED_COLOR
  const deliveryColor = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR

  const borderColor = isConflict ? '#ef4444' : isRTI ? '#16a34a' : color.border
  const bgColor     = isContinuation
    ? 'rgba(0,0,0,0.015)'
    : isConflict ? 'rgba(239,68,68,0.06)' : isRTI ? 'rgba(22,163,74,0.06)' : color.bg
  const textColor   = isRTI ? '#15803d' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)
  const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)

  const card = (
    <div
      className="h-full rounded border border-l-2 px-1.5 py-1 cursor-pointer hover:brightness-105 hover:shadow-sm transition-all select-none flex flex-col justify-between"
      style={{
        borderColor:     isContinuation
          ? 'rgba(0,0,0,0.07)'
          : isConflict ? 'rgba(239,68,68,0.3)' : isRTI ? 'rgba(22,163,74,0.3)' : '#e5e7eb',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        opacity: isContinuation ? 0.72 : 1,
      }}
      onClick={() => { if (!pickingSlot && !pickingDriver) setSelectedLoad(load.id, 'view') }}
    >
      {/* Row 1: ID + RTI + slot badge + avatar */}
      <div className="flex items-start gap-1 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            {isContinuation && <ArrowRight className="size-2.5 text-slate-300 shrink-0" />}
            <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
              {load.aljexId || <em className="text-amber-600 not-italic font-semibold">Build</em>}
            </span>
            {isRTI && <CheckCircle2 className="size-2.5 text-emerald-600 shrink-0" />}
          </div>
        </div>

        {/* Slot badge (right side top) */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          {pickingSlot ? (
            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className="text-[9px] font-black rounded-full flex items-center justify-center leading-none hover:opacity-80"
                  style={{
                    background: n === slotLabel ? '#94a3b8' : borderColor,
                    color: '#fff',
                    minWidth: '14px',
                    minHeight: '14px',
                    padding: '0 2px',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSetSlot(load.id, n)
                    setPickingSlot(false)
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : (
            <span
              className="text-[9px] font-black rounded-full flex items-center justify-center leading-none hover:opacity-75 cursor-pointer"
              style={{
                background: borderColor,
                color: '#fff',
                minWidth: '14px',
                minHeight: '14px',
                padding: '0 2px',
              }}
              onClick={(e) => { e.stopPropagation(); setPickingSlot(true) }}
            >
              {slotLabel}
            </span>
          )}

          {/* Avatar(s) */}
          <div className="relative" ref={driverPickerRef}>
            {isAssigned ? (
              <div
                className="flex items-center cursor-pointer hover:opacity-75 transition-opacity"
                onClick={(e) => { e.stopPropagation(); setPickingDriver(true) }}
                title="Click to reassign driver"
              >
                <Avatar
                  src={pickupDriver?.photoUrl}
                  initials={initials(pickupDriverName)}
                  size="xs"
                  className="shrink-0"
                  style={{ background: borderColor, color: '#fff' }}
                />
                {isSplit && deliveryDriver && (
                  <Avatar
                    src={deliveryDriver.photoUrl}
                    initials={initials(deliveryDriverName)}
                    size="xs"
                    className="shrink-0 -ml-1"
                    style={{ background: deliveryColor.border, color: '#fff' }}
                  />
                )}
              </div>
            ) : (
              <button
                className="text-[9px] font-semibold text-amber-500 underline underline-offset-1 hover:text-amber-600 leading-none"
                onClick={(e) => { e.stopPropagation(); setPickingDriver(true) }}
              >
                Unassgnd
              </button>
            )}

            {/* Driver picker dropdown */}
            {pickingDriver && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 min-w-[150px] max-h-52 overflow-y-auto">
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-slate-500 hover:bg-slate-50 flex items-center gap-2"
                  onClick={(e) => { e.stopPropagation(); assignDriver(null) }}
                >
                  <span className="size-5 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center text-[9px] font-bold text-amber-500 shrink-0">?</span>
                  Unassigned
                </button>
                <div className="border-t border-slate-100 my-0.5" />
                {activeDrivers.map((d) => {
                  const dc = d.colorKey ? getColor(d.colorKey) : UNASSIGNED_COLOR
                  const isCurrent = d.id === load.pickupDriverId
                  return (
                    <button
                      key={d.id}
                      className={cn('w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-50 flex items-center gap-2', isCurrent && 'font-semibold')}
                      onClick={(e) => { e.stopPropagation(); assignDriver(d.id) }}
                    >
                      <span
                        className="size-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
                        style={{ background: dc.avatarBg, color: dc.border, border: `1px solid ${dc.border}` }}
                      >
                        {initials(d.name)}
                      </span>
                      {d.name}
                      {isCurrent && <span className="ml-auto text-slate-400">✓</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: appt info — PU only on pickup day, DE only on delivery day, both for single-day */}
      {(() => {
        const pickupDay   = chicagoDateStr(load.pickupAppt)
        const deliveryDay = load.deliveryAppt ? chicagoDateStr(load.deliveryAppt) : pickupDay
        const isMultiDay  = pickupDay !== deliveryDay
        return (
          <div className="flex items-center gap-0.5 min-w-0 mt-0.5 flex-wrap">
            {isContinuation ? (
              // Delivery day of a multi-day load — show DE only
              <>
                <span className="text-[9px] text-slate-400 shrink-0 leading-none">DE:</span>
                <ApptBadge type={load.deliveryApptType ?? 'exact'} />
                <span className="text-[9px] tabular-nums text-slate-500 shrink-0 leading-none">{deTime}</span>
              </>
            ) : isMultiDay ? (
              // Pickup day of a multi-day load — show PU only
              <>
                <span className="text-[9px] text-slate-400 shrink-0 leading-none">PU:</span>
                <ApptBadge type={load.pickupApptType ?? 'exact'} />
                <span className="text-[9px] tabular-nums text-slate-500 leading-none">{puTime}</span>
              </>
            ) : (
              // Single-day load — show both
              <>
                <ApptBadge type={load.pickupApptType ?? 'exact'} />
                <span className="text-[9px] tabular-nums text-slate-500 leading-none">{puTime}</span>
                <ArrowRight className="size-2 shrink-0 text-slate-300" />
                <ApptBadge type={load.deliveryApptType ?? 'exact'} />
                <span className="text-[9px] tabular-nums text-slate-500 leading-none">{deTime}</span>
              </>
            )}
          </div>
        )
      })()}

      {/* Row 3: origin → destination */}
      {(load.originCity || load.destinationCity) && (
        <div className="flex items-center gap-0.5 min-w-0 mt-0.5">
          <span className="text-[9px] text-slate-400 truncate leading-none">{load.originCity || '—'}</span>
          <ArrowRight className="size-2 shrink-0 text-slate-300" />
          <span className="text-[9px] text-slate-400 truncate leading-none">{load.destinationCity || '—'}</span>
        </div>
      )}
    </div>
  )

  if (pickingSlot || pickingDriver) return <div className="h-full">{card}</div>

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <div className="h-full">{card}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] text-xs p-3 space-y-1">
        <div className="font-bold text-sm text-white">{load.aljexId || '(no ID)'}</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">TMS/PO</span><span>{load.tmsId}</span>
          <span className="text-muted-foreground">PU#</span><span>{load.pickupNumber}</span>
          <span className="text-muted-foreground">Pickup</span>
          <span>
            {(load.pickupApptType ?? 'exact') !== 'exact'
              ? puTime
              : formatDateTime(load.pickupAppt)}
            {' '}
            <span className="text-muted-foreground text-[10px]">({APPT_TYPE_CONFIG[load.pickupApptType ?? 'exact']?.label})</span>
          </span>
          <span className="text-muted-foreground">Delivery</span>
          <span>
            {(load.deliveryApptType ?? 'exact') !== 'exact'
              ? deTime
              : formatDateTime(load.deliveryAppt)}
            {' '}
            <span className="text-muted-foreground text-[10px]">({APPT_TYPE_CONFIG[load.deliveryApptType ?? 'exact']?.label})</span>
          </span>
          <span className="text-muted-foreground">Driver</span>
          <span>{isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}</span>
          {isRTI && (
            <>
              <span className="text-muted-foreground">RTI</span>
              <span className="text-emerald-400 font-medium">Ready to Invoice</span>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

// ── Week grid ─────────────────────────────────────────────────────────────────

interface CompactWeekViewProps {
  loads: Load[]
  drivers: Driver[]
  conflictIds: Set<string>
  weekStart: Date
}

// Group key for natural ordering within a driver's day
function groupKey(load: Load): string {
  return `${load.pickupDriverId ?? 'unassigned'}-${chicagoDateStr(load.pickupAppt)}`
}

export function CompactWeekView({ loads, drivers, conflictIds, weekStart }: CompactWeekViewProps) {
  const days = getFullWeek(weekStart) // [Mon … Sun]

  // Per-load slot label overrides (free 1–5 label, independent of track/row)
  const [loadSlots, setLoadSlots] = useState<Map<string, number>>(new Map())

  const handleSetSlot = useCallback((loadId: string, slot: number) => {
    setLoadSlots((prev) => { const next = new Map(prev); next.set(loadId, slot); return next })
  }, [])

  // ── Track assignment ───────────────────────────────────────────────────────
  // Each load gets a row index (track). Multi-day loads hold the same track
  // across all columns they appear in. New loads fill the lowest free track.
  const trackMap = useMemo<Map<string, number>>(() => {
    const dayStrs = days.map((d) => chicagoDateStr(d.toISOString()))
    const map = new Map<string, number>()

    for (const dayStr of dayStrs) {
      // Tracks occupied by continuations through this day
      const occupied = new Set<number>()
      for (const [id, track] of map) {
        const l = loads.find((x) => x.id === id)
        if (!l?.pickupAppt) continue
        const pDay = chicagoDateStr(l.pickupAppt)
        const dDay = l.deliveryAppt ? chicagoDateStr(l.deliveryAppt) : pDay
        if (pDay < dayStr && dDay >= dayStr) occupied.add(track)
      }

      // New loads starting today, sorted for stable assignment
      const newToday = loads
        .filter((l) => l.pickupAppt && chicagoDateStr(l.pickupAppt) === dayStr)
        .sort((a, b) => {
          const ga = groupKey(a), gb = groupKey(b)
          if (ga !== gb) return ga.localeCompare(gb)
          return (a.pickupAppt ?? '').localeCompare(b.pickupAppt ?? '')
        })

      for (const l of newToday) {
        let t = 0
        while (occupied.has(t)) t++
        map.set(l.id, t)
        occupied.add(t)
      }
    }

    return map
  }, [loads, days])

  const maxTrack = useMemo(() => {
    if (trackMap.size === 0) return -1
    return Math.max(...trackMap.values())
  }, [trackMap])

  // ── Build per-day slot arrays ──────────────────────────────────────────────
  const daySlots = useMemo(() => {
    return days.map((day) => {
      const dayStr = chicagoDateStr(day.toISOString())
      const slots = new Map<number, { load: Load; isContinuation: boolean }>()

      for (const [loadId, track] of trackMap) {
        const load = loads.find((l) => l.id === loadId)
        if (!load?.pickupAppt) continue
        const pDay = chicagoDateStr(load.pickupAppt)
        const dDay = load.deliveryAppt ? chicagoDateStr(load.deliveryAppt) : pDay
        if (dayStr >= pDay && dayStr <= dDay) {
          slots.set(track, { load, isContinuation: pDay !== dayStr })
        }
      }

      return { day, slots }
    })
  }, [days, loads, trackMap])

  const SLOT_HEIGHT = 72 // px — fixed height per track row for cross-column alignment

  return (
    <div className="flex h-full overflow-hidden bg-white rounded-xl">
      {daySlots.map(({ day, slots }, colIdx) => {
        const { weekday, date } = formatDayHeader(day.toISOString())
        const isWeekend = colIdx >= 5
        const primaryCount = [...slots.values()].filter((e) => !e.isContinuation).length

        return (
          <div
            key={colIdx}
            className={cn(
              'flex flex-col flex-1 min-w-0 border-r border-slate-200 last:border-r-0',
              isWeekend && 'bg-slate-50/40',
            )}
          >
            {/* Column header */}
            <div className={cn(
              'sticky top-0 z-10 border-b border-slate-200 px-2 py-2 shrink-0',
              isWeekend ? 'bg-slate-50' : 'bg-white',
            )}>
              <div className="text-[11px] font-bold text-slate-700 uppercase tracking-wide leading-none">{weekday}</div>
              <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">{date}</div>
              {primaryCount > 0 && (
                <div className="text-[9px] font-semibold text-slate-400 mt-0.5">
                  {primaryCount} load{primaryCount !== 1 ? 's' : ''}
                </div>
              )}
            </div>

            {/* Track rows — fixed height for cross-column alignment */}
            <div className="flex-1 overflow-y-auto">
              {maxTrack < 0 ? (
                <div className="text-center text-[10px] text-slate-300 pt-6 select-none">—</div>
              ) : (
                Array.from({ length: maxTrack + 1 }, (_, track) => {
                  const entry = slots.get(track)
                  return (
                    <div
                      key={track}
                      className="px-1 border-b border-slate-50 last:border-b-0"
                      style={{ height: SLOT_HEIGHT }}
                    >
                      {entry ? (
                        <div className="h-full py-0.5">
                          <CompactCard
                            load={entry.load}
                            drivers={drivers}
                            conflictIds={conflictIds}
                            slotLabel={loadSlots.get(entry.load.id) ?? (track + 1)}
                            isContinuation={entry.isContinuation}
                            onSetSlot={handleSetSlot}
                          />
                        </div>
                      ) : (
                        <div className="h-full" />
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
