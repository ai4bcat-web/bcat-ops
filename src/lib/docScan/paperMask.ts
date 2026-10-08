/**
 * Find the page by what paper IS, not by where the edges are.
 *
 * The edge detector takes the biggest tangle of edges in the frame and draws a hull round
 * it. On a dock that tangle is the page's text PLUS the clipboard it is clipped to PLUS
 * the shadow across it, all joined up — and the outline lands on the clipboard. Jason's
 * BOL on 8 Oct: a white page on a yellow clipboard, outline on the clipboard, bottom
 * corner cut off along a shadow line.
 *
 * Paper has one property nothing around it shares: it has no colour. A yellow clipboard,
 * a brown seat, a blue dash are all saturated; a white page is not, in sun or in shadow.
 * So the page is the largest connected blob of unsaturated, reasonably bright pixels, and
 * its corners are the corners of that blob. A shadow dims the paper but does not colour
 * it, so the blob runs under the shadow and the corner is where the paper ends, not where
 * the light does.
 *
 * Pure RGBA in, quad out. The gray edge detector stays as the fallback — a page on a white
 * desk has no colour boundary either, and there the edges are all we have.
 */
import {
  bestQuadrilateral, convexHull, orderQuad, polygonArea, simplifyPolygon, type Point, type Quad,
} from './geometry'

/** Above this a pixel is coloured — clipboard, seat, dash — not paper. (0 = grey, 1 = pure hue.) */
export const PAPER_MAX_SATURATION = 0.25
/** Paper must be at least this bright relative to the frame's bright reference (p95). Shadowed paper passes. */
export const PAPER_MIN_VALUE_RATIO = 0.45
/** Smaller than this share of the frame is not the page the driver is holding up. */
export const PAPER_MIN_AREA_RATIO = 0.12

/** 1 where a pixel looks like paper: unsaturated and not dark. */
export function paperMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h
  const value = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b)
    value[i] = mx
    hist[mx]++
  }
  // The bright reference: what the well-lit paper reads as, ignoring glints.
  let acc = 0, p95 = 255
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.95) { p95 = v; break } }
  const minValue = Math.max(60, p95 * PAPER_MIN_VALUE_RATIO)

  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const mx = value[i]
    if (mx < minValue) continue
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
    if ((mx - mn) / mx <= PAPER_MAX_SATURATION) mask[i] = 1
  }
  return mask
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let keep = 1
    for (let dy = -r; dy <= r && keep; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) { keep = 0; break }
    }
    out[y * w + x] = keep
  }
  return out
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1
    }
  }
  return out
}

/** The largest 4-connected blob in the mask; null when there is none. */
function largestComponent(mask: Uint8Array, w: number, h: number): { pixels: Int32Array; size: number } | null {
  const label = new Int32Array(w * h).fill(-1)
  const stack: number[] = []
  let best: { start: number; size: number } | null = null
  let id = 0
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] !== -1) continue
    let size = 0
    stack.length = 0
    stack.push(s)
    label[s] = id
    while (stack.length) {
      const i = stack.pop()!
      size++
      const x = i % w, y = (i / w) | 0
      if (x > 0 && mask[i - 1] && label[i - 1] === -1) { label[i - 1] = id; stack.push(i - 1) }
      if (x < w - 1 && mask[i + 1] && label[i + 1] === -1) { label[i + 1] = id; stack.push(i + 1) }
      if (y > 0 && mask[i - w] && label[i - w] === -1) { label[i - w] = id; stack.push(i - w) }
      if (y < h - 1 && mask[i + w] && label[i + w] === -1) { label[i + w] = id; stack.push(i + w) }
    }
    if (!best || size > best.size) best = { start: id, size }
    id++
  }
  if (!best) return null
  const pixels = new Int32Array(best.size)
  let k = 0
  for (let i = 0; i < w * h; i++) if (label[i] === best.start) pixels[k++] = i
  return { pixels, size: best.size }
}

export interface PaperQuad {
  quad: Quad
  confidence: 'high' | 'low'
}

/**
 * The page's corners from a colour frame, or null when nothing paper-shaped fills enough
 * of it — or when the paper runs out of the frame, which no crop can fix.
 */
export function findPaperQuad(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): PaperQuad | null {
  let mask = paperMask(rgba, w, h)
  // Open to shed stray bright specks, close to swallow the text and the fold lines.
  const r = Math.max(1, Math.round(Math.min(w, h) / 160))
  mask = dilate(erode(mask, w, h, r), w, h, r)
  mask = erode(dilate(mask, w, h, r * 2), w, h, r * 2)

  const comp = largestComponent(mask, w, h)
  if (!comp || comp.size < w * h * PAPER_MIN_AREA_RATIO) return null

  // Only the blob's boundary matters for its hull.
  const boundary: Point[] = []
  for (let k = 0; k < comp.size; k++) {
    const i = comp.pixels[k]
    const x = i % w, y = (i / w) | 0
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) boundary.push({ x, y })
  }
  const hull = convexHull(boundary)
  if (hull.length < 4) return null

  // Paper against the frame edge: part of the page is out of shot.
  const margin = Math.max(2, Math.min(w, h) * 0.015)
  if (hull.some((p) => p.x <= margin || p.y <= margin || p.x >= w - 1 - margin || p.y >= h - 1 - margin)) return null

  const simplified = simplifyPolygon(hull, Math.max(3, Math.hypot(w, h) / 80))
  const corners = simplified.length === 4 ? simplified : bestQuadrilateral(simplified.length >= 4 ? simplified : hull)
  if (corners.length !== 4) return null
  const quadArea = polygonArea(corners)
  if (quadArea <= 0) return null
  // How much of the quad the paper actually fills: a page is a quad; a hand or a seat is not.
  const fill = comp.size / quadArea
  if (fill < 0.6) return null
  return { quad: orderQuad(corners), confidence: fill >= 0.8 ? 'high' : 'low' }
}
