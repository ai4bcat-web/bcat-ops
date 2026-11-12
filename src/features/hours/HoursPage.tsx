/**
 * Employee hours, for the office.
 *
 * One fortnightly pay period at a time: a summary bar, one collapsible row per driver (worked,
 * PTO, holiday, total hours, hourly rate and the period's pay) and a day-by-day table behind
 * each. This is the page payroll is run from, so these things are deliberate:
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
 * PAY IS GATED. Rate and pay need the pay pages' own access (`driverPay`); without it the page
 * is hours only and no rate is even fetched. No pay figure of any kind exists in the driver app.
 *
 * No overtime. See src/lib/timeClock.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { useHourlyRates } from '@/hooks/useHourlyRates'
import { listTimeClockEntries, correctTimeClockEntry } from '@/lib/apiClient'
import type { TimeClockEntry } from '@/types'
import { ptoDaysUsed, yearOf } from '@/lib/timeOff'
import {
  summarizePayPeriod, payPeriodStartOf, payPeriodDays, recentPayPeriodStarts,
  decimalHours, rowMinutes, type TimeClockRow,
} from '@/lib/timeClock'
import { payForPeriod, currentRateFrom } from '@/lib/hoursPay'
import { periodCsv, type DriverHoursRow } from '@/lib/hoursView'
import { fetchMotiveDays, type MotiveDaysByDriver } from '@/lib/staffMotiveDays'
import { errorText } from '@/lib/errorText'
import { defaultHiddenDriverIds, readSavedHiddenIds, saveHiddenDriverIds, toggleHidden } from '@/lib/hoursDriverFilter'
import { HoursPeriodView, type DayEdit } from './HoursPeriodView'
import { PtoDaysSection } from './PtoDaysSection'

function todayChicago(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** "Sep 28 – Oct 11" — the fortnight as the office says it. */
function periodLabel(periodStart: string): string {
  const s = new Date(`${periodStart}T12:00:00Z`)
  const e = new Date(s)
  e.setUTCDate(e.getUTCDate() + 13)
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${f(s)} – ${f(e)}`
}

export function HoursPage() {
  const { drivers } = useDrivers()
  const { user, hasPageAccess } = useAuth()
  const staffEmail = user?.email ?? ''

  const [periodStart, setPeriodStart] = useState(() => payPeriodStartOf(todayChicago()))
  const [entries, setEntries] = useState<TimeClockEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<DayEdit | null>(null)
  /*
   * When each truck actually moved, from the ELD. Loaded beside the cards rather than with
   * them: the page is useful without it, and Motive being slow or down must not stop
   * payroll being read.
   */
  const [motive, setMotive] = useState<MotiveDaysByDriver>({})
  const [saving, setSaving] = useState(false)

  const periods = useMemo(() => recentPayPeriodStarts(todayChicago(), 13), [])

  const load = useCallback((start: string) => {
    const end = payPeriodDays(start)[13]
    listTimeClockEntries({ from: start, to: end })
      .then((rows) => { setEntries(rows); setError(null) })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(periodStart) }, [load, periodStart])

  /*
   * PTO used this calendar year, per driver. The pay-period load above is only fourteen days,
   * so the year is its own small load; a failure leaves the figure blank, not the page broken.
   */
  const ptoYear = yearOf(todayChicago())
  const [yearRows, setYearRows] = useState<TimeClockEntry[] | null>(null)
  useEffect(() => {
    let stale = false
    listTimeClockEntries({ from: `${ptoYear}-01-01`, to: `${ptoYear}-12-31` })
      .then((rows) => { if (!stale) setYearRows(rows) })
      .catch(() => { /* the figure just stays blank */ })
    return () => { stale = true }
  }, [ptoYear, entries])

  /*
   * Only drivers who clock. Everyone else would be an empty row forever, and a page of
   * empty rows makes the ones that matter harder to find.
   */
  const roster = useMemo(
    () => drivers.filter((d) => d.fleetGroup === 'LOCAL' && d.active !== false && d.type !== 'broker').sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )
  // Driver filter: Ryne's test driver and Dan Palmer start hidden; the choice sticks per browser.
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const [savedHidden, setSavedHidden] = useState<string[] | null>(() => readSavedHiddenIds(storage))
  const hidden = useMemo(() => savedHidden ?? defaultHiddenDriverIds(roster), [savedHidden, roster])
  const setHidden = (ids: string[]) => { setSavedHidden(ids); saveHiddenDriverIds(ids, storage) }
  const clocking = useMemo(() => roster.filter((d) => !hidden.includes(d.id)), [roster, hidden])

  useEffect(() => {
    const ids = clocking.map((d) => d.id)
    if (ids.length === 0) return
    let stale = false
    const days = payPeriodDays(periodStart)
    fetchMotiveDays(ids, days[0], days[13])
      .then((m) => { if (!stale) setMotive(m) })
      .catch(() => { /* the comparison column simply says nothing */ })
    return () => { stale = true }
  }, [clocking, periodStart])

  // Pay (rates and dollars) is for staff who can open the pay pages; everyone else sees hours only.
  const canSeePay = hasPageAccess('driverPay')
  const { settings: paySettings, status: ratesStatus, error: ratesError, reload: reloadRates, saveRate } = useHourlyRates(canSeePay, staffEmail)

  const byDriver = useMemo<DriverHoursRow[]>(() => {
    return clocking.map((d) => {
      const rows = entries.filter((e) => e.driverId === d.id) as TimeClockRow[]
      const period = summarizePayPeriod(periodStart, rows)
      const pay = canSeePay
        ? payForPeriod(period.days.map((x) => ({ date: x.date, minutes: x.totalMinutes })), paySettings.get(d.id) ?? {})
        : null
      return { driverId: d.id, name: d.name, period, pay }
    })
  }, [clocking, entries, periodStart, canSeePay, paySettings])

  const ptoDays = useMemo(() => {
    if (!yearRows) return null
    return Object.fromEntries(clocking.map((d) => [d.id, ptoDaysUsed(yearRows.filter((e) => e.driverId === d.id), ptoYear)]))
  }, [yearRows, clocking, ptoYear])

  const exportCsv = () => {
    const blob = new Blob([periodCsv(byDriver, canSeePay)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `employee-hours-${periodStart}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const startEdit = (rowId: string) => {
    const row = entries.find((e) => e.id === rowId)
    if (!row) return
    setEditing({
      id: row.id,
      hours: String(decimalHours(rowMinutes(row as TimeClockRow))),
      note: row.note ?? '',
    })
  }

  const saveEdit = async (rowId: string) => {
    const row = entries.find((e) => e.id === rowId)
    if (!editing || !row) return
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
      load(periodStart)
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
    <TmsScrollPage
      title="Employee hours"
      subtitle={<>Ivan drivers&rsquo; time cards, by fortnightly pay period. No overtime &mdash; hours are hours, at forty and at eighty. Truck times are from Motive for context only &mdash; drivers swap trucks, and a pre-trip or a slow dock puts the clock outside the driving window quite legitimately.</>}
      actions={
        <div className="flex items-center gap-3 print:hidden">
          <details className="relative">
            <summary className="flex h-9 cursor-pointer select-none items-center rounded-md border border-input bg-background px-3 text-sm list-none">
              Drivers · {clocking.length} of {roster.length}
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-border bg-background p-2 shadow-lg">
              <div className="mb-1 flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span>Show on this page</span>
                <span className="flex gap-2 normal-case tracking-normal">
                  <button type="button" className="text-primary hover:underline" onClick={() => setHidden([])}>All</button>
                  <button type="button" className="text-primary hover:underline" onClick={() => setHidden(defaultHiddenDriverIds(roster))}>Default</button>
                </span>
              </div>
              {roster.map((d) => (
                <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                  <input type="checkbox" checked={!hidden.includes(d.id)} onChange={() => setHidden(toggleHidden(hidden, d.id))} />
                  <span>{d.name}</span>
                </label>
              ))}
            </div>
          </details>
          <select
            aria-label="Pay period"
            value={periodStart}
            onChange={(e) => { setLoading(true); setPeriodStart(e.target.value) }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {periods.map((p, i) => (
              <option key={p} value={p}>{periodLabel(p)}{i === 0 ? ' · Current' : ''}</option>
            ))}
          </select>
        </div>
      }
    >
      {error && (
        <TmsAlert tone="red" icon={AlertTriangle}>{error}</TmsAlert>
      )}

      {ratesStatus === 'error' && (
        <TmsAlert tone="red" icon={AlertTriangle} className="print:hidden">
          Hourly rates could not be loaded{ratesError ? `: ${ratesError}` : ''}. Pay is not shown and rates cannot be edited until they load.
          <button type="button" className="ml-2 font-semibold underline" onClick={reloadRates}>Try again</button>
        </TmsAlert>
      )}

      <div className="mt-4">
        {byDriver.length === 0 ? (
          <p className="text-sm text-muted-foreground">{roster.length === 0 ? 'No Ivan drivers on the roster.' : 'Every driver is hidden — use the Drivers filter to show some.'}</p>
        ) : (
          <HoursPeriodView
            rows={byDriver}
            periodLabel={periodLabel(periodStart)}
            defaultRateFrom={periodStart}
            showPay={canSeePay}
            ratesReady={ratesStatus === 'ready'}
            motive={motive}
            ptoYear={ptoYear}
            ptoDays={ptoDays}
            rateInfo={(id) => {
              const st = paySettings.get(id)
              return { currentFrom: st ? currentRateFrom(st) : null, rate: st?.hourlyRate ?? null }
            }}
            onSaveRate={async (id, rate, from) => { await saveRate(id, rate, from); toast.success('Rate saved') }}
            onExportCsv={exportCsv}
            editing={editing}
            setEditing={setEditing}
            saving={saving}
            onStartEdit={startEdit}
            onSaveEdit={(id) => void saveEdit(id)}
          />
        )}
      </div>

      <PtoDaysSection
        drivers={roster}
        staffEmail={staffEmail}
        today={todayChicago()}
        onChanged={() => load(periodStart)}
      />
    </TmsScrollPage>
  )
}
