import { useMemo, useState, useEffect, useRef } from 'react'
import type { Load, Driver, Stop } from '@/types'
import {
  getFullWeek, chicagoDateStr, formatApptTime, formatDateTime, formatDayHeader,
} from '@/lib/date'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { updateStop } from '@/lib/stops'
import { Avatar } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckCircle2, ArrowRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { cn } from '@/lib/utils'

// ── Appointment type badge ─────────────────────────────────────────────────────

const APPT_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  exact: { label: 'APPT',  cls: 'bg-[color:var(--tms-badge-blue-tint)] text-[color:var(--tms-badge-blue)] border-[color:var(--tms-badge-blue)]' },
  fcfs:  { label: 'FCFS',  cls: 'bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)] border-[color:var(--tms-badge-orange)]' },
  tbd:   { label: 'NEED',  cls: 'bg-muted text-muted-foreground border-border' },
  range: { label: 'RANGE', cls: 'bg-[color:var(--tms-badge-purple-tint)] text-[color:var(--tms-badge-purple)] border-[color:var(--tms-badge-purple)]' },
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
  // Multi-stop leg mode: this card represents the leg fromStop → toStop (one driver per leg).
  fromStop?: Stop
  toStop?: Stop
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, slotLabel, isContinuation, fromStop, toStop }: CompactCardProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { updateLoad } = useLoads()
  const [pickingDriver, setPickingDriver] = useState(false)
  const driverPickerRef = useRef<HTMLDivElement>(null)

  const legMode = !!(fromStop && toStop)

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
    if (legMode) updateLoad(load.id, { stops: updateStop(load, fromStop!.id, { driverId }) }).catch(() => {})
    else updateLoad(load.id, { pickupDriverId: driverId, deliveryDriverId: driverId }).catch(() => {})
    setPickingDriver(false)
  }

  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))

  // Per-leg appt/driver/route values in leg mode; whole-load values otherwise.
  const puApptType = legMode ? fromStop!.apptType : load.pickupApptType
  const deApptType = legMode ? toStop!.apptType   : load.deliveryApptType
  const originCity = legMode ? fromStop!.city     : load.originCity
  const destCity   = legMode ? toStop!.city       : load.destinationCity
  const legDriverId = legMode ? fromStop!.driverId : load.pickupDriverId

  const isRTI      = load.readyToInvoice
  const isConflict = conflictIds.has(load.id)
  const isAssigned = !!legDriverId
  // A leg has exactly one driver; only legacy whole-load rows can be "split".
  const isSplit    = !legMode && load.pickupDriverId !== load.deliveryDriverId && !!load.deliveryDriverId

  const pickupDriver       = drivers.find((d) => d.id === legDriverId)
  const deliveryDriver     = isSplit ? drivers.find((d) => d.id === load.deliveryDriverId) : undefined
  const pickupDriverName   = pickupDriver?.name  ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  const color         = load.colorKey ? getColor(load.colorKey) : UNASSIGNED_COLOR
  const deliveryColor = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR

  const borderColor = isConflict ? 'var(--tms-badge-red)' : isRTI ? 'var(--tms-badge-green)' : color.border
  const bgColor     = isContinuation
    ? 'color-mix(in srgb, var(--tms-text) 2%, transparent)'
    : isConflict ? 'var(--tms-badge-red-tint)' : isRTI ? 'var(--tms-badge-green-tint)' : color.bg
  const textColor   = isRTI ? 'var(--tms-text)' : color.text

  const puApptIso = legMode ? fromStop!.appt : load.pickupAppt
  const deApptIso = legMode ? toStop!.appt   : load.deliveryAppt
  const puTime = formatApptTime(puApptIso, puApptType, legMode ? fromStop!.apptEnd : load.pickupApptEnd)
  const deTime = formatApptTime(deApptIso, deApptType, legMode ? toStop!.apptEnd : load.deliveryApptEnd)

  const card = (
    <div
      className="h-full rounded border-2 border-l-2 px-1.5 py-1 cursor-pointer hover:brightness-105 hover:shadow-sm transition-all select-none flex flex-col justify-between"
      style={{
        borderColor:     isContinuation
          ? 'color-mix(in srgb, var(--tms-text) 7%, transparent)'
          : isConflict ? 'color-mix(in srgb, var(--tms-badge-red) 30%, transparent)' : isRTI ? 'var(--tms-badge-green)' : 'var(--tms-text)',
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
            {isContinuation && <ArrowRight className="size-2.5 text-[color:var(--tms-disabled)] shrink-0" />}
            {load.hot && <span className="shrink-0 text-[10px] leading-none" title="Hot load">🔥</span>}
            <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
              {load.aljexId || <em className="text-[color:var(--tms-badge-orange)] not-italic font-semibold">Build</em>}
            </span>
            {isRTI && <CheckCircle2 className="size-2.5 shrink-0" style={{ color: 'var(--tms-on-primary)' }} />}
          </div>
        </div>

        {/* Slot badge — auto-numbered by display position */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <span
            className="text-[9px] font-black rounded-full flex items-center justify-center leading-none"
            style={{
              background: borderColor,
              color: 'var(--tms-on-primary)',
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
                  style={{ background: borderColor, color: 'var(--tms-on-primary)' }}
                />
                {isSplit && deliveryDriver && (
                  <Avatar
                    src={deliveryDriver.photoUrl}
                    initials={initials(deliveryDriverName)}
                    size="xs"
                    className="shrink-0 -ml-1"
                    style={{ background: deliveryColor.border, color: 'var(--tms-on-primary)' }}
                  />
                )}
              </div>
            ) : (
              <button
                className="text-[9px] font-semibold text-[color:var(--tms-badge-orange)] underline underline-offset-1 hover:text-[color:var(--tms-badge-orange)] leading-none"
                onClick={(e) => { e.stopPropagation(); setPickingDriver(true) }}
              >
                Unassgnd
              </button>
            )}

            {/* Driver picker dropdown */}
            {pickingDriver && (
              <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50, background: 'var(--tms-card)', borderRadius: 8, boxShadow: 'var(--tms-shadow-pop)', border: '1px solid var(--tms-border)', padding: '4px 0', minWidth: 150, maxHeight: 208, overflowY: 'auto' }}>
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted flex items-center gap-2"
                  onClick={(e) => { e.stopPropagation(); assignDriver(null) }}
                >
                  <span className="size-5 rounded-full bg-[color:var(--tms-badge-orange-tint)] border border-[color:var(--tms-badge-orange)] flex items-center justify-center text-[9px] font-bold text-[color:var(--tms-badge-orange)] shrink-0">?</span>
                  Unassigned
                </button>
                <div className="border-t border-border my-0.5" />
                {activeDrivers.map((d) => {
                  const dc = d.colorKey ? getColor(d.colorKey) : UNASSIGNED_COLOR
                  const isCurrent = d.id === legDriverId
                  return (
                    <button
                      key={d.id}
                      className={cn('w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted flex items-center gap-2', isCurrent && 'font-semibold')}
                      onClick={(e) => { e.stopPropagation(); assignDriver(d.id) }}
                    >
                      <span
                        className="size-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
                        style={{ background: dc.avatarBg, color: dc.border, border: `1px solid ${dc.border}` }}
                      >
                        {initials(d.name)}
                      </span>
                      {d.name}
                      {isCurrent && <span className="ml-auto text-muted-foreground">✓</span>}
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
            <span className="text-[9px] text-muted-foreground shrink-0 leading-none">DE:</span>
            <ApptBadge type={deApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-muted-foreground shrink-0 leading-none">{deTime}</span>
          </>
        ) : (
          <>
            <ApptBadge type={puApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-muted-foreground leading-none">{puTime}</span>
            <ArrowRight className="size-2 shrink-0 text-[color:var(--tms-disabled)]" />
            <ApptBadge type={deApptType ?? 'exact'} />
            <span className="text-[9px] tabular-nums text-muted-foreground leading-none">{deTime}</span>
          </>
        )}
      </div>

      {/* Row 3: origin → destination */}
      {(originCity || destCity) && (
        <div className="flex items-center gap-0.5 min-w-0 mt-0.5">
          <span className="text-[9px] text-muted-foreground truncate leading-none">{originCity || '—'}</span>
          <ArrowRight className="size-2 shrink-0 text-[color:var(--tms-disabled)]" />
          <span className="text-[9px] text-muted-foreground truncate leading-none">{destCity || '—'}</span>
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
        <div className="font-bold text-sm text-[color:var(--tms-on-primary)]">{load.aljexId || '(no ID)'}</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">TMS/PO</span><span>{load.tmsId}</span>
          <span className="text-muted-foreground">PU#</span><span>{load.pickupNumber}</span>
          <span className="text-muted-foreground">{legMode ? 'From' : 'Pickup'}</span>
          <span>
            {(puApptType ?? 'exact') !== 'exact'
              ? puTime
              : formatDateTime(puApptIso)}
            {' '}
            <span className="text-muted-foreground text-[10px]">({APPT_TYPE_CONFIG[puApptType ?? 'exact']?.label})</span>
          </span>
          <span className="text-muted-foreground">{legMode ? 'To' : 'Delivery'}</span>
          <span>
            {(deApptType ?? 'exact') !== 'exact'
              ? deTime
              : formatDateTime(deApptIso)}
            {' '}
            <span className="text-muted-foreground text-[10px]">({APPT_TYPE_CONFIG[deApptType ?? 'exact']?.label})</span>
          </span>
          <span className="text-muted-foreground">PU Driver</span>
          <span>{pickupDriverName}</span>
          {isSplit && (
            <><span className="text-muted-foreground">DE Driver</span><span>{deliveryDriverName}</span></>
          )}
          {isRTI && (
            <>
              <span className="text-muted-foreground">RTI</span>
              <span className="text-[color:var(--tms-badge-green)] font-medium">Ready to Invoice</span>
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

// A scheduling bar: a whole load (legacy) or a single leg between consecutive stops
// (multi-stop). The track/segment machinery is identical for both — it only needs a
// start/end appt and a driver.
interface WeekItem {
  key: string
  load: Load
  driverId: string | null
  startAppt: string
  endAppt: string
  fromStop?: Stop
  toStop?: Stop
}

// Group key for natural ordering within a driver's day
function groupKey(item: WeekItem): string {
  return `${item.driverId ?? 'unassigned'}-${chicagoDateStr(item.startAppt)}`
}

export function CompactWeekView({ loads, drivers, conflictIds, weekStart }: CompactWeekViewProps) {
  const days = getFullWeek(weekStart) // [Mon … Sun]
  const dayStrs = useMemo(() => days.map((d) => chicagoDateStr(d.toISOString())), [days])

  // One bar per load
  const items = useMemo<WeekItem[]>(() => {
    return loads.map((load) => ({
      key: load.id,
      load,
      driverId: load.pickupDriverId,
      startAppt: load.pickupAppt,
      endAppt: load.deliveryAppt || load.pickupAppt,
    }))
  }, [loads])

  const itemByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items])

  // ── Track assignment ───────────────────────────────────────────────────────
  const trackMap = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()

    for (const dayStr of dayStrs) {
      const occupied = new Set<number>()
      for (const [key, track] of map) {
        const it = itemByKey.get(key)
        if (!it?.startAppt) continue
        const pDay = chicagoDateStr(it.startAppt)
        const dDay = it.endAppt ? chicagoDateStr(it.endAppt) : pDay
        if (pDay < dayStr && dDay >= dayStr) occupied.add(track)
      }

      const newToday = items
        .filter((it) => it.startAppt && chicagoDateStr(it.startAppt) === dayStr)
        .sort((a, b) => {
          const ga = groupKey(a), gb = groupKey(b)
          if (ga !== gb) return ga.localeCompare(gb)
          return (a.startAppt ?? '').localeCompare(b.startAppt ?? '')
        })

      for (const it of newToday) {
        let t = 0
        while (occupied.has(t)) t++
        map.set(it.key, t)
        occupied.add(t)
      }
    }

    return map
  }, [items, itemByKey, dayStrs])

  const maxTrack = useMemo(() => {
    if (trackMap.size === 0) return -1
    return Math.max(...trackMap.values())
  }, [trackMap])

  // ── Build grid segments — one entry per item, with column span ─────────────
  const segments = useMemo(() => {
    const result: {
      item: WeekItem; track: number
      startCol: number; endCol: number
      isContinuation: boolean
    }[] = []

    for (const [key, track] of trackMap) {
      const it = itemByKey.get(key)
      if (!it?.startAppt) continue

      const pDay = chicagoDateStr(it.startAppt)
      const dDay = it.endAppt ? chicagoDateStr(it.endAppt) : pDay

      let startCol = -1, endCol = -1
      for (let i = 0; i < dayStrs.length; i++) {
        if (dayStrs[i] >= pDay && dayStrs[i] <= dDay) {
          if (startCol === -1) startCol = i
          endCol = i
        }
      }
      if (startCol === -1) continue // not visible this week

      result.push({
        item: it, track,
        startCol, endCol,
        isContinuation: pDay < dayStrs[0], // carried over from a previous week
      })
    }

    return result
  }, [trackMap, itemByKey, dayStrs])

  // Bar count per column (for header badge — only count bars starting that day)
  const primaryCounts = useMemo(() =>
    dayStrs.map((d) =>
      segments.filter((s) => dayStrs[s.startCol] === d && !s.isContinuation).length
    ),
    [segments, dayStrs],
  )

  const SLOT_HEIGHT = 72

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--tms-card)', borderRadius: 12 }}>

      {/* ── Sticky column headers ─────────────────────────────────────────── */}
      <div className="grid shrink-0" style={{ gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--tms-border)', position: 'sticky', top: 0, zIndex: 10 }}>
        {days.map((day, colIdx) => {
          const { weekday, date } = formatDayHeader(day.toISOString())
          const isWeekend = colIdx >= 5
          return (
            <div
              key={colIdx}
              style={{
                padding: '8px', borderRight: colIdx < 6 ? '1px solid var(--tms-border)' : 'none',
                background: isWeekend ? 'var(--tms-bg)' : 'var(--tms-card)',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tms-text)', textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: 1 }}>{weekday}</div>
              <div style={{ fontSize: 10, color: 'var(--tms-muted)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{date}</div>
              {primaryCounts[colIdx] > 0 && (
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--tms-muted)', marginTop: 2 }}>
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
          <div className="text-center text-[10px] text-[color:var(--tms-disabled)] pt-6 select-none">—</div>
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
                  borderRight: colIdx < 6 ? '1px solid var(--tms-border)' : 'none',
                  background: colIdx >= 5 ? 'var(--tms-bg)' : 'transparent',
                  opacity: colIdx >= 5 ? 0.6 : 1,
                }}
              />
            ))}

            {/* Bars — one per load (legacy) or per leg (multi-stop), spanning their day range */}
            {segments.map(({ item, track, startCol, endCol, isContinuation }) => {
              const slotLabel = segments.filter((s) => s.item.driverId === item.driverId && s.track < track).length + 1
              return (
                <div
                  key={item.key}
                  className="px-1 py-0.5 relative z-10"
                  style={{
                    gridColumn: `${startCol + 1} / ${endCol + 2}`,
                    gridRow: track + 1,
                  }}
                >
                  <CompactCard
                    load={item.load}
                    drivers={drivers}
                    conflictIds={conflictIds}
                    slotLabel={slotLabel}
                    isContinuation={isContinuation}
                    fromStop={item.fromStop}
                    toStop={item.toStop}
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
