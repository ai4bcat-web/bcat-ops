/**
 * Download a POD as a PDF, whatever it is stored as.
 *
 * Two problems this solves at once.
 *
 * The enhanced copy is always a JPEG, but the preview downloaded it as
 * `enhanced-<fileName>` — and `fileName` is usually the original's name, often ending
 * `.pdf`. So the browser saved JPEG bytes called something.pdf and nothing would open it.
 * It looked like the download was broken rather than mislabelled.
 *
 * And a POD leaves this office for a broker or for OTR, where one PDF is the expected
 * form. A loose JPEG is the thing someone then has to convert by hand.
 *
 * So the bytes are fetched, wrapped in a PDF if they are an image, and saved with a name
 * that matches what is inside. Already a PDF means saved untouched — no re-encode.
 */
import { saveBlob } from './download'
import { pagesToPdf } from './pagesToPdf'

/** Extensions we replace with `.pdf`, so "POD.jpg" does not become "POD.jpg.pdf". */
const KNOWN_EXT = /\.(pdf|jpe?g|png|webp|gif|tiff?|heic|heif)$/i

/** pdf-lib can embed these; anything else has to be saved as it came. */
const EMBEDDABLE = /^image\/(jpeg|jpg|png)$/i

export function pdfFileName(baseName: string): string {
  const trimmed = (baseName || 'POD').trim().replace(KNOWN_EXT, '')
  return `${trimmed || 'POD'}.pdf`
}

/**
 * Fetch and save as a PDF. Throws on a bad response so the caller can show a toast
 * rather than appear to do nothing.
 */
export async function downloadPodAsPdf(url: string, baseName: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  const blob = await res.blob()
  const contentType = blob.type || ''

  if (/^application\/pdf/i.test(contentType)) {
    saveBlob(blob, pdfFileName(baseName))
    return
  }

  // Not an image pdf-lib can embed (HEIC, TIFF, an unknown type): save the real bytes
  // under their real name. A file that opens beats a PDF that does not exist.
  if (!EMBEDDABLE.test(contentType)) {
    saveBlob(blob, baseName || 'POD')
    return
  }

  const combined = await pagesToPdf(
    [{ fileName: baseName || 'POD', contentType, blob }],
    'POD',
  )
  if (!combined) {
    saveBlob(blob, baseName || 'POD')
    return
  }
  saveBlob(combined.blob, pdfFileName(baseName))
}
