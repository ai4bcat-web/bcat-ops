import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Camera, FileText, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { preparePage } from './imagePrep'
import { MAX_SCAN_PAGES, SCAN_ACCEPTED_TYPES_STRING, type PendingPage } from '../driverApi'

interface CameraCaptureProps {
  /** Called when the driver taps Done. */
  onDone: (pages: PendingPage[]) => void
  /** Called when the driver backs out without finishing. */
  onCancel?: () => void
  /** Pages already captured, e.g. preserved after a failed upload retry. */
  initialPages?: PendingPage[]
}

// Executor form on purpose: drivers run this on iPhones that may predate Safari 17.4, which is
// where Promise.withResolvers first shipped. A TypeError here would kill the photo-library
// fallback on exactly the old devices that need it.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

export function CameraCapture({ onDone, onCancel, initialPages = [] }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)

  const [pages, setPages] = useState<PendingPage[]>(initialPages)
  const [cameraState, setCameraState] = useState<'requesting' | 'live' | 'denied' | 'unavailable'>('requesting')
  const [capturing, setCapturing] = useState(false)

  const atMaxPages = pages.length >= MAX_SCAN_PAGES
  const pageLabel = pages.length === 1 ? '1 page' : `${pages.length} pages`

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function start() {
      const media = navigator.mediaDevices
      if (!media || !media.getUserMedia) {
        if (mounted) setCameraState('unavailable')
        return
      }

      try {
        const stream = await media.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        })
        if (!mounted) {
          stopStream()
          return
        }
        streamRef.current = stream
        /*
         * Do NOT assign srcObject here. The <video> only renders while cameraState is
         * 'live', so at this moment it does not exist yet and videoRef.current is null —
         * the assignment was silently skipped and the driver got a black screen with a
         * working camera behind it. A separate effect attaches the stream once the element
         * is actually mounted.
         */
        setCameraState('live')
      } catch (err) {
        if (!mounted) return
        const name = err instanceof Error ? err.name : ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setCameraState('denied')
        } else {
          setCameraState('unavailable')
        }
      }
    }

    start()
    return () => {
      mounted = false
      stopStream()
    }
  }, [stopStream])

  /**
   * Attach the stream once the <video> exists.
   *
   * Runs after the commit that mounts it, which is the only point where both the element
   * and the stream are available. Also re-attaches if React ever remounts the element.
   */
  useEffect(() => {
    if (cameraState !== 'live') return
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream) return
    if (video.srcObject !== stream) video.srcObject = stream
    // Safari sometimes ignores autoPlay for a stream attached after mount.
    void video.play?.().catch(() => undefined)
  }, [cameraState])

  const takePicture = useCallback(async () => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || capturing || atMaxPages) return

    setCapturing(true)
    try {
      const page = await preparePage(video, `scan-${Date.now()}-${pages.length + 1}.jpg`)
      setPages((prev) => [...prev, page])
    } catch {
      toast.error('Could not capture page. Try again.')
    } finally {
      setCapturing(false)
    }
  }, [pages.length, capturing, atMaxPages])

  const retakeLast = useCallback(() => {
    setPages((prev) => prev.slice(0, -1))
  }, [])

  const deletePage = useCallback((index: number) => {
    setPages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const addPages = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const remaining = MAX_SCAN_PAGES - pages.length
    if (remaining <= 0) {
      toast.error(`You can send up to ${MAX_SCAN_PAGES} pages.`)
      return
    }

    const toAdd = Array.from(files).slice(0, remaining)
    setCapturing(true)
    try {
      const newPages = await Promise.all(
        toAdd.map(async (file, index) => {
          if (file.type === 'application/pdf') {
            return await preparePage(file, file.name || `upload-${index + 1}.pdf`)
          }
          const src = URL.createObjectURL(file)
          try {
            const img = await loadImage(src)
            return await preparePage(img, file.name || `upload-${index + 1}.jpg`)
          } finally {
            URL.revokeObjectURL(src)
          }
        }),
      )
      setPages((prev) => [...prev, ...newPages])
    } catch {
      toast.error('Could not use file. Try again.')
    } finally {
      setCapturing(false)
    }
  }, [pages.length])

  const handleCameraFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      await addPages(e.target.files)
      e.target.value = ''
    },
    [addPages],
  )

  const handleLibraryFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      await addPages(e.target.files)
      e.target.value = ''
    },
    [addPages],
  )

  const thumbnailStrip = (
    <div className="flex gap-2 overflow-x-auto py-2">
      {pages.map((page, index) => (
        <PageThumbnail key={`${page.fileName}-${index}`} page={page} index={index} onDelete={deletePage} />
      ))}
    </div>
  )

  return (
    <div className="relative flex h-[100dvh] w-full flex-col bg-black text-white">
      {cameraState === 'requesting' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
          <p className="text-sm opacity-80">Starting camera…</p>
        </div>
      )}

      {(cameraState === 'unavailable' || cameraState === 'denied') && (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <Camera className="h-12 w-12 opacity-50" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-semibold">
            {cameraState === 'denied' ? 'Camera access denied' : 'Camera not available'}
          </h2>
          <p className="mt-2 max-w-xs text-sm opacity-80">
            {cameraState === 'denied'
              ? 'This usually means camera permission is off. Use the buttons below instead.'
              : 'Your device or browser is not letting us use the camera. Use the buttons below.'}
          </p>

          {pages.length > 0 && (
            <div className="w-full max-w-xs">
              <div className="mt-6 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium">{pageLabel} captured</div>
              {thumbnailStrip}
            </div>
          )}

          <Button
            size="lg"
            className="mt-6 h-14 gap-2 px-6 text-base"
            onClick={() => cameraInputRef.current?.click()}
          >
            <Camera className="h-5 w-5" />
            Take photo
          </Button>

          <Button
            size="lg"
            variant="outline"
            className="mt-3 h-14 gap-2 border-white/30 bg-black/30 px-6 text-base text-white hover:bg-white/10 hover:text-white"
            onClick={() => libraryInputRef.current?.click()}
          >
            <Upload className="h-5 w-5" />
            Choose photo or PDF
          </Button>

          {pages.length > 0 && (
            <Button size="lg" className="mt-3 h-14 px-6 text-base" onClick={() => onDone(pages)}>
              Done ({pages.length})
            </Button>
          )}

          {pages.length > 0 && (
            <Button variant="ghost" size="sm" className="mt-2 gap-1 text-white/80" onClick={retakeLast}>
              <RotateCcw className="h-4 w-4" />
              Retake last page
            </Button>
          )}

          {onCancel && (
            <Button variant="ghost" className="mt-3 text-white/80" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {cameraState === 'live' && (
        <>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />

          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
            <div className="pointer-events-auto flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {onCancel ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-white"
                    onClick={onCancel}
                    aria-label="Cancel"
                  >
                    <X className="h-6 w-6" />
                  </Button>
                ) : (
                  <div className="w-10" />
                )}

                <div className="rounded-full bg-black/60 px-3 py-1.5 text-sm font-medium backdrop-blur-sm">
                  {pageLabel}
                  {atMaxPages && <span className="ml-1 text-amber-300">(max {MAX_SCAN_PAGES})</span>}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {pages.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1 text-white"
                    onClick={retakeLast}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Retake
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1 text-white"
                  onClick={() => libraryInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Choose file
                </Button>
              </div>
            </div>

            {pages.length > 0 && (
              <div className="pointer-events-auto mt-16 w-full max-w-md self-center">{thumbnailStrip}</div>
            )}

            <div className="pointer-events-auto flex items-end justify-between pb-6">
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={pages.length === 0}
                onClick={() => onDone(pages)}
                className="h-14 border-white/30 bg-black/50 px-5 text-base text-white hover:bg-white/10 hover:text-white disabled:opacity-40"
              >
                Done{pages.length > 0 ? ` (${pages.length})` : ''}
              </Button>

              <button
                type="button"
                aria-label="Capture page"
                disabled={capturing || atMaxPages}
                onClick={takePicture}
                className="mx-auto mb-1 flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/90 shadow-lg active:scale-95 disabled:opacity-50"
              >
                <span className="h-14 w-14 rounded-full bg-white" />
              </button>

              {/* Bottom-right intentionally left empty — it is thumb-occluded on phones. */}
              <div className="w-20" />
            </div>
          </div>
        </>
      )}

      <input
        ref={cameraInputRef}
        type="file"
        accept={SCAN_ACCEPTED_TYPES_STRING}
        capture="environment"
        multiple
        className="hidden"
        onChange={handleCameraFileChange}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept={SCAN_ACCEPTED_TYPES_STRING}
        multiple
        className="hidden"
        onChange={handleLibraryFileChange}
      />
    </div>
  )
}

interface PageThumbnailProps {
  page: PendingPage
  index: number
  onDelete: (index: number) => void
}

function PageThumbnail({ page, index, onDelete }: PageThumbnailProps) {
  // Memoised rather than created in an effect: the effect only revokes, so a remount
  // builds a fresh URL instead of leaving an <img> pointing at a revoked one.
  const url = useMemo(() => URL.createObjectURL(page.blob), [page.blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const isPdf = page.contentType === 'application/pdf'

  return (
    <div className="relative shrink-0 rounded-lg border border-white/20 bg-black/60 p-1 backdrop-blur-sm">
      {isPdf ? (
        <div className="flex h-16 w-12 flex-col items-center justify-center rounded bg-slate-100 text-slate-700">
          <FileText className="h-6 w-6" aria-hidden="true" />
          <span className="mt-1 text-[9px] font-medium uppercase">PDF</span>
        </div>
      ) : url ? (
        <img src={url} alt={`Page ${index + 1}`} className="h-16 w-12 rounded object-cover" />
      ) : (
        <div className="h-16 w-12 rounded bg-white/10" />
      )}
      <button
        type="button"
        aria-label={`Delete page ${index + 1}`}
        onClick={() => onDelete(index)}
        className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow-sm"
      >
        <Trash2 className="h-3 w-3" />
      </button>
      <span className="absolute bottom-0 left-0 right-0 rounded-b bg-black/70 py-0.5 text-center text-[9px] text-white">
        {index + 1}
      </span>
    </div>
  )
}
