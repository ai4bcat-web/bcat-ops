/**
 * The in-app scanner: point the phone at the page and it finds it, straightens it and
 * cleans it up.
 *
 * The picker used to offer one route — "scan it with Notes or Google Drive first, then
 * pick the PDF". That works and it stays, but it asks a driver standing at a dock in the
 * rain to leave the app, use a second one, and come back. Most of them photograph the page
 * instead, and a photograph of a POD at an angle on a dark seat is what the office then
 * cannot read.
 *
 * So this does the scanning here. The live outline is the SAME detector the server runs
 * after upload (src/lib/docScan), which matters: what the driver sees framed is what the
 * server will crop to. A second implementation would drift, and the drift would look like
 * the app lying.
 *
 * It never blocks a submission. A page it thinks is dark or blurry gets a warning and a
 * Retake button, and "Use it anyway" right beside — a driver who cannot send the POD at
 * all is a worse outcome than one who sends a poor photograph of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, X, RotateCcw, Check, Loader2, AlertTriangle, Plus, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { scanFrameColor, toGray, assessReadability, enhanceForReading, type Readability } from '@/lib/docScan/capture'
import { preparePage } from './imagePrep'
import type { PendingPage } from '../driverApi'

/** How often the viewfinder looks for the page. Every frame is wasted work on a phone. */
const DETECT_INTERVAL_MS = 350

interface Shot {
  page: PendingPage
  previewUrl: string
  readability: Readability
  /** False when no page outline was found and the whole frame was kept instead. */
  cropped: boolean
  /**
   * The same frame uncropped, kept alongside a cropped shot so a wrong outline — half a
   * folded page, a clipboard edge — is one tap from fixed instead of a retake.
   */
  whole: { page: PendingPage; previewUrl: string; readability: Readability } | null
}

export interface ScanCameraProps {
  onCapture: (page: PendingPage) => void
  onClose: () => void
  /** Shown on the shutter bar so the driver knows how many more they may add. */
  remaining: number
  /** Pages already taken this session, so Done can say how many are going. */
  captured?: number
  /**
   * All pages are in: send them. Carries the page on screen when pressed from the
   * review step, so the last shot is not lost between "keep it" and "done".
   */
  onDone?: (lastPage: PendingPage | null) => void
  /** Drop the page most recently kept, without leaving the camera. */
  onUndoLast?: () => void
}

