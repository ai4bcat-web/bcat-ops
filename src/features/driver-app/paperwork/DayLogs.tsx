/**
 * Whether today needs ELD logs — said at the top of the day, every day.
 *
 * The 150 air-mile rule: a day with any pickup or delivery outside the radius from
 * Pleasant Prairie needs records of duty status; a day kept inside it does not. The
 * driver should know which BEFORE they roll, so this sits above the stops, and it says
 * "no logs needed" out loud on a local day rather than going quiet — silence reads as
 * "nobody checked". UNKNOWN (a stop that could not be placed) gets its own amber state
 * rather than being folded into "not required": the point of surfacing it is that
 * somebody looks. The driver's own log for the day is one tap away when logs are required.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardList } from 'lucide-react'
import type { PaperworkLoad } from '../driverApi'
import { HosPanel } from './HosPanel'
import { SHORT_HAUL_AIR_MILES, WORK_REPORTING_LOCATION } from '@/lib/eldRadius'
import { dayEldState } from './dayEld'

export function DayLogs({ loads, date, isToday = true }: { loads: PaperworkLoad[]; date: string; isToday?: boolean }) {
  const [open, setOpen] = useState(false)
  const state = dayEldState(loads)
  if (state === 'NO_DATA') return null
  const day = isToday ? 'today' : 'this day'
  const flagged = loads.filter((l) => l.eld && l.eld.status !== 'NOT_REQUIRED')

  if (state === 'NOT_REQUIRED') {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-bold">No ELD logs needed {day}.</span>
          {loads.length > 0
            ? ` Every stop is within ${SHORT_HAUL_AIR_MILES} air miles of ${WORK_REPORTING_LOCATION.name}.`
            : ' Nothing scheduled.'}
        </span>
      </div>
    )
  }

  const required = state === 'REQUIRED'
  const tone = required ? 'border-sky-400/40 bg-sky-500/10 text-sky-100' : 'border-amber-400/40 bg-amber-500/10 text-amber-100'
  return (
    <div className={`mb-4 rounded-xl border p-4 ${tone}`}>
      <p className="flex items-center gap-2 text-base font-bold">
        {required ? <ClipboardList className="h-5 w-5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />}
        {required ? `ELD logs required ${day}` : `Check ELD ${day}`}
      </p>
      {flagged.map((l) => (
        <p key={l.id} className="mt-1 text-sm opacity-90">{l.reference} · {l.eld?.label}</p>
      ))}
      {required && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
        >
          {open ? 'Hide my logs' : 'Show my logs for this day'}
        </button>
      )}
      {open && <HosPanel key={date} date={date} />}
    </div>
  )
}
