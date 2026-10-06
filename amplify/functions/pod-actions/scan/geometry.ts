/*
 * The Jimp-bound half of document geometry.
 *
 * The pixel maths — deskew, page detection, perspective warp — moved to
 * src/lib/docScan/geometry.ts so the driver's phone and this Lambda run the SAME
 * detector. Two copies would drift, and the drift would show up as the phone drawing one
 * outline and the server cropping somewhere else, with nothing on either side to explain
 * it. They are re-exported below so this module's own callers did not have to change.
 *
 * What stays here is everything that needs a Jimp image: rotation, illumination cleanup,
 * and the gray <-> Jimp conversions. A relative import, never the `@/` alias — esbuild
 * bundles these handlers and knows nothing about tsconfig paths (see bundle.test.ts).
 */

import { Jimp } from 'jimp'

/**
 * Structural view of Jimp instances used in this module.
 * Intentionally narrow so different Jimp entry modules (read, new, clone)
 * stay structurally assignable.
 */
export interface JimpImage {
  bitmap: { width: number; height: number; data: Buffer | Uint8Array }
  width: number
  height: number
  scaleToFit(options: { w: number; h: number }): this
  getBuffer(mime: string, options?: unknown): Promise<Buffer>
}

import {
  detectSkewAngle,
  findDocumentBoundary,
  warpPerspective,
  rotateBilinear,
  type Point,
  type Quad,
  type Detection,
} from '../../../../src/lib/docScan/geometry'

export {
  detectSkewAngle,
  findDocumentBoundary,
  warpPerspective,
  rotateBilinear,
}
export type { Point, Quad, Detection }

/** Stays server-side: a Node Buffer is what Jimp's bitmap wants, and the browser has none. */
export function rgbaBufferFromGray(
  gray: Uint8Array,
  w: number,
  h: number,
): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = gray[i]
    buf[i * 4 + 1] = gray[i]
    buf[i * 4 + 2] = gray[i]
    buf[i * 4 + 3] = 255
  }
  return buf
}


/**
 * Rotate a Jimp RGBA image by multiples of 90 degrees without interpolation.
 * Positive angle is counter-clockwise (matches Jimp rotate convention).
 */
function cloneImage(image: JimpImage): JimpImage {
  const { width: w, height: h, data } = image.bitmap
  return new Jimp({ width: w, height: h, data: Buffer.from(data) })
}

export function orthogonalRotate(image: JimpImage, angle: number): JimpImage {
  const normalized = ((angle % 360) + 360) % 360
  const { width: w, height: h, data } = image.bitmap
  if (normalized === 0) return cloneImage(image)
  if (normalized === 180) {
    const out = new Jimp({ width: w, height: h })
    const d = out.bitmap.data
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = ((h - 1 - y) * w + (w - 1 - x)) * 4
        const dst = (y * w + x) * 4
        d[dst] = data[src]
        d[dst + 1] = data[src + 1]
        d[dst + 2] = data[src + 2]
        d[dst + 3] = data[src + 3]
      }
    }
    return out
  }
  // Both quarter turns swap width and height.
  const cw = normalized === 270 // 270 CCW == 90 CW
  const outW = h
  const outH = w
  const out = new Jimp({ width: outW, height: outH })
  const d = out.bitmap.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4
      // CW: (x, y) -> (h - 1 - y, x); CCW: (x, y) -> (y, w - 1 - x)
      const dst = cw
        ? (x * outW + (h - 1 - y)) * 4
        : ((w - 1 - x) * outW + y) * 4
      d[dst] = data[src]
      d[dst + 1] = data[src + 1]
      d[dst + 2] = data[src + 2]
      d[dst + 3] = data[src + 3]
    }
  }
  return out
}

