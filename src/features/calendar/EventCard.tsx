import { AlertTriangle, CheckCircle2, Clock, ArrowRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar } from '@/components/ui/avatar'
import type { Load, Driver, Stop } from '@/types'
import type { DriverColor } from '@/lib/driverColors'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import { formatApptTime, formatDateTime, isSameChicagoDay } from '@/lib/date'
import { cn } from '@/lib/utils'

interface EventCardProps {
  load: Load
  stop?: Stop  // multi-stop mode: this card is ONE stop (its own driver/appt/location)
  drivers: Driver[]
  color: DriverColor
  isConflict: boolean
  isSelected: boolean
  orderNumber: number
  onEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function EventCard({ load, stop, drivers, color, isConflict, isSelected, orderNumber, onEdit, onContextMenu }: EventCardProps) {
  const stopMode = !!stop
  const isRTI    = load.readyToInvoice
  // A single stop has exactly one driver and one day — no split / multi-day decorations.
  const isSplit  = stopMode ? false : (load.pickupDriverId !== load.deliveryDriverId && !!load.deliveryDriverId)
  const isMultiDay = stopMode ? false : !isSameChicagoDay(load.pickupAppt, load.deliveryAppt)

  const primaryDriverId    = stopMode ? stop!.driverId : load.pickupDriverId
  const pickupDriver       = drivers.find((d) => d.id === primaryDriverId)
  const deliveryDriver     = isSplit ? drivers.find((d) => d.id === load.deliveryDriverId) : undefined
  const deliveryColor      = deliveryDriver?.colorKey ? getColor(deliveryDriver.colorKey) : UNASSIGNED_COLOR
  const pickupDriverName   = pickupDriver?.name  ?? 'Unassigned'
  const deliveryDriverName = deliveryDriver?.name ?? 'Unassigned'

  const borderColor = isConflict ? 'var(--tms-badge-red)' : isRTI ? 'var(--tms-primary-ink)' : color.border
  const bgColor     = isConflict ? 'var(--tms-badge-red-tint)' : isRTI ? 'var(--tms-primary)' : color.bg
  const textColor   = isRTI ? 'var(--tms-on-primary)' : color.text

  const puTime = stopMode
    ? formatApptTime(stop!.appt, stop!.apptType, stop!.apptEnd)
    : formatApptTime(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)

  const card = (
    <div
      className={cn(
        'h-full w-full rounded-md border-2 border-l-[3px] overflow-hidden relative',
        'transition-shadow cursor-pointer hover:shadow-lg hover:brightness-110',
        isSelected && 'ring-2 ring-offset-1',
        isConflict && 'animate-pulse-once',
      )}
      style={{
        borderColor:     isConflict ? 'color-mix(in srgb, var(--tms-badge-red) 30%, transparent)' : isRTI ? 'var(--tms-primary-ink)' : 'var(--tms-text)',
        borderLeftColor: borderColor,
        backgroundColor: bgColor,
        ...(isSplit ? { borderRightColor: deliveryColor.border, borderRightWidth: 3 } : {}),
      }}
      onContextMenu={onContextMenu}
    >
      <div className="px-2 py-1.5 h-full flex flex-col gap-0.5 overflow-hidden">

        {/* Row 1: ALJEX ID (primary) — or amber CTA if missing */}
        <div className="flex items-center justify-between gap-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            {load.hot && (
              <span className="shrink-0 text-xs leading-none" title="Hot load">🔥</span>
            )}
            {load.aljexId ? (
              <span className="text-xs font-bold truncate leading-tight" style={{ color: textColor }} title={load.aljexId}>
                {load.aljexId}
              </span>
            ) : (
              <button
                className="text-[11px] font-semibold italic truncate text-[color:var(--tms-badge-orange)] underline underline-offset-2 hover:text-[color:var(--tms-badge-orange)]"
                onClick={(e) => { e.stopPropagation(); onEdit() }}
              >
                Need to build
              </button>
            )}
          </div>
          <span
            className="text-[9px] font-black shrink-0 rounded-full flex items-center justify-center leading-none"
            style={{ background: borderColor, color: 'var(--tms-on-primary)', minWidth: '14px', minHeight: '14px', padding: '0 2px' }}
          >
            {orderNumber}
          </span>
        </div>

