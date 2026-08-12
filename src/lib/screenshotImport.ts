/**
 * Screenshot → trip rows for the Driver Pay import.
 *
 * The heavy lifting (reading the image) happens server-side via the
 * `parseTripScreenshot` mutation; this module prepares the image on the client —
 * AppSync caps a request at ~1MB, so screenshots are downscaled and re-encoded
 * as JPEG before upload — and adapts the result to the CSV parser's row shape.
 */
import type { RawTripRow } from '@/lib/tripCsv'
import type { ScreenshotTrip } from '@/lib/apiClient'

// Claude's high-res vision tier reads up to 2576px on the long edge; the Relay
// table is comfortably legible well below that.
const MAX_EDGE = 2300
// Keep the base64 payload safely under AppSync's ~1MB request limit.
const MAX_BASE64_CHARS = 900_000

/** Downscale + re-encode an image file/blob to a base64 JPEG suitable for upload. */
export async function imageToUploadableBase64(file: Blob): Promise<{ base64: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not read the image (no canvas context)')
    // Screenshots with transparency render on black by default — force white.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)

    // Step the JPEG quality down until the payload fits the request limit.
    for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      if (base64.length <= MAX_BASE64_CHARS) return { base64, mediaType: 'image/jpeg' }
    }
    throw new Error('Screenshot is too large even after compression — crop it to just the trips table')
  } finally {
    bitmap.close()
  }
}

/** First image file on a paste event (screenshot paste), if any. */
export function imageFromClipboard(e: React.ClipboardEvent): File | null {
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
  }
  return null
}

/** Adapt a server-parsed screenshot trip to the CSV parser's row shape. */
export function screenshotTripToRaw(t: ScreenshotTrip): RawTripRow {
  const miles = typeof t.miles === 'number' && isFinite(t.miles) ? t.miles : null
  const freight = typeof t.freightAmount === 'number' && isFinite(t.freightAmount) ? t.freightAmount : 0
  let ratePerMile = typeof t.ratePerMile === 'number' && isFinite(t.ratePerMile) ? t.ratePerMile : null
  if (ratePerMile == null && miles && miles > 0) ratePerMile = Math.round((freight / miles) * 100) / 100
  return {
    loadId: t.loadId?.trim() || null,
    origin: t.origin?.trim() || null,
    destination: t.destination?.trim() || null,
    miles,
    equipment: t.equipment?.trim() || null,
    freightAmount: freight,
    ratePerMile,
    dispatcher: null,
    status: t.status?.trim() || 'Completed',
    driverName: '',
    date: t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    tripId: null,
  }
}
