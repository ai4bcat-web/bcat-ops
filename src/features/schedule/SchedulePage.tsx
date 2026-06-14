import { useState, useMemo } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { chicagoDateStr, formatApptTime, addDays } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { Load, Driver } from '@/types'
import {
  type StopAssignment,
  loadsForDriverOnDay, stopsForDriverOnDay, buildSmsText, buildStopSmsText,
} from './sms'

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return chicagoDateStr(new Date())
}

function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    timeZone: 'UTC',
  }).format(d)
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-9 gap-1.5 text-xs shrink-0', className)}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  )
}

// ── Driver schedule card ──────────────────────────────────────────────────────

function DriverCard({ driver, dateStr, loads, assignments }: {
  driver: Driver; dateStr: string; loads?: Load[]; assignments?: StopAssignment[]
}) {
  const multiStop = !!assignments
  const sms = useMemo(
    () => (multiStop ? buildStopSmsText(driver, assignments!, dateStr) : buildSmsText(driver, loads!, dateStr)),
    [multiStop, driver, assignments, loads, dateStr],
  )
  const isBroker = driver.type === 'broker'
  const count = multiStop ? assignments!.length : loads!.length
  const unit  = multiStop ? 'stop' : 'load'
  const hasHot = multiStop ? assignments!.some((a) => a.load.hot) : loads!.some((l) => l.hot)

  return (
    <div style={{ borderRadius: 12, border: '2px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)', background: 'var(--ds-surface)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground truncate">{driver.name}</span>
            {hasHot && (
              <span title="Has a hot load" className="shrink-0">🔥</span>
            )}
            {isBroker && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">
                Broker
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {count === 0 ? `No ${unit}s today` : `${count} ${unit}${count !== 1 ? 's' : ''}`}
          </div>
        </div>
        <CopyButton text={sms} />
      </div>

      {/* Per-stop list (multi-stop mode) */}
      {multiStop && assignments!.length > 0 && (
        <ul className="divide-y divide-border/60">
          {assignments!.map(({ load, stop }, i) => {
            const time = formatApptTime(stop.appt, stop.apptType, stop.apptEnd)
            const loc  = [stop.name, stop.city].filter(Boolean).join(', ')
            const isPickup = stop.type === 'pickup'
            const tbd = isPickup ? 'Pickup TBD' : 'Destination TBD'
            return (
              <li key={`${load.id}:${stop.id}`} className={cn('px-4 py-3', load.hot && 'bg-red-50/60')}>
                <div className="flex items-start gap-3">
                  <span className={cn(
                    'size-5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5',
                    load.hot ? 'bg-red-100 text-red-700' : 'bg-primary/10 text-primary',
                  )}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-sm font-medium text-foreground">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1.5">
                        {isPickup ? 'Pick up' : 'Deliver'}
                      </span>
                      <span className="truncate block" title={loc || tbd}>
                        {load.hot && <span title="Hot load" className="mr-1">🔥</span>}
                        {loc || <span className="text-muted-foreground">{tbd}</span>}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      <span><span className="font-medium text-foreground">{isPickup ? 'Pickup' : 'Delivery'}:</span> {time}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground font-mono">
                      <span>{load.aljexId}</span>
                      {isPickup && <span>PU# {load.pickupNumber}</span>}
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Load list (legacy whole-load mode) */}
      {!multiStop && loads!.length > 0 && (
        <ul className="divide-y divide-border/60">
          {loads!.map((load, i) => {
            const puTime = formatApptTime(load.pickupAppt,   load.pickupApptType,   load.pickupApptEnd)
            const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)
            const origin = [load.originName, load.originCity].filter(Boolean).join(', ')
            const dest   = [load.destinationName, load.destinationCity].filter(Boolean).join(', ')
            return (
              <li key={load.id} className={cn('px-4 py-3', load.hot && 'bg-red-50/60')}>
                <div className="flex items-start gap-3">
                  <span className={cn(
                    'size-5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5',
                    load.hot ? 'bg-red-100 text-red-700' : 'bg-primary/10 text-primary',
                  )}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {/* Route */}
                    <div className="text-sm font-medium text-foreground">
                      <span className="truncate block" title={origin || 'Origin TBD'}>
                        {load.hot && <span title="Hot load" className="mr-1">🔥</span>}
                        {origin || <span className="text-muted-foreground">Origin TBD</span>}
                      </span>
                      <span className="text-muted-foreground text-xs">→ </span>
                      <span className="truncate block" title={dest || 'Destination TBD'}>{dest || <span className="text-muted-foreground">Destination TBD</span>}</span>
                    </div>
                    {/* Times */}
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      <span><span className="font-medium text-foreground">Pickup:</span> {puTime}</span>
                      <span><span className="font-medium text-foreground">Delivery:</span> {deTime}</span>
                    </div>
                    {/* IDs */}
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground font-mono">
                      <span>{load.aljexId}</span>
                      <span>PU# {load.pickupNumber}</span>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* SMS preview */}
      <div style={{ borderTop: '1px solid var(--ds-border)', padding: '12px 16px', background: 'var(--ds-bg)' }}>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
          SMS Preview
        </p>
        <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap font-sans leading-relaxed select-text">
          {sms}
        </pre>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface DriverWork {
  driver: Driver
  loads?: Load[]
  assignments?: StopAssignment[]
  count: number
  sms: string
}

export function SchedulePage() {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const multiStopRender = useAppStore((s) => s.multiStopRender)
  const [dateStr, setDateStr] = useState(todayStr)

  const activeDrivers = drivers.filter((d) => d.active)

  // Only show drivers that have work on this day. In multi-stop mode "work" is the set of
  // STOPS assigned to that driver that day (a middle-delivery-only driver still shows up).
  const driversWithWork = useMemo<DriverWork[]>(() =>
    activeDrivers
      .map((d): DriverWork => {
        if (multiStopRender) {
          const assignments = stopsForDriverOnDay(loads, d.id, dateStr)
          return { driver: d, assignments, count: assignments.length, sms: buildStopSmsText(d, assignments, dateStr) }
        }
        const dl = loadsForDriverOnDay(loads, d.id, dateStr)
        return { driver: d, loads: dl, count: dl.length, sms: buildSmsText(d, dl, dateStr) }
      })
      .filter((w) => w.count > 0),
    [activeDrivers, loads, dateStr, multiStopRender]
  )

  // Drivers with no work today (collapsed section)
  const driversWithoutWork = useMemo(() =>
    activeDrivers.filter((d) => !driversWithWork.some((w) => w.driver.id === d.id)),
    [activeDrivers, driversWithWork]
  )

  const prevDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`), -1)))
  const nextDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`),  1)))
  const goToday = () => setDateStr(todayStr())

  const allSms = driversWithWork
    .map((w) => w.sms)
    .join('\n\n' + '─'.repeat(40) + '\n\n')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ds-bg)' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', minHeight: 64, borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0, overflowX: 'auto' }}>
        <MessageSquare className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold text-foreground shrink-0">Driver Schedules</span>

        <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

        {/* Date nav */}
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={prevDay} aria-label="Previous day">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-9 px-3 text-sm" onClick={goToday}>
            Today
          </Button>
          <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={nextDay} aria-label="Next day">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <span className="text-sm font-semibold text-foreground shrink-0 tabular-nums">
          {formatShortDate(dateStr)}
        </span>

        <div className="flex-1" />

        {driversWithWork.length > 0 && (
          <CopyButton text={allSms} className="shrink-0" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {driversWithWork.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <MessageSquare className="size-10 opacity-20" />
            <p className="text-sm font-medium">No loads scheduled for {formatShortDate(dateStr)}</p>
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl mx-auto">
            <p className="text-xs text-muted-foreground">
              {driversWithWork.length} driver{driversWithWork.length !== 1 ? 's' : ''} scheduled
              {driversWithoutWork.length > 0 && ` · ${driversWithoutWork.map((d) => d.name.split(' ')[0]).join(', ')} off`}
            </p>
            {driversWithWork.map((w) => (
              <DriverCard key={w.driver.id} driver={w.driver} dateStr={dateStr} loads={w.loads} assignments={w.assignments} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
