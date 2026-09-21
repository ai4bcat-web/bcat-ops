/** Shared file-type handling for Amazon dispute uploads (driver portal + staff manual). */

export const MAX_DISPUTE_FILE_BYTES = 10 * 1024 * 1024 // 10 MiB
export const PDF_TYPE = 'application/pdf'

// Browsers report no MIME type for some formats (HEIC on desktop Chrome, files from
// unusual apps) - fall back to the extension so a real photo is never rejected.
export const DISPUTE_IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
}

const IMAGE_TYPE_REGEX = /^image\/(?!svg)[a-z0-9.+-]+$/

/** MIME type to send for a picked file: the browser's, else inferred from the extension. */
export function fileContentType(file: { name?: string; type: string }): string {
  if (file.type) return file.type
  const ext = file.name?.match(/\.([a-zA-Z0-9]+)$/)?.[1].toLowerCase() ?? ''
  if (ext === 'pdf') return PDF_TYPE
  return DISPUTE_IMAGE_EXTENSIONS[ext] ?? ''
}

/**
 * Why a picked file can't be attached, or null when it is fine. Some platforms hand
 * back an empty `type` for HEIC and for files dragged out of desktop apps, so the name
 * extension decides when the browser couldn't — the same fallback the portal Lambda uses.
 */
export function disputeFileRejection(
  file: { name?: string; type: string; size: number },
  { allowPdf = false }: { allowPdf?: boolean } = {},
): string | null {
  const type = file.type.toLowerCase()
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? ''
  const knownImage = IMAGE_TYPE_REGEX.test(type) || (!type && ext in DISPUTE_IMAGE_EXTENSIONS)
  const knownPdf = type === PDF_TYPE || (!type && ext === 'pdf')
  if (!knownImage && !(allowPdf && knownPdf)) {
    return allowPdf
      ? 'Attach a screenshot (PNG, JPG, HEIC…) or a PDF.'
      : 'Attach an image (PNG, JPG, HEIC…).'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > MAX_DISPUTE_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`
  }
  return null
}
