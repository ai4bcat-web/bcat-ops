import { useEffect, useState } from 'react'
import { Download, AlertCircle, Loader2, FileText } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { getPodAssets } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import { downloadFromUrl } from '@/lib/download'
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
  const [variant, setVariant] = useState<'original' | 'enhanced'>('original')
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

  const handleDownload = async (url: string, filename: string) => {
    setDownloading(true)
    try {
      await downloadFromUrl(url, filename)
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
            <div className="flex items-center gap-2">
              <VariantBtn active={variant === 'original'} onClick={() => setVariant('original')}>
                Original
              </VariantBtn>
              <VariantBtn active={variant === 'enhanced'} onClick={() => setVariant('enhanced')} disabled={!canEnhance}>
                Enhanced
              </VariantBtn>
            </div>

            <div className="flex items-center gap-2">
              {assets?.originalUrl && (
                <button
                  onClick={() => handleDownload(assets.originalUrl!, doc.fileName)}
                  disabled={downloading}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-semibold"
                >
                  <Download size={13} /> Original
                </button>
              )}
              {canEnhance && (
                <button
                  onClick={() => handleDownload(assets.enhancedUrl!, `enhanced-${doc.fileName}`)}
                  disabled={downloading}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-semibold bg-emerald-50 text-emerald-700 border-emerald-200"
                >
                  <Download size={13} /> Enhanced
                </button>
              )}
            </div>
          </div>

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
