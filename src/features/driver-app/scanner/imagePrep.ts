import type { PendingPage } from '../driverApi'

export type PageSource = CanvasImageSource | { readonly width: number; readonly height: number } | File

const MAX_EDGE = 2000
const JPEG_QUALITY = 0.8

function readSourceSize(source: PageSource): { width: number; height: number } {
  if (source instanceof File) {
    // PDFs and other non-image files flow through untouched; dimensions are irrelevant.
    return { width: 0, height: 0 }
  }

  if (source instanceof HTMLVideoElement) {
    return {
      width: source.videoWidth || source.clientWidth,
      height: source.videoHeight || source.clientHeight,
    }
  }

  if (source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    }
  }

  if (source instanceof HTMLCanvasElement) {
    return { width: source.width, height: source.height }
  }

  if ('width' in source && 'height' in source) {
    return { width: Number(source.width), height: Number(source.height) }
  }

  throw new Error('Unsupported image source')
}

export interface PreparePageOptions {
  /** Injected in tests so the resize dimensions can be observed without a real browser canvas. */
  createCanvas?: () => HTMLCanvasElement
}

/**
 * Client-side prep for a captured frame: downscale so the longest edge is at most
 * 2000px, preserve aspect ratio, and encode as JPEG at ~0.8 quality.
 *
 * Perspective/deskew enhancement happens server-side in amplify/functions/pod-actions/scan.ts;
 * keep this function to resize + encode only.
 */
export async function preparePage(
  source: PageSource,
  fileName: string,
  options: PreparePageOptions = {},
): Promise<PendingPage> {
  // PDFs (and any other file the driver picks on desktop) do not need canvas encoding.
  if (source instanceof File) {
    return {
      fileName: source.name || fileName,
      contentType: source.type || 'application/octet-stream',
      byteSize: source.size,
      blob: source,
    }
  }

  const { width: srcWidth, height: srcHeight } = readSourceSize(source)
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new Error('Image source has no usable dimensions')
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(srcWidth, srcHeight))
  const targetWidth = Math.max(1, Math.round(srcWidth * scale))
  const targetHeight = Math.max(1, Math.round(srcHeight * scale))

  const canvas = options.createCanvas ? options.createCanvas() : document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Could not get 2D canvas context')
  }

  ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) {
        resolve(b)
      } else {
        reject(new Error('JPEG encoding failed'))
      }
    }, 'image/jpeg', JPEG_QUALITY)
  })

  return {
    fileName,
    contentType: 'image/jpeg',
    byteSize: blob.size,
    blob,
  }
}

/**
 * Turn a file the driver picked into a page, whatever it turns out to be.
 *
 * This exists because the picker used to decode the photo itself and throw the file away
 * when that failed — and on an iPhone it fails often. The Files app hands back whatever is
 * on disk regardless of the `accept` list, which for a photo taken on any recent iPhone is
 * HEIC; a decode that fails leaves an <img> with naturalWidth 0, which read as "no usable
 * dimensions" and dropped the page. From the driver's side: pick a document, land back on
 * the upload screen, nothing saved.
 *
 * So decoding is now an optimisation, not a gate. Downscaling saves a driver at a dock
 * several megabytes of upload, and when it cannot be done the ORIGINAL file is sent. The
 * server cleans PODs anyway, and a POD that arrives unconverted beats one that never
 * arrives.
 */
export async function prepareFile(file: File): Promise<PendingPage> {
  const original: PendingPage = {
    fileName: file.name || 'page',
    contentType: file.type || 'application/octet-stream',
    byteSize: file.size,
    blob: file,
  }

  // A PDF is already the document: a scanner app made it, and re-encoding would only
  // rasterize away its text.
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return original

  const source = await decodeImage(file)
  if (!source) return original

  try {
    return await preparePage(source, file.name || 'page.jpg')
  } catch {
    // Canvas refused — a picture too large for this phone's limits, or a tainted source.
    return original
  } finally {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
  }
}

/**
 * Decode a picked file, or null if this browser cannot.
 *
 * createImageBitmap first: it handles formats an <img> will not, decodes off the main
 * thread, and reports failure by rejecting rather than by quietly producing a zero-sized
 * image. The <img> path stays as the fallback for Safari versions without it.
 */
async function decodeImage(file: File): Promise<CanvasImageSource | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through — an <img> may still manage it.
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = url
    })
    // A zero-sized decode is a failure wearing a success's clothes.
    if (!img || !(img.naturalWidth || img.width)) return null
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}
