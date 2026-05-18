import { useMemo } from 'react'
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
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

function CompactCard({ load, drivers, conflictIds, orderNumber }: CompactCardProps) {
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
      {/* Line 1: time · aljex id · RTI · driver avatar(s) */}
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-[10px] tabular-nums text-slate-500 shrink-0 leading-none">{puTime}</span>
        <span className="flex-1 text-[11px] font-bold truncate leading-none" style={{ color: textColor }}>
          {load.aljexId || <em className="text-amber-600 not-italic font-semibold">Build</em>}
        </span>
        <span
          className="text-[9px] font-black shrink-0 rounded-full flex items-center justify-center leading-none"
          style={{ background: borderColor, color: '#fff', minWidth: '14px', minHeight: '14px', padding: '0 2px' }}
        >
          {orderNumber}
        </span>
        {isRTI && <CheckCircle2 className="size-2.5 text-emerald-600 shrink-0" />}
        {/* Pickup driver avatar */}
        <Avatar
          src={pickupDriver?.photoUrl}
          initials={initials(pickupDriverName)}
          size="xs"
          className="shrink-0"
          style={{ background: borderColor, color: '#fff' }}
        />
        {/* Delivery driver avatar — only for split loads */}
        {isSplit && deliveryDriver && (
          <Avatar
            src={deliveryDriver.photoUrl}
            initials={initials(deliveryDriverName)}
            size="xs"
            className="shrink-0 -ml-1"
            style={{ background: deliveryColor.border, color: '#fff' }}
          />
        )}
        {/* Amber "!" flag when unassigned */}
        {!isAssigned && (
          <span className="text-[10px] font-bold text-amber-500 shrink-0 leading-none">!</span>
        )}
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
  )

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

export function CompactWeekView({ loads, drivers, conflictIds, weekStart }: CompactWeekViewProps) {
  const days = getFullWeek(weekStart) // [Mon … Sun]

  // Order number per load: sequence # within driver's day (sorted by pickupAppt)
  const loadOrderMap = useMemo(() => {
    const map = new Map<string, number>()
    const groups = new Map<string, Load[]>()
    loads.forEach((l) => {
      const date = chicagoDateStr(l.pickupAppt)
      const key = `${l.pickupDriverId ?? 'unassigned'}-${date}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(l)
    })
    groups.forEach((group) => {
      group
        .sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
        .forEach((l, i) => map.set(l.id, i + 1))
    })
    return map
  }, [loads])

  const loadsByDay = useMemo(() => {
    return days.map((day) => {
      const dayStr = chicagoDateStr(day.toISOString())
      const dayLoads = loads
        .filter((l) => !!l.pickupAppt && chicagoDateStr(l.pickupAppt) === dayStr)
        .sort((a, b) => {
          // TBD/invalid → sort to end
          const at = !a.pickupAppt || !a.pickupAppt.startsWith('2') ? 'ZZZZ' : a.pickupAppt
          const bt = !b.pickupAppt || !b.pickupAppt.startsWith('2') ? 'ZZZZ' : b.pickupAppt
          return at.localeCompare(bt)
        })
      return { day, dayLoads }
    })
  }, [loads, days])

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
                <CompactCard key={load.id} load={load} drivers={drivers} conflictIds={conflictIds} orderNumber={loadOrderMap.get(load.id) ?? 1} />
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
