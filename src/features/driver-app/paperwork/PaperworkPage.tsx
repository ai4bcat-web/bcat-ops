/**
 * Ivan paperwork — the driver's home when they are on Ivan's own fleet.
 *
 * Same shape as the owner operators' settlement so there is one app to explain, and
 * deliberately none of its money: no rate, no deductions, no check. What it adds is the
 * two things an employee driver actually needs — what is still missing, and somewhere to
 * put the clock when they sat at a dock.
 *
 * Defaults to the current week and pages back through history, same as the settlement.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Camera, FileWarning, Loader2, RefreshCcw, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  fetchPaperwork, fetchPaperworkWeeks,
  type Paperwork, type PaperworkWeek,
} from '../driverApi'
import { PaperworkRows } from './PaperworkRows'
import { TodayStops } from './TodayStops'
import { UnattachedPods } from '../UnattachedPods'
import { sundayOf, weekLabel } from '@/features/driver-pay/week'
import { chicagoDateStr } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { useDriverPm } from '../useDriverProgram'
import { PmGauge } from './PmGauge'

/**
 * When this driver's truck is next due a PM.
 *
 * On the home screen rather than buried in Account, because the point is that a driver sees
 * it without going looking. Overdue is red and due-soon amber; a PM that is simply a long
 * way off still shows, quietly, so "when is my next PM" always has an answer here.
 *
 * Nothing renders when there is no truck assigned or the profile has not loaded — an empty
 * gauge on a page about paperwork is just noise.
 */
function PmLine() {
  const pm = useDriverPm()
  // Nothing to show for a driver with no truck assigned, or before the profile lands.
  if (!pm) return null
  return <PmGauge pm={pm} />
}

export function PaperworkPage() {
  const navigate = useNavigate()
  const [weeks, setWeeks] = useState<PaperworkWeek[] | null>(null)
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null)
  const [week, setWeek] = useState<Paperwork | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [weeksRetryKey, setWeeksRetryKey] = useState(0)
  const [weekRetryKey, setWeekRetryKey] = useState(0)

  const currentWeekStart = sundayOf()

  // The week in progress is always offered, even before anything delivers in it.
  const weekOptions = useMemo(() => {
    if (!weeks) return weeks
    if (weeks.some((w) => w.weekStart === currentWeekStart)) return weeks
    return [{ weekStart: currentWeekStart, loadCount: 0, podsMissing: 0, podsIllegible: 0 }, ...weeks]
  }, [weeks, currentWeekStart])

  const selected =
    selectedWeekStart ??
    weekOptions?.find((w) => w.weekStart === currentWeekStart)?.weekStart ??
    weekOptions?.[0]?.weekStart ??
    null

  useEffect(() => {
    let stale = false
    fetchPaperworkWeeks()
      .then((list) => {
        if (stale) return
        setWeeks([...list].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)))
      })
      .catch((err) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [weeksRetryKey])

  useEffect(() => {
    if (!selected) return
    let stale = false
    fetchPaperwork(selected)
      .then((w) => { if (!stale) { setWeek(w); setError(null) } })
      .catch((err) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [selected, weekRetryKey])

  const reload = useCallback(() => setWeekRetryKey((k) => k + 1), [])

  const sendPod = useCallback(
    (load: { id: string; reference: string }) =>
      navigate(`/driver/scan?kind=pod&ref=${encodeURIComponent(load.reference)}&loadId=${encodeURIComponent(load.id)}`),
    [navigate],
  )

  const loadingWeeks = weeks === null && error === null
  const loadingWeek = selected != null && week?.weekStart !== selected && error === null

  if (loadingWeeks) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p>Loading your week…</p>
      </div>
    )
  }

  if (error && weeks === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden="true" />
        <p className="font-medium text-foreground">{error}</p>
        <Button onClick={() => { setError(null); setWeeks(null); setWeeksRetryKey((k) => k + 1) }} className="h-11 gap-2 px-6">
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-4 text-xl font-bold text-foreground">Dashboard</h1>

      <PmLine />

      {/*
        Today first. The week below is the record; this is the work — every pickup and
        delivery on today's sheet, with the detention box and, at a delivery, the POD
        button. Only on the week in progress: a past week has no "today" in it.
      */}
      {week && week.weekStart === selected && selected === currentWeekStart && (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Today
          </h2>
          <TodayStops
            loads={week.loads}
            today={week.today ?? chicagoDateStr(new Date())}
            onSendPod={sendPod}
            onChange={reload}
          />
        </section>
      )}

      {weekOptions && weekOptions.length > 0 && (
        <div className="mb-4">
          <label htmlFor="pw-week" className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Week
          </label>
          <Select value={selected ?? ''} onValueChange={setSelectedWeekStart}>
            <SelectTrigger id="pw-week" className="h-12 w-full text-base">
              <SelectValue placeholder="Choose a week" />
            </SelectTrigger>
            <SelectContent>
              {weekOptions.map((w) => (
                <SelectItem key={w.weekStart} value={w.weekStart} className="text-base">
                  {weekLabel(w.weekStart)}
                  {w.weekStart === currentWeekStart ? ' · This week' : ''} ·{' '}
                  {w.loadCount} load{w.loadCount === 1 ? '' : 's'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/*
        The week at a glance, always — not only when something is wrong.
        The alert box below says what is outstanding; this says what the week IS, so a
        driver opening a clean week sees "6 loads, all PODs in" rather than a bare list and
        no confirmation that nothing is owed.
      */}
      {week && week.weekStart === selected && (
        <dl className="mb-4 grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/40 p-3 text-center">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Loads</dt>
            <dd className="text-lg font-bold tabular-nums text-foreground">{week.loadCount}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">PODs needed</dt>
            <dd className={`text-lg font-bold tabular-nums ${week.podsMissing > 0 ? 'text-amber-300' : 'text-foreground'}`}>
              {week.podsMissing}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">ELD logs</dt>
            <dd className="text-lg font-bold tabular-nums text-foreground">{week.eldRequired ?? 0}</dd>
          </div>
        </dl>
      )}

      {/* What is outstanding, before the list. The reason to open the page at all. */}
      {week && week.weekStart === selected && (week.podsMissing > 0 || week.podsIllegible > 0) && (
        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          {week.podsMissing > 0 && (
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
              <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
              {week.podsMissing} load{week.podsMissing === 1 ? '' : 's'} still need a POD
            </p>
          )}
          {week.podsIllegible > 0 && (
            <p className="flex items-center gap-2 text-sm font-semibold text-red-200">
              <FileWarning className="h-4 w-4 shrink-0" aria-hidden="true" />
              {week.podsIllegible} POD{week.podsIllegible === 1 ? '' : 's'} cannot be read — please resend
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-center">
          <p className="font-medium text-red-300">{error}</p>
          <Button onClick={reload} variant="outline" className="mt-3 h-10 gap-2" aria-label="Retry">
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}

      {loadingWeek && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <p>Loading loads…</p>
        </div>
      )}

      {!loadingWeek && week && week.weekStart === selected && !error && (
        <PaperworkRows loads={week.loads} onSendPod={sendPod} />
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
