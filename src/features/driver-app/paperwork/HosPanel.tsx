/**
 * This driver's duty status for the day a load delivered, straight from Motive.
 *
 * READ ONLY, and it says so. Duty status is a federal record: the FMCSA requires changes to
 * go through the certified ELD, so this shows what Motive already holds and sends the
 * driver to the Motive app to change anything. Nothing in BCAT Ops writes to a log.
 *
 * Loaded on demand rather than with the week — one Motive call per load the driver actually
 * opens, instead of a dozen on every page load.
 */
import { useEffect, useState } from 'react'
import { ClipboardList, ExternalLink, Loader2 } from 'lucide-react'
import { fetchHosDay, type HosResponse } from '../driverApi'
import { hoursLabel } from '@/lib/motiveHos'

/** Where a driver actually changes their status. */
const MOTIVE_APP_URL = 'https://app.gomotive.com'

const TYPE_LABEL: Record<string, string> = {
  on_duty: 'On duty',
  driving: 'Driving',
  off_duty: 'Off duty',
  sleeper: 'Sleeper',
}

function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
}

export function HosPanel({ date }: { date: string }) {
  const [state, setState] = useState<{ loading: boolean; data: HosResponse | null; error: string | null }>({
    loading: true, data: null, error: null,
  })

  /*
   * No synchronous reset to "loading" here — that is a setState inside an effect, which
   * cascades renders. The panel is mounted with `key={date}` by its caller, so a different
   * day is a different component and starts from the useState default above.
   */
  useEffect(() => {
    let stale = false
    fetchHosDay(date)
      .then((data) => { if (!stale) setState({ loading: false, data, error: null }) })
      .catch(() => {
        // Never a hard failure on a row: the load is still the point of the screen.
        if (!stale) setState({ loading: false, data: null, error: 'Could not reach Motive just now.' })
      })
    return () => { stale = true }
  }, [date])

  if (state.loading) {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading your logs…
      </p>
    )
  }

  if (state.error) return <p className="mt-3 text-sm text-muted-foreground">{state.error}</p>

  const res = state.data
  if (!res) return null

  if (!res.linked) {
    // Named rather than hidden: an unlinked driver is something staff can fix.
    return <p className="mt-3 text-sm text-muted-foreground">{res.reason ?? 'No Motive logs available.'}</p>
  }

  if (!res.day || res.day.segments.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No Motive activity recorded on {res.date}.</p>
  }

  const day = res.day

  return (
    <div className="mt-3 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ClipboardList className="h-4 w-4" aria-hidden="true" />
          Your logs for {res.date}
        </p>
        <p className="text-xs text-muted-foreground">
          {hoursLabel(day.workedSeconds)} worked
          {day.totalMiles != null ? ` · ${day.totalMiles.toLocaleString()} mi` : ''}
        </p>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between"><dt className="text-muted-foreground">Driving</dt><dd>{hoursLabel(day.drivingSeconds)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">On duty</dt><dd>{hoursLabel(day.onDutySeconds)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">First on duty</dt><dd>{clock(day.firstOnDutyAt)}</dd></div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Last off duty</dt>
          {/* Null means the segment is still running — "still on duty" is the honest answer. */}
          <dd>{day.lastOffDutyAt ? clock(day.lastOffDutyAt) : 'still on'}</dd>
        </div>
      </dl>

      <ol className="mt-2 flex flex-col gap-0.5 border-l border-border pl-3">
        {day.segments.map((s, i) => (
          <li key={`${s.startAt}-${i}`} className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{TYPE_LABEL[s.type] ?? s.type}</span>{' '}
            {clock(s.startAt)}–{s.endAt ? clock(s.endAt) : 'now'}
            {s.location ? ` · ${s.location}` : ''}
          </li>
        ))}
      </ol>

      {/*
        The only way to change a status. Saying where it has to happen is not a limitation
        to apologise for — an ELD edit made anywhere else is not a compliant record.
      */}
      <a
        href={MOTIVE_APP_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        Change your duty status in Motive
      </a>
    </div>
  )
}
