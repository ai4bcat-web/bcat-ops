/**
 * Add the pages of a document, from the phone's own camera or its files.
 *
 * There is deliberately NO in-app camera. A live-video capture screen was tried and did
 * not work reliably on real phones — a driver at a dock got a black screen and no way to
 * send paperwork, which is the worst possible failure for this app. The phone's own camera
 * app and any scanner app a driver already uses are better at this than we will be: they
 * handle focus, lighting, cropping and multi-page PDFs, and they are the tools drivers
 * already know.
 *
 * So this screen takes files. `capture="environment"` on the first input opens the phone's
 * camera directly, which covers a quick one-page photo; anything more — a multi-page POD, a
 * crooked page worth re-cropping — is better scanned in a scanner app and picked from
 * files as a single PDF.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Camera, FileText, ScanLine, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { preparePage } from './imagePrep'
import { MAX_SCAN_PAGES, SCAN_ACCEPTED_TYPES_STRING, type PendingPage } from '../driverApi'

interface PagePickerProps {
  /** Called when the driver taps Done. */
  onDone: (pages: PendingPage[]) => void
  /** Called when the driver backs out without finishing. */
  onCancel?: () => void
  /** Pages already added, e.g. preserved after a failed upload retry. */
  initialPages?: PendingPage[]
}

// Executor form on purpose: drivers run this on iPhones that may predate Safari 17.4, which
// is where Promise.withResolvers first shipped. A TypeError here would kill the photo
// fallback on exactly the old devices that need it.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

export function PagePicker({ onDone, onCancel, initialPages = [] }: PagePickerProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)

  const [pages, setPages] = useState<PendingPage[]>(initialPages)
  const [busy, setBusy] = useState(false)

  const atMax = pages.length >= MAX_SCAN_PAGES
  const pageLabel = pages.length === 1 ? '1 page' : `${pages.length} pages`

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
    setBusy(true)
    try {
      const added = await Promise.all(
        toAdd.map(async (file, index) => {
          // A PDF passes through whole: a scanner app's output is already the document.
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
      setPages((prev) => [...prev, ...added])
    } catch {
      toast.error('Could not use that file. Try again.')
    } finally {
      setBusy(false)
    }
  }, [pages.length])

  // The value is cleared so picking the same file twice in a row still fires onChange.
  const onPick = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      e.target.value = ''
      await addPages(files)
    },
    [addPages],
  )

  return (
    <div className="flex min-h-dvh flex-col bg-background p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Add the document</h1>
        {onCancel && (
          <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={onCancel}>
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          size="lg"
          className="h-16 w-full justify-start gap-3 text-base"
          disabled={busy || atMax}
          onClick={() => cameraInputRef.current?.click()}
        >
          <Camera className="h-5 w-5" />
          Take a photo
        </Button>

        <Button
          type="button"
          size="lg"
          variant="outline"
          className="h-16 w-full justify-start gap-3 text-base"
          disabled={busy || atMax}
          onClick={() => libraryInputRef.current?.click()}
        >
          <Upload className="h-5 w-5" />
          Choose a file or scan
        </Button>
      </div>

      {/* Said once, where it is useful, rather than left for someone to work out. */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          For more than one page, or a page that needs straightening, use the scanner app on
          your phone (Notes on iPhone, Google Drive on Android) and pick the PDF it makes.
          It reads far better than a photo.
        </p>
      </div>

      {atMax && (
        <p className="mt-3 text-sm text-amber-700">
          That is the most pages we can send at once ({MAX_SCAN_PAGES}).
        </p>
      )}

      {pages.length > 0 && (
        <div className="mt-5">
          <p className="text-sm font-medium">{pageLabel} ready</p>
          <div className="flex gap-2 overflow-x-auto py-2">
            {pages.map((page, index) => (
              <PageThumbnail
                key={`${page.fileName}-${index}`}
                page={page}
                index={index}
                onDelete={deletePage}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto pt-6">
        <Button
          type="button"
          size="lg"
          className="h-14 w-full text-base font-semibold"
          disabled={pages.length === 0 || busy}
          onClick={() => onDone(pages)}
        >
          {busy ? 'Working…' : `Done${pages.length > 0 ? ` (${pages.length})` : ''}`}
        </Button>
      </div>

      <input
        ref={cameraInputRef}
        type="file"
        accept={SCAN_ACCEPTED_TYPES_STRING}
        capture="environment"
        multiple
        className="hidden"
        data-testid="camera-input"
        onChange={(e) => void onPick(e)}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept={SCAN_ACCEPTED_TYPES_STRING}
        multiple
        className="hidden"
        data-testid="library-input"
        onChange={(e) => void onPick(e)}
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
    <div className="relative shrink-0 rounded-lg border border-border bg-card p-1">
      {isPdf ? (
        <div className="flex h-16 w-12 flex-col items-center justify-center rounded bg-muted text-muted-foreground">
          <FileText className="h-6 w-6" aria-hidden="true" />
          <span className="mt-1 text-[9px] font-medium uppercase">PDF</span>
        </div>
      ) : (
        <img src={url} alt={`Page ${index + 1}`} className="h-16 w-12 rounded object-cover" />
      )}
      <button
        type="button"
        aria-label={`Remove page ${index + 1}`}
        onClick={() => onDelete(index)}
        className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-1 text-destructive-foreground"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  )
}
