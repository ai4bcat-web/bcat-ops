import { useCallback, useEffect, useMemo, useState } from 'react'
import { Upload, RefreshCw, Loader2, FileText, User, AlertCircle, ExternalLink, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { toast } from 'sonner'
import {
  listDriverSubmissions,
  getDriverDocUrl,
  setDriverSubmissionLoad,
  isUnassignedPod,
  type SubmissionWithDocs,
  type DriverSubmissionDocRecord,
  type SubmissionSource,
} from '@/lib/driverSubmissionsClient'
import { DriverDocUploadDialog } from './DriverDocUploadDialog'
import { AssignLoadDialog } from '@/features/pods/AssignLoadDialog'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function sourceLabel(source: SubmissionSource | null | undefined, submittedByEmail?: string | null): string {
  if (source === 'STAFF') {
    return submittedByEmail ? `Staff (${submittedByEmail})` : 'Staff'
  }
  if (source === 'EMAIL') return 'Email'
  return 'Driver PWA'
}

function kindBadge(kind: 'RATECON' | 'POD') {
  if (kind === 'RATECON') {
    return <Badge variant="secondary" className="text-xs">RATECON</Badge>
  }
  return <Badge variant="outline" className="text-xs">POD</Badge>
}

function DocThumbnail({ doc }: { doc: DriverSubmissionDocRecord }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getDriverDocUrl(doc.s3Key)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [doc.s3Key])

  const isPdf = doc.contentType === 'application/pdf' || doc.s3Key.endsWith('.pdf')
  const label = doc.pageNumber ? `Page ${doc.pageNumber}` : doc.fileName ?? 'Doc'

  return (
    <a
      href={url ?? '#'}
      target="_blank"
      rel="noreferrer"
      title={doc.fileName ?? doc.s3Key}
      className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-accent"
    >
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : url ? (
        <>
          {isPdf ? <FileText className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />}
          <span className="max-w-[120px] truncate">{label}</span>
        </>
      ) : (
        <>
          <AlertCircle className="h-3 w-3 text-destructive" />
          <span className="max-w-[120px] truncate">{label}</span>
        </>
      )}
    </a>
  )
}

