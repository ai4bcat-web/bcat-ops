/**
 * One row per load the driver is hauling this week.
 *
 * Carries every detail of the load except what it pays — see paperwork.ts for why the
 * number is absent from the payload rather than merely hidden here.
 *
 * The POD state leads each row, because that is the one thing on this page the driver can
 * still do something about. Three states, and they are NOT the same problem:
 *   missing     nothing sent. The row asks for it.
 *   illegible   something was sent and nobody can read it. Worse than missing, because the
 *               driver believes they are done. The row says what was wrong with the photo
 *               and offers to replace it.
 *   on file     said quietly. A green tick nobody needs to read is the goal.
 */
import { AlertTriangle, Camera, Check, ClipboardList, Clock, FileWarning } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { PaperworkLoad } from '../driverApi'
import { HosPanel } from './HosPanel'

function apptLabel(iso: string | null): string {
  if (!iso) return 'No appointment'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'No appointment'
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  })
}

function PodBadge({ load }: { load: PaperworkLoad }) {
  const { pod } = load
  if (!pod.present) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-600">
        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
        POD needed
      </span>
    )
  }
  if (pod.legibility === 'UNREADABLE' || pod.legibility === 'LOW') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-600">
        <FileWarning className="h-3.5 w-3.5" aria-hidden="true" />
        {pod.legibility === 'UNREADABLE' ? 'POD unreadable' : 'POD hard to read'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700">
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      POD on file{pod.pages > 1 ? ` · ${pod.pages} pages` : ''}
    </span>
  )
}

/**
 * Whether this run needs records of duty status, by the 150 air-mile rule.
 *
 * Shown as a badge next to the POD badge so it is visible before the driver rolls, which is
 * the only time it is useful. UNKNOWN gets its own amber "check" state rather than being
 * folded into "not required" — the point of surfacing it is that somebody looks.
 */
/**
 * The calendar day this load delivered, as YYYY-MM-DD, for looking up that day's log.
 *
 * Taken from the delivery appointment because that is the day the driver was running it.
 * Null when there is no delivery date, in which case there is no day to ask Motive about.
 */
function deliveredDate(load: PaperworkLoad): string | null {
  const iso = load.deliveryAppt ?? load.pickupAppt
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function EldBadge({ load }: { load: PaperworkLoad }) {
  const { eld } = load
  // An API that predates the field tells us nothing; say nothing rather than "no logs".
  if (!eld) return null
  if (eld.status === 'REQUIRED') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-700"
        title={eld.label}
      >
        <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
        ELD logs required
      </span>
    )
  }
  if (eld.status === 'UNKNOWN') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-600"
        title={eld.label}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Check ELD
      </span>
    )
  }
  // Short-haul and inside the radius: no badge. A "no logs needed" chip on every local
  // load would be noise on a list that is almost entirely local runs.
  return null
}

/** One end of the lane: where, and when it is due there. */
function Leg({ label, place, when }: { label: string; place: string | null; when: string | null }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-10 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{place ?? '—'}</span>
        {when && (
          <span className="block text-xs tabular-nums text-muted-foreground">{apptLabel(when)}</span>
        )}
      </dd>
    </div>
  )
}

