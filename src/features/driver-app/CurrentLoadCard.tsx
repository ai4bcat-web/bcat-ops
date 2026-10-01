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
import { Loader2, Truck, FileText, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchCurrentLoad, type CurrentLoad } from './driverApi'

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // A promise chain, not an async function: the mount effect calls this directly and
  // every state write has to land after the fetch, never in the same synchronous tick.
  const refresh = useCallback(() =>
    fetchCurrentLoad()
      .then((next) => { setLoad(next); setError(null) })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load your current job')
      })
      .finally(() => setLoading(false)),
  [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--ds-border)] p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking your current load…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-[var(--ds-border)] p-4 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
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
      <div className="rounded-xl border border-dashed border-[var(--ds-border)] p-5 text-center">
        <Truck className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">No load running</p>
        <p className="text-xs text-muted-foreground">
          Your next load shows up here once dispatch assigns it. You can still scan a POD
          at any time.
        </p>
      </div>
    )
  }

  const complete = load.hasRateConfirmation && load.hasPod

  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface)] p-4 shadow-sm">
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

      {/* Why a load might be held up at billing — shown to the driver, not hidden in the office. */}
      {complete ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700">
          <CheckCircle2 className="size-3.5" />
          Rate confirmation and POD are both in. Nothing else needed.
        </p>
      ) : (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
          <FileText className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Still needed to bill this load:{' '}
            {[!load.hasRateConfirmation && 'rate confirmation', !load.hasPod && 'POD']
              .filter(Boolean)
              .join(' and ')}
            . Use the Scan tab to send {load.hasRateConfirmation ? 'it' : 'them'} in.
          </span>
        </div>
      )}
    </div>
  )
}
