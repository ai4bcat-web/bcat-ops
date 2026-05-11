import { useState, useMemo } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { chicagoDateStr, formatApptTime, addDays } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { Load, Driver } from '@/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return chicagoDateStr(new Date())
}

function formatFullDate(dateStr: string): string {
  // dateStr = "YYYY-MM-DD"
  const d = new Date(`${dateStr}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
    timeZone: 'UTC',
  }).format(d)
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

function loadsForDriverOnDay(loads: Load[], driverId: string, dateStr: string): Load[] {
  return loads
    .filter((l) => l.pickupDriverId === driverId && chicagoDateStr(l.pickupAppt) === dateStr)
    .sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
}

function buildSmsText(driver: Driver, loads: Load[], dateStr: string): string {
  const date = formatFullDate(dateStr)
  const first = driver.name.split(' ')[0]

  if (loads.length === 0) {
    return `Hi ${first}! No loads scheduled for ${date}.\n\n- BCAT Dispatch`
  }

  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
  const loadSentences = loads.map((load, i) => {
    const puTime = formatApptTime(load.pickupAppt,   load.pickupApptType,   load.pickupApptEnd)
    const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)
    const origin = [load.originName, load.originCity].filter(Boolean).join(' in ') || 'Origin TBD'
    const dest   = [load.destinationName, load.destinationCity].filter(Boolean).join(' in ') || 'Destination TBD'
    const ord    = ordinals[i] ?? `#${i + 1}`
    const verb   = i === 0 ? 'First' : ord.charAt(0).toUpperCase() + ord.slice(1)
    return `${verb}, pick up at ${origin} at ${puTime} and deliver to ${dest} by ${deTime} (Load: ${load.aljexId}, PU#: ${load.pickupNumber}).`
  })

  const count = loads.length === 1 ? '1 load' : `${loads.length} loads`
  return `Hi ${first}! Here's your schedule for ${date}. You have ${count} today.\n\n${loadSentences.join(' ')}\n\n- BCAT Dispatch`
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
      className={cn('h-8 gap-1.5 text-xs shrink-0', className)}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  )
}

// ── Driver schedule card ──────────────────────────────────────────────────────

function DriverCard({ driver, loads, dateStr }: { driver: Driver; loads: Load[]; dateStr: string }) {
  const sms = useMemo(() => buildSmsText(driver, loads, dateStr), [driver, loads, dateStr])
  const isBroker = driver.type === 'broker'

  return (
    <div className="rounded-lg border border-border overflow-hidden shadow-sm" style={{ background: '#0d1d3d' }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border" style={{ background: 'rgba(74,142,239,0.06)' }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground truncate">{driver.name}</span>
            {isBroker && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">
                Broker
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {loads.length === 0 ? 'No loads today' : `${loads.length} load${loads.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <CopyButton text={sms} />
      </div>

      {/* Load list */}
      {loads.length > 0 && (
        <ul className="divide-y divide-border/60">
          {loads.map((load, i) => {
            const puTime = formatApptTime(load.pickupAppt,   load.pickupApptType,   load.pickupApptEnd)
            const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)
            const origin = [load.originName, load.originCity].filter(Boolean).join(', ')
            const dest   = [load.destinationName, load.destinationCity].filter(Boolean).join(', ')
            return (
              <li key={load.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="size-5 rounded-full bg-primary/10 text-primary text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {/* Route */}
                    <div className="text-sm font-medium text-foreground">
                      <span className="truncate block" title={origin || 'Origin TBD'}>{origin || <span className="text-muted-foreground">Origin TBD</span>}</span>
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
      <div className="border-t border-border px-4 py-3" style={{ background: 'rgba(74,142,239,0.03)' }}>
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

export function SchedulePage() {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const [dateStr, setDateStr] = useState(todayStr)

  const activeDrivers = drivers.filter((d) => d.active)

  // Only show drivers that have loads on this day
  const driversWithLoads = useMemo(() =>
    activeDrivers
      .map((d) => ({ driver: d, loads: loadsForDriverOnDay(loads, d.id, dateStr) }))
      .filter(({ loads: l }) => l.length > 0),
    [activeDrivers, loads, dateStr]
  )

  // Drivers with no loads today (collapsed section)
  const driversWithoutLoads = useMemo(() =>
    activeDrivers.filter((d) => !driversWithLoads.some(({ driver }) => driver.id === d.id)),
    [activeDrivers, driversWithLoads]
  )

  const prevDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`), -1)))
  const nextDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`),  1)))
  const goToday = () => setDateStr(todayStr())

  const allSms = driversWithLoads
    .map(({ driver, loads: l }) => buildSmsText(driver, l, dateStr))
    .join('\n\n' + '─'.repeat(40) + '\n\n')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 h-13 min-h-[52px] border-b border-border shrink-0 overflow-x-auto" style={{ background: 'linear-gradient(180deg,#0e2454 0%,#07122b 100%)' }}>
        <MessageSquare className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold text-foreground shrink-0">Driver Schedules</span>

        <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

        {/* Date nav */}
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={prevDay} aria-label="Previous day">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8 px-3 text-sm" onClick={goToday}>
            Today
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={nextDay} aria-label="Next day">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <span className="text-sm font-semibold text-foreground shrink-0 tabular-nums">
          {formatShortDate(dateStr)}
        </span>

        <div className="flex-1" />

        {driversWithLoads.length > 0 && (
          <CopyButton text={allSms} className="shrink-0" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {driversWithLoads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <MessageSquare className="size-10 opacity-20" />
            <p className="text-sm font-medium">No loads scheduled for {formatShortDate(dateStr)}</p>
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl mx-auto">
            <p className="text-xs text-muted-foreground">
              {driversWithLoads.length} driver{driversWithLoads.length !== 1 ? 's' : ''} scheduled
              {driversWithoutLoads.length > 0 && ` · ${driversWithoutLoads.map((d) => d.name.split(' ')[0]).join(', ')} off`}
            </p>
            {driversWithLoads.map(({ driver, loads: l }) => (
              <DriverCard key={driver.id} driver={driver} loads={l} dateStr={dateStr} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