/** A fact about the load, small enough to sit beside the others. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{children}</span>
  )
}

export function PaperworkRows({
  loads,
  onSendPod,
  onRecordTimes,
}: {
  loads: PaperworkLoad[]
  onSendPod: (load: PaperworkLoad) => void
  onRecordTimes: (load: PaperworkLoad, leg: 'PICKUP' | 'DELIVERY') => void
}) {
  // Which rows have their duty log open. Per row, so opening one does not fetch the rest.
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set())
  const toggleLogs = (id: string) =>
    setOpenLogs((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  if (loads.length === 0) {
    return (
      <p className="rounded-xl bg-muted/40 p-5 text-center text-sm text-muted-foreground">
        Nothing delivering this week.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {loads.map((load) => {
        const times = [load.pickupTimes, load.deliveryTimes]
        const billable = times.some((t) => t.billable)
        return (
          <li key={load.id} className="rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-base font-bold text-foreground">{load.reference}</p>
                <p className="truncate text-sm text-muted-foreground">{load.customer ?? 'No customer'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <EldBadge load={load} />
                <PodBadge load={load} />
              </div>
            </div>

            {/*
              The lane, stacked rather than joined with an arrow. On a phone a long pair ran
              to three wrapped lines and which end was which stopped being obvious; two
              labelled lines survive any city name.
            */}
            <dl className="mt-3 flex flex-col gap-1.5">
              <Leg label="From" place={load.origin} when={load.pickupAppt} />
              <Leg label="To" place={load.destination} when={load.deliveryAppt} />
            </dl>

            {/*
              Everything else as chips on one wrapping line. This was a two-column grid of
              label-over-value pairs, which on a narrow screen left most of the row as white
              space and pushed the POD button below the fold — and the button is the thing
              the driver came to press. Rate is deliberately not among them.
            */}
            {(load.miles !== null || load.trailerNumber || load.commodity ||
              load.weight !== null || load.pieces !== null || load.status) && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {load.status && <Chip>{load.status}</Chip>}
                {load.trailerNumber && <Chip>Trailer {load.trailerNumber}</Chip>}
                {load.miles !== null && <Chip>{load.miles.toLocaleString()} mi</Chip>}
                {load.weight !== null && <Chip>{load.weight.toLocaleString()} lb</Chip>}
                {load.pieces !== null && <Chip>{load.pieces} pcs</Chip>}
                {load.commodity && <Chip>{load.commodity}</Chip>}
              </div>
            )}

            {load.stops.length > 2 && (
              <ol className="mt-3 flex flex-col gap-1 border-l border-border pl-3">
                {load.stops.map((s, i) => (
                  <li key={`${load.id}-stop-${i}`} className="text-xs text-muted-foreground">
                    <span className="font-semibold uppercase text-muted-foreground">{s.type}</span>{' '}
                    {[s.name, [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </li>
                ))}
              </ol>
            )}

            {/* Why logs are required, named so the driver can check it against the run. */}
            {load.eld && load.eld.status !== 'NOT_REQUIRED' && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-sky-500/10 p-3 text-sm text-sky-800">
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{load.eld.label}</span>
              </p>
            )}

            {/*
              The driver's own duty log for the day this load delivered, on demand.
              Only offered when logs are actually required — on a short-haul day there is
              no record to keep, so a log panel would be inviting a driver to worry about
              paperwork the exemption spares them.
            */}
            {load.eld?.status === 'REQUIRED' && deliveredDate(load) && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => toggleLogs(load.id)}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
                >
                  <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
                  {openLogs.has(load.id) ? 'Hide my logs' : 'Show my logs for this day'}
                </button>
                {openLogs.has(load.id) && <HosPanel key={deliveredDate(load)!} date={deliveredDate(load)!} />}
              </div>
            )}

            {load.notes && <p className="mt-3 text-sm text-muted-foreground">{load.notes}</p>}

            {/* Why a POD was rejected, in words the driver can act on. */}
            {load.pod.notes && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{load.pod.notes}. Please send a new photo.</span>
              </p>
            )}

            {billable && (
              <p className="mt-3 text-sm font-semibold text-amber-400">
                Detention recorded
                {load.pickupTimes.billable && load.pickupTimes.hours !== null && ` · pickup ${load.pickupTimes.hours}h`}
                {load.deliveryTimes.billable && load.deliveryTimes.hours !== null && ` · delivery ${load.deliveryTimes.hours}h`}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                className="h-12 flex-1 gap-2 text-base font-semibold"
                variant={load.pod.present && load.pod.legibility === 'OK' ? 'outline' : 'default'}
                onClick={() => onSendPod(load)}
              >
                <Camera className="h-4 w-4" aria-hidden="true" />
                {load.pod.present ? 'Replace POD' : 'Send POD'}
              </Button>
              <Button
                variant="outline"
                className="h-12 gap-2 text-sm"
                onClick={() => onRecordTimes(load, 'PICKUP')}
              >
                <Clock className="h-4 w-4" aria-hidden="true" />
                Pickup times
              </Button>
              <Button
                variant="outline"
                className="h-12 gap-2 text-sm"
                onClick={() => onRecordTimes(load, 'DELIVERY')}
              >
                <Clock className="h-4 w-4" aria-hidden="true" />
                Delivery times
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