export function DriverDocsPage() {
  const drivers = useAppStore((s) => s.drivers)
  const loads = useAppStore((s) => s.loads)
  const { user } = useAuth()
  const staffEmail = user?.email ?? ''

  const [submissions, setSubmissions] = useState<SubmissionWithDocs[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  /**
   * Which PODs to show. A POD a driver sent without a load number counts for nothing
   * until someone attaches it — it is not on the load, so the load cannot be invoiced
   * and the driver is not paid for it. The filter exists so that queue is visible
   * rather than buried in a reverse-chronological list.
   */
  const [filter, setFilter] = useState<'ALL' | 'NEEDS_LOAD'>('ALL')
  /** The submission whose assign dialog is open. */
  const [assigning, setAssigning] = useState<SubmissionWithDocs | null>(null)

  // A promise chain, not an async function: the mount effect calls this directly and
  // every state write has to land after the fetch, never in the same synchronous tick.
  const load = useCallback(() =>
    listDriverSubmissions(500)
      .then((rows) => { setSubmissions(rows); setError(null) })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load submissions'
        setError(message)
        toast.error(message)
      })
      .finally(() => setLoading(false)),
  [])

  /** Manual reload from the Refresh button, which does want the spinner back. */
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => {
    void load()
  }, [load])

  const driversById = useMemo(() => {
    const map = new Map(drivers.map((d) => [d.id, d]))
    return map
  }, [drivers])

  const handleSubmitted = useCallback((submission: SubmissionWithDocs) => {
    setSubmissions((prev) => [submission, ...prev])
  }, [])

  const needsLoad = useMemo(() => submissions.filter(isUnassignedPod), [submissions])
  const shown = filter === 'NEEDS_LOAD' ? needsLoad : submissions

  const handleAssign = useCallback(async (submission: SubmissionWithDocs, loadId: string | null) => {
    try {
      const updated = await setDriverSubmissionLoad(submission.id, loadId)
      // Patch in place; the docs are unchanged and a refetch would lose scroll position.
      setSubmissions((prev) =>
        prev.map((s) => (s.id === submission.id ? { ...s, ...updated, docs: s.docs } : s)),
      )
      const pro = loadId ? (loads.find((l) => l.id === loadId)?.aljexId ?? '').trim() : ''
      toast.success(loadId ? `POD assigned to ${pro ? `PRO ${pro}` : 'the load'}` : 'POD unassigned')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not assign the POD')
    }
  }, [loads])

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="sticky top-0 z-10 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Driver Documents</h1>
            <span className="text-sm text-muted-foreground">Rate confirmations and PODs uploaded by drivers or on their behalf.</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Only worth showing once something is actually waiting. */}
            {needsLoad.length > 0 && (
              <div className="mr-1 flex items-center gap-1 rounded-lg border border-border p-0.5">
                {(['ALL', 'NEEDS_LOAD'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                      filter === key ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {key === 'ALL' ? `All ${submissions.length}` : `Needs a load ${needsLoad.length}`}
                  </button>
                ))}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="mr-1 h-3.5 w-3.5" />
              Upload
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 py-5">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && submissions.length === 0 && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading submissions…
          </div>
        )}

        {!loading && submissions.length === 0 && !error && (
          <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-sm text-muted-foreground">
            No driver submissions yet. Use the Upload button to add one on a driver&apos;s behalf.
          </div>
        )}

        {shown.length > 0 && (
          <div className="space-y-3">
            {shown.map((submission) => {
              const driver = driversById.get(submission.driverId) ?? null
              const driverName = driver?.name ?? submission.driverName
              const kinds = [...new Set(submission.docs.map((d) => d.kind))].sort()
              const unassigned = isUnassignedPod(submission)
              const assignedLoad = submission.loadId
                ? loads.find((l) => l.id === submission.loadId)
                : undefined
              return (
                <div
                  key={submission.id}
                  className={`rounded-xl border bg-card p-4 shadow-sm ${
                    unassigned ? 'border-amber-300' : 'border-border'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                        <User className="h-4 w-4 text-secondary-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="truncate font-medium">{driverName}</span>
                          {kinds.map((k) => (
                            <span key={k}>{kindBadge(k)}</span>
                          ))}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatDate(submission.createdAt)}</span>
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
                            {sourceLabel(submission.source, submission.submittedByEmail)}
                          </span>
                          {submission.referenceNumber && (
                            <span>Ref: {submission.referenceNumber}</span>
                          )}
                          {/* A PRO is what a person recognises; the raw load UUID is not. */}
                          {submission.loadId && (
                            <span>
                              Load{' '}
                              {assignedLoad?.aljexId?.trim()
                                ? `PRO ${assignedLoad.aljexId.trim()}`
                                : submission.loadId.slice(-6)}
                            </span>
                          )}
                          {unassigned && (
                            <span className="font-semibold text-amber-700">Needs a load</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Assign is offered on any POD: an unassigned one needs a load, and an
                        assigned one may have been put on the wrong load. */}
                    {submission.docs.some((d) => d.kind === 'POD') && (
                      <Button
                        variant={unassigned ? 'default' : 'outline'}
                        size="sm"
                        className="shrink-0"
                        onClick={() => setAssigning(submission)}
                      >
                        <Link2 className="mr-1 h-3.5 w-3.5" />
                        {submission.loadId ? 'Change load' : 'Assign to load'}
                      </Button>
                    )}
                  </div>

                  {submission.note && (
                    <p className="mt-3 text-sm text-muted-foreground">{submission.note}</p>
                  )}

                  {submission.docs.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {submission.docs.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0)).map((doc) => (
                        <DocThumbnail key={doc.id} doc={doc} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {assigning && (
        <AssignLoadDialog
          assignedLoadId={assigning.loadId}
          /* The driver is known outright here — unlike a texted POD, which has to be
             matched from a phone number. So their recent loads are offered first. */
          driver={driversById.get(assigning.driverId) ?? null}
          loads={loads}
          onAssign={(loadId) => { void handleAssign(assigning, loadId) }}
          onUnassign={() => { void handleAssign(assigning, null) }}
          onClose={() => setAssigning(null)}
        />
      )}

      <DriverDocUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        drivers={drivers}
        onSubmitted={handleSubmitted}
        staffEmail={staffEmail}
      />
    </div>
  )
}
