/**
 * The employee time clock, for Ivan's own drivers.
 *
 * One big button, because that is the whole job: a driver standing by a truck taps in or
 * out. Everything else on the page — this week's hours, previous weeks, holiday and PTO —
 * is there to answer "how many hours do I have" without phoning the office.
 *
 * Hours are hours: no overtime, by design. See src/lib/timeClock.ts.
 *
 * Corrections are deliberately NOT possible here. A driver editing their own card after the
 * fact is the one thing that would make these numbers arguable, so a mistake goes to staff
 * on the hours page, who correct it on the record with their name against it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Clock, Loader2, Plane, PartyPopper, RefreshCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { fetchTimeClock, punchTimeClock, type TimeClockResponse } from '../driverApi'
import { minutesLabel, PAID_HOLIDAYS } from '@/lib/timeClock'
import { errorText } from '@/lib/errorText'

/** "Mon, Oct 6" — a driver scans their week by weekday. */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function clockLabel(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
}

function weekLabel(weekStart: string): string {
  const s = new Date(`${weekStart}T12:00:00Z`)
  const e = new Date(s)
  e.setUTCDate(e.getUTCDate() + 6)
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${f(s)} – ${f(e)}`
}

export function TimeClockPage() {
  const [data, setData] = useState<TimeClockResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * No synchronous setLoading here: this runs from an effect on mount, and a setState in an
   * effect body cascades renders (react-hooks/set-state-in-effect). `loading` starts true,
   * and the handlers that call this from an event set it themselves.
   */
  const load = useCallback((week?: string) => {
    fetchTimeClock(week)
      .then((d) => { setData(d); setSelected(d.week.weekStart); setError(null) })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const loadWeek = (week: string) => { setLoading(true); setSelected(week); load(week) }

  const punch = async (action: 'IN' | 'OUT' | 'HOLIDAY' | 'PTO', opts?: { date?: string }) => {
    setBusy(true)
    try {
      await punchTimeClock(action, opts)
      toast.success(
        action === 'IN' ? 'Clocked in'
          : action === 'OUT' ? 'Clocked out'
            : action === 'PTO' ? 'PTO added' : 'Holiday added',
      )
      load(selected ?? undefined)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" onClick={() => { setLoading(true); load() }}>
          <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
        </Button>
      </div>
    )
  }

  if (!data) return null
  const { week, openShift } = data
  const isThisWeek = selected === data.weeks[0]
  // Staff viewing a driver's app. The server refuses a punch; the button says so first.
  const readOnly = data.readOnly === true

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-4 text-xl font-bold text-foreground">Time clock</h1>

      {/* The button, and the only thing most visits are for. */}
      <div className="mb-5 rounded-xl border border-border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          {openShift ? `Clocked in at ${clockLabel(openShift.clockInAt)}` : 'Not clocked in'}
        </p>
        <Button
          className="mt-3 h-14 w-full text-base font-semibold"
          variant={openShift ? 'outline' : 'default'}
          disabled={busy || readOnly}
          title={readOnly ? 'You are viewing this driver\u2019s app; only they can punch their clock' : undefined}
          onClick={() => void punch(openShift ? 'OUT' : 'IN')}
        >
          <Clock className="mr-2 h-5 w-5" aria-hidden="true" />
          {busy ? 'Working…' : openShift ? 'Clock out' : 'Clock in'}
        </Button>
        {readOnly && (
          <p className="mt-2 text-xs text-muted-foreground">
            Viewing only &mdash; a driver&rsquo;s clock can only be punched by them.
          </p>
        )}
        {openShift && (
          /*
           * An open shift is worth nothing until it closes — said out loud so a driver is
           * not left wondering why today still reads 0h while they are standing there
           * working. See rowMinutes in src/lib/timeClock.ts.
           */
          <p className="mt-2 text-xs text-muted-foreground">
            Today&rsquo;s hours are counted once you clock out.
          </p>
        )}
      </div>

      {data.weeks.length > 0 && (
        <div className="mb-4">
          <label htmlFor="tc-week" className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Week
          </label>
          <Select value={selected ?? ''} onValueChange={loadWeek}>
            <SelectTrigger id="tc-week" className="h-12 w-full text-base">
              <SelectValue placeholder="Choose a week" />
            </SelectTrigger>
            <SelectContent>
              {data.weeks.map((w, i) => (
                <SelectItem key={w} value={w} className="text-base">
                  {weekLabel(w)}{i === 0 ? ' · This week' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="mb-4 rounded-xl border border-border bg-background p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-foreground">Week total</p>
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {minutesLabel(week.totalMinutes)}
          </p>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <div><dt className="text-muted-foreground">Worked</dt><dd className="font-semibold">{minutesLabel(week.workedMinutes)}</dd></div>
          <div><dt className="text-muted-foreground">Holiday</dt><dd className="font-semibold">{minutesLabel(week.holidayMinutes)}</dd></div>
          <div><dt className="text-muted-foreground">PTO</dt><dd className="font-semibold">{minutesLabel(week.ptoMinutes)}</dd></div>
        </dl>
      </div>

      <ul className="flex flex-col gap-2">
        {week.days.map((d) => (
          <li key={d.date} className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold text-foreground">{dayLabel(d.date)}</p>
              <p className="text-sm font-semibold tabular-nums">
                {d.open ? 'On the clock' : minutesLabel(d.totalMinutes)}
              </p>
            </div>
            {d.rows.map((r) => (
              <p key={r.id} className="mt-1 text-xs text-muted-foreground">
                {r.kind === 'WORK'
                  ? `${clockLabel(r.clockInAt)} – ${r.clockOutAt ? clockLabel(r.clockOutAt) : 'now'}`
                  : r.kind === 'HOLIDAY' ? 'Paid holiday' : 'PTO'}
                {r.note ? ` · ${r.note}` : ''}
                {/* Shown, not hidden: a driver should see their card was changed. */}
                {r.correctedBy ? ' · corrected by the office' : ''}
              </p>
            ))}
          </li>
        ))}
      </ul>

      {isThisWeek && (
        <div className="mt-5 flex flex-col gap-2">
          <Button
            variant="outline"
            className="h-12"
            disabled={busy || readOnly}
            onClick={() => void punch('HOLIDAY', { date: data.today })}
          >
            <PartyPopper className="mr-2 h-4 w-4" aria-hidden="true" />
            Add a paid holiday for today
          </Button>
          {/* Only Jason and Chuck accrue PTO; everyone else never sees this. */}
          {data.ptoEligible && (
            <Button
              variant="outline"
              className="h-12"
              disabled={busy || readOnly}
              onClick={() => void punch('PTO', { date: data.today })}
            >
              <Plane className="mr-2 h-4 w-4" aria-hidden="true" />
              Use PTO for today
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Paid holidays: {PAID_HOLIDAYS.map((h) => h.label).join(', ')}. Something wrong on
            your card? The office can correct it.
          </p>
        </div>
      )}
    </div>
  )
}