        {/* Row 2: TMS ID → PU# */}
        <div className="flex items-center gap-0.5 min-w-0">
          <span className="text-[10px] font-mono truncate" style={{ color: 'var(--tms-muted)' }}>{load.tmsId}</span>
          <ArrowRight className="size-2 shrink-0" style={{ color: 'var(--tms-disabled)' }} />
          <span className="text-[10px] font-mono truncate" style={{ color: 'var(--tms-muted)' }}>{load.pickupNumber}</span>
        </div>

        {stopMode ? (
          /* Single stop location — delivery stops get the arrow marker */
          (stop!.name || stop!.city) && (
            <div className="flex items-center gap-0.5 min-w-0"
              title={[stop!.name, stop!.city].filter(Boolean).join(' · ')}>
              {stop!.type === 'delivery' && <ArrowRight className="size-2 shrink-0" style={{ color: 'var(--tms-badge-blue)' }} />}
              <span className="text-[10px] leading-tight truncate" style={{ color: 'var(--tms-text-2)' }}>
                {stop!.name}
                {stop!.city && <span style={{ color: 'var(--tms-muted)' }}> · {stop!.city}</span>}
              </span>
            </div>
          )
        ) : (
          <>
            {/* Origin */}
            {(load.originName || load.originCity) && (
              <div className="text-[10px] leading-tight truncate" style={{ color: 'var(--tms-text-2)' }}
                title={[load.originName, load.originCity].filter(Boolean).join(' · ')}>
                {load.originName}
                {load.originCity && <span style={{ color: 'var(--tms-muted)' }}> · {load.originCity}</span>}
              </div>
            )}

            {/* Destination */}
            {(load.destinationName || load.destinationCity) && (
              <div className="flex items-center gap-0.5 min-w-0"
                title={[load.destinationName, load.destinationCity].filter(Boolean).join(' · ')}>
                <ArrowRight className="size-2 shrink-0" style={{ color: 'var(--tms-badge-blue)' }} />
                <span className="text-[10px] leading-tight truncate" style={{ color: 'var(--tms-text-2)' }}>
                  {load.destinationName}
                  {load.destinationCity && <span style={{ color: 'var(--tms-muted)' }}> · {load.destinationCity}</span>}
                </span>
              </div>
            )}
          </>
        )}

        <div className="flex-1" />

        {/* Bottom row: time (left) · RTI icon + driver avatar + name (right) */}
        <div className="flex items-center justify-between gap-1 min-w-0">
          <span className="text-[10px] shrink-0 tabular-nums" style={{ color: 'var(--tms-muted)' }}>{puTime}</span>
          <div className="flex items-center gap-1 min-w-0 overflow-hidden"
            title={isSplit ? `${pickupDriverName} → ${deliveryDriverName}` : pickupDriverName}>
            {isRTI && <CheckCircle2 className="size-3 shrink-0" style={{ color: 'var(--tms-on-primary)' }} />}
            {primaryDriverId ? (
              <>
                <Avatar
                  src={pickupDriver?.photoUrl}
                  initials={(pickupDriverName.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()) || '?'}
                  size="xs"
                  className="shrink-0"
                  style={{ background: borderColor, color: 'var(--tms-on-primary)' }}
                />
                {isSplit && deliveryDriver && (
                  <Avatar
                    src={deliveryDriver.photoUrl}
                    initials={(deliveryDriverName.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()) || '?'}
                    size="xs"
                    className="shrink-0 -ml-1"
                    style={{ background: deliveryColor.border, color: 'var(--tms-on-primary)' }}
                  />
                )}
              </>
            ) : (
              <span className="text-[10px] font-medium text-[color:var(--tms-badge-orange)] shrink-0">Unassigned</span>
            )}
          </div>
        </div>
      </div>

      {/* Top-right: conflict + multi-day badges */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 pointer-events-none">
        {isConflict && <AlertTriangle className="size-3 text-[color:var(--tms-badge-red)]" />}
        {isMultiDay  && <Clock className="size-3" style={{ color: 'var(--tms-disabled)' }} />}
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
        <div className="font-bold text-sm text-[color:var(--tms-on-primary)]">{load.aljexId}</div>
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
          <span className={isRTI ? 'text-[color:var(--tms-badge-green)] font-medium' : 'text-muted-foreground'}>
            {isRTI ? 'Ready to Invoice' : 'Pending'}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
