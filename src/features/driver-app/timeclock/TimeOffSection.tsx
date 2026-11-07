/**
 * Time off, asked for in hours and approved by the office.
 *
 * A request lands as Pending; nothing reaches the calendar, the planner or the clock until
 * the office approves it. The rules (PTO is one eight-hour day inside a window, everything
 * else starts today or later) live in src/lib/timeOff.ts and run here before the request is
 * sent, and again on the server, so what the form refuses is what the server would refuse.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { fetchTimeOff, requestTimeOff, type TimeOffState } from '../driverApi'
import {
  addDaysISO, describeRange, PTO_DAYS_AHEAD, PTO_DAYS_BACK, PTO_HOURS, statusOf,
  validateTimeOffRequest, type TimeOffStatus, type TimeOffType,
} from '@/lib/timeOff'
import { errorText } from '@/lib/errorText'

const TYPE_LABEL: Record<TimeOffType, string> = {
  FULL_DAY_OFF: 'Day off',
  EARLY_START: 'Early start',
  LATE_START: 'Late start',
  PTO: 'PTO',
}

const STATUS_BADGE: Record<TimeOffStatus, { label: string; cls: string }> = {
  PENDING: { label: 'Pending', cls: 'bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)]' },
  APPROVED: { label: 'Approved', cls: 'bg-[color:var(--tms-badge-green-tint)] text-[color:var(--tms-badge-green)]' },
  DENIED: { label: 'Denied', cls: 'bg-[color:var(--tms-badge-red-tint)] text-[color:var(--tms-badge-red)]' },
}

const FIELD = 'h-11 w-full rounded-md border border-border bg-background px-3 text-base text-foreground disabled:opacity-60'
const LABEL = 'mb-1 block text-sm font-medium text-muted-foreground'

/** "1 day" / "3 days". */
const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export function TimeOffSection({ today, readOnly, refreshKey }: {
  /** The Chicago day, from the clock's own response. */
  today: string
  /** Staff viewing a driver's app: they may look, not ask on the driver's behalf. */
  readOnly: boolean
  /** Bumped by the page when it files a request itself, so the list reloads. */
  refreshKey: number
}) {
  const [state, setState] = useState<TimeOffState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [type, setType] = useState<TimeOffType>('FULL_DAY_OFF')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [hours, setHours] = useState('8')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchTimeOff()
      .then((s) => { setState(s); setLoadError(null) })
      .catch((e) => setLoadError(errorText(e)))
  }, [])

  // refreshKey is the page's way of saying a request was filed elsewhere: reload when it changes.
  useEffect(() => { load() }, [load, refreshKey])

  if (!state) {
    return (
      <section className="mt-6" aria-label="Time off">
        <h2 className="mb-2 text-base font-semibold text-foreground">Time off</h2>
        {loadError
          ? <p className="text-sm text-muted-foreground">{loadError}</p>
          : <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />}
      </section>
    )
  }

  const { ptoEligible, ptoUsed, requests } = state
  const isPto = type === 'PTO'

  const pick = (t: TimeOffType) => {
    setType(t)
    setFormError(null)
    if (t === 'PTO') { setEndDate(startDate); setHours(String(PTO_HOURS)) }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const checked = validateTimeOffRequest(
      { type, startDate, endDate: isPto ? startDate : endDate, hours: isPto ? PTO_HOURS : hours, note },
      today,
      ptoEligible,
    )
    if (!checked.ok) { setFormError(checked.error); return }
    const v = checked.value
    setBusy(true)
    setFormError(null)
    try {
      await requestTimeOff({
        type: v.type, startDate: v.startDate, endDate: v.endDate, hours: v.hours,
        ...(v.note ? { note: v.note } : {}),
      })
      toast.success('Requested — the office will review it')
      setNote('')
      setType('FULL_DAY_OFF')
      setStartDate(today)
      setEndDate(today)
      setHours('8')
      load()
    } catch (err) {
      const msg = errorText(err)
      setFormError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const locked = busy || readOnly

  return (
    <section className="mt-6" aria-label="Time off">
      <h2 className="mb-2 text-base font-semibold text-foreground">Time off</h2>

      {(ptoEligible || ptoUsed.days > 0) && (
        <p className="mb-3 text-sm text-muted-foreground">
          PTO used in {ptoUsed.year}: <span className="font-semibold text-foreground">{dayCount(ptoUsed.days)}</span>
        </p>
      )}

      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div>
          <label htmlFor="to-type" className={LABEL}>Type</label>
          <select id="to-type" className={FIELD} value={type} disabled={locked} onChange={(e) => pick(e.target.value as TimeOffType)}>
            <option value="FULL_DAY_OFF">{TYPE_LABEL.FULL_DAY_OFF}</option>
            <option value="EARLY_START">{TYPE_LABEL.EARLY_START}</option>
            <option value="LATE_START">{TYPE_LABEL.LATE_START}</option>
            {ptoEligible && <option value="PTO">{TYPE_LABEL.PTO}</option>}
          </select>
          {!ptoEligible && <p className="mt-1 text-xs text-muted-foreground">PTO is not set up for you</p>}
        </div>

        <div className={isPto ? '' : 'grid grid-cols-2 gap-3'}>
          <div>
            <label htmlFor="to-start" className={LABEL}>{isPto ? 'Date' : 'First day'}</label>
            <input
              id="to-start" type="date" className={FIELD} value={startDate} disabled={locked}
              min={isPto ? addDaysISO(today, -PTO_DAYS_BACK) : today}
              max={isPto ? addDaysISO(today, PTO_DAYS_AHEAD) : undefined}
              onChange={(e) => { setStartDate(e.target.value); if (isPto || endDate < e.target.value) setEndDate(e.target.value) }}
            />
          </div>
          {!isPto && (
            <div>
              <label htmlFor="to-end" className={LABEL}>Last day</label>
              <input
                id="to-end" type="date" className={FIELD} value={endDate} min={startDate} disabled={locked}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          )}
        </div>

        <div>
          <label htmlFor="to-hours" className={LABEL}>Hours</label>
          <input
            id="to-hours" type="number" inputMode="decimal" min="0.25" step="0.25" className={FIELD}
            value={isPto ? String(PTO_HOURS) : hours} disabled={locked || isPto}
            onChange={(e) => setHours(e.target.value)}
          />
          {isPto && <p className="mt-1 text-xs text-muted-foreground">PTO is a full {PTO_HOURS}-hour day</p>}
        </div>

        <div>
          <label htmlFor="to-note" className={LABEL}>Note (optional)</label>
          <input
            id="to-note" type="text" className={FIELD} value={note} maxLength={500} disabled={locked}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {formError && <p role="alert" className="text-sm text-[color:var(--tms-badge-red)]">{formError}</p>}
        {readOnly && <p className="text-xs text-muted-foreground">Read-only while viewing as a driver</p>}

        <Button type="submit" className="h-12" disabled={locked}>
          {busy ? 'Sending…' : 'Submit request'}
        </Button>
      </form>

      {requests.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Your requests">
          {requests.map((r) => {
            const badge = STATUS_BADGE[statusOf(r)]
            return (
              <li key={r.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-base font-semibold text-foreground">{describeRange(r.startDate, r.endDate)}</p>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.cls}`}>{badge.label}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {TYPE_LABEL[r.type]}{r.hours != null ? ` · ${r.hours}h` : ''}
                  {r.note ? ` · ${r.note}` : ''}
                </p>
                {r.reviewNote && <p className="mt-1 text-sm text-foreground">Office: {r.reviewNote}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
