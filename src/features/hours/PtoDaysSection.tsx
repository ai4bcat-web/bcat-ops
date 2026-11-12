/**
 * PTO days, on the Employee hours page: every PTO day a driver has taken, added by staff.
 *
 * A PTO day is a paid day on the driver's time card, so it already counts in the fortnight's hours
 * and pay above; this section is where the days are recorded, corrected and removed, with the year's
 * days and hours per driver beside them. Each change is signed (who, and what the day said before).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsField } from '@/features/tms/kit/TmsField'
import { TmsInput, TmsTextarea } from '@/features/tms/kit/TmsInput'
import { TmsSelect } from '@/features/tms/kit/TmsSelect'
import { listTimeClockEntries } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { decimalHours, type TimeClockRow } from '@/lib/timeClock'
import type { TimeClockEntry } from '@/types'
import {
  DEFAULT_PTO_MINUTES, expandPtoDates, filterPtoRows, planPtoDays, ptoMinutesFor, ptoRowsOf, ptoTotalsByDriver, sortDriversForPto,
  type PtoRow,
} from '@/lib/ptoDays'
import { addPtoDays, editPtoDay, removePtoDay } from '@/lib/ptoDaysApi'
import { formatDays, ptoAllowanceForYear, ptoBalance, ptoStartDate, untilLabel, validHireDate } from '@/lib/ptoAllowance'

export interface PtoDriver { id: string; name: string; ptoEligible?: boolean | null; hireDate?: string | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** "PTO starts Jan 1, 2027 (in 7 weeks)" — admin side only; the driver app never shows this. */
function startsText(hire: string | null | undefined, today: string): string | null {
  const start = ptoStartDate(hire)
  if (!start) return null
  const label = new Date(`${start}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return start > today ? `PTO starts ${label} (${untilLabel(today, start)})` : null
}

/** One line per calendar year the new days land in: "Uses 3 of 5 days in 2027, 2 left". */
function balanceLines(driver: PtoDriver | undefined, add: readonly string[], minutes: number, existing: readonly PtoRow[], today: string): { text: string; warn: boolean }[] {
  if (!driver || add.length === 0) return []
  if (!validHireDate(driver.hireDate)) return [{ text: 'No hire date in the driver file, so no PTO balance.', warn: false }]
  const mine = existing.filter((r) => r.driverId === driver.id)
  const groups = new Map<string, string[]>()
  for (const d of add) {
    const key = d < driver.hireDate! ? 'before' : d.slice(0, 4)
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  const out: { text: string; warn: boolean }[] = []
  for (const [key, dates] of groups) {
    if (key === 'before') { out.push({ text: `${dates.length === 1 ? 'A day is' : `${dates.length} days are`} before the hire date.`, warn: true }); continue }
    const allowance = ptoAllowanceForYear(driver.hireDate, key)
    if (allowance === 0) {
      const starts = startsText(driver.hireDate, today)
      out.push({ text: `No PTO allowance in ${key} yet${starts ? `. ${starts}` : ''}.`, warn: true })
      continue
    }
    const bal = ptoBalance(driver.hireDate, dates[0], mine)!
    const after = bal.used + (dates.length * minutes) / 480
    const left = Math.round((bal.allowance - after) * 100) / 100
    out.push({ text: `Uses ${formatDays(after)} of ${bal.allowance} days in ${key}, ${left >= 0 ? `${formatDays(left)} left` : `${formatDays(-left)} over`}.`, warn: left < 0 })
  }
  return out
}

function parseExtra(text: string): string[] {
  return text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
}

function AddDialog({
  drivers, existing, onClose, onSave, today,
}: {
  drivers: PtoDriver[]
  existing: readonly PtoRow[]
  onClose: () => void
  onSave: (v: { driverId: string; dates: string[]; minutes: number; note: string }) => Promise<void>
  today: string
}) {
  const ordered = useMemo(() => sortDriversForPto(drivers), [drivers])
  const [driverId, setDriverId] = useState(ordered[0]?.id ?? '')
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [weekends, setWeekends] = useState(false)
  const [extra, setExtra] = useState('')
  const [hours, setHours] = useState(String(DEFAULT_PTO_MINUTES / 60))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const driver = ordered.find((d) => d.id === driverId)
  const requested = useMemo(() => expandPtoDates({ from, to, extraDates: parseExtra(extra), includeWeekends: weekends }), [from, to, extra, weekends])
  const have = useMemo(() => new Set(existing.filter((r) => r.driverId === driverId).map((r) => r.workDate)), [existing, driverId])
  const plan = planPtoDays(requested, have)
  const minutes = ptoMinutesFor(Number(hours))
  const balance = useMemo(() => balanceLines(driver, plan.add, minutes, existing, today), [driver, plan.add, minutes, existing, today])
  const bad = parseExtra(extra).filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))
  const problem = !driverId ? 'Choose a driver.' : minutes <= 0 ? 'Hours per day must be more than zero.' : plan.error ?? (plan.add.length === 0 ? 'No new days to add.' : null)

  const save = async () => {
    setBusy(true)
    try { await onSave({ driverId, dates: plan.add, minutes, note }) } finally { setBusy(false) }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Add PTO days"
      description="Each day is a paid day on the driver's time card and goes on the calendar."
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void save() }} disabled={busy || problem !== null}>
            {plan.add.length > 1 ? `Add ${plan.add.length} days` : 'Add day'}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TmsField label="Driver" hint={driver && driver.ptoEligible !== true ? 'Not marked PTO eligible in the driver file. You can still record the day.' : undefined}>
          <TmsSelect value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            {ordered.map((d) => <option key={d.id} value={d.id}>{d.name}{d.ptoEligible === true ? '' : ' · not PTO eligible'}</option>)}
          </TmsSelect>
        </TmsField>
        <div className="grid grid-cols-2 gap-3">
          <TmsField label="From">
            <TmsInput type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} />
          </TmsField>
          <TmsField label="To">
            <TmsInput type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </TmsField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} /> Include weekends
        </label>
        <TmsField label="Other dates (optional)" hint="Backfill: type any other days, as YYYY-MM-DD, separated by commas or new lines." error={bad.length ? `Not a date: ${bad.join(', ')}` : undefined}>
          <TmsTextarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="2026-03-02, 2026-03-03" />
        </TmsField>
        <div className="grid grid-cols-2 gap-3">
          <TmsField label="Hours per day">
            <TmsInput type="number" min={0.25} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />
          </TmsField>
          <TmsField label="Note (optional)">
            <TmsInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Family trip" />
          </TmsField>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          {problem && plan.add.length === 0 && !plan.error ? problem : plan.error ? plan.error : `Adds ${plan.add.length} ${plan.add.length === 1 ? 'day' : 'days'} · ${decimalHours(minutes * plan.add.length)} h`}
          {plan.skipped.length > 0 && ` · skipping ${plan.skipped.length} that already ${plan.skipped.length === 1 ? 'has' : 'have'} PTO`}
        </p>
        {balance.map((b) => (
          <p key={b.text} className={`text-sm ${b.warn ? 'text-[color:var(--tms-badge-red)]' : 'text-muted-foreground'}`} aria-live="polite" data-testid="pto-balance">{b.text} {b.warn && 'You can still add it.'}</p>
        ))}
      </div>
    </TmsDialog>
  )
}

function EditDialog({ row, onClose, onSave }: { row: PtoRow; onClose: () => void; onSave: (minutes: number, note: string) => Promise<void> }) {
  const [hours, setHours] = useState(String(row.minutes / 60))
  const [note, setNote] = useState(row.note.replace(/\s*\(?PTO (?:entered|approved) by \S+?\)?$/, ''))
  const [busy, setBusy] = useState(false)
  const minutes = ptoMinutesFor(Number(hours))
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Edit PTO day"
      description={dayLabel(row.workDate)}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={busy || minutes <= 0} onClick={() => { setBusy(true); void onSave(minutes, note).finally(() => setBusy(false)) }}>Save</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TmsField label="Hours"><TmsInput type="number" min={0.25} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} /></TmsField>
        <TmsField label="Note"><TmsInput value={note} onChange={(e) => setNote(e.target.value)} /></TmsField>
      </div>
    </TmsDialog>
  )
}

export function PtoDaysSection({
  drivers, staffEmail, today, onChanged,
}: {
  drivers: PtoDriver[]
  staffEmail: string
  /** Chicago today, YYYY-MM-DD. */
  today: string
  /** Called after any add, edit or remove so the fortnight above re-reads its rows. */
  onChanged: () => void
}) {
  const [year, setYear] = useState(today.slice(0, 4))
  const [rows, setRows] = useState<TimeClockEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [driverId, setDriverId] = useState('')
  const [month, setMonth] = useState('')
  const [weekOf, setWeekOf] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PtoRow | null>(null)
  const [removing, setRemoving] = useState<PtoRow | null>(null)

  const load = useCallback(() => {
    listTimeClockEntries({ from: `${Number(year) - 2}-01-01`, to: `${year}-12-31` })
      .then((r) => { setRows(r.filter((e) => e.kind === 'PTO')); setError(null) })
      .catch((e) => setError(errorText(e)))
  }, [year])
  useEffect(() => { load() }, [load])

  const names = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])
  const all = useMemo(() => ptoRowsOf((rows ?? []) as unknown as TimeClockRow[] as never), [rows])
  const shown = useMemo(() => filterPtoRows(all.filter((r) => r.workDate.startsWith(year)), { driverId: driverId || undefined, month: month ? `${year}-${month}` : undefined, weekOf: weekOf || undefined }), [all, driverId, month, year, weekOf])
  const totals = useMemo(() => ptoTotalsByDriver(all, year).sort((a, b) => (names.get(a.driverId) ?? '').localeCompare(names.get(b.driverId) ?? '')), [all, year, names])
  // Balance as of today for the current year, else the year's last day.
  const asOf = year === today.slice(0, 4) ? today : `${year}-12-31`
  const balances = useMemo(() => {
    const used = new Map(totals.map((t) => [t.driverId, t]))
    return drivers
      .map((d) => ({ d, t: used.get(d.id), bal: ptoBalance(d.hireDate, asOf, all.filter((r) => r.driverId === d.id)) }))
      .filter((x) => x.t || x.d.ptoEligible === true || (x.bal?.allowance ?? 0) > 0)
      .sort((a, b) => a.d.name.localeCompare(b.d.name))
  }, [drivers, totals, all, asOf])
  const years = useMemo(() => { const y = Number(today.slice(0, 4)); return [y + 1, y, y - 1, y - 2].map(String) }, [today])
  const entryOf = (id: string) => (rows ?? []).find((r) => r.id === id)

  const done = (message: string) => { toast.success(message); load(); onChanged() }

  return (
    <section className="mt-8 flex flex-col gap-3 print:hidden" aria-label="PTO days">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">PTO days</h2>
        <TmsSelect aria-label="PTO year" value={year} onChange={(e) => setYear(e.target.value)} className="w-24">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </TmsSelect>
        <TmsButton variant="primary" className="ml-auto" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> Add PTO days</TmsButton>
      </div>

      {error && <p role="alert" className="text-sm text-[color:var(--tms-badge-red)]">PTO days could not be loaded: {error}</p>}

      <div className="flex flex-wrap gap-2" aria-label={`PTO used in ${year}`}>
        {totals.length === 0 && rows !== null && <span className="text-sm text-muted-foreground">No PTO days recorded for {year}.</span>}
        {balances.map(({ d, t, bal }) => (
          <span key={d.id} className="rounded-full border border-border px-3 py-1 text-sm">
            {d.name}: <b>{t?.days ?? 0}</b> {t?.days === 1 ? 'day' : 'days'} · {decimalHours(t?.minutes ?? 0)} h
            {bal && bal.allowance > 0
              ? <span className={bal.remaining < 0 ? 'text-[color:var(--tms-badge-red)]' : 'text-muted-foreground'}>{' '}· {formatDays(bal.used)} of {bal.allowance} used, {bal.remaining >= 0 ? `${formatDays(bal.remaining)} left` : `${formatDays(-bal.remaining)} over`}</span>
              : <span className="text-muted-foreground">{' '}· {validHireDate(d.hireDate) ? (startsText(d.hireDate, today) ?? `no allowance in ${year}`) : 'No hire date'}</span>}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <TmsField label="Driver">
          <TmsSelect value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">All drivers</option>
            {sortDriversForPto(drivers).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Month">
          <TmsSelect value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Whole year</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Week containing">
          <TmsInput type="date" value={weekOf} onChange={(e) => setWeekOf(e.target.value)} />
        </TmsField>
        {(driverId || month || weekOf) && <TmsButton variant="ghost" onClick={() => { setDriverId(''); setMonth(''); setWeekOf('') }}>Clear filters</TmsButton>}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm" aria-label="PTO days taken">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Driver</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 font-medium">Note</th>
              <th className="px-3 py-2 font-medium">Entered by</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows === null && !error && <tr><td className="px-3 py-3 text-muted-foreground" colSpan={6}>Loading…</td></tr>}
            {rows !== null && shown.length === 0 && <tr><td className="px-3 py-3 text-muted-foreground" colSpan={6}>No PTO days match.</td></tr>}
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border/60">
                <td className="whitespace-nowrap px-3 py-2">{dayLabel(r.workDate)}</td>
                <td className="px-3 py-2">{names.get(r.driverId) ?? 'Driver'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{decimalHours(r.minutes)}{r.corrected && <span className="ml-1 text-[10px] text-muted-foreground" title="Corrected">edited</span>}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.note.replace(/\s*\(?PTO (?:entered|approved) by \S+?\)?$/, '') || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.enteredBy || '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <TmsButton size="sm" variant="ghost" aria-label={`Edit PTO ${r.workDate} ${names.get(r.driverId) ?? ''}`} onClick={() => setEditing(r)}>Edit</TmsButton>
                  <TmsButton size="sm" variant="ghost" aria-label={`Remove PTO ${r.workDate} ${names.get(r.driverId) ?? ''}`} onClick={() => setRemoving(r)}>Remove</TmsButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddDialog
          drivers={drivers}
          existing={all}
          today={today}
          onClose={() => setAdding(false)}
          onSave={async (v) => {
            try {
              const { added } = await addPtoDays({ ...v, staffEmail })
              setAdding(false)
              done(`${added} PTO ${added === 1 ? 'day' : 'days'} added`)
            } catch (e) { toast.error(errorText(e)); load(); onChanged() }
          }}
        />
      )}
      {editing && (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSave={async (minutes, note) => {
            const entry = entryOf(editing.id)
            if (!entry) { setEditing(null); return }
            try { await editPtoDay(entry, { minutes, note }, staffEmail); setEditing(null); done('PTO day updated') } catch (e) { toast.error(errorText(e)) }
          }}
        />
      )}
      {removing && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open) setRemoving(null) }}
          title="Remove this PTO day?"
          description={`${names.get(removing.driverId) ?? 'Driver'} · ${dayLabel(removing.workDate)} · ${decimalHours(removing.minutes)} h. It comes off the time card and the calendar.`}
          footer={
            <>
              <TmsButton variant="ghost" onClick={() => setRemoving(null)}>Keep</TmsButton>
              <TmsButton
                variant="destructive"
                onClick={() => { const r = removing; void removePtoDay({ id: r.id, driverId: r.driverId, workDate: r.workDate }).then(() => { setRemoving(null); done('PTO day removed') }).catch((e) => toast.error(errorText(e))) }}
              >Remove</TmsButton>
            </>
          }
        />
      )}
    </section>
  )
}
