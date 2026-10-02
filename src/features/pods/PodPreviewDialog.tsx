import { useEffect, useState } from 'react'
import { Download, AlertCircle, Loader2, FileText } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { getPodAssets } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import { toast } from 'sonner'
import { downloadPodAsPdf } from '@/lib/podDownload'
import { formatDateTime } from '@/lib/date'
import type { PodDocument, PodAssets } from '@/types/pods'

function formatOnlyReason(doc: PodDocument): string | null {
  const ct = doc.contentType ?? ''
  if (/pdf/i.test(ct)) return 'PDFs are kept as originals only'
  if (/heic/i.test(ct)) return 'HEIC files are kept as originals only'
  if (/webp/i.test(ct)) return 'WebP files are kept as originals only'
  if (doc.processingStatus === 'ORIGINAL_ONLY') return 'Original-only format'
  if (doc.processingStatus === 'FAILED') return 'Enhancement failed — original is still available'
  return null
}

export function PodPreviewDialog({ doc, onClose }: { doc: PodDocument; onClose: () => void }) {
  const [assets, setAssets] = useState<PodAssets | null>(null)
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [assetsError, setAssetsError] = useState<string | null>(null)
  /*
   * Opens on the enhanced scan.
   *
   * That is the readable document — deskewed, cleaned, always JPEG — and the copy that
   * should reach a broker or OTR. Opening on the raw phone photo meant people worked from
   * it and sent it on, which is the whole reason the enhancement exists. `activeUrl` falls
   * back to the original on its own when there is no enhanced copy, so this default is safe
   * before the assets have even loaded.
   */
  const [variant, setVariant] = useState<'original' | 'enhanced'>('enhanced')
  const [downloading, setDownloading] = useState(false)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getPodAssets(doc.id)
      .then((a) => { setAssets(a); setAssetsError(null) })
      .catch((err) => setAssetsError(graphqlErrorText(err) || 'Could not load image'))
      .finally(() => setAssetsLoading(false))
  }, [doc.id])

  const activeUrl = variant === 'enhanced' && assets?.enhancedUrl ? assets.enhancedUrl : assets?.originalUrl
  const canEnhance = doc.processingStatus === 'READY' && !!assets?.enhancedUrl
  const originalOnlyNote = formatOnlyReason(doc)
  // Only formats browsers decode natively go in <img>; the enhanced copy is always JPEG.
  const isBrowserImage = /^image\/(jpeg|png|webp|gif)/i.test(doc.contentType ?? '')

  const handleDownload = async (want: 'enhanced' | 'original', filename: string) => {
    setDownloading(true)
    try {
      /*
       * Sign it now, not when the dialog opened.
       *
       * A presigned URL lasts fifteen minutes, and S3 answers an expired one with a 403
       * carrying no CORS headers — which the browser reports as "Failed to fetch", naming
       * neither the cause nor the fix. A dialog left open while someone reads the POD is
       * exactly how that happens.
       */
      const fresh = await getPodAssets(doc.id)
      const url = want === 'enhanced' ? fresh.enhancedUrl : fresh.originalUrl
      if (!url) {
        toast.error(
          want === 'enhanced'
            ? 'There is no cleaned copy of this POD yet'
            : 'This POD has no stored file',
        )
        return
      }
      // Always a PDF: a POD leaves here for a broker or OTR, where one PDF is the form.
      await downloadPodAsPdf(url, filename)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download this POD')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {doc.companyName || 'POD preview'}
          </DialogTitle>
          <DialogDescription>
            {doc.senderName || doc.senderContact || 'Unknown sender'} · {formatDateTime(doc.receivedAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* Enhanced leads. The raw photo is named for what it is, so nobody picks it
                thinking it is the better copy. */}
            <div className="flex items-center gap-2">
              <VariantBtn active={variant === 'enhanced'} onClick={() => setVariant('enhanced')} disabled={!canEnhance}>
                Enhanced
              </VariantBtn>
              <VariantBtn active={variant === 'original'} onClick={() => setVariant('original')}>
                {canEnhance ? 'Raw photo' : 'Original'}
              </VariantBtn>
            </div>

            <div className="flex items-center gap-2">
              {canEnhance && (
                <button
                  onClick={() => handleDownload('enhanced', doc.fileName)}
                  disabled={downloading}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-semibold bg-emerald-50 text-emerald-700 border-emerald-200"
                >
                  <Download size={13} /> Download enhanced
                </button>
              )}
              {assets?.originalUrl && (
                <button
                  onClick={() => handleDownload('original', doc.fileName)}
                  disabled={downloading}
                  className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs ${
                    canEnhance ? 'font-medium text-muted-foreground' : 'font-semibold'
                  }`}
                >
                  <Download size={13} /> {canEnhance ? 'Raw photo' : 'Original'}
                </button>
              )}
            </div>
          </div>

          {canEnhance && variant === 'original' && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <FileText size={14} />
              This is the raw phone photo, kept as a record of what arrived. Send the enhanced
              copy instead — it is the readable one.
            </div>
          )}
          {originalOnlyNote && (
            <div className="text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2 flex items-center gap-2">
              <FileText size={14} /> {originalOnlyNote}
            </div>
          )}
          {doc.scanReviewReason && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Review scan: {doc.scanReviewReason} The original is retained for comparison.
            </div>
          )}

          {doc.processingStatus === 'PENDING' && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> The cleaned image is being generated on the server.
            </div>
          )}

          {doc.processingError && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 flex items-center gap-2">
              <AlertCircle size={14} /> {doc.processingError}
            </div>
          )}

          <div
            className="rounded-lg border bg-muted flex items-center justify-center overflow-hidden"
            style={{ minHeight: 320 }}
          >
            {assetsLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-12">
                <Loader2 size={18} className="animate-spin" /> Loading…
              </div>
            ) : assetsError ? (
              <div className="text-sm text-red-600 py-12">{assetsError}</div>
            ) : activeUrl && (variant === 'enhanced' || isBrowserImage) ? (
              <img
                src={activeUrl}
                alt={doc.fileName}
                className="max-w-full max-h-[60vh] object-contain"
              />
            ) : activeUrl && /pdf/i.test(doc.contentType ?? '') ? (
              <iframe src={activeUrl} title={doc.fileName} className="w-full" style={{ height: '60vh' }} />
            ) : (
              <div className="text-sm text-muted-foreground py-12 flex flex-col items-center gap-2">
                <FileText size={32} />
                {activeUrl ? 'This format cannot be previewed here — use Download original.' : 'No image available'}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div>Reference: <span className="text-foreground">{doc.referenceNumber || '—'}</span></div>
            <div>File: <span className="text-foreground">{doc.fileName}</span></div>
            <div className="col-span-2">Notes: <span className="text-foreground">{doc.notes || '—'}</span></div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function VariantBtn({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-8 px-3 rounded-md border text-xs font-semibold transition-colors ${
        active
          ? 'bg-foreground text-background border-foreground'
          : 'bg-background text-foreground border-input hover:bg-muted'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {children}
    </button>
  )
}
