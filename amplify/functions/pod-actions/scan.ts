import { imageSize } from 'image-size'
import { Jimp } from 'jimp'

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 24_000_000
const MAX_EDGE = 2200

/**
 * Deterministic scan cleanup, not generative AI: EXIF orientation, white alpha
 * flattening, grayscale and local illumination correction. Never crop or replace
 * source pixels in storage; callers retain the original separately. Unsupported
 * formats (including multi-page PDFs/TIFFs) remain original-only.
 */
export async function enhancePodImage(
  bytes: Buffer,
  contentType: string,
): Promise<{ bytes: Buffer; contentType: 'image/jpeg' } | null> {
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('Image exceeds the 20 MB scan limit')
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (!jpeg && !png) {
    if (/^image\/(jpeg|png)(;|$)/i.test(contentType)) throw new Error('Invalid JPEG or PNG image')
    return null
  }

  // Read dimensions BEFORE a decoder allocates the full bitmap.
  const { width, height } = imageSize(bytes)
  if (!width || !height || width * height > MAX_PIXELS || width > 16000 || height > 16000) {
    throw new Error('Image exceeds the 24 megapixel scan limit')
  }
  const image = await Jimp.read(bytes, {
    'image/jpeg': { maxResolutionInMP: 24, maxMemoryUsageInMB: 256 },
  })
  if (Math.max(image.width, image.height) > MAX_EDGE) image.scaleToFit({ w: MAX_EDGE, h: MAX_EDGE })
  const { data, width: w, height: h } = image.bitmap
  const stride = w + 1
  // MAX_EDGE bounds the sum below Uint32's limit (2200² × 255).
  const integral = new Uint32Array(stride * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const alpha = data[p + 3] / 255
      const luminance = Math.round((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * alpha + 255 * (1 - alpha))
      data[p] = luminance
      rowSum += luminance
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum
    }
  }
  // Wide neighborhoods suppress paper shadows without hard-thresholding faint
  // handwriting/signatures. Retain grayscale rather than forcing black/white.
  const radius = Math.max(24, Math.round(Math.min(w, h) / 24))
  for (let y = 0; y < h; y++) {
    const top = Math.max(0, y - radius)
    const bottom = Math.min(h, y + radius + 1)
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - radius)
      const right = Math.min(w, x + radius + 1)
      const sum = integral[bottom * stride + right] - integral[top * stride + right]
        - integral[bottom * stride + left] + integral[top * stride + left]
      const illumination = Math.max(32, sum / ((right - left) * (bottom - top)))
      const p = (y * w + x) * 4
      const corrected = Math.min(255, Math.max(0, Math.round((data[p] * 255 / illumination - 8) * 255 / 247)))
      data[p] = corrected
      data[p + 1] = corrected
      data[p + 2] = corrected
      data[p + 3] = 255
    }
  }
  return { bytes: await image.getBuffer('image/jpeg', { quality: 92 }), contentType: 'image/jpeg' }
}
