import { AlertTriangle, CheckCircle2, Clock, ArrowRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar } from '@/components/ui/avatar'
import type { Load, Driver } from '@/types'
import type { DriverColor } from '@/lib/driverColors'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { formatApptTime, formatDateTime, isSameChicagoDay } from '@/lib/date'
import { cn } from '@/lib/utils'

interface EventCardProps {
  load: Load
  drivers: Driver[]
  color: DriverColor
  isConflict: boolean
  isSelected: boolean
  orderNumber: number
  onContextMenu: (e: React.MouseEvent) => void
}

export function EventCard({ load, drivers, color, isConflict, isSelected, orderNumber, onContextMenu }: EventCardProps) {
  const isRTI = load.readyToInvoice
  const isSplit = load.pickupDriverId !== load.deliveryDriverId && load.deliveryDriverId !== null
  const isMultiDay = !isSameChicagoDay(load.pickupAppt, load.deliveryAppt)
  const isFCFS = load.pickupApptType === 'fcfs'

  const pickupDriver = drivers.find((d) => d.id === load.pickupDriverId)
  const deliveryDriver = drivers.find((d) => d.id === load.deliveryDriverId)
  const deliveryColor = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR
  const pickupDriverName = pickupDriver?.name ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  // Dark-optimised colors
  const borderColor = isConflict ? '#f87171' : isRTI ? '#4ade80' : color.border
  const bgColor     = isConflict ? 'rgba(248,113,113,0.18)' : isRTI ? 'rgba(74,222,128,0.15)' : color.bg
  const textColor   = isRTI ? '#86efac' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)
  const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)

  const card = (
    <div
      className={cn(
        'h-full w-full rounded-md border border-l-[3px] overflow-hidden',
        'transition-shadow cursor-pointer',
        'hover:shadow-lg hover:brightness-110',
        isSelected && 'ring-2 ring-blue-400 ring-offset-1 ring-offset-[#07122b]',
        isConflict && 'animate-pulse-once',
      )}
      style={{
        borderColor:     isConflict ? 'rgba(248,113,113,0.35)' : isRTI ? 'rgba(74,222,128,0.3)' : '#1e3a6b',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        ...(isSplit ? { borderRightColor: deliveryColor.border, borderRightWidth: 3 } : {}),
      }}
      onContextMenu={onContextMenu}
    >
      <div className="px-2 py-1.5 h-full flex flex-col justify-between gap-0.5 overflow-hidden">

        {/* Top row: order badge + time + PU# */}
        <div className="flex items-baseline justify-between gap-1 min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span
              className="text-[10px] font-black shrink-0 size-4 rounded-full flex items-center justify-center leading-none"
              style={{ background: borderColor, color: '#07122b', minWidth: '16px', minHeight: '16px', lineHeight: 1 }}
            >
              {orderNumber}
            </span>
            <span
              className={cn('text-[11px] font-bold truncate', isFCFS && 'tracking-wide uppercase text-[10px]')}
              style={{ color: '#ffffff' }}
              title={puTime}
            >
              {puTime}
            </span>
          </div>
          <span className="text-[10px] font-mono shrink-0" style={{ color: 'rgba(203,213,225,0.8)' }} title={load.pickupNumber}>
            {load.pickupNumber}
          </span>
        </div>

        {/* ALJEX ID */}
        <span
          className="text-xs font-bold truncate leading-tight"
          style={{ color: textColor }}
          title={load.aljexId}
        >
          {load.aljexId}
        </span>

        {/* Driver name + avatar */}
        <div
          className="flex items-center gap-1 min-w-0"
          title={isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}
        >
          <Avatar
            src={pickupDriver?.photoUrl}
            initials={(pickupDriverName.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()) || '?'}
            size="xs"
            className="shrink-0"
          />
          <span
            className="text-[10px] font-semibold truncate leading-tight"
            style={{ color: '#e2e8f0' }}
          >
            {isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}
          </span>
        </div>

        {/* Origin name · city */}
        {(load.originName || load.originCity) && (
          <div
            className="text-[10px] leading-tight truncate font-medium"
            style={{ color: '#cbd5e1' }}
            title={[load.originName, load.originCity].filter(Boolean).join(' · ')}
          >
            {load.originName}
            {load.originCity && <span style={{ color: '#94a3b8' }}> · {load.originCity}</span>}
          </div>
        )}

        {/* Destination name · city */}
        {(load.destinationName || load.destinationCity) && (
          <div className="flex items-center gap-0.5 min-w-0" title={[load.destinationName, load.destinationCity].filter(Boolean).join(' · ')}>
            <ArrowRight className="size-2.5 shrink-0" style={{ color: '#5b9bff' }} />
            <span
              className="text-[10px] leading-tight truncate font-medium"
              style={{ color: '#cbd5e1' }}
            >
              {load.destinationName}
              {load.destinationCity && <span style={{ color: '#94a3b8' }}> · {load.destinationCity}</span>}
            </span>
          </div>
        )}

        {/* Bottom: TMS ID + delivery time */}
        <div className="flex items-center gap-0.5 min-w-0">
          <span className="text-[10px] font-mono truncate" style={{ color: '#94a3b8' }} title={load.tmsId}>{load.tmsId}</span>
          <ArrowRight className="size-2.5 shrink-0" style={{ color: '#5b9bff' }} />
          <span className="text-[10px] truncate font-medium" style={{ color: '#e2e8f0' }} title={deTime}>{deTime}</span>
        </div>
      </div>

      {/* Top-right badges: conflict + multi-day */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5">
        {isConflict && <AlertTriangle className="size-3 text-red-400" />}
        {isMultiDay && <Clock         className="size-3" style={{ color: '#64748b' }} />}
      </div>

      {/* Bottom-right: RTI checkmark */}
      {isRTI && (
        <div className="absolute bottom-1 right-1">
          <CheckCircle2 className="size-3.5 text-emerald-400" />
        </div>
      )}
    </div>
  )

  const tooltipApptLine = (label: string, appt: string, type?: string, apptEnd?: string) => {
    const display = formatApptTime(appt, type, apptEnd)
    const full = formatDateTime(appt)
    return (
      <>
        <span className="text-muted-foreground">{label}</span>
        <span>{type === 'fcfs' ? 'FCFS (any time)' : type === 'range' && apptEnd ? `${display} · ${full.split(',')[0]}` : full}</span>
      </>
    )
  }

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <div className="h-full w-full relative">{card}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] text-xs space-y-1.5 p-3">
        <div className="font-bold text-sm text-white">{load.aljexId}</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">TMS / PO</span><span>{load.tmsId}</span>
          <span className="text-muted-foreground">PU #</span><span>{load.pickupNumber}</span>
          {load.originCity && (
            <><span className="text-muted-foreground">Origin</span>
            <span>{[load.originName, load.originCity].filter(Boolean).join(' · ')}</span></>
          )}
          {load.destinationCity && (
            <><span className="text-muted-foreground">Dest</span>
            <span>{[load.destinationName, load.destinationCity].filter(Boolean).join(' · ')}</span></>
          )}
          {tooltipApptLine('Pickup', load.pickupAppt, load.pickupApptType, load.pickupApptEnd)}
          {tooltipApptLine('Delivery', load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)}
          <span className="text-muted-foreground">PU Driver</span><span>{pickupDriverName}</span>
          {isSplit && <><span className="text-muted-foreground">DE Driver</span><span>{deliveryDriverName}</span></>}
          <span className="text-muted-foreground">RTI</span>
          <span className={isRTI ? 'text-emerald-400 font-medium' : 'text-muted-foreground'}>
            {isRTI ? 'Ready to Invoice' : 'Pending'}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
