import type { PendingPage } from '../driverApi'

export type PageSource = CanvasImageSource | { readonly width: number; readonly height: number }

const MAX_EDGE = 2000
const JPEG_QUALITY = 0.8

function readSourceSize(source: PageSource): { width: number; height: number } {
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
