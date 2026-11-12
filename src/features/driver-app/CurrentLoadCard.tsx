/**
 * The driver's current load, at the top of the Loads tab.
 *
 * It answers one question: which load am I on, and what does the office still need
 * from me before it can be invoiced. Driver-reported status was removed — the office
 * learns what it needs from the documents arriving and from the ELD, so asking a driver
 * to tap a progression on top of that was work with no reader.
 *
 * Location is never read from the browser. Position on the dashboard comes from the
 * ELD; this screen is documents only.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Truck, FileText, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchOpenLoads, type CurrentLoad } from './driverApi'

/** "Wed 1 Oct, 4:30 AM" — short enough for a phone, explicit about the day. */
function apptLabel(iso: string | null): string {
  if (!iso) return 'TBD'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'TBD'
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  })
}

export function CurrentLoadCard() {
  const [load, setLoad] = useState<CurrentLoad | null>(null)
  const [alsoOpen, setAlsoOpen] = useState<CurrentLoad[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // A promise chain, not an async function: the mount effect calls this directly and
  // every state write has to land after the fetch, never in the same synchronous tick.
  const refresh = useCallback(() =>
    fetchOpenLoads()
      .then((next) => { setLoad(next.load); setAlsoOpen(next.alsoOpen); setError(null) })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load your current job')
      })
      .finally(() => setLoading(false)),
  [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--tms-border)] p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking your current load…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-[var(--tms-border)] p-4 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[color:var(--tms-badge-orange)]" />
        <div className="flex-1">
          <p className="text-foreground">{error}</p>
          {/* Accessible name is specific: this card sits above the submissions
              list, which has its own retry, and two controls called "Try again"
              are ambiguous to a screen reader and to tests alike. */}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            aria-label="Retry loading your current load"
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </div>
      </div>
    )
  }

  // Rest state: nothing assigned is normal, not a failure.
  if (!load) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--tms-border)] p-5 text-center">
        <Truck className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">No load running</p>
        <p className="text-xs text-muted-foreground">
          Your next load shows up here once dispatch assigns it. You can still scan a POD
          at any time.
        </p>
      </div>
    )
  }

  /*
   * The POD is what the driver owes, plus anything the office ticked for this load.
   *
   * A rate confirmation is the broker's paperwork and the office collects it in the
   * factoring queue. Listing it here asked a driver for something they often do not have
   * and cannot get, which makes the whole notice easy to ignore — including the half that
   * is genuinely theirs and genuinely holds their pay.
   */
  const podIn = load.hasPod
  // The office can ask for more than the POD on a load (a lumper receipt, a scale ticket).
  const extraDocsNeeded = (load.requiredDocs ?? []).length > 1
  const allDocsIn = (load.requiredDocs ?? []).every((d) => d.done)

  return (
    <div className="space-y-3">
    <div className="rounded-xl border border-[var(--tms-border)] bg-[var(--tms-card)] p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">PRO {load.proNumber || '—'}</p>
          <h2 className="truncate text-base font-semibold text-foreground">{load.lane}</h2>
          {load.customer && (
            <p className="truncate text-xs text-muted-foreground">{load.customer}</p>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div>
          <dt className="text-muted-foreground">Pick up</dt>
          <dd className="font-medium text-foreground">{apptLabel(load.pickupAppt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Deliver</dt>
          <dd className="font-medium text-foreground">{apptLabel(load.deliveryAppt)}</dd>
        </div>
      </dl>

      {/* Extra paperwork the office asked for on this load: listed with what is already in. */}
      {extraDocsNeeded ? (
        <section aria-label="Documents needed for this load" data-testid="load-required-docs" className="mt-3 rounded-lg border border-[var(--tms-border)] p-2.5 text-xs">
          <p className="font-medium text-foreground">Documents needed for this load</p>
          <ul className="mt-1.5 space-y-1">
            {(load.requiredDocs ?? []).map((d) => (
              <li key={d.type} className="flex items-center gap-1.5" data-testid={`load-required-doc-${d.type}`} data-done={d.done ? 'true' : 'false'}>
                {d.done
                  ? <CheckCircle2 className="size-3.5 text-[color:var(--tms-badge-green)]" aria-label="In" />
                  : <XCircle className="size-3.5 text-[color:var(--tms-badge-orange)]" aria-label="Still needed" />}
                <span className="text-foreground">{d.label}</span>
                <span className="text-muted-foreground">{d.done ? 'in' : 'still needed'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted-foreground">
            {allDocsIn ? 'Everything is in. Nothing else needed from you.' : 'Send each one from the Scan tab. The load is not paid until all of them are in.'}
          </p>
        </section>
      ) : podIn ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[color:var(--tms-badge-green)]">
          <CheckCircle2 className="size-3.5" />
          POD is in. Nothing else needed from you.
        </p>
      ) : (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-[color:var(--tms-badge-orange-tint)] p-2.5 text-xs text-[color:var(--tms-badge-orange)]">
          <FileText className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Send the POD for this load from the Scan tab. It is not paid until the POD is in.
          </span>
        </div>
      )}

      {/* Stated, not asked for: the office adds this one when the load reaches factoring. */}
      {!load.hasRateConfirmation && (
        <p className="mt-2 text-xs text-muted-foreground">
          No rate confirmation on file yet. The office adds that one, so there is nothing
          for you to do — send it from the Scan tab only if you have it.
        </p>
      )}
    </div>
    {alsoOpen.length > 0 && (
      <section aria-label="Also on your list" data-testid="also-open-loads">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Also on your list</h3>
        <ul className="mt-1.5 space-y-2">
          {alsoOpen.map((l) => (
            <li key={l.id} className="rounded-xl border border-[var(--tms-border)] bg-[var(--tms-card)] p-3 text-xs shadow-sm">
              <p className="font-mono text-muted-foreground">PRO {l.proNumber || '—'}</p>
              <p className="truncate text-sm font-semibold text-foreground">{l.lane}</p>
              {l.customer && <p className="truncate text-muted-foreground">{l.customer}</p>}
              <p className="mt-1 text-foreground">
                <span className="text-muted-foreground">Pick up </span>{apptLabel(l.pickupAppt)}
                <span className="text-muted-foreground"> · Deliver </span>{apptLabel(l.deliveryAppt)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    )}
    </div>
  )
}
