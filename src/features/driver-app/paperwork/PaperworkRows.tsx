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
import { AlertTriangle, Camera, Check, Clock, FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PaperworkLoad } from '../driverApi'

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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{value}</dd>
    </div>
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
              <PodBadge load={load} />
            </div>

            <p className="mt-2.5 text-sm text-muted-foreground">
              {[load.origin, load.destination].filter(Boolean).join('  →  ') || 'No lane'}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">Delivers {apptLabel(load.deliveryAppt)}</p>

            {/* Everything else about the load. Rate is deliberately not among it. */}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
              {load.pickupAppt && <Detail label="Pickup" value={apptLabel(load.pickupAppt)} />}
              {load.miles !== null && <Detail label="Miles" value={String(load.miles)} />}
              {load.trailerNumber && <Detail label="Trailer" value={load.trailerNumber} />}
              {load.commodity && <Detail label="Commodity" value={load.commodity} />}
              {load.weight !== null && <Detail label="Weight" value={`${load.weight.toLocaleString()} lb`} />}
              {load.pieces !== null && <Detail label="Pieces" value={String(load.pieces)} />}
              {load.status && <Detail label="Status" value={load.status} />}
            </dl>

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
