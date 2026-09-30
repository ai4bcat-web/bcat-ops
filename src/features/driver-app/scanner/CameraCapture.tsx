import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Camera, RotateCcw, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { preparePage } from './imagePrep'
import type { PendingPage } from '../driverApi'

interface CameraCaptureProps {
  /** Called when the driver taps Done. */
  onDone: (pages: PendingPage[]) => void
  /** Called when the driver backs out without finishing. */
  onCancel?: () => void
  /** Pages already captured, e.g. preserved after a failed upload retry. */
  initialPages?: PendingPage[]
}

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
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [pages, setPages] = useState<PendingPage[]>(initialPages)
  const [cameraState, setCameraState] = useState<'requesting' | 'live' | 'denied' | 'unavailable'>('requesting')
  const [capturing, setCapturing] = useState(false)

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
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
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

  const takePicture = useCallback(async () => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || capturing) return

    setCapturing(true)
    try {
      const page = await preparePage(video, `scan-${Date.now()}-${pages.length + 1}.jpg`)
      setPages((prev) => [...prev, page])
    } catch {
      toast.error('Could not capture page. Try again.')
    } finally {
      setCapturing(false)
    }
  }, [pages.length, capturing])

  const retakeLast = useCallback(() => {
    setPages((prev) => prev.slice(0, -1))
  }, [])

  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      setCapturing(true)
      try {
        const newPages = await Promise.all(
          Array.from(files).map(async (file, index) => {
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
        toast.error('Could not use photo. Try again.')
      } finally {
        setCapturing(false)
        e.target.value = ''
      }
    },
    [],
  )

  const pageLabel = pages.length === 1 ? '1 page' : `${pages.length} pages`

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
              ? 'Enable camera permission in settings, or use the file picker below.'
              : 'Use your phone camera or photo library below.'}
          </p>

          {pages.length > 0 && (
            <div className="mt-6 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium">
              {pageLabel} captured
            </div>
          )}

          <Button
            size="lg"
            className="mt-6 h-14 gap-2 px-6 text-base"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-5 w-5" />
            Take photo or choose file
          </Button>

          {pages.length > 0 && (
            <Button
              size="lg"
              className="mt-3 h-14 px-6 text-base"
              onClick={() => onDone(pages)}
            >
              Done ({pages.length})
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
            <div className="pointer-events-auto flex items-center justify-between">
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
              </div>
            </div>

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
                disabled={capturing}
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
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  )
}
