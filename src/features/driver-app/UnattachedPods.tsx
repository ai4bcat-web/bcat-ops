/**
 * PODs this driver sent without a load number, and a way to put them on a load.
 *
 * A driver standing at a dock usually has the signed paperwork before the office has
 * built the load. Making them wait would mean a POD that never gets sent, so the app
 * takes it unattached — and then has to give them somewhere to finish the job, because
 * an unattached POD counts for nothing: it is the link to the load that lets the load be
 * invoiced, and therefore paid.
 *
 * The office can attach these too, from Driver Docs. Whoever gets there first wins;
 * attaching twice is harmless.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Link2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  fetchSubmissions,
  fetchRecentLoads,
  attachSubmissionToLoad,
  type SubmissionSummary,
  type RecentLoad,
} from './driverApi'

/** "1 Oct" — enough to tell two loads apart on a phone. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return 'no date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'no date'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** A POD that is not on a load yet. A rate con alone is not this driver's problem. */
function isUnattachedPod(s: SubmissionSummary): boolean {
  return !s.loadId && s.docs.some((d) => d.kind === 'POD')
}

/**
 * `submissions` comes from the page above when that page already has them — a second
 * identical request is pure cost on a truck connection. Omit it and this fetches its own,
 * which is how the settlement page uses it.
 *
 * The load list is always fetched lazily, only once a driver actually opens a picker.
 */
export function UnattachedPods({
  submissions,
  onAttached,
}: {
  submissions?: SubmissionSummary[] | null
  onAttached?: (submissionId: string, loadId: string) => void
}) {
  const [ownSubmissions, setOwnSubmissions] = useState<SubmissionSummary[] | null>(null)
  const selfFetch = submissions === undefined

  useEffect(() => {
    if (!selfFetch) return
    let cancelled = false
    void fetchSubmissions()
      .then((rows) => { if (!cancelled) setOwnSubmissions(rows) })
      .catch(() => { if (!cancelled) setOwnSubmissions([]) })
    return () => { cancelled = true }
  }, [selfFetch])

  const [loads, setLoads] = useState<RecentLoad[] | null>(null)
  const [loadsError, setLoadsError] = useState<string | null>(null)
  /** Which POD is being attached, so only its own picker opens. */
  const [picking, setPicking] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const source = selfFetch ? ownSubmissions : submissions
  const pods = (source ?? []).filter(isUnattachedPod)

  const openPicker = useCallback(async (submissionId: string) => {
    setPicking(submissionId)
    if (loads !== null) return
    try {
      setLoadsError(null)
      setLoads(await fetchRecentLoads())
    } catch (err) {
      setLoadsError(err instanceof Error ? err.message : 'Could not load your loads')
    }
  }, [loads])

  const attach = useCallback(
    async (submissionId: string, load: RecentLoad) => {
      setSaving(submissionId)
      try {
        await attachSubmissionToLoad(submissionId, load.id)
        setPicking(null)
        toast.success(`POD attached to PRO ${load.proNumber || load.lane}`)
        // Drop it locally when we own the list; otherwise the parent patches its copy.
        setOwnSubmissions((prev) =>
          prev ? prev.map((s) => (s.id === submissionId ? { ...s, loadId: load.id } : s)) : prev,
        )
        onAttached?.(submissionId, load.id)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not attach the POD')
      } finally {
        setSaving(null)
      }
    },
    [onAttached],
  )

  // Nothing waiting is the normal state, and it needs no words at all.
  if (pods.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <Link2 className="mt-0.5 size-4 shrink-0 text-amber-700" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-amber-900">
            {pods.length === 1 ? '1 POD is not on a load yet' : `${pods.length} PODs are not on a load yet`}
          </h2>
          <p className="text-xs text-amber-800">
            Pick the load each one belongs to. A POD only counts once it is on a load.
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {pods.map((pod) => {
          const open = picking === pod.id
          const pages = pod.docs.filter((d) => d.kind === 'POD').length
          return (
            <li key={pod.id} className="rounded-lg border border-amber-200 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-xs">
                  <p className="font-medium text-foreground">
                    Sent {shortDate(pod.createdAt)} · {pages} {pages === 1 ? 'page' : 'pages'}
                  </p>
                  {pod.referenceNumber && (
                    <p className="text-muted-foreground">You wrote: {pod.referenceNumber}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={open ? 'outline' : 'default'}
                  className="h-9 shrink-0"
                  disabled={saving !== null}
                  onClick={() => (open ? setPicking(null) : void openPicker(pod.id))}
                >
                  {open ? 'Cancel' : 'Choose load'}
                </Button>
              </div>

              {open && (
                <div className="mt-3">
                  {loadsError ? (
                    <div className="text-xs">
                      <p className="text-amber-800">{loadsError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        aria-label="Retry loading your loads"
                        onClick={() => { setLoads(null); void openPicker(pod.id) }}
                      >
                        Try again
                      </Button>
                    </div>
                  ) : loads === null ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> Loading your loads…
                    </p>
                  ) : loads.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      None of your loads are built yet. The office will attach this one.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {loads.map((load) => (
                        <li key={load.id}>
                          <button
                            type="button"
                            disabled={saving !== null}
                            onClick={() => void attach(pod.id, load)}
                            className="flex w-full items-center gap-2 rounded-lg border border-[var(--ds-border)] px-3 py-2.5 text-left disabled:opacity-60"
                          >
                            {saving === pod.id ? (
                              <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                              <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-foreground">
                                PRO {load.proNumber || '—'} · {load.lane}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {shortDate(load.deliveryAppt)}
                                {load.customer ? ` · ${load.customer}` : ''}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
