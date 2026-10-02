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
 * Follow a link the browser will save, with no script in the way.
 *
 * The fallback when reading the bytes ourselves fails. A navigation is not an XHR: no CORS
 * preflight, nothing an extension or a network policy blocks the way it blocks a
 * cross-origin fetch. The trade is that an image arrives as an image rather than wrapped in
 * a PDF — which beats "Failed to fetch" and no file at all.
 *
 * Deliberately NOT target="_blank": this runs after an await, so the user-gesture context
 * is gone and a popup blocker eats it silently — which looked exactly like the failure it
 * was supposed to rescue. The URL carries a Content-Disposition, so a same-tab navigation
 * saves the file without leaving the page.
 */
function followDownloadLink(url: string, fileName: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Fetch and save as a PDF. Throws on a bad response so the caller can show a toast
 * rather than appear to do nothing.
 *
 * `fetch` can fail for reasons that have nothing to do with the file: a browser extension,
 * a corporate proxy, a captive network. Those surface as the bare word "Failed to fetch",
 * which names neither cause nor fix and reads exactly like a broken button. So a failure to
 * READ the bytes falls back to handing the URL to the browser, and anything else says which
 * step gave up.
 */
export async function downloadPodAsPdf(
  url: string,
  baseName: string,
  /** Signed with a Content-Disposition, for when reading the bytes is blocked. */
  downloadUrl?: string,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    // Could not even reach it from script — an extension, a proxy, a captive network. The
    // browser can still follow a link.
    followDownloadLink(downloadUrl ?? url, pdfFileName(baseName))
    return
  }
  if (!res.ok) throw new Error(`The file store returned ${res.status}`)
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

  // Wrapping the image in a PDF is a nicety, not the job. If pdf-lib cannot embed this
  // particular JPEG, the file itself still has to reach the person who asked for it.
  const combined = await pagesToPdf([{ fileName: baseName || 'POD', contentType, blob }], 'POD')
    .catch(() => null)
  if (!combined) {
    saveBlob(blob, baseName || 'POD')
    return
  }
  saveBlob(combined.blob, pdfFileName(baseName))
}