/** Perceived brightness of an RGBA pixel; transparent pixels flatten to white paper. */
export function luminanceAt(data: Uint8Array | Buffer, p: number): number {
  const alpha = data[p + 3] / 255
  return Math.round((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * alpha + 255 * (1 - alpha))
}

/**
 * How bright the PAPER is, everywhere on the page.
 *
 * Taken as a high percentile within each tile of a coarse grid, then smoothed and
 * bilinearly expanded back to full size. Paper is the brightest thing in any small patch
 * of a document, so a high percentile finds it whether the patch is blank, covered in
 * print, or in shadow.
 *
 * A local MEAN was tried first and is wrong twice over. Over a dense paragraph the mean is
 * dragged down by the text itself, so dividing by it flattens the paragraph to white —
 * that is the washout that made cleaned PODs read worse than the photographs. And near the
 * edge of a page held in someone's hand, the mean mixes bright paper with a dark hand, so
 * the shaded margin divides to almost nothing and is crushed to solid black, taking the
 * SHIP FROM and SHIP TO blocks with it. A percentile has neither problem: text and the
 * dark surround both sit below it and neither moves it.
 */
function paperLevelField(
  gray: Float32Array,
  w: number,
  h: number,
  tile: number,
  percentile: number,
): Float32Array {
  const gw = Math.max(1, Math.ceil(w / tile))
  const gh = Math.max(1, Math.ceil(h / tile))
  const coarse = new Float32Array(gw * gh)
  const bucket: number[] = []

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * tile
      const y0 = gy * tile
      const x1 = Math.min(w, x0 + tile)
      const y1 = Math.min(h, y0 + tile)
      bucket.length = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) bucket.push(gray[y * w + x])
      }
      if (bucket.length === 0) { coarse[gy * gw + gx] = 255; continue }
      bucket.sort((a, b) => a - b)
      coarse[gy * gw + gx] = bucket[Math.min(bucket.length - 1, Math.floor(bucket.length * percentile))]
    }
  }

  // Smooth the grid so a tile boundary never shows up as a seam on the finished page.
  const smooth = new Float32Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let total = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const y = gy + dy
          const x = gx + dx
          if (y < 0 || y >= gh || x < 0 || x >= gw) continue
          total += coarse[y * gw + x]
          count++
        }
      }
      smooth[gy * gw + gx] = total / count
    }
  }

  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / tile - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(gh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / tile - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(gw - 1, x0 + 1)
      const tx = fx - x0
      const top = smooth[y0 * gw + x0] * (1 - tx) + smooth[y0 * gw + x1] * tx
      const bottom = smooth[y1 * gw + x0] * (1 - tx) + smooth[y1 * gw + x1] * tx
      out[y * w + x] = top * (1 - ty) + bottom * ty
    }
  }
  return out
}

/*
 * How the page is separated from its lighting.
 *
 * PAPER_TILE_DIVISOR: the grid is about a sixteenth of the short edge per tile — small
 * enough to follow a shadow across a sheet, large enough that a tile always contains some
 * paper to measure.
 *
 * PAPER_PERCENTILE: the ninetieth, not the maximum. The maximum is a specular highlight
 * off a phone flash, and keying the whole page to a glare spot darkens everything else.
 *
 * INK_POINT: paper now lands at 1.0 by construction, so this is a fixed anchor rather
 * than something measured. Half of paper brightness is ink; above that is shading. Fixed
 * is the point — a measured anchor adapts to the page, which means two photographs of the
 * same document come out looking different.
 *
 * SHARPEN_AMOUNT: a light unsharp mask. Flattening costs a little edge definition, and
 * small print is where that is felt.
 */
const PAPER_TILE_DIVISOR = 16
const MIN_PAPER_TILE = 8
const PAPER_PERCENTILE = 0.9
const INK_POINT = 0.5
const SHARPEN_AMOUNT = 0.6
/** Floors the paper level so a frame with no paper in it cannot divide by nearly nothing. */
const MIN_PAPER_LEVEL = 32

/**
 * In-place illumination cleanup: divide the lighting out, then put the contrast back.
 *
 * Works on luminance, never a single channel — red stamps, blue ink and pink paper all
 * have to keep their contrast. The output is greyscale, which is what a POD is.
 */
export function applyIlluminationCleanup(jimp: JimpImage): void {
  const { width: w, height: h, data } = jimp.bitmap
  if (w === 0 || h === 0) return

  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) gray[i] = luminanceAt(data, i * 4)

  const tile = Math.max(MIN_PAPER_TILE, Math.round(Math.min(w, h) / PAPER_TILE_DIVISOR))
  const paper = paperLevelField(gray, w, h, tile, PAPER_PERCENTILE)

  // Paper lands at 1.0 whatever the lighting was; ink lands below it.
  const levelled = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const ratio = gray[i] / Math.max(MIN_PAPER_LEVEL, paper[i])
    levelled[i] = Math.max(0, Math.min(255, ((ratio - INK_POINT) / (1 - INK_POINT)) * 255))
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let value = levelled[i]
      // Unsharp mask on the interior; the one-pixel border keeps its levelled value.
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        const mean =
          (levelled[i - 1] + levelled[i + 1] + levelled[i - w] + levelled[i + w] + levelled[i]) / 5
        value = levelled[i] + SHARPEN_AMOUNT * (levelled[i] - mean)
      }
      const v = Math.round(Math.max(0, Math.min(255, value)))
      const p = i * 4
      data[p] = v
      data[p + 1] = v
      data[p + 2] = v
      data[p + 3] = 255
    }
  }
}

/**
 * Bilinear rotation for small deskew angles. Expands canvas as needed.
 */

export function jimpFromGray(gray: Uint8Array, w: number, h: number): JimpImage {
  return new Jimp({ width: w, height: h, data: rgbaBufferFromGray(gray, w, h) })
}

export function jimpToGray(image: JimpImage): Uint8Array {
  const { width: w, height: h, data } = image.bitmap
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    gray[i] = luminanceAt(data, i * 4)
  }
  return gray
}
