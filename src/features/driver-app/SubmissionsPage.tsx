import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Plus, Loader2, AlertCircle, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  DriverApiError,
  fetchDocUrl,
  fetchSubmissions,
  type SubmissionDoc,
  type SubmissionStatus,
  type SubmissionSummary,
} from './driverApi'
import { type BadgeVariantProps } from '@/lib/ui/badge-variants'
import { CurrentLoadCard } from './CurrentLoadCard'

function statusVariant(status: SubmissionStatus): NonNullable<BadgeVariantProps['variant']> {
  switch (status) {
    case 'NEW':
    case 'NOTIFIED':
      return 'default'
    case 'LINKED':
      return 'green'
    case 'ARCHIVED':
      return 'secondary'
    default:
      return 'outline'
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function DocThumbnail({
  submissionId,
  doc,
}: {
  submissionId: string
  doc: SubmissionDoc
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDocUrl(submissionId, doc.id)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        // A broken thumbnail does not block the list.
      })
    return () => {
      cancelled = true
    }
  }, [submissionId, doc.id])

  if (!url) {
    return (
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50">
        <ImageIcon className="h-6 w-6 text-slate-400" aria-hidden="true" />
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={doc.fileName}
      className="h-20 w-20 shrink-0 rounded-md border border-slate-200 object-cover"
    />
  )
}

function SubmissionCard({ submission }: { submission: SubmissionSummary }) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  return (
    <div
      data-testid="submission-card"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p data-testid="submission-title" className="truncate font-semibold text-slate-900">
            {submission.referenceNumber || `Submission ${submission.id.slice(-6)}`}
          </p>
          <p className="mt-1 text-xs text-slate-500">{formatDate(submission.createdAt)}</p>
        </div>
        <Badge variant={statusVariant(submission.status)}>{submission.status}</Badge>
      </div>

      {submission.note && (
        <p className="mt-2 line-clamp-2 text-sm text-slate-600">{submission.note}</p>
      )}

      {submission.docs.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {submission.docs.map((doc) => (
            <DocThumbnail key={doc.id} submissionId={submission.id} doc={doc} />
          ))}
        </div>
      )}

      <div className={`mt-4 flex ${isMobile ? 'justify-start' : 'justify-end'}`}>
        <Button
          size="lg"
          className="h-12 gap-2"
          onClick={() => navigate(`/driver/scan?kind=pod&submissionId=${encodeURIComponent(submission.id)}`)}
        >
          <Plus className="h-5 w-5" />
          Add POD
        </Button>
      </div>
    </div>
  )
}

export default function SubmissionsPage() {
  const navigate = useNavigate()
  const [submissions, setSubmissions] = useState<SubmissionSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await fetchSubmissions()
        const sorted = [...data].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        if (!cancelled) {
          setSubmissions(sorted)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof DriverApiError ? err.message : 'Could not load submissions')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [retryKey])

  const retry = useCallback(() => {
    setLoading(true)
    setError(null)
    setSubmissions(null)
    setRetryKey((k) => k + 1)
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-background/95 px-4 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">My submissions</h1>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => navigate('/driver/scan?kind=pod')}>
              Scan POD
            </Button>
            <Button size="sm" onClick={() => navigate('/driver/scan?kind=ratecon')}>
              Scan rate con
            </Button>
          </div>
        </div>
      </header>

      <main className="p-4">
        {/* The job in front of the driver comes first; submissions are the history below it. */}
        <div className="mb-4">
          <CurrentLoadCard />
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-slate-500" aria-hidden="true" />
            <p className="mt-3 text-sm text-slate-500">Loading submissions…</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">Something went wrong</p>
                <p className="mt-1 text-sm">{error}</p>
              </div>
            </div>
            <Button
              variant="outline"
              className="mt-4 w-full"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        )}

        {!loading && !error && submissions?.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Package className="h-12 w-12 text-slate-300" aria-hidden="true" />
            <p className="mt-4 text-base font-medium text-slate-700">No submissions yet</p>
            <p className="mt-1 px-6 text-sm text-slate-500">
              Scan a rate confirmation and it will show up here.
            </p>
            <Button className="mt-6" onClick={() => navigate('/driver/scan?kind=ratecon')}>
              Scan a rate confirmation
            </Button>
          </div>
        )}

        {!loading && !error && submissions && submissions.length > 0 && (
          <div className="space-y-4">
            {submissions.map((submission) => (
              <SubmissionCard key={submission.id} submission={submission} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
