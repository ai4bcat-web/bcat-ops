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
  onEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function EventCard({ load, drivers, color, isConflict, isSelected, orderNumber, onEdit, onContextMenu }: EventCardProps) {
  const isRTI    = load.readyToInvoice
  const isSplit  = load.pickupDriverId !== load.deliveryDriverId && !!load.deliveryDriverId
  const isMultiDay = !isSameChicagoDay(load.pickupAppt, load.deliveryAppt)

  const pickupDriver       = drivers.find((d) => d.id === load.pickupDriverId)
  const deliveryDriver     = isSplit ? drivers.find((d) => d.id === load.deliveryDriverId) : undefined
  const deliveryColor      = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR
  const pickupDriverName   = pickupDriver?.name  ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  const borderColor = isConflict ? '#ef4444' : isRTI ? '#15803d' : color.border
  const bgColor     = isConflict ? 'rgba(239,68,68,0.08)' : isRTI ? '#22c55e' : color.bg
  const textColor   = isRTI ? '#fff' : color.text

  const puTime = formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)

  const card = (
    <div
      className={cn(
        'h-full w-full rounded-md border border-l-[3px] overflow-hidden relative',
        'transition-shadow cursor-pointer hover:shadow-lg hover:brightness-110',
        isSelected && 'ring-2 ring-offset-1',
        isConflict && 'animate-pulse-once',
      )}
      style={{
        borderColor:     isConflict ? 'rgba(239,68,68,0.3)' : isRTI ? '#15803d' : '#e5e5e2',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        ...(isSplit ? { borderRightColor: deliveryColor.border, borderRightWidth: 3 } : {}),
      }}
      onContextMenu={onContextMenu}
    >
      <div className="px-2 py-1.5 h-full flex flex-col gap-0.5 overflow-hidden">

        {/* Row 1: ALJEX ID (primary) — or amber CTA if missing */}
        <div className="flex items-center justify-between gap-1 min-w-0">
          {load.aljexId ? (
            <span className="text-xs font-bold truncate leading-tight" style={{ color: textColor }} title={load.aljexId}>
              {load.aljexId}
            </span>
          ) : (
            <button
              className="text-[11px] font-semibold italic truncate text-amber-600 underline underline-offset-2 hover:text-amber-700"
              onClick={(e) => { e.stopPropagation(); onEdit() }}
            >
              Need to build
            </button>
          )}
          <span
            className="text-[9px] font-black shrink-0 rounded-full flex items-center justify-center leading-none"
            style={{ background: borderColor, color: '#fff', minWidth: '14px', minHeight: '14px', padding: '0 2px' }}
          >
            {orderNumber}
          </span>
        </div>

        {/* Row 2: TMS ID → PU# */}
        <div className="flex items-center gap-0.5 min-w-0">
          <span className="text-[10px] font-mono truncate" style={{ color: '#6b7280' }}>{load.tmsId}</span>
          <ArrowRight className="size-2 shrink-0" style={{ color: '#9ca3af' }} />
          <span className="text-[10px] font-mono truncate" style={{ color: '#6b7280' }}>{load.pickupNumber}</span>
        </div>

        {/* Origin */}
        {(load.originName || load.originCity) && (
          <div className="text-[10px] leading-tight truncate" style={{ color: '#374151' }}
            title={[load.originName, load.originCity].filter(Boolean).join(' · ')}>
            {load.originName}
            {load.originCity && <span style={{ color: '#6b7280' }}> · {load.originCity}</span>}
          </div>
        )}

        {/* Destination */}
        {(load.destinationName || load.destinationCity) && (
          <div className="flex items-center gap-0.5 min-w-0"
            title={[load.destinationName, load.destinationCity].filter(Boolean).join(' · ')}>
            <ArrowRight className="size-2 shrink-0" style={{ color: '#2563eb' }} />
            <span className="text-[10px] leading-tight truncate" style={{ color: '#374151' }}>
              {load.destinationName}
              {load.destinationCity && <span style={{ color: '#6b7280' }}> · {load.destinationCity}</span>}
            </span>
          </div>
        )}

        <div className="flex-1" />

        {/* Bottom row: time (left) · RTI icon + driver avatar + name (right) */}
        <div className="flex items-center justify-between gap-1 min-w-0">
          <span className="text-[10px] shrink-0 tabular-nums" style={{ color: '#6b7280' }}>{puTime}</span>
          <div className="flex items-center gap-1 min-w-0 overflow-hidden"
            title={isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}>
            {isRTI && <CheckCircle2 className="size-3 shrink-0" style={{ color: '#fff' }} />}
            {load.pickupDriverId ? (
              <>
                <Avatar
                  src={pickupDriver?.photoUrl}
                  initials={(pickupDriverName.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()) || '?'}
                  size="xs"
                  className="shrink-0"
                  style={{ background: borderColor, color: '#ffffff' }}
                />
                {isSplit && deliveryDriver && (
                  <Avatar
                    src={deliveryDriver.photoUrl}
                    initials={(deliveryDriverName.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()) || '?'}
                    size="xs"
                    className="shrink-0 -ml-1"
                    style={{ background: deliveryColor.border, color: '#ffffff' }}
                  />
                )}
              </>
            ) : (
              <span className="text-[10px] font-medium text-amber-500 shrink-0">Unassigned</span>
            )}
          </div>
        </div>
      </div>

      {/* Top-right: conflict + multi-day badges */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 pointer-events-none">
        {isConflict && <AlertTriangle className="size-3 text-red-500" />}
        {isMultiDay  && <Clock className="size-3" style={{ color: '#9ca3af' }} />}
      </div>
    </div>
  )

  const tooltipApptLine = (label: string, appt: string, type?: string, apptEnd?: string) => {
    const display = formatApptTime(appt, type, apptEnd)
    if (type === 'tbd') return (
      <><span className="text-muted-foreground">{label}</span><span>TBD</span></>
    )
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
