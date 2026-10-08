/**
 * Turn a camera frame into a scan: find the page, flatten it, make it readable.
 *
 * This is the client half of the pipeline the server already runs on upload. It exists
 * because by the time the server sees a bad photo it is too late — the driver has walked
 * away from the dock. Detecting the page WHILE they are framing it means a crooked,
 * half-out-of-frame shot gets fixed in the two seconds they are already standing there.
 *
 * It shares `findDocumentBoundary` and `warpPerspective` with the Lambda rather than
 * reimplementing them, so the outline drawn on the viewfinder is the same page the server
 * would have found. The server still runs its own full pass afterwards — this never
 * replaces that, it just stops rubbish reaching it.
 *
 * No DOM beyond canvas, so every function here is testable without a browser.
 */
import { findDocumentBoundary, warpPerspective, type Quad } from './geometry'
import { findPaperQuad } from './paperMask'

/** Longest edge the detector works at. Full-resolution edge detection is pointlessly slow. */
const DETECT_EDGE = 480
/** Longest edge of the finished scan. Matches what preparePage already caps uploads at. */
const OUTPUT_EDGE = 2000

export interface GrayFrame {
  data: Uint8Array
  width: number
  height: number
}

/** RGBA → luma, at a size the detector can run on every frame without dropping any. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayFrame {
  const data = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    // Rec. 601 luma — the same weighting the server's jimpToGray uses.
    data[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000
  }
  return { data, width, height }
}

export interface DetectedPage {
  /** In the coordinates of the frame that was passed in. */
  quad: Quad
  confidence: 'high' | 'low'
}

/**
 * Find the page in one frame.
 *
 * Returns null rather than a guess. A wrong outline is worse than none: it tells the
 * driver the app has the page when it is about to crop their signature off.
 */
export function detectPage(frame: GrayFrame): DetectedPage | null {
  const { corners, confidence } = findDocumentBoundary(frame.data, frame.width, frame.height, 1)
  if (!corners || confidence === 'none') return null
  return { quad: corners, confidence }
}

/** The quad scaled from detection coordinates up to the full-resolution frame. */
export function scaleQuad(quad: Quad, factor: number): Quad {
  const s = (p: { x: number; y: number }) => ({ x: p.x * factor, y: p.y * factor })
  return {
    topLeft: s(quad.topLeft), topRight: s(quad.topRight),
    bottomRight: s(quad.bottomRight), bottomLeft: s(quad.bottomLeft),
  }
}

/** The size to render a detected page at, keeping its own proportions. */
export function outputSize(quad: Quad): { width: number; height: number } {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
  const w = Math.max(d(quad.topLeft, quad.topRight), d(quad.bottomLeft, quad.bottomRight))
  const h = Math.max(d(quad.topLeft, quad.bottomLeft), d(quad.topRight, quad.bottomRight))
  if (w < 1 || h < 1) return { width: 1, height: 1 }
  const scale = Math.min(1, OUTPUT_EDGE / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

export interface Readability {
  /** Variance of the Laplacian — the standard focus measure. Higher is sharper. */
  sharpness: number
  /** Mean luma, 0–255. */
  brightness: number
  /** How much of the tonal range is used. Flat means a washed-out or very dark shot. */
  contrast: number
  ok: boolean
  /** What to tell the driver to do about it. Null when the page is fine. */
  problem: string | null
}

/**
 * Is this page actually readable?
 *
 * Checked on the phone, before the upload, because every one of these is fixable in the
 * two seconds the driver is still standing in front of the document — and none of them is
 * fixable afterwards. The server scores legibility too, but that score arrives after the
 * truck has left.
 *
 * The thresholds are deliberately forgiving. A POD that is merely poor still has to go
 * through; refusing it would leave the driver with no way to submit at all, which is worse
 * than a hard-to-read scan. These warn, they do not block.
 */
export function assessReadability(frame: GrayFrame): Readability {
  const { data, width, height } = frame
  let sum = 0
  let min = 255
  let max = 0
  for (let i = 0; i < data.length; i++) {
    sum += data[i]
    if (data[i] < min) min = data[i]
    if (data[i] > max) max = data[i]
  }
  const brightness = data.length ? sum / data.length : 0
  const contrast = max - min

  // Variance of the Laplacian over the interior.
  let lapSum = 0
  let lapSqSum = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width]
      lapSum += lap
      lapSqSum += lap * lap
      n++
    }
  }
  const mean = n ? lapSum / n : 0
  const sharpness = n ? lapSqSum / n - mean * mean : 0

  let problem: string | null = null
  if (brightness < 40) problem = 'Too dark — move into better light.'
  else if (brightness > 225) problem = 'Washed out — move out of direct glare.'
  else if (contrast < 40) problem = 'Very flat — put the page on a darker surface.'
  else if (sharpness < 50) problem = 'Blurry — hold still and tap to focus.'

  return { sharpness, brightness, contrast, ok: problem === null, problem }
}

