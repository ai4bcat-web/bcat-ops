import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { rememberScanIntent, forgetScanIntent } from './scanIntent'
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
  submitMisc,
  attachSubmissionToLoad,
  DriverApiError,
  fetchCurrentLoad,
  fetchSubmissions,
  ResumableDriverApiError,
  submitPod,
  submitRatecon,
  submitStandalonePod,
  type PendingPage,
  type SubmissionKind,
  type SubmissionSummary,
} from '../driverApi'
import { PagePicker } from './PagePicker'
import { useDriverProgram } from '../useDriverProgram'

type Phase = 'choose' | 'select' | 'capture' | 'review' | 'submitting' | 'success' | 'error'

export default function ScanPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isMobile = useIsMobile()
  /*
   * Where "done" goes. An Ivan driver has no settlement — the server answers that route
   * with a 409 — so sending them there after a scan landed them on an error screen with a
   * Retry button. Each program goes back to its own home.
   */
  const program = useDriverProgram()
  const homePath = program === 'PAPERWORK' ? '/driver/paperwork' : '/driver/settlement'
  const homeLabel = program === 'PAPERWORK' ? 'Back to my loads' : 'Back to my settlement'

  const initialKind: SubmissionKind | null = useMemo(() => {
    const raw = searchParams.get('kind')
    if (raw === 'ratecon') return 'RATECON'
    if (raw === 'pod') return 'POD'
    if (raw === 'misc') return 'MISC'
    return null
  }, [searchParams])
  const initialSubmissionId = searchParams.get('submissionId')
  /**
   * The PRO this scan belongs to, when the driver came from a specific load on their
   * settlement. It answers the only question the picker screen was there to ask, so with
   * it the scanner opens straight on the camera.
   */
  /*
   * Two apps hand a load to this screen two different ways, and both have to work.
   *
   * The owner-operator settlement sends `pro`. The Ivan paperwork page sends `ref` — which
   * IS the PRO, see PaperworkLoad.reference — and the load's `id` as `loadId`. This screen
   * only ever read `pro`, so an Ivan driver who tapped Send POD on a load was dropped into
   * the generic "which load?" picker with nothing filled in, and the load link was thrown
   * away: their POD arrived unattached unless whatever they typed happened to match.
   */
  const initialPro = (searchParams.get('pro') ?? searchParams.get('ref') ?? '').trim()
  const initialLoadId = (searchParams.get('loadId') ?? '').trim() || null
  /** The stop a photo upload was started from, so the office sees "Pickup — Batory Oakley". */
  const initialStopId = (searchParams.get('stopId') ?? '').trim() || null
  const initialStopLabel = (searchParams.get('stopLabel') ?? '').trim() || null

  const initialPhase: Phase = useMemo(() => {
    if (initialKind === 'RATECON') return 'capture'
    // Photos go straight to the camera: there is nothing to choose, they are for the stop they were started from.
    if (initialKind === 'MISC') return 'capture'
    if (initialKind === 'POD') return initialSubmissionId || initialPro || initialLoadId ? 'capture' : 'select'
    return 'choose'
  }, [initialKind, initialSubmissionId, initialPro, initialLoadId])

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [kind, setKind] = useState<SubmissionKind | null>(initialKind)
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(initialSubmissionId)
  const [pages, setPages] = useState<PendingPage[]>([])
  const [referenceNumber, setReferenceNumber] = useState(initialPro)
  /** The PRO of the load this driver is on, offered as the reference. */
  const [currentPro, setCurrentPro] = useState<string | null>(null)
  /** True when the last send carried no load number, so the success copy can say so. */
  const [sentUnattached, setSentUnattached] = useState(false)
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

  /**
   * Offer the PRO of the load the driver is actually on.
   *
   * A reference typed from memory at a dock is how a POD ends up attached to the wrong
   * load, or to none — and a POD that matches no load holds the driver's own pay. The
   * app already knows which load they are running, so it fills it in. It is still an
   * ordinary editable field: a driver sending a POD for something else just types over it.
   */
  /*
   * Write down what this scan is for, so a relaunch can come back to it.
   *
   * iOS discards the web view while the phone's file picker is in front of it, and a
   * home-screen app relaunches at start_url — which lands on the settlement. The driver
   * sees their scan screen flash and vanish. The pages cannot survive that (they are
   * Blobs), but the load and the document kind can.
   */
  useEffect(() => {
    if (!initialKind) return
    rememberScanIntent({
      kind: initialKind === 'POD' ? 'pod' : initialKind === 'MISC' ? 'misc' : 'ratecon',
      pro: initialPro || undefined,
      submissionId: initialSubmissionId || undefined,
      loadId: initialLoadId || undefined,
      stopId: initialStopId || undefined,
      stopLabel: initialStopLabel || undefined,
    })
  }, [initialKind, initialPro, initialSubmissionId, initialLoadId, initialStopId, initialStopLabel])

  useEffect(() => {
    let cancelled = false
    void fetchCurrentLoad()
      .then((load) => {
        const pro = (load?.proNumber ?? '').trim()
        if (cancelled || !pro) return
        setCurrentPro(pro)
        // A PRO in the URL came from the load the driver tapped; never override it.
        setReferenceNumber((prev) => prev || pro)
      })
      .catch(() => {
        // No current load is normal, and a failure here must not block a POD.
      })
    return () => { cancelled = true }
  }, [])

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

    // A POD never needs a load number. A driver at a dock often has the paperwork
    // before the office has built the load, and the worst outcome is a signed POD that
    // never gets sent because the app would not accept it. Unattached PODs land in a
    // queue the office assigns once the load exists.

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
      } else if (kind === 'MISC') {
        const submissionId = await submitMisc({
          pages,
          referenceNumber: referenceNumber.trim() || undefined,
          note: note.trim() || undefined,
          stopId: initialStopId ?? undefined,
          stopLabel: initialStopLabel ?? undefined,
          resumeFromId: resumeFromId ?? undefined,
        })
        if (initialLoadId) {
          try { await attachSubmissionToLoad(submissionId, initialLoadId) } catch { /* the PRO is on it; the office can link it */ }
        }
      } else if (selectedSubmissionId) {
        await submitPod(selectedSubmissionId, pages, { resume: !!resumeFromId })
      } else {
        const submissionId = await submitStandalonePod({
          pages,
          referenceNumber: referenceNumber.trim() || undefined,
          note: note.trim() || undefined,
          resumeFromId: resumeFromId ?? undefined,
        })
        /*
         * Came from a specific load: link the POD to it on the server, which checks that
         * both are this driver's. This is what makes the POD count against THAT load on
         * the office's screens. Best-effort — the pages are already sent, and a POD that
         * reached the office with its PRO typed in beats one that never left the phone
         * because a second request failed.
         */
        if (initialLoadId) {
          try {
            await attachSubmissionToLoad(submissionId, initialLoadId)
          } catch {
            // The PRO is on the submission; the office can link it from the queue.
          }
        }
      }
      setSentUnattached(kind === 'POD' && !selectedSubmissionId && !referenceNumber.trim() && !initialLoadId)
      setResumeFromId(null)
      // Done with it: a relaunch must not drop them back into a job they finished.
      forgetScanIntent()
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
  }, [kind, pages, referenceNumber, note, resumeFromId, selectedSubmissionId, initialLoadId])

  const reset = useCallback(() => {
    setKind(null)
    setSelectedSubmissionId(null)
    setPages([])
    setReferenceNumber('')
    setNote('')
    setResumeFromId(null)
    setSentUnattached(false)
    setError(null)
    setSubmissions(null)
    setPhase('choose')
    forgetScanIntent()
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
      <div className="flex min-h-full flex-col justify-center gap-4 bg-background p-6">
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

        <Button variant="ghost" className="mt-4" onClick={() => navigate(homePath)}>
          {homeLabel}
        </Button>
      </div>
    )
  }

  if (phase === 'select') {
    return (
      <div className="min-h-full bg-background p-4">
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
                  Send the POD anyway — the office will attach it once the load is built.
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

            {/* Always available, and never blocked: a driver whose load list is empty, or
                whose load has not been built yet, still has to be able to send the POD
                they are holding. The load number is optional. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-medium text-slate-900">Do not see your load?</p>
              <p className="mt-1 text-sm text-slate-500">
                {currentPro
                  ? `This is PRO ${currentPro}, the load you are on. Change it if this POD is for a different load.`
                  : 'Put the load number in if you have it. If you do not, send the POD anyway and the office will attach it to the right load.'}
              </p>
              <Input
                className="mt-3"
                placeholder="Load number (optional)"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setSelectedSubmissionId(null)
                    setPhase('capture')
                  }
                }}
              />
              <Button
                className="mt-3 w-full"
                onClick={() => {
                  setSelectedSubmissionId(null)
                  setPhase('capture')
                }}
              >
                {referenceNumber.trim() ? 'Continue with this load number' : 'Send without a load number'}
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (phase === 'capture' && kind) {
    return (
      <PagePicker
        initialPages={pages}
        photos={kind === 'MISC'}
        onDone={handleCaptureDone}
        onCancel={() => {
          /*
           * A scan aimed at a particular load — opened from a row on the settlement, so it
           * arrived with a PRO or a submission — has nothing to choose, and dropping the
           * driver into the load picker would look like the app lost their place. They go
           * back where they came from. A POD with no target does return to the picker.
           */
          if (kind === 'POD' && !selectedSubmissionId && !initialPro) {
            setPhase('select')
          } else {
            // Backing out on purpose is not an interruption to resume.
            forgetScanIntent()
            navigate(homePath)
          }
        }}
      />
    )
  }

  if (phase === 'review') {
    return (
      <div className="min-h-full bg-background p-4">
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
            Review {kind === 'RATECON' ? 'rate confirmation' : kind === 'MISC' ? 'photos' : 'POD'}
          </h1>
        </div>

        <div className="space-y-4">
          {kind === 'MISC' && (
            <>
              <div className="rounded-lg border border-border bg-card p-3 text-sm">
                <span className="font-medium">For:</span>{' '}
                {[referenceNumber.trim() ? `PRO ${referenceNumber.trim()}` : null, initialStopLabel].filter(Boolean).join(' · ') || 'this load'}
              </div>
              <div className="space-y-2">
                <Label htmlFor="note">What is it? (optional)</Label>
                <Textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. seal number, damaged pallet, gate pass"
                />
              </div>
            </>
          )}
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
            <p className="text-sm text-amber-300">
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
      <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" aria-hidden="true" />
        <p className="mt-4 text-lg font-medium">Uploading {pages.length} page(s)…</p>
        <p className="mt-2 text-sm text-slate-500">Please keep this screen open.</p>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">
        <CheckCircle2 className="h-16 w-16 text-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-bold">Sent!</h2>
        <p className="mt-2 max-w-xs text-slate-600">
          {kind === 'MISC'
            ? 'The office can see your photos on the load.'
            : sentUnattached
              ? 'The office has it and will attach it to your load. Nothing else for you to do.'
              : 'The office has been notified. You can add POD pages later from My loads.'}
        </p>
        <div className="mt-8 flex w-full max-w-xs flex-col gap-3">
          <Button size="lg" className="h-14 w-full" onClick={() => navigate(homePath)}>
            {homeLabel}
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
    <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">
      <AlertCircle className="h-16 w-16 text-red-500" aria-hidden="true" />
      <h2 className="mt-4 text-xl font-bold">Could not send</h2>
      <p className="mt-2 text-sm text-slate-600">
        {error ?? 'Something went wrong while uploading.'}
      </p>
      <p className="mt-4 px-4 text-sm text-slate-500">
        Your photos are still here — you do not need to re-shoot them.
      </p>
      {resumeFromId && (
        <p className="mt-2 text-sm text-amber-300">
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
