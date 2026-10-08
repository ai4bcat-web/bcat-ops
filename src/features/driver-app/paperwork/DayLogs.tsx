/**
 * The driver's own duty log for the day on screen, on demand.
 *
 * Only offered when logs are actually required by something that day — on a short-haul
 * day there is no record to keep, so a log panel would be inviting a driver to worry
 * about paperwork the exemption spares them. Fetched only when opened: one Motive call
 * per day the driver actually looks at.
 */
import { useState } from 'react'
import { AlertTriangle, ClipboardList } from 'lucide-react'
import type { PaperworkLoad } from '../driverApi'
import { HosPanel } from './HosPanel'

export function DayLogs({ loads, date }: { loads: PaperworkLoad[]; date: string }) {
  const [open, setOpen] = useState(false)
  // UNKNOWN gets its own "check" state rather than being folded into "not required" —
  // the point of surfacing it is that somebody looks. NOT_REQUIRED says nothing: a "no
  // logs needed" line on every local day would be noise on a sheet that is mostly local.
  const flagged = loads.filter((l) => l.eld && l.eld.status !== 'NOT_REQUIRED')
  if (flagged.length === 0) return null
  const required = flagged.some((l) => l.eld?.status === 'REQUIRED')
  const tone = required ? 'border-sky-400/40 bg-sky-500/10 text-sky-100' : 'border-amber-400/40 bg-amber-500/10 text-amber-100'
  return (
    <div className={`mt-4 rounded-xl border p-4 ${tone}`}>
      <p className="flex items-center gap-2 text-sm font-bold">
        {required ? <ClipboardList className="h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />}
        {required ? 'ELD logs required' : 'Check ELD'}
      </p>
      {flagged.map((l) => (
        <p key={l.id} className="mt-1 text-sm opacity-90">{l.eld?.label}</p>
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
