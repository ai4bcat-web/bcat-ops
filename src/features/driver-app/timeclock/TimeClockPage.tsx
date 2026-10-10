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
import { Clock, Loader2, Moon, Plane, PartyPopper, RefreshCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { fetchTimeClock, punchTimeClock, type TimeClockResponse } from '../driverApi'
import { minutesLabel, PAID_HOLIDAYS } from '@/lib/timeClock'
import { errorText } from '@/lib/errorText'
import { fetchPaperwork } from '../driverApi'
import { chicagoDateStr } from '@/lib/date'
import { weekStartOfISO } from '@/features/driver-pay/week'
import { pickupsNeedingPaperworkLocation, deliveriesNeedingPaperworkConfirm } from '@/lib/paperworkLocation'
import { EndOfDayPaperworkDialog, StartOfDayPaperworkDialog, type WhereItem, type ConfirmItem } from '../paperwork/PaperworkGates'
import { useDriverTruck } from '../useDriverProgram'
import { TruckPickerDialog } from '../TruckPicker'

/** Cents to "$1,500.00" — a figure a driver checks against what they were paid. */
function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

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
  // The paperwork questions that gate the clock: where it went (out), do you have it (in).
  const [whereItems, setWhereItems] = useState<WhereItem[] | null>(null)
  const [confirmItems, setConfirmItems] = useState<ConfirmItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Clocking in is the start of the day: the moment to say which truck, if not said yet.
  const { truck, loaded: truckLoaded } = useDriverTruck()
  const [pickTruck, setPickTruck] = useState(false)

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

  /*
   * Clocking in asks about paperwork for today's deliveries picked up earlier; clocking out
   * asks where today's pickups' paperwork went. If the week cannot be read the clock still
   * works: the gate is a reminder, not a lock on getting paid.
   */
  const gatedPunch = async (action: 'IN' | 'OUT') => {
    setBusy(true)
    try {
      const today = chicagoDateStr(new Date())
      const week = await fetchPaperwork(weekStartOfISO(today))
      if (action === 'OUT') {
        const items = pickupsNeedingPaperworkLocation(week.loads, today)
        if (items.length) { setWhereItems(items); return }
      } else {
        const items = deliveriesNeedingPaperworkConfirm(week.loads, today)
        if (items.length) { setConfirmItems(items); return }
      }
    } catch (e) {
      console.warn('[timeclock] paperwork gate skipped', e)
    } finally {
      setBusy(false)
    }
    await punch(action)
  }

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

      {/* The button, and the only thing most visits are for. The card itself says which
          state the driver is in — green while on the clock — so it reads from across the
          cab before a single word does. */}
      <div className={`mb-5 rounded-xl border p-4 ${openShift ? 'border-emerald-400/50 bg-emerald-500/15' : 'border-border bg-card'}`}>
        <p className={`flex items-center gap-2 text-base font-semibold ${openShift ? 'text-emerald-200' : 'text-foreground'}`}>
          {openShift && (
            <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
          )}
          {openShift ? `On the clock since ${clockLabel(openShift.clockInAt)}` : 'Not clocked in'}
        </p>
        <Button
          className={`mt-3 h-16 w-full text-lg font-bold ${openShift ? 'border-emerald-400/60 bg-background text-foreground hover:bg-emerald-500/10' : ''}`}
          variant={openShift ? 'outline' : 'default'}
          disabled={busy || readOnly}
          title={readOnly ? 'You are viewing this driver\u2019s app; only they can punch their clock' : undefined}
          onClick={() => {
            if (!openShift && truckLoaded && !truck) { setPickTruck(true); return }
            void gatedPunch(openShift ? 'OUT' : 'IN')
          }}
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
          <p className="mt-2 text-sm text-emerald-100/80">
            Today&rsquo;s hours are counted once you clock out.
          </p>
        )}
      </div>

      <TruckPickerDialog open={pickTruck} onClose={() => setPickTruck(false)} onPicked={() => void gatedPunch('IN')} />

      {whereItems ? <EndOfDayPaperworkDialog items={whereItems} truckUnit={truck?.unitNumber ?? null} onClose={() => setWhereItems(null)} onDone={() => { setWhereItems(null); void punch('OUT') }} /> : null}

      {confirmItems ? <StartOfDayPaperworkDialog items={confirmItems} onClose={() => setConfirmItems(null)} onDone={() => { setConfirmItems(null); void punch('IN') }} /> : null}

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

      <div className="mb-4 rounded-xl border border-border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Week total</p>
          <p className="text-3xl font-bold tabular-nums text-foreground">
            {minutesLabel(week.totalMinutes)}
          </p>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3">
          <div><dt className="text-xs text-muted-foreground">Worked</dt><dd className="text-base font-bold tabular-nums text-foreground">{minutesLabel(week.workedMinutes)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Holiday</dt><dd className="text-base font-bold tabular-nums text-foreground">{minutesLabel(week.holidayMinutes)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">PTO</dt><dd className="text-base font-bold tabular-nums text-foreground">{minutesLabel(week.ptoMinutes)}</dd></div>
        </dl>
      </div>

      {/*
        The pay period's overnight runs, and what they came to.
        The only money in the Ivan app, and it lives here because this is where a driver
        looks to see what a period was worth. Gross: Ivan drivers have nothing deducted, so
        a "net" line would be the same number wearing a label that invites a hunt for the
        difference. Scoped to the same Monday-to-Sunday week as the card above it.
      */}
      {data.overnight && data.overnight.loads.length > 0 && (
        <section className="mb-4 rounded-xl border border-indigo-400/40 bg-indigo-500/15 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-indigo-100">
              <Moon className="h-4 w-4" aria-hidden="true" /> Overnight loads
            </h2>
            <p className="text-lg font-bold tabular-nums text-indigo-100">
              {money(data.overnight.grossCents)}
            </p>
          </div>
          <p className="mt-0.5 text-xs text-indigo-200/80">
            {data.overnight.loads.length} run{data.overnight.loads.length === 1 ? '' : 's'} this
            period &middot; gross
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {data.overnight.loads.map((l) => (
              <li key={l.id} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-indigo-100">
                  <span className="font-semibold">{l.reference}</span>
                  {l.origin || l.destination
                    ? ` · ${[l.origin, l.destination].filter(Boolean).join(' → ')}`
                    : ''}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-indigo-100">
                  {l.rateCents != null ? money(l.rateCents) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="flex flex-col gap-2">
        {week.days.map((d) => {
          // Today stands out so the driver finds their own day without reading dates; a
          // day with hours on it reads brighter than an empty one.
          const isToday = d.date === data.today
          const hasHours = d.open || d.totalMinutes > 0
          return (
          <li
            key={d.date}
            className={`rounded-lg border p-3 ${isToday ? 'border-primary/70 bg-primary/10' : 'border-border bg-card'}`}
          >
            <div className="flex items-baseline justify-between">
              <p className="text-base font-semibold text-foreground">
                {dayLabel(d.date)}
                {isToday && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-primary">Today</span>}
              </p>
              {d.open ? (
                <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-sm font-bold text-emerald-200">
                  On the clock
                </span>
              ) : (
                <p className={`text-base font-bold tabular-nums ${hasHours ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {minutesLabel(d.totalMinutes)}
                </p>
              )}
            </div>
            {d.rows.map((r) => (
              <p key={r.id} className="mt-1 text-sm text-muted-foreground">
                {r.kind === 'WORK'
                  ? `${clockLabel(r.clockInAt)} – ${r.clockOutAt ? clockLabel(r.clockOutAt) : 'now'}`
                  : r.kind === 'HOLIDAY' ? 'Paid holiday' : 'PTO'}
                {r.note ? ` · ${r.note}` : ''}
                {/* Shown, not hidden: a driver should see their card was changed. */}
                {r.correctedBy ? ' · corrected by the office' : ''}
              </p>
            ))}
          </li>
          )
        })}
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
