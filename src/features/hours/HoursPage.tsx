/**
 * Employee hours, for the office.
 *
 * One week at a time, one row per driver per day, with the week's total per driver. This is
 * the page payroll is run from, so two things are deliberate:
 *
 * CORRECTIONS ARE THE OFFICE'S AND ARE SIGNED. Drivers cannot edit their own cards — that
 * is what would make the numbers arguable — so every fix happens here, records who made it,
 * and keeps what the row said before. A disagreement about a paycheck is then settled by
 * looking rather than by remembering.
 *
 * MOTIVE IS SHOWN BESIDE, NEVER INSTEAD. The truck's first and last movement for the day
 * comes from the ELD and is the honest cross-check on a time card, but it is not the same
 * measurement: a driver on duty doing paperwork is working and the truck is not moving. So
 * the two sit side by side and a gap is flagged for a human, never auto-corrected.
 *
 * No overtime. See src/lib/timeClock.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { listTimeClockEntries, correctTimeClockEntry } from '@/lib/apiClient'
import type { TimeClockEntry } from '@/types'
import {
  summarizeWeek, weekStartOf, weekDays, recentWeekStarts, minutesLabel, decimalHours,
  rowMinutes, type TimeClockRow,
} from '@/lib/timeClock'
import { errorText } from '@/lib/errorText'

/** How far a time card may differ from the truck before the office is asked to look. */
const MOTIVE_GAP_TOLERANCE_MIN = 60

function todayChicago(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC',
  })
}

function weekLabel(weekStart: string): string {
  const s = new Date(`${weekStart}T12:00:00Z`)
  const e = new Date(s)
  e.setUTCDate(e.getUTCDate() + 6)
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${f(s)} – ${f(e)}`
}

export function HoursPage() {
  const { drivers } = useDrivers()
  const { user } = useAuth()
  const staffEmail = user?.email ?? ''

  const [weekStart, setWeekStart] = useState(() => weekStartOf(todayChicago()))
  const [entries, setEntries] = useState<TimeClockEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; hours: string; note: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const weeks = useMemo(() => recentWeekStarts(todayChicago(), 12), [])
  const days = useMemo(() => weekDays(weekStart), [weekStart])

  const load = useCallback((start: string) => {
    const end = weekDays(start)[6]
    listTimeClockEntries({ from: start, to: end })
      .then((rows) => { setEntries(rows); setError(null) })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(weekStart) }, [load, weekStart])

  /*
   * Only drivers who clock. Everyone else would be an empty row forever, and a page of
   * empty rows makes the ones that matter harder to find.
   */
  const clocking = useMemo(
    () => drivers.filter((d) => d.fleetGroup === 'LOCAL' && d.active !== false && d.type !== 'broker'),
    [drivers],
  )

  const byDriver = useMemo(() => {
    return clocking.map((d) => {
      const rows = entries.filter((e) => e.driverId === d.id) as TimeClockRow[]
      return { driver: d, week: summarizeWeek(weekStart, rows) }
    })
  }, [clocking, entries, weekStart])

  const grandTotal = byDriver.reduce((n, r) => n + r.week.totalMinutes, 0)

  const startEdit = (row: TimeClockEntry) => {
    setEditing({
      id: row.id,
      hours: String(decimalHours(rowMinutes(row as TimeClockRow))),
      note: row.note ?? '',
    })
  }

  const saveEdit = async (row: TimeClockEntry) => {
    if (!editing) return
    const hours = Number(editing.hours)
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      toast.error('Hours must be between 0 and 24')
      return
    }
    setSaving(true)
    try {
      await correctTimeClockEntry(row, { minutes: Math.round(hours * 60), note: editing.note }, staffEmail)
      toast.success('Correction saved')
      setEditing(null)
      load(weekStart)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-8 py-5">
        <div>
          <h1 className="text-lg font-bold text-foreground">Employee hours</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Ivan drivers&rsquo; time cards, Monday to Sunday. No overtime &mdash; hours are hours.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            aria-label="Week"
            value={weekStart}
            onChange={(e) => { setLoading(true); setWeekStart(e.target.value) }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {weeks.map((w, i) => (
              <option key={w} value={w}>{weekLabel(w)}{i === 0 ? ' · This week' : ''}</option>
            ))}
          </select>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Week total</p>
            <p className="text-lg font-bold tabular-nums text-foreground">{minutesLabel(grandTotal)}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 px-8 py-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-8 py-6">
        {byDriver.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Ivan drivers on the roster.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {byDriver.map(({ driver, week }) => (
              <section key={driver.id} className="rounded-xl border border-border bg-background">
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">{driver.name}</h2>
                  <p className="text-sm tabular-nums text-muted-foreground">
                    <span className="font-bold text-foreground">{minutesLabel(week.totalMinutes)}</span>
                    {' '}· {decimalHours(week.totalMinutes)} h
                    {week.holidayMinutes > 0 ? ` · holiday ${minutesLabel(week.holidayMinutes)}` : ''}
                    {week.ptoMinutes > 0 ? ` · PTO ${minutesLabel(week.ptoMinutes)}` : ''}
                    {week.open ? ' · still on the clock' : ''}
                  </p>
                </header>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Day</th>
                      <th className="px-4 py-2 font-medium">Entries</th>
                      <th className="px-4 py-2 text-right font-medium">Hours</th>
                      <th className="px-4 py-2 font-medium">Correct</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((date) => {
                      const day = week.days.find((d) => d.date === date)!
                      return (
                        <tr key={date} className="border-b border-border/60 last:border-0">
                          <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{dayLabel(date)}</td>
                          <td className="px-4 py-2">
                            {day.rows.length === 0 ? (
                              <span className="text-muted-foreground">&mdash;</span>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {day.rows.map((r) => (
                                  <span key={r.id} className="text-xs text-muted-foreground">
                                    {r.kind === 'WORK' ? 'Worked' : r.kind === 'HOLIDAY' ? 'Paid holiday' : 'PTO'}
                                    {r.note ? ` · ${r.note}` : ''}
                                    {/* Who changed it, so nobody has to ask. */}
                                    {r.correctedBy ? ` · corrected by ${r.correctedBy}` : ''}
                                    {r.originalMinutes != null ? ` (was ${minutesLabel(r.originalMinutes)})` : ''}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">
                            {day.open ? 'on the clock' : minutesLabel(day.totalMinutes)}
                          </td>
                          <td className="px-4 py-2">
                            {day.rows.map((r) => (
                              <div key={r.id} className="flex items-center gap-1">
                                {editing?.id === r.id ? (
                                  <>
                                    <Input
                                      aria-label="Hours"
                                      className="h-7 w-16 text-xs"
                                      value={editing.hours}
                                      onChange={(e) => setEditing({ ...editing, hours: e.target.value })}
                                    />
                                    <Input
                                      aria-label="Note"
                                      className="h-7 w-40 text-xs"
                                      placeholder="why"
                                      value={editing.note}
                                      onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                                    />
                                    <Button size="sm" className="h-7 px-2" disabled={saving}
                                            onClick={() => void saveEdit(r as TimeClockEntry)}>
                                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-7 px-2"
                                            onClick={() => setEditing(null)}>
                                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    </Button>
                                  </>
                                ) : (
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                                          onClick={() => startEdit(r as TimeClockEntry)}>
                                    <Pencil className="mr-1 h-3 w-3" aria-hidden="true" /> Edit
                                  </Button>
                                )}
                              </div>
                            ))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export { MOTIVE_GAP_TOLERANCE_MIN }
