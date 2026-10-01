import { useCallback, useEffect, useMemo, useState } from 'react'
import { Upload, RefreshCw, Loader2, FileText, User, AlertCircle, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { toast } from 'sonner'
import {
  listDriverSubmissions,
  getDriverDocUrl,
  type SubmissionWithDocs,
  type DriverSubmissionDocRecord,
  type SubmissionSource,
} from '@/lib/driverSubmissionsClient'
import { DriverDocUploadDialog } from './DriverDocUploadDialog'

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
  const { user } = useAuth()
  const staffEmail = user?.email ?? ''

  const [submissions, setSubmissions] = useState<SubmissionWithDocs[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)

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

        {submissions.length > 0 && (
          <div className="space-y-3">
            {submissions.map((submission) => {
              const driverName = driversById.get(submission.driverId)?.name ?? submission.driverName
              const kinds = [...new Set(submission.docs.map((d) => d.kind))].sort()
              return (
                <div
                  key={submission.id}
                  className="rounded-xl border border-border bg-card p-4 shadow-sm"
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
                          {submission.loadId && <span>Load: {submission.loadId}</span>}
                        </div>
                      </div>
                    </div>
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
