/**
 * The driver's current load, at the top of the Loads tab.
 *
 * One status per load — en route, on site, delivered — advanced by big buttons
 * sized for a phone in a truck. The server validates every transition, so the
 * buttons here only ever offer moves the shared rules already allow.
 *
 * Location is never read from the browser. Position on the dashboard comes from
 * the ELD; this screen is status and documents only.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, MapPin, Truck, FileText, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { fetchCurrentLoad, updateLoadStatus, type CurrentLoad } from './driverApi'

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
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      setLoad(await fetchCurrentLoad())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your current job')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const advance = useCallback(
    async (status: CurrentLoad['status'], label: string) => {
      if (!load) return
      setSaving(status)
      try {
        const next = await updateLoadStatus(load.id, status)
        setLoad({ ...load, ...next })
        toast.success(`Marked ${label.toLowerCase()}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the status')
      } finally {
        setSaving(null)
      }
    },
    [load],
  )

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
          Your next load shows up here once dispatch assigns it.
        </p>
      </div>
    )
  }

  const delivered = load.status === 'DELIVERED'

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
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
            delivered
              ? 'bg-emerald-50 text-emerald-700'
              : load.status === 'ON_SITE'
                ? 'bg-blue-50 text-blue-700'
                : load.status === 'EN_ROUTE'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-slate-100 text-slate-600'
          }`}
        >
          {load.statusLabel}
        </span>
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
      {(!load.hasRateConfirmation || !load.hasPod) && (
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

      {delivered ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700">
          <CheckCircle2 className="size-3.5" />
          Delivered{load.statusAt ? ` ${apptLabel(load.statusAt)}` : ''}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {load.nextStatuses.map((s) => (
            <Button
              key={s.value}
              size="lg"
              variant={s.value === 'DELIVERED' ? 'default' : 'outline'}
              className="h-12 flex-1 min-w-[140px]"
              disabled={saving !== null}
              onClick={() => void advance(s.value, s.label)}
            >
              {saving === s.value ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MapPin className="size-4" />
              )}
              {s.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
