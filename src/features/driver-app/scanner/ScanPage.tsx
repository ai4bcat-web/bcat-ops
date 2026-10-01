import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Package,
  RotateCcw,
  Truck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  DriverApiError,
  fetchSubmissions,
  ResumableDriverApiError,
  submitPod,
  submitRatecon,
  submitStandalonePod,
  type PendingPage,
  type SubmissionKind,
  type SubmissionSummary,
} from '../driverApi'
import { CameraCapture } from './CameraCapture'

type Phase = 'choose' | 'select' | 'capture' | 'review' | 'submitting' | 'success' | 'error'

export default function ScanPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isMobile = useIsMobile()

  const initialKind: SubmissionKind | null = useMemo(() => {
    const raw = searchParams.get('kind')
    if (raw === 'ratecon') return 'RATECON'
    if (raw === 'pod') return 'POD'
    return null
  }, [searchParams])
  const initialSubmissionId = searchParams.get('submissionId')

  const initialPhase: Phase = useMemo(() => {
    if (initialKind === 'RATECON') return 'capture'
    if (initialKind === 'POD') return initialSubmissionId ? 'capture' : 'select'
    return 'choose'
  }, [initialKind, initialSubmissionId])

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [kind, setKind] = useState<SubmissionKind | null>(initialKind)
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(initialSubmissionId)
  const [pages, setPages] = useState<PendingPage[]>([])
  const [referenceNumber, setReferenceNumber] = useState('')
  const [note, setNote] = useState('')
  const [resumeFromId, setResumeFromId] = useState<string | null>(null)

  const [submissions, setSubmissions] = useState<SubmissionSummary[] | null>(null)
  const [loadingSubmissions, setLoadingSubmissions] = useState(initialPhase === 'select')
  const [submissionsError, setSubmissionsError] = useState<string | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedSubmission = useMemo(
    () => submissions?.find((s) => s.id === selectedSubmissionId),
    [submissions, selectedSubmissionId],
  )

  useEffect(() => {
    if (phase !== 'select' || submissions !== null || !loadingSubmissions) {
      return
    }
    let cancelled = false
    async function load() {
      try {
        const data = await fetchSubmissions()
        const sorted = [...data].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        if (!cancelled) {
          setSubmissions(sorted)
          setSubmissionsError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setSubmissionsError(
            err instanceof DriverApiError ? err.message : 'Could not load your loads',
          )
        }
      } finally {
        if (!cancelled) {
          setLoadingSubmissions(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [phase, submissions, loadingSubmissions])

  const handleCaptureDone = useCallback((captured: PendingPage[]) => {
    setPages(captured)
    setPhase('review')
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!kind) return

    if (kind === 'POD' && !selectedSubmissionId && !referenceNumber.trim()) {
      setError('Please enter a load or reference number for this POD.')
      setPhase('error')
      return
    }

    setBusy(true)
    setError(null)
    setPhase('submitting')

    try {
      if (kind === 'RATECON') {
        await submitRatecon({
          pages,
          referenceNumber: referenceNumber.trim() || undefined,
          note: note.trim() || undefined,
          resumeFromId: resumeFromId ?? undefined,
        })
      } else if (selectedSubmissionId) {
        await submitPod(selectedSubmissionId, pages, { resume: !!resumeFromId })
      } else {
        await submitStandalonePod({
          pages,
          referenceNumber: referenceNumber.trim() || undefined,
          note: note.trim() || undefined,
          resumeFromId: resumeFromId ?? undefined,
        })
      }
      setResumeFromId(null)
      setPhase('success')
    } catch (err) {
      if (err instanceof ResumableDriverApiError) {
        setResumeFromId(err.submissionId)
      }
      setError(
        err instanceof DriverApiError
          ? err.message
          : 'We could not send your pages. Your photos are still here — try again.',
      )
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }, [kind, pages, referenceNumber, note, resumeFromId, selectedSubmissionId])

  const reset = useCallback(() => {
    setKind(null)
    setSelectedSubmissionId(null)
    setPages([])
    setReferenceNumber('')
    setNote('')
    setResumeFromId(null)
    setError(null)
    setSubmissions(null)
    setPhase('choose')
    navigate('/driver/scan', { replace: true })
  }, [navigate])

  const pageThumbnails = useMemo(
    () => (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {pages.map((page, index) => (
          <PagePreview key={`${page.fileName}-${index}`} page={page} index={index} />
        ))}
      </div>
    ),
    [pages],
  )

  if (phase === 'choose') {
    return (
      <div className="flex min-h-screen flex-col justify-center gap-4 bg-background p-6">
        <h1 className="text-center text-2xl font-bold text-foreground">What are you sending?</h1>
        <p className="mb-2 text-center text-sm text-muted-foreground">
          Pick the document you want to scan or upload.
        </p>

        <Button
          size="lg"
          className="h-24 flex-col gap-2 text-lg"
          onClick={() => {
            setKind('RATECON')
            setPhase('capture')
          }}
        >
          <Truck className="h-6 w-6" />
          Rate confirmation
        </Button>

        <Button
          variant="outline"
          size="lg"
          className="h-24 flex-col gap-2 text-lg"
          onClick={() => {
            setKind('POD')
            setSelectedSubmissionId(null)
            setSubmissions(null)
            setSubmissionsError(null)
            setLoadingSubmissions(true)
            setPhase('select')
          }}
        >
          <Package className="h-6 w-6" />
          POD (delivery receipt)
        </Button>

        <Button variant="ghost" className="mt-4" onClick={() => navigate('/driver/loads')}>
          Back to my loads
        </Button>
      </div>
    )
  }

  if (phase === 'select') {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={() => setPhase('choose')}>
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-semibold">Choose a load for this POD</h1>
        </div>

        {loadingSubmissions && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-slate-500" aria-hidden="true" />
            <p className="mt-3 text-sm text-slate-500">Loading your loads…</p>
          </div>
        )}

        {submissionsError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            <p>{submissionsError}</p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => {
                setSubmissionsError(null)
                setSubmissions(null)
                setLoadingSubmissions(true)
              }}
            >
              Try again
            </Button>
          </div>
        )}

        {!loadingSubmissions && (
          <div className="space-y-4">
            {!submissionsError && submissions?.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-500">You do not have any loads listed yet.</p>
                <p className="mt-1 text-sm text-slate-500">
                  You can still send a POD using a load or reference number.
                </p>
              </div>
            )}

            {!submissionsError && submissions && submissions.length > 0 && (
              <div className="space-y-3">
                {submissions.map((submission) => (
                  <button
                    key={submission.id}
                    type="button"
                    onClick={() => {
                      setSelectedSubmissionId(submission.id)
                      setPhase('capture')
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors active:bg-slate-50"
                  >
                    <p className="font-medium text-slate-900">
                      {submission.referenceNumber || `Load ${submission.id.slice(-6)}`}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {new Date(submission.createdAt).toLocaleDateString()}
                    </p>
                  </button>
                ))}
              </div>
            )}

            {/* Always available: a driver whose load list is empty or failed to load still has
                to be able to send the POD they are holding. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-medium text-slate-900">Do not see your load?</p>
              <p className="mt-1 text-sm text-slate-500">
                Enter the load or reference number and send the POD anyway.
              </p>
              <Input
                className="mt-3"
                placeholder="e.g. VRID or load number"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && referenceNumber.trim()) {
                    setSelectedSubmissionId(null)
                    setPhase('capture')
                  }
                }}
              />
              <Button
                className="mt-3 w-full"
                disabled={!referenceNumber.trim()}
                onClick={() => {
                  setSelectedSubmissionId(null)
                  setPhase('capture')
                }}
              >
                Continue with reference
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (phase === 'capture' && kind) {
    return (
      <CameraCapture
        initialPages={pages}
        onDone={handleCaptureDone}
        onCancel={() => {
          // Backing out of a standalone POD returns to the load picker; everything else leaves
          // the scanner entirely.
          if (kind === 'POD' && !selectedSubmissionId) {
            setPhase('select')
          } else {
            navigate('/driver/loads')
          }
        }}
      />
    )
  }

  if (phase === 'review') {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="mb-4 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            onClick={() => setPhase('capture')}
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-semibold">
            Review {kind === 'RATECON' ? 'rate confirmation' : 'POD'}
          </h1>
        </div>

        <div className="space-y-4">
          {kind === 'RATECON' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="reference">Reference # (optional)</Label>
                <Input
                  id="reference"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="e.g. VRID or load number"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Any extra details for dispatch"
                />
              </div>
            </>
          )}

          {kind === 'POD' && selectedSubmission && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <span className="font-medium">Load:</span>{' '}
              {selectedSubmission.referenceNumber || selectedSubmission.id.slice(-6)}
            </div>
          )}

          {kind === 'POD' && !selectedSubmission && (
            <>
              <div className="space-y-2">
                <Label htmlFor="reference">Load / reference #</Label>
                <Input
                  id="reference"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="So dispatch knows which load this POD belongs to"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Any extra details for dispatch"
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>Captured pages</Label>
            {pageThumbnails}
          </div>

          {resumeFromId && (
            <p className="text-sm text-amber-600">
              Retrying a previous upload. We will not create a second submission.
            </p>
          )}

          <div className={`flex gap-3 pt-4 ${isMobile ? 'flex-col' : 'flex-row'}`}>
            <Button
              size="lg"
              className={`h-14 ${isMobile ? 'w-full' : 'flex-1'}`}
              disabled={pages.length === 0 || busy}
              onClick={handleSubmit}
            >
              Send to office
            </Button>
            <Button
              variant="outline"
              size="lg"
              className={`h-14 ${isMobile ? 'w-full' : 'flex-1'}`}
              onClick={() => setPhase('capture')}
            >
              Add more pages
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'submitting') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" aria-hidden="true" />
        <p className="mt-4 text-lg font-medium">Uploading {pages.length} page(s)…</p>
        <p className="mt-2 text-sm text-slate-500">Please keep this screen open.</p>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <CheckCircle2 className="h-16 w-16 text-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-bold">Sent!</h2>
        <p className="mt-2 max-w-xs text-slate-600">
          The office has been notified. You can add POD pages later from My loads.
        </p>
        <div className="mt-8 flex w-full max-w-xs flex-col gap-3">
          <Button size="lg" className="h-14 w-full" onClick={() => navigate('/driver/loads')}>
            View my loads
          </Button>
          <Button variant="outline" size="lg" className="h-14 w-full" onClick={reset}>
            Scan another
          </Button>
        </div>
      </div>
    )
  }

  // phase === 'error'
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <AlertCircle className="h-16 w-16 text-red-500" aria-hidden="true" />
      <h2 className="mt-4 text-xl font-bold">Could not send</h2>
      <p className="mt-2 text-sm text-slate-600">
        {error ?? 'Something went wrong while uploading.'}
      </p>
      <p className="mt-4 px-4 text-sm text-slate-500">
        Your photos are still here — you do not need to re-shoot them.
      </p>
      {resumeFromId && (
        <p className="mt-2 text-sm text-amber-600">
          We will retry the same submission so nothing is duplicated.
        </p>
      )}
      <div className="mt-8 flex w-full max-w-xs flex-col gap-3">
        <Button size="lg" className="h-14 w-full" onClick={handleSubmit} disabled={busy}>
          {resumeFromId ? 'Retry upload' : 'Try again'}
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-14 w-full gap-2"
          onClick={() => setPhase('review')}
        >
          <RotateCcw className="h-5 w-5" />
          Review pages
        </Button>
      </div>
    </div>
  )
}

function PagePreview({ page, index }: { page: PendingPage; index: number }) {
  // Memoised rather than created in an effect: the effect only revokes, so a remount
  // builds a fresh URL instead of leaving an <img> pointing at a revoked one.
  const url = useMemo(() => URL.createObjectURL(page.blob), [page.blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  if (page.contentType === 'application/pdf') {
    return (
      <div className="flex aspect-[3/4] flex-col items-center justify-center rounded-lg border border-slate-200 bg-slate-50 p-2">
        <FileText className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <span className="mt-1 truncate text-center text-xs text-slate-500">PDF</span>
      </div>
    )
  }

  return (
    <div className="flex aspect-[3/4] flex-col items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-1">
      {url ? (
        <img src={url} alt={`Page ${index + 1}`} className="h-full w-full rounded object-cover" />
      ) : (
        <FileText className="h-8 w-8 text-slate-400" aria-hidden="true" />
      )}
    </div>
  )
}
