import { useMemo, useState, useEffect, useRef } from 'react'
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
  tbd:   { label: 'NEED',  cls: 'bg-slate-100 text-slate-500 border-slate-200' },
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
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, slotLabel, isContinuation }: CompactCardProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { updateLoad } = useLoads()
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
  const isSplit    = load.pickupDriverId !== load.deliveryDriverId && !!load.deliveryDriverId

  const pickupDriver       = drivers.find((d) => d.id === load.pickupDriverId)
  const deliveryDriver     = isSplit ? drivers.find((d) => d.id === load.deliveryDriverId) : undefined
  const pickupDriverName   = pickupDriver?.name  ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  const color         = load.colorKey ? getColor(load.colorKey) : UNASSIGNED_COLOR
  const deliveryColor = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR

  const borderColor = isConflict ? '#ef4444' : isRTI ? '#15803d' : color.border
  const bgColor     = isContinuation
    ? 'rgba(0,0,0,0.015)'
    : isConflict ? 'rgba(239,68,68,0.06)' : isRTI ? '#22c55e' : color.bg
  const textColor   = isRTI ? '#fff' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)
  const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)

  const card = (
    <div
      className="h-full rounded border border-l-2 px-1.5 py-1 cursor-pointer hover:brightness-105 hover:shadow-sm transition-all select-none flex flex-col justify-between"
      style={{
        borderColor:     isContinuation
          ? 'rgba(0,0,0,0.07)'
          : isConflict ? 'rgba(239,68,68,0.3)' : isRTI ? '#15803d' : '#e5e7eb',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        opacity: isContinuation ? 0.72 : 1,
      }}
      onClick={() => { if (!pickingDriver) setSelectedLoad(load.id, 'view') }}
    >
      {/* Row 1: ID + RTI + slot badge + avatar */}
      <div className="flex items-start gap-1 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            {isContinuation && <ArrowRight className="size-2.5 text-slate-300 shrink-0" />}
            <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
              {load.aljexId || <em className="text-amber-600 not-italic font-semibold">Build</em>}
            </span>
            {isRTI && <CheckCircle2 className="size-2.5 shrink-0" style={{ color: '#fff' }} />}
          </div>
        </div>

        {/* Slot badge — auto-numbered by display position */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <span
            className="text-[9px] font-black rounded-full flex items-center justify-center leading-none"
            style={{
              background: borderColor,
              color: '#fff',
              minWidth: '14px',
              minHeight: '14px',
              padding: '0 2px',
            }}
          >
            {slotLabel}
          </span>

          {/* Avatar(s) */}
          <div className="relative" ref={driverPickerRef}>
            {isAssigned ? (
              <div
                className="flex items-center cursor-pointer hover:opacity-75 transition-opacity"
                onClick={(e) => { e.stopPropagation(); setPickingDriver(true) }}
                title={isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}
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
              <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50, background: 'var(--ds-surface)', borderRadius: 8, boxShadow: 'var(--sh-lg)', border: '1px solid var(--ds-border)', padding: '4px 0', minWidth: 150, maxHeight: 208, overflowY: 'auto' }}>
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

      {/* Row 2: appt info — DE only for carry-overs, PU→DE for everything else */}
      <div className="flex items-center gap-0.5 min-w-0 mt-0.5 flex-wrap">
        {isContinuation ? (
          <>
            <span className="text-[9px] text-slate-400 shrink-0 leading-none">DE:</span>
            <ApptBadge type={load.deliveryApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-slate-500 shrink-0 leading-none">{deTime}</span>
          </>
        ) : (
          <>
            <ApptBadge type={load.pickupApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-slate-500 leading-none">{puTime}</span>
            <ArrowRight className="size-2 shrink-0 text-slate-300" />
            <ApptBadge type={load.deliveryApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-slate-500 leading-none">{deTime}</span>
          </>
        )}
      </div>

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

  if (pickingDriver) return <div className="h-full">{card}</div>

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
          <span className="text-muted-foreground">PU Driver</span>
          <span>{pickupDriverName}</span>
          {isSplit && (
            <><span className="text-muted-foreground">DE Driver</span><span>{deliveryDriverName}</span></>
          )}
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
  const dayStrs = useMemo(() => days.map((d) => chicagoDateStr(d.toISOString())), [days])

  // ── Track assignment ───────────────────────────────────────────────────────
  const trackMap = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()

    for (const dayStr of dayStrs) {
      const occupied = new Set<number>()
      for (const [id, track] of map) {
        const l = loads.find((x) => x.id === id)
        if (!l?.pickupAppt) continue
        const pDay = chicagoDateStr(l.pickupAppt)
        const dDay = l.deliveryAppt ? chicagoDateStr(l.deliveryAppt) : pDay
        if (pDay < dayStr && dDay >= dayStr) occupied.add(track)
      }

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
  }, [loads, dayStrs])

  const maxTrack = useMemo(() => {
    if (trackMap.size === 0) return -1
    return Math.max(...trackMap.values())
  }, [trackMap])

  // ── Build grid segments — one entry per load, with column span ─────────────
  const segments = useMemo(() => {
    const result: {
      load: Load; track: number
      startCol: number; endCol: number
      isContinuation: boolean
    }[] = []

    for (const [loadId, track] of trackMap) {
      const load = loads.find((l) => l.id === loadId)
      if (!load?.pickupAppt) continue

      const pDay = chicagoDateStr(load.pickupAppt)
      const dDay = load.deliveryAppt ? chicagoDateStr(load.deliveryAppt) : pDay

      let startCol = -1, endCol = -1
      for (let i = 0; i < dayStrs.length; i++) {
        if (dayStrs[i] >= pDay && dayStrs[i] <= dDay) {
          if (startCol === -1) startCol = i
          endCol = i
        }
      }
      if (startCol === -1) continue // not visible this week

      result.push({
        load, track,
        startCol, endCol,
        isContinuation: pDay < dayStrs[0], // carried over from a previous week
      })
    }

    return result
  }, [trackMap, loads, dayStrs])

  // Load count per column (for header badge — only count loads starting that day)
  const primaryCounts = useMemo(() =>
    dayStrs.map((d) =>
      segments.filter((s) => dayStrs[s.startCol] === d && !s.isContinuation).length
    ),
    [segments, dayStrs],
  )

  const SLOT_HEIGHT = 72

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ds-surface)', borderRadius: 12 }}>

      {/* ── Sticky column headers ─────────────────────────────────────────── */}
      <div className="grid shrink-0" style={{ gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--ds-border)', position: 'sticky', top: 0, zIndex: 10 }}>
        {days.map((day, colIdx) => {
          const { weekday, date } = formatDayHeader(day.toISOString())
          const isWeekend = colIdx >= 5
          return (
            <div
              key={colIdx}
              style={{
                padding: '8px', borderRight: colIdx < 6 ? '1px solid var(--ds-border)' : 'none',
                background: isWeekend ? 'var(--ds-bg)' : 'var(--ds-surface)',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t1)', textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: 1 }}>{weekday}</div>
              <div style={{ fontSize: 10, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{date}</div>
              {primaryCounts[colIdx] > 0 && (
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ds-t3)', marginTop: 2 }}>
                  {primaryCounts[colIdx]} load{primaryCounts[colIdx] !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Body grid ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {maxTrack < 0 ? (
          <div className="text-center text-[10px] text-slate-300 pt-6 select-none">—</div>
        ) : (
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: 'repeat(7, 1fr)',
              gridTemplateRows: `repeat(${maxTrack + 1}, ${SLOT_HEIGHT}px)`,
            }}
          >
            {/* Column background tints + right borders */}
            {days.map((_, colIdx) => (
              <div
                key={`col-bg-${colIdx}`}
                style={{
                  gridColumn: colIdx + 1,
                  gridRow: `1 / ${maxTrack + 2}`,
                  borderRight: colIdx < 6 ? '1px solid var(--ds-border)' : 'none',
                  background: colIdx >= 5 ? 'var(--ds-bg)' : 'transparent',
                  opacity: colIdx >= 5 ? 0.6 : 1,
                }}
              />
            ))}

            {/* Load cards — spanning across their full day range */}
            {segments.map(({ load, track, startCol, endCol, isContinuation }) => {
              const driverId = load.pickupDriverId
              const slotLabel = segments.filter((s) => s.load.pickupDriverId === driverId && s.track < track).length + 1
              return (
                <div
                  key={load.id}
                  className="px-1 py-0.5 relative z-10"
                  style={{
                    gridColumn: `${startCol + 1} / ${endCol + 2}`,
                    gridRow: track + 1,
                  }}
                >
                  <CompactCard
                    load={load}
                    drivers={drivers}
                    conflictIds={conflictIds}
                    slotLabel={slotLabel}
                    isContinuation={isContinuation}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
