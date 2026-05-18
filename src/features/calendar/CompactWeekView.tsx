import { useMemo, useState, useCallback } from 'react'
import type { Load, Driver } from '@/types'
import {
  getFullWeek, chicagoDateStr, formatApptTime, formatDateTime, formatDayHeader,
} from '@/lib/date'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { Avatar } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckCircle2, ArrowRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/utils'

// ── Compact card ──────────────────────────────────────────────────────────────

interface CompactCardProps {
  load: Load
  drivers: Driver[]
  conflictIds: Set<string>
  orderNumber: number
  groupSize: number
  onReorder: (loadId: string, newPosition: number) => void
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, orderNumber, groupSize, onReorder }: CompactCardProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

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
  const bgColor     = isConflict ? 'rgba(239,68,68,0.06)' : isRTI ? 'rgba(22,163,74,0.06)' : color.bg
  const textColor   = isRTI ? '#15803d' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)
  const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)

  // Cycle order 1→2→…→min(groupSize,5)→1 on each click
  const cycleOrder = (e: React.MouseEvent) => {
    e.stopPropagation()
    const max = Math.min(groupSize, 5)
    if (max <= 1) return
    onReorder(load.id, (orderNumber % max) + 1)
  }

  const card = (
    <div
      className="rounded border border-l-2 px-1.5 py-1 cursor-pointer hover:brightness-105 hover:shadow-sm transition-all select-none"
      style={{
        borderColor:     isConflict ? 'rgba(239,68,68,0.3)' : isRTI ? 'rgba(22,163,74,0.3)' : '#e5e7eb',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
      }}
      onClick={() => setSelectedLoad(load.id, 'view')}
    >
      {/* Main row: left content + right column (badge above avatar) */}
      <div className="flex items-start gap-1 min-w-0">
        {/* Left: time + aljex id + RTI */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] tabular-nums text-slate-500 shrink-0 leading-none">{puTime}</span>
            <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
              {load.aljexId || <em className="text-amber-600 not-italic font-semibold">Build</em>}
            </span>
            {isRTI && <CheckCircle2 className="size-2.5 text-emerald-600 shrink-0" />}
          </div>
          {/* Line 2: origin city → destination city */}
          {(load.originCity || load.destinationCity) && (
            <div className="flex items-center gap-0.5 min-w-0 mt-0.5">
              <span className="text-[10px] text-slate-400 truncate leading-none">{load.originCity || '—'}</span>
              <ArrowRight className="size-2 shrink-0 text-slate-300" />
              <span className="text-[10px] text-slate-400 truncate leading-none">{load.destinationCity || '—'}</span>
            </div>
          )}
        </div>

        {/* Right column: order badge on top, avatar(s) below */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          {/* Order badge — click to cycle */}
          <span
            className="text-[9px] font-black rounded-full flex items-center justify-center leading-none transition-opacity hover:opacity-75"
            style={{
              background: borderColor,
              color: '#fff',
              minWidth: '14px',
              minHeight: '14px',
              padding: '0 2px',
              cursor: Math.min(groupSize, 5) > 1 ? 'pointer' : 'default',
            }}
            title={Math.min(groupSize, 5) > 1 ? 'Click to cycle order' : undefined}
            onClick={cycleOrder}
          >
            {orderNumber}
          </span>
          {/* Avatar(s) */}
          <div className="flex items-center">
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
            {!isAssigned && (
              <span className="text-[10px] font-bold text-amber-500 leading-none">!</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  if (pickingOrder) return <div>{card}</div>

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
          <span className="text-muted-foreground">RTI</span>
          <span className={isRTI ? 'text-emerald-400 font-medium' : 'text-muted-foreground'}>
            {isRTI ? 'Ready to Invoice' : 'Pending'}
          </span>
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

  const handleReorder = useCallback((loadId: string, newPosition: number) => {
    const load = loads.find((l) => l.id === loadId)
    if (!load) return
    const key = groupKey(load)

    setGroupOrderings((prev) => {
      // Get the current group (all loads with this key), compute base ordering
      const groupLoads = loads.filter((l) => groupKey(l) === key)
      const base = prev.get(key) ?? naturalOrder(groupLoads)
      // Reconcile: keep only IDs still in the group, append any new ones
      const presentIds = new Set(groupLoads.map((l) => l.id))
      const reconciled = base.filter((id) => presentIds.has(id))
      groupLoads.forEach((l) => { if (!reconciled.includes(l.id)) reconciled.push(l.id) })

      // Move loadId to newPosition (1-indexed)
      const without = reconciled.filter((id) => id !== loadId)
      without.splice(newPosition - 1, 0, loadId)

      const next = new Map(prev)
      next.set(key, without)
      return next
    })
  }, [loads])

  // Build loadOrderMap and groupSizeMap from orderings
  const { loadOrderMap, groupSizeMap } = useMemo(() => {
    const orderMap = new Map<string, number>()
    const sizeMap  = new Map<string, number>()

    // Collect all driver-day groups
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

    return { loadOrderMap: orderMap, groupSizeMap: sizeMap }
  }, [loads, groupOrderings])

  const loadsByDay = useMemo(() => {
    return days.map((day) => {
      const dayStr = chicagoDateStr(day.toISOString())
      const dayLoads = loads
        .filter((l) => !!l.pickupAppt && chicagoDateStr(l.pickupAppt) === dayStr)
        .sort((a, b) => {
          // Sort by driver group then by order within group
          const keyA = groupKey(a), keyB = groupKey(b)
          if (keyA !== keyB) return keyA.localeCompare(keyB)
          return (loadOrderMap.get(a.id) ?? 1) - (loadOrderMap.get(b.id) ?? 1)
        })
      return { day, dayLoads }
    })
  }, [loads, days, loadOrderMap])

  return (
    <div className="flex h-full overflow-hidden bg-white rounded-xl">
      {loadsByDay.map(({ day, dayLoads }, colIdx) => {
        const { weekday, date } = formatDayHeader(day.toISOString())
        const isWeekend = colIdx >= 5 // Sat + Sun are index 5 and 6
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
              {dayLoads.length > 0 && (
                <div className="text-[9px] font-semibold text-slate-400 mt-0.5">
                  {dayLoads.length} load{dayLoads.length !== 1 ? 's' : ''}
                </div>
              )}
            </div>

            {/* Compact cards stacked top-to-bottom */}
            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
              {dayLoads.map((load) => (
                <CompactCard
                  key={load.id}
                  load={load}
                  drivers={drivers}
                  conflictIds={conflictIds}
                  orderNumber={loadOrderMap.get(load.id) ?? 1}
                  groupSize={groupSizeMap.get(load.id) ?? 1}
                  onReorder={handleReorder}
                />
              ))}
              {dayLoads.length === 0 && (
                <div className="text-center text-[10px] text-slate-300 pt-6 select-none">—</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
