/**
 * Add the pages of a document: scan them here, or pick a file.
 *
 * Both routes exist, and the history is why. A live viewfinder was tried once and gave
 * drivers a black screen on real phones. A plain straight-to-camera shortcut replaced it
 * and was removed too, for a better reason: a raw photo is the worst version of a POD,
 * because nothing crops it, straightens it or checks it is readable before it is sent.
 *
 * Upload stayed, and still leads — a driver who already scanned the page with Notes or
 * Google Drive has the best possible version of it and should not be talked out of that.
 *
 * What is new is that the missing middle is covered. Scan does here what those apps do:
 * finds the page, flattens it, lifts the ink, and says so when the shot is too dark or
 * too blurry — using the SAME detector the server runs after upload, so what the driver
 * sees framed is what the server will crop to. The old black-screen failure is handled
 * rather than hoped against: ScanCamera checks that frames are genuinely arriving and
 * sends the driver back here if they are not.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Camera, FileText, ScanLine, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { prepareFile } from './imagePrep'
import { ScanCamera } from './ScanCamera'
import { MAX_SCAN_PAGES, SCAN_ACCEPTED_TYPES_STRING, type PendingPage } from '../driverApi'

interface PagePickerProps {
  /** Called when the driver taps Done. */
  onDone: (pages: PendingPage[]) => void
  /** Called when the driver backs out without finishing. */
  onCancel?: () => void
  /** Pages already added, e.g. preserved after a failed upload retry. */
  initialPages?: PendingPage[]
}

export function PagePicker({ onDone, onCancel, initialPages = [] }: PagePickerProps) {
  const libraryInputRef = useRef<HTMLInputElement>(null)

  const [pages, setPages] = useState<PendingPage[]>(initialPages)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)

  const atMax = pages.length >= MAX_SCAN_PAGES
  const pageLabel = pages.length === 1 ? '1 page' : `${pages.length} pages`

  const deletePage = useCallback((index: number) => {
    setPages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  /*
   * Add what the driver picked. One file failing never costs the others, and a file that
   * cannot be decoded is still sent.
   *
   * This used to run every page through one Promise.all and throw the whole batch away if
   * any of them failed to decode — which on an iPhone is the normal case, because the
   * Files app hands back the HEIC on disk whatever the accept list says. The driver picked
   * a document, landed back on this screen, and nothing had saved. prepareFile falls back
   * to the original bytes now; this only has to keep the pages it gets.
   */
  const addPages = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const remaining = MAX_SCAN_PAGES - pages.length
    if (remaining <= 0) {
      toast.error(`You can send up to ${MAX_SCAN_PAGES} pages.`)
      return
    }

    const toAdd = files.slice(0, remaining)
    setBusy(true)
    try {
      const settled = await Promise.allSettled(toAdd.map((file) => prepareFile(file)))
      const added = settled
        .filter((r): r is PromiseFulfilledResult<PendingPage> => r.status === 'fulfilled')
        .map((r) => r.value)
      const failed = settled.length - added.length

      if (added.length) setPages((prev) => [...prev, ...added])
      if (failed > 0) {
        // Named, so a driver knows whether to try a different file or just carry on.
        toast.error(
          added.length
            ? `${failed} of those would not open. The rest are ready.`
            : 'That file would not open. Try picking it again, or scan it to a PDF first.',
        )
      }
    } finally {
      setBusy(false)
    }
  }, [pages.length])

  /*
   * Take the files OUT of the input before clearing it.
   *
   * `input.files` is a live FileList bound to the element, not a snapshot. Setting
   * `value = ''` — which is what makes picking the same file twice fire onChange again —
   * empties that list too, so the reference captured a line earlier was already empty by
   * the time anything read it. Every pick added nothing, and Done stayed grey.
   *
   * Array.from copies first, so clearing the input cannot reach what we are holding.
   */
  const onPick = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''
      await addPages(files)
    },
    [addPages],
  )

  return (
    <div
      className="flex min-h-full flex-col bg-background p-4"
      /* The heading sat under the phone's status bar — the clock and the battery drew
         straight over it, and Cancel shared space with them. Padded past the inset. */
      style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Add the document</h1>
        {onCancel && (
          <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={onCancel}>
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>

      <Button
        type="button"
        size="lg"
        className="h-16 w-full justify-start gap-3 text-base"
        disabled={busy || atMax}
        onClick={() => libraryInputRef.current?.click()}
      >
        <Upload className="h-5 w-5" />
        Upload the document
      </Button>

      {/*
        Second, not first. A driver who already scanned the page with Notes or Google
        Drive has the best version of it there is, and this button should not talk them
        out of that. It is for the far more common case: standing at a dock with a paper
        POD and no patience for leaving the app.
      */}
      <Button
        type="button"
        size="lg"
        variant="outline"
        className="mt-3 h-16 w-full justify-start gap-3 text-base"
        disabled={busy || atMax}
        onClick={() => setScanning(true)}
      >
        <Camera className="h-5 w-5" />
        <span className="flex flex-col items-start leading-tight">
          Scan it with the camera
          <span className="text-xs font-normal text-muted-foreground">
            Crops and straightens the page for you
          </span>
        </span>
      </Button>

      {/* Said once, where it is useful, rather than left for someone to work out. */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Already scanned it with Notes or Google Drive? Upload that PDF — it handles more
          than one page and reads best of all.
        </p>
      </div>

      {atMax && (
        <p className="mt-3 text-sm text-amber-300">
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

      {scanning && (
        <ScanCamera
          remaining={MAX_SCAN_PAGES - pages.length}
          onClose={() => setScanning(false)}
          onCapture={(page) => {
            // Stays open on purpose: a multi-page POD is the normal case, and closing
            // after every shot would make the driver reopen the camera for page two.
            setPages((prev) => (prev.length >= MAX_SCAN_PAGES ? prev : [...prev, page]))
          }}
        />
      )}

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
