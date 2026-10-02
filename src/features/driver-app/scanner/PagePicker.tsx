/**
 * Add the pages of a document, from the phone's own camera or its files.
 *
 * Upload only. There is no camera here at all — not a live viewfinder, and not a
 * shortcut into the phone's camera either.
 *
 * A live-video capture screen was tried and gave drivers a black screen on real phones.
 * A straight-to-camera shortcut replaced it and was removed too: a photo taken in the
 * moment is the worst version of a POD, because nothing crops it, straightens it or
 * checks it is readable before it is sent. The scanner app already on the phone does all
 * of that and produces one PDF.
 *
 * So a driver picks a file. Their phone still offers its camera inside its own file
 * sheet if they want it — that is the operating system's choice, not a path this screen
 * promotes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { FileText, ScanLine, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { prepareFile } from './imagePrep'
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

      {/* Said once, where it is useful, rather than left for someone to work out. */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Scan it first with the app on your phone — Notes on iPhone, Google Drive on
          Android — then pick the PDF it makes. It crops and straightens the page, handles
          more than one page, and reads far better than a photo.
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