export function ScanCamera({ onCapture, onClose, remaining, captured = 0, onDone, onUndoLast }: ScanCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const workRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [shot, setShot] = useState<Shot | null>(null)
  // Unreadable shots in a row. Three means the camera is not going to get there — a
  // scratched lens, a dark dock — and the driver needs another way in, not a fourth try.
  const [rejects, setRejects] = useState(0)
  const [found, setFound] = useState(false)
  /*
   * A FRAME has arrived — not merely a stream.
   *
   * These are different things and conflating them is the black-screen bug: getUserMedia
   * resolves, the element mounts, `ready` goes true, the shutter lights up, and no picture
   * ever comes. videoWidth is the only thing that actually proves a picture exists, so it
   * is what the shutter waits on.
   */
  const [hasFrame, setHasFrame] = useState(false)

  // ── Camera ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, and the highest the device will give us — detail is the whole
          // point. `ideal` rather than `exact` so a laptop webcam still works for testing.
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setReady(true)

        /*
         * Prove frames are actually arriving.
         *
         * A live viewfinder was tried here once before and gave drivers a black screen on
         * real phones — getUserMedia resolves, the element mounts, and no frame ever
         * comes, so nothing errors and the driver stares at black with a shutter button
         * under it. `readyState`/`videoWidth` is the only honest signal, so it is checked,
         * and a camera that has produced nothing after five seconds says so and offers the
         * way out instead of pretending.
         */
        window.setTimeout(() => {
          if (cancelled) return
          const v = videoRef.current
          if (!v || v.videoWidth > 0) return
          streamRef.current?.getTracks().forEach((t) => t.stop())
          setError('The camera started but sent no picture. Use Upload instead — your phone’s own scanner app works well.')
        }, 5000)
      } catch (err) {
        if (cancelled) return
        const name = err instanceof Error ? err.name : ''
        setError(
          name === 'NotAllowedError'
            ? 'The camera is blocked. Allow camera access for this site, then try again.'
            : name === 'NotFoundError'
              ? 'No camera on this device — use Upload instead.'
              : 'Could not start the camera. Use Upload instead.',
        )
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  /** A scratch canvas, reused — allocating one per frame churns memory on a phone. */
  const workCanvas = () => {
    if (!workRef.current) workRef.current = document.createElement('canvas')
    return workRef.current
  }

  // ── Live outline ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || shot) return
    let stop = false

    const tick = () => {
      if (stop) return
      const video = videoRef.current
      const overlay = overlayRef.current
      if (!video || !overlay || !video.videoWidth) return
      setHasFrame(true)

      const DETECT_W = 320
      const scale = DETECT_W / video.videoWidth
      const w = DETECT_W
      const h = Math.max(1, Math.round(video.videoHeight * scale))
      const canvas = workCanvas()
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      // Colour, not gray: the page is found by being the one uncoloured thing in shot.
      const result = scanFrameColor({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h })

      // Draw the outline over the preview, in the preview's own pixels.
      overlay.width = overlay.clientWidth
      overlay.height = overlay.clientHeight
      const octx = overlay.getContext('2d')
      if (!octx) return
      octx.clearRect(0, 0, overlay.width, overlay.height)
      setFound(!!result)
      if (!result) return

      const fx = overlay.width / w
      const fy = overlay.height / h
      const q = result.quad
      octx.beginPath()
      octx.moveTo(q.topLeft.x * fx, q.topLeft.y * fy)
      octx.lineTo(q.topRight.x * fx, q.topRight.y * fy)
      octx.lineTo(q.bottomRight.x * fx, q.bottomRight.y * fy)
      octx.lineTo(q.bottomLeft.x * fx, q.bottomLeft.y * fy)
      octx.closePath()
      octx.fillStyle = 'rgba(34,197,94,0.14)'
      octx.fill()
      octx.strokeStyle = '#22c55e'
      octx.lineWidth = 3
      octx.stroke()
    }

    const id = window.setInterval(tick, DETECT_INTERVAL_MS)
    return () => { stop = true; window.clearInterval(id) }
  }, [ready, shot])

  // ── Shutter ───────────────────────────────────────────────────────────────
  const capture = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || busy) return
    setBusy(true)
    try {
      const w = video.videoWidth
      const h = video.videoHeight
      const canvas = workCanvas()
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('Could not read the camera frame')
      ctx.drawImage(video, 0, 0, w, h)
      const pixels = ctx.getImageData(0, 0, w, h).data

      /*
       * No page found is not a failure. The driver pressed the shutter, so they want this
       * frame; keep it whole rather than refusing, and say it was not cropped so they can
       * judge for themselves whether to retake.
       */
      const result = scanFrameColor({ data: pixels, width: w, height: h })
      const wholeGray = toGray(pixels, w, h)
      const out = result?.gray ?? wholeGray
      const cropped = !!result

      const toCanvas = (g: { data: Uint8Array; width: number; height: number }) => {
        const render = document.createElement('canvas')
        render.width = g.width
        render.height = g.height
        const rctx = render.getContext('2d')
        if (!rctx) throw new Error('Could not build the scan')
        const rgba = rctx.createImageData(g.width, g.height)
        for (let i = 0; i < g.data.length; i++) {
          rgba.data[i * 4] = g.data[i]
          rgba.data[i * 4 + 1] = g.data[i]
          rgba.data[i * 4 + 2] = g.data[i]
          rgba.data[i * 4 + 3] = 255
        }
        rctx.putImageData(rgba, 0, 0)
        return render
      }

      const stamp = Date.now()
      const page = await preparePage(toCanvas(out), `scan-${stamp}.jpg`)
      const readability = assessReadability(out)
      // The uncropped frame, cleaned the same way, in case the outline was wrong.
      let whole: Shot['whole'] = null
      if (cropped) {
        const wholeClean = enhanceForReading(wholeGray)
        const wholePage = await preparePage(toCanvas(wholeClean), `scan-${stamp}-full.jpg`)
        whole = { page: wholePage, previewUrl: URL.createObjectURL(wholePage.blob), readability: assessReadability(wholeClean) }
      }
      setRejects((n) => (readability.problem ? n + 1 : 0))
      setShot({
        page,
        previewUrl: URL.createObjectURL(page.blob),
        readability,
        cropped,
        whole,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That shot could not be processed — try again.')
    } finally {
      setBusy(false)
    }
  }, [busy])

  const discard = useCallback(() => {
    setShot((s) => {
      if (s) { URL.revokeObjectURL(s.previewUrl); if (s.whole) URL.revokeObjectURL(s.whole.previewUrl) }
      return null
    })
  }, [])

  /** Swap the cropped result for the whole frame: the outline missed, the photo did not. */
  const useWhole = useCallback(() => {
    setShot((s) => {
      if (!s?.whole) return s
      URL.revokeObjectURL(s.previewUrl)
      return { page: s.whole.page, previewUrl: s.whole.previewUrl, readability: s.whole.readability, cropped: false, whole: null }
    })
  }, [])

  useEffect(() => () => {
    if (shot) { URL.revokeObjectURL(shot.previewUrl); if (shot.whole) URL.revokeObjectURL(shot.whole.previewUrl) }
  }, [shot])

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-300" />
        <p className="text-base">{error}</p>
        <Button type="button" size="lg" onClick={onClose}>Back</Button>
      </div>
    )
  }

  // ── Review ────────────────────────────────────────────────────────────────
  if (shot) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-black">
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <img src={shot.previewUrl} alt="The scan you just took" className="max-h-full max-w-full object-contain" />
        </div>

        <div className="space-y-3 bg-background p-4" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}>
          {/*
            Not readable is not sendable. A POD nobody can read is worse than none — the
            driver believes they are done and the office finds out at invoicing. So the
            only way forward from an unreadable shot is another shot, with the reason said
            plainly. After three in a row the file picker is offered as the way out.
          */}
          {shot.readability.problem ? (
            <>
              <div className="flex items-start gap-2 rounded-xl border border-red-400/60 bg-red-500/15 p-3 text-sm text-red-100">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>
                  <span className="block text-base font-bold">This page can’t be read — please retake it.</span>
                  {shot.readability.problem}
                </p>
              </div>
              <Button type="button" size="lg" className="h-14 w-full gap-2 text-base font-bold" onClick={discard}>
                <RotateCcw className="h-5 w-5" /> Retake
              </Button>
              {rejects >= 3 && (
                <Button type="button" variant="outline" size="lg" className="h-12 w-full text-base" onClick={onClose}>
                  Still can’t get it? Upload a photo instead
                </Button>
              )}
            </>
          ) : null}
          {/* The outline is a guess; the driver can see whether it was right. */}
          {!shot.readability.problem && shot.cropped && shot.whole && (
            <button
              type="button"
              onClick={useWhole}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
              Crop looks wrong? Use the whole photo
            </button>
          )}
          {!shot.readability.problem && !shot.cropped && (
            <p className="text-sm text-muted-foreground">
              No page edges found, so the whole picture was kept. Put the page on a darker
              surface with all four corners showing and it will crop itself.
            </p>
          )}

          {/*
            Keep it and shoot the next page, or keep it and send everything. A multi-page
            BOL is the normal case, so "add another page" is the big one; Done is right
            there for the single-page POD so nobody hunts for how to finish.
          */}
          {!shot.readability.problem && (
          <div className="flex gap-3">
            <Button type="button" variant="outline" size="lg" className="h-14 gap-2 px-4 text-base" onClick={discard}>
              <RotateCcw className="h-5 w-5" /> Retake
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-14 flex-1 gap-2 text-base font-semibold"
              disabled={remaining <= 1 && !onDone}
              onClick={() => { onCapture(shot.page); discard() }}
            >
              <Plus className="h-5 w-5" /> {remaining > 1 ? 'Add another page' : 'Keep it'}
            </Button>
          </div>
          )}
          {!shot.readability.problem && onDone && (
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="h-14 w-full gap-2 text-base font-semibold"
              onClick={() => { const page = shot.page; discard(); onDone(page) }}
            >
              <Check className="h-5 w-5" /> Done{captured > 0 ? ` — send ${captured + 1} pages` : ''}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // ── Viewfinder ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-3" style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}>
        <span className="text-sm font-medium text-white/90">
          {!hasFrame ? 'Starting the camera…' : found ? 'Page found — hold still' : 'Line the page up'}
        </span>
        <Button type="button" variant="ghost" size="icon" aria-label="Close the camera" onClick={onClose}>
          <X className="h-5 w-5 text-white" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-contain" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-white/70" />
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-2 p-4" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}>
        <p className="text-xs text-white/60">
          {remaining > 0 ? `${remaining} more page${remaining === 1 ? '' : 's'} can be added` : 'Last page'}
        </p>
        <div className="flex w-full items-center justify-center gap-6">
          <button
            type="button"
            aria-label="Take the photo"
            disabled={!hasFrame || busy}
            onClick={() => void capture()}
            className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white bg-white/20 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-7 w-7 animate-spin text-white" /> : <Camera className="h-7 w-7 text-white" />}
          </button>
          {/* Pages are in hand: a way to finish without first closing the camera. */}
          {onDone && captured > 0 && (
            <Button
              type="button"
              size="lg"
              className="h-12 gap-2 px-5 text-base font-semibold"
              onClick={() => onDone(null)}
            >
              <Check className="h-5 w-5" /> Done ({captured})
            </Button>
          )}
        </div>
        {/* The last page kept was wrong: drop it here, shoot it again, never leave the camera. */}
        {onUndoLast && captured > 0 && (
          <button type="button" onClick={onUndoLast} className="text-sm font-semibold text-white/80 underline underline-offset-2">
            Retake last page
          </button>
        )}
      </div>
    </div>
  )
}

export default ScanCamera
