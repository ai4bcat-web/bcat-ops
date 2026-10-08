/**
 * Ivan paperwork — the driver's home when they are on Ivan's own fleet.
 *
 * One day at a time. The sheet is the pickups and deliveries on the day shown — today
 * when the app opens — each with its status, its detention box and, at a delivery, the
 * POD. Back and forward step a day; the calendar jumps to one, to find the POD from a
 * particular delivery. Never past today: a driver has no paperwork for a load they have
 * not run yet, and the API does not hand those out.
 *
 * Same app as the owner operators' settlement so there is one app to explain, and
 * deliberately none of its money: no rate, no deductions, no check.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Loader2, RefreshCcw, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchPaperwork, type Paperwork } from '../driverApi'
import { TodayStops } from './TodayStops'
import { DayLogs } from './DayLogs'
import { UnattachedPods } from '../UnattachedPods'
import { weekStartOfISO } from '@/features/driver-pay/week'
import { chicagoDateStr } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { useDriverPm } from '../useDriverProgram'
import { PmGauge } from './PmGauge'
import { stopsForDay } from './daySheet'
import { TruckLine } from '../TruckPicker'

/**
 * When this driver's truck is next due a PM.
 *
 * On the home screen rather than buried in Account, because the point is that a driver sees
 * it without going looking. Overdue is red and due-soon amber; a PM that is simply a long
 * way off still shows, quietly, so "when is my next PM" always has an answer here.
 */
function PmLine() {
  const pm = useDriverPm()
  if (!pm) return null
  return <PmGauge pm={pm} />
}

/** "Tue, Oct 7" from a YYYY-MM-DD. */
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

export function PaperworkPage() {
  const navigate = useNavigate()
  const today = useMemo(() => chicagoDateStr(new Date()), [])
  const [day, setDay] = useState(today)
  const [week, setWeek] = useState<Paperwork | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const dateInput = useRef<HTMLInputElement>(null)

  // The sheet is built from the week that holds the day; stepping within a week is free.
  const weekStart = weekStartOfISO(day)
  useEffect(() => {
    let stale = false
    fetchPaperwork(weekStart)
      .then((w) => { if (!stale) { setWeek(w); setError(null) } })
      .catch((err) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [weekStart, retryKey])

  const reload = useCallback(() => setRetryKey((k) => k + 1), [])

  const sendPod = useCallback(
    (load: { id: string; reference: string }) =>
      navigate(`/driver/scan?kind=pod&ref=${encodeURIComponent(load.reference)}&loadId=${encodeURIComponent(load.id)}`),
    [navigate],
  )

  const addPhotos = useCallback(
    (load: { id: string; reference: string }, stop: { id: string; type: string; name: string | null }) => {
      const label = `${stop.type.toLowerCase() === 'delivery' ? 'Delivery' : 'Pickup'}${stop.name ? ` — ${stop.name}` : ''}`
      const q = new URLSearchParams({ kind: 'misc', ref: load.reference, loadId: load.id, stopId: stop.id, stopLabel: label })
      navigate(`/driver/scan?${q.toString()}`)
    },
    [navigate],
  )

  const loaded = week !== null && week.weekStart === weekStart
  const loading = !loaded && error === null
  const isToday = day === today
  const dayLoads = useMemo(
    () => (loaded ? [...new Set(stopsForDay(week.loads, day).map((i) => i.load))] : []),
    [loaded, week, day],
  )

  if (error && !loaded) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden="true" />
        <p className="font-medium text-foreground">{error}</p>
        <Button onClick={() => { setError(null); reload() }} className="h-11 gap-2 px-6">
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-4 text-xl font-bold text-foreground">Dashboard</h1>

      {/* First thing in the morning: which truck, so the ELD and the map follow the driver. */}
      <TruckLine />

      <PmLine />

      {/* The day, and the three ways to change it: back, forward, pick. */}
      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="outline"
          className="h-12 w-12 shrink-0 p-0"
          aria-label="Previous day"
          onClick={() => setDay((d) => shiftDay(d, -1))}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </Button>
        <button
          type="button"
          className="flex h-12 min-w-0 flex-1 flex-col items-center justify-center rounded-md border border-input bg-card px-2"
          aria-label="Pick a day"
          onClick={() => {
            const el = dateInput.current
            if (!el) return
            if (typeof el.showPicker === 'function') el.showPicker()
            else el.click()
          }}
        >
          <span className="flex items-center gap-1.5 text-base font-bold leading-tight text-foreground">
            <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
            {isToday ? 'Today' : dayLabel(day)}
          </span>
          <span className="text-xs text-muted-foreground">{isToday ? dayLabel(day) : 'tap to pick a day'}</span>
        </button>
        <input
          ref={dateInput}
          type="date"
          aria-label="Day"
          className="sr-only"
          value={day}
          max={today}
          onChange={(e) => { if (e.target.value && e.target.value <= today) setDay(e.target.value) }}
        />
        <Button
          variant="outline"
          className="h-12 w-12 shrink-0 p-0"
          aria-label="Next day"
          disabled={isToday || day > today}
          onClick={() => setDay((d) => shiftDay(d, 1))}
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <p>Loading your day…</p>
        </div>
      )}

      {loaded && (
        <>
          {/* What the week still owes, so a missed POD from Tuesday is not lost by Friday. */}
          {week.podsMissing > 0 && (
            <p className="mb-3 text-sm font-semibold text-amber-200">
              {week.podsMissing} load{week.podsMissing === 1 ? '' : 's'} this week still need{week.podsMissing === 1 ? 's' : ''} a POD
              {week.podsIllegible > 0 ? ` · ${week.podsIllegible} cannot be read` : ''}
            </p>
          )}
          {week.podsMissing === 0 && week.podsIllegible > 0 && (
            <p className="mb-3 text-sm font-semibold text-red-200">
              {week.podsIllegible} POD{week.podsIllegible === 1 ? '' : 's'} this week cannot be read — please resend
            </p>
          )}

          {/* Logs or no logs, before anything else: the one thing to know before rolling. */}
          <DayLogs loads={dayLoads} date={day} isToday={isToday} />

          <TodayStops loads={week.loads} today={day} onSendPod={sendPod} onAddPhotos={addPhotos} onChange={reload} />
        </>
      )}

      {/* Paperwork for a load the office has not built yet still has to have a way out. */}
      <div className="mt-5 flex flex-col gap-3">
        <UnattachedPods />
        <Button
          variant="outline"
          className="h-12 w-full gap-2 text-base"
          onClick={() => navigate('/driver/scan?kind=pod')}
        >
          <Truck className="h-4 w-4" aria-hidden="true" />
          Send paperwork for another load
        </Button>
      </div>
    </div>
  )
}
