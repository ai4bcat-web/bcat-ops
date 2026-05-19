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

// ── Compact card ──────────────────────────────────────────────────────────────

interface CompactCardProps {
  load: Load
  drivers: Driver[]
  conflictIds: Set<string>
  orderNumber: number
  isContinuation?: boolean
  onReorder: (loadId: string, newPosition: number) => void
}

// groupSizeMap intentionally unused — kept in useMemo for potential future features

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, orderNumber, isContinuation, onReorder }: CompactCardProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { updateLoad } = useLoads()
  const [pickingOrder, setPickingOrder] = useState(false)
  const [pickingDriver, setPickingDriver] = useState(false)
  const driverPickerRef = useRef<HTMLDivElement>(null)

  // Close driver picker on outside click
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
    ? 'rgba(0,0,0,0.02)'
    : isConflict ? 'rgba(239,68,68,0.06)' : isRTI ? 'rgba(22,163,74,0.06)' : color.bg
  const textColor   = isRTI ? '#15803d' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)
  const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)

  const card = (
    <div
      className="rounded border border-l-2 px-1.5 py-1 cursor-pointer hover:brightness-105 hover:shadow-sm transition-all select-none"
      style={{
        borderColor:     isContinuation
          ? 'rgba(0,0,0,0.08)'
          : isConflict ? 'rgba(239,68,68,0.3)' : isRTI ? 'rgba(22,163,74,0.3)' : '#e5e7eb',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        opacity: isContinuation ? 0.7 : 1,
      }}
      onClick={() => { if (!pickingOrder && !pickingDriver) setSelectedLoad(load.id, 'view') }}
    >
      {/* Main row: left content + right column */}
      <div className="flex items-start gap-1 min-w-0">
        {/* Left: time + aljex id + RTI */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
              {load.aljexId || <em className="text-amber-600 not-italic font-semibold">Build</em>}
            </span>
            {isRTI && <CheckCircle2 className="size-2.5 text-emerald-600 shrink-0" />}
            {isContinuation && <ArrowRight className="size-2.5 text-slate-300 shrink-0" />}
          </div>
          {!isContinuation && (
            <div className="flex items-center gap-1 min-w-0 mt-0.5">
              <span className="text-[10px] tabular-nums text-slate-500 shrink-0 leading-none">PU: {puTime}</span>
              <ArrowRight className="size-2 shrink-0 text-slate-300" />
              <span className="text-[10px] tabular-nums text-slate-500 shrink-0 leading-none">DE: {deTime}</span>
            </div>
          )}
          {/* Origin → destination */}
          {(load.originCity || load.destinationCity) && (
            <div className="flex items-center gap-0.5 min-w-0 mt-0.5">
              <span className="text-[10px] text-slate-400 truncate leading-none">{load.originCity || '—'}</span>
              <ArrowRight className="size-2 shrink-0 text-slate-300" />
              <span className="text-[10px] text-slate-400 truncate leading-none">{load.destinationCity || '—'}</span>
            </div>
          )}
        </div>

        {/* Right column: order badge + avatar(s) */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          {/* Order badge — always shows 1–5 picker, free assignment */}
          {pickingOrder ? (
            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className="text-[9px] font-black rounded-full flex items-center justify-center leading-none transition-opacity hover:opacity-80"
                  style={{
                    background: n === orderNumber ? '#94a3b8' : borderColor,
                    color: '#fff',
                    minWidth: '14px',
                    minHeight: '14px',
                    padding: '0 2px',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onReorder(load.id, n)
                    setPickingOrder(false)
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
              onClick={(e) => { e.stopPropagation(); setPickingOrder(true) }}
            >
              {orderNumber}
            </span>
          )}

          {/* Avatar(s) or Unassigned link */}
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
                Unassigned
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
    </div>
  )

  if (pickingOrder || pickingDriver) return <div>{card}</div>

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <div>{card}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] text-xs p-3 space-y-1">
        <div className="font-bold text-sm text-white">{load.aljexId || '(no ID)'}</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">TMS/PO</span><span>{load.tmsId}</span>
          <span className="text-muted-foreground">PU#</span><span>{load.pickupNumber}</span>
          <span className="text-muted-foreground">Pickup</span>
          <span>{puTime === 'TBD' ? 'TBD' : formatDateTime(load.pickupAppt)}</span>
          <span className="text-muted-foreground">Delivery</span>
          <span>{deTime === 'TBD' ? 'TBD' : formatDateTime(load.deliveryAppt)}</span>
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

function groupKey(load: Load): string {
  return `${load.pickupDriverId ?? 'unassigned'}-${chicagoDateStr(load.pickupAppt)}`
}

function naturalOrder(groupLoads: Load[]): string[] {
  return [...groupLoads]
    .sort((a, b) => {
      const at = !a.pickupAppt || !a.pickupAppt.startsWith('2') ? 'ZZZZ' : a.pickupAppt
      const bt = !b.pickupAppt || !b.pickupAppt.startsWith('2') ? 'ZZZZ' : b.pickupAppt
      return at.localeCompare(bt)
    })
    .map((l) => l.id)
}

export function CompactWeekView({ loads, drivers, conflictIds, weekStart }: CompactWeekViewProps) {
  const days = getFullWeek(weekStart) // [Mon … Sun]

  // Manual reorder overrides: groupKey → ordered array of load IDs
  const [groupOrderings, setGroupOrderings] = useState<Map<string, string[]>>(new Map())

  // Per-load slot overrides: loadId → 1–5 (free label, independent of group size)
  const [loadSlots, setLoadSlots] = useState<Map<string, number>>(new Map())

  const handleReorder = useCallback((loadId: string, newPosition: number) => {
    // Update the free slot label
    setLoadSlots((prev) => {
      const next = new Map(prev)
      next.set(loadId, newPosition)
      return next
    })

    // Also update the group stacking order
    const load = loads.find((l) => l.id === loadId)
    if (!load) return
    const key = groupKey(load)

    setGroupOrderings((prev) => {
      const groupLoads = loads.filter((l) => groupKey(l) === key)
      const base = prev.get(key) ?? naturalOrder(groupLoads)
      const presentIds = new Set(groupLoads.map((l) => l.id))
      const reconciled = base.filter((id) => presentIds.has(id))
      groupLoads.forEach((l) => { if (!reconciled.includes(l.id)) reconciled.push(l.id) })

      const without = reconciled.filter((id) => id !== loadId)
      // Clamp to actual group size for stacking purposes
      without.splice(Math.min(newPosition - 1, without.length), 0, loadId)

      const next = new Map(prev)
      next.set(key, without)
      return next
    })
  }, [loads])

  const { loadOrderMap } = useMemo(() => {
    const orderMap = new Map<string, number>()
    const sizeMap  = new Map<string, number>()

    const groups = new Map<string, Load[]>()
    loads.forEach((l) => {
      const key = groupKey(l)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(l)
    })

    groups.forEach((groupLoads, key) => {
      const storedOrder = groupOrderings.get(key)
      let orderedIds: string[]
      if (storedOrder) {
        const presentIds = new Set(groupLoads.map((l) => l.id))
        const reconciled = storedOrder.filter((id) => presentIds.has(id))
        groupLoads.forEach((l) => { if (!reconciled.includes(l.id)) reconciled.push(l.id) })
        orderedIds = reconciled
      } else {
        orderedIds = naturalOrder(groupLoads)
      }
      orderedIds.forEach((id, i) => orderMap.set(id, i + 1))
      groupLoads.forEach((l) => sizeMap.set(l.id, groupLoads.length))
    })

    return { loadOrderMap: orderMap }
  }, [loads, groupOrderings])

  // Build per-day load list — include loads whose span covers this day
  const loadsByDay = useMemo(() => {
    return days.map((day) => {
      const dayStr = chicagoDateStr(day.toISOString())
      const dayEntries: { load: Load; isContinuation: boolean }[] = []

      for (const l of loads) {
        if (!l.pickupAppt) continue
        const pickupDay   = chicagoDateStr(l.pickupAppt)
        const deliveryDay = l.deliveryAppt ? chicagoDateStr(l.deliveryAppt) : pickupDay

        if (pickupDay === dayStr) {
          dayEntries.push({ load: l, isContinuation: false })
        } else if (pickupDay < dayStr && deliveryDay >= dayStr) {
          dayEntries.push({ load: l, isContinuation: true })
        }
      }

      // Sort: primary loads first (by group + order), then continuations
      dayEntries.sort((a, b) => {
        if (a.isContinuation !== b.isContinuation) return a.isContinuation ? 1 : -1
        const keyA = groupKey(a.load), keyB = groupKey(b.load)
        if (keyA !== keyB) return keyA.localeCompare(keyB)
        return (loadOrderMap.get(a.load.id) ?? 1) - (loadOrderMap.get(b.load.id) ?? 1)
      })

      return { day, dayEntries }
    })
  }, [loads, days, loadOrderMap])

  return (
    <div className="flex h-full overflow-hidden bg-white rounded-xl">
      {loadsByDay.map(({ day, dayEntries }, colIdx) => {
        const { weekday, date } = formatDayHeader(day.toISOString())
        const isWeekend = colIdx >= 5
        const primaryCount = dayEntries.filter((e) => !e.isContinuation).length
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
              'sticky top-0 z-10 border-b border-slate-200 px-2 py-2',
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

            {/* Cards */}
            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
              {dayEntries.map(({ load, isContinuation }) => (
                <CompactCard
                  key={`${load.id}-${isContinuation ? 'cont' : 'pri'}`}
                  load={load}
                  drivers={drivers}
                  conflictIds={conflictIds}
                  orderNumber={loadSlots.get(load.id) ?? loadOrderMap.get(load.id) ?? 1}
                  isContinuation={isContinuation}
                  onReorder={handleReorder}
                />
              ))}
              {dayEntries.length === 0 && (
                <div className="text-center text-[10px] text-slate-300 pt-6 select-none">—</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