/**
 * Lift the ink off the paper.
 *
 * A photographed page is grey, unevenly lit and low contrast. This stretches the tonal
 * range so paper goes white and ink goes black, using percentiles rather than min/max so
 * one dark speck or one blown highlight cannot flatten the whole page.
 */
export function enhanceForReading(frame: GrayFrame): GrayFrame {
  const { data, width, height } = frame
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++

  const total = data.length
  const at = (p: number) => {
    let seen = 0
    const target = total * p
    for (let v = 0; v < 256; v++) {
      seen += hist[v]
      if (seen >= target) return v
    }
    return 255
  }
  // 5th percentile is ink, 85th is paper. Anything above paper level is paper.
  const black = at(0.05)
  const white = Math.max(black + 1, at(0.85))

  const out = new Uint8Array(data.length)
  const span = white - black
  for (let i = 0; i < data.length; i++) {
    const v = ((data[i] - black) / span) * 255
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return { data: out, width, height }
}

export interface ColorFrame {
  /** RGBA, as getImageData hands it over. */
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

/** Nearest-neighbour RGBA downscale, for the detector only. */
export function downscaleColor(frame: ColorFrame, width: number, height: number): ColorFrame {
  const out = new Uint8ClampedArray(width * height * 4)
  const xr = frame.width / width
  const yr = frame.height / height
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.height - 1, (y * yr) | 0)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, (x * xr) | 0)
      const si = (sy * frame.width + sx) * 4
      const oi = (y * width + x) * 4
      out[oi] = frame.data[si]; out[oi + 1] = frame.data[si + 1]; out[oi + 2] = frame.data[si + 2]; out[oi + 3] = 255
    }
  }
  return { data: out, width, height }
}

/**
 * Find the page in a colour frame: by paper colour first (see paperMask.ts), by edges
 * when colour cannot separate it — a white page on a white desk.
 */
export function detectPageColor(frame: ColorFrame): DetectedPage | null {
  const paper = findPaperQuad(frame.data, frame.width, frame.height)
  if (paper) return paper
  return detectPage(toGray(frame.data, frame.width, frame.height))
}

/** scanFrame for a colour frame: the colour detector, then the same flatten-and-clean. */
export function scanFrameColor(full: ColorFrame): { gray: GrayFrame; quad: Quad } | null {
  const factor = Math.max(full.width, full.height) / DETECT_EDGE
  const small = factor > 1 ? downscaleColor(full, Math.round(full.width / factor), Math.round(full.height / factor)) : full
  const found = detectPageColor(small)
  if (!found) return null
  const quad = factor > 1 ? scaleQuad(found.quad, full.width / small.width) : found.quad
  const gray = toGray(full.data, full.width, full.height)
  const { width, height } = outputSize(quad)
  const warped = warpPerspective(gray.data, gray.width, gray.height, quad, width, height)
  return { gray: enhanceForReading({ data: warped, width, height }), quad }
}

/** Everything in one step: detect, flatten, clean. Null when no page could be found. */
export function scanFrame(full: GrayFrame): { gray: GrayFrame; quad: Quad } | null {
  const factor = Math.max(full.width, full.height) / DETECT_EDGE
  const small = factor > 1 ? downscale(full, Math.round(full.width / factor), Math.round(full.height / factor)) : full
  const found = detectPage(small)
  if (!found) return null

  const quad = factor > 1 ? scaleQuad(found.quad, full.width / small.width) : found.quad
  const { width, height } = outputSize(quad)
  const warped = warpPerspective(full.data, full.width, full.height, quad, width, height)
  return { gray: enhanceForReading({ data: warped, width, height }), quad }
}

/** Nearest-neighbour downscale. Good enough to find a page; never used for the output. */
export function downscale(frame: GrayFrame, width: number, height: number): GrayFrame {
  const out = new Uint8Array(width * height)
  const xr = frame.width / width
  const yr = frame.height / height
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.height - 1, (y * yr) | 0)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, (x * xr) | 0)
      out[y * width + x] = frame.data[sy * frame.width + sx]
    }
  }
  return { data: out, width, height }
}

export { DETECT_EDGE, OUTPUT_EDGE }
