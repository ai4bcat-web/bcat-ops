/*
 * Pure-Jimp document geometry helpers.
 *
 * Hough deskew, edge/contour quadrilateral detection, and bilinear
 * perspective warp. No native platform dependencies: runs on Lambda Node.js
 * using only CPU pixel loops.
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

export interface Point {
  x: number
  y: number
}

export interface Quad {
  topLeft: Point
  topRight: Point
  bottomRight: Point
  bottomLeft: Point
}

export interface Detection<T> {
  value: T
  confidence: 'high' | 'low' | 'none'
}

const DEG2RAD = Math.PI / 180

function hypot(a: number, b: number): number {
  return Math.hypot(a, b)
}

function dist(a: Point, b: Point): number {
  return hypot(a.x - b.x, a.y - b.y)
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function convexHull(points: Point[]): Point[] {
  if (points.length <= 3) return points.slice()
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const lower: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function polygonArea(poly: Point[]): number {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y
  }
  return Math.abs(area) / 2
}

/**
 * Douglas–Peucker polyline simplification.
 */
function simplifyPolygon(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.slice()
  let dmax = 0
  let index = 0
  const end = points.length - 1
  for (let i = 1; i < end; i++) {
    const d = pointLineDistance(points[i], points[0], points[end])
    if (d > dmax) {
      index = i
      dmax = d
    }
  }
  if (dmax > epsilon) {
    const left = simplifyPolygon(points.slice(0, index + 1), epsilon)
    const right = simplifyPolygon(points.slice(index), epsilon)
    return left.slice(0, left.length - 1).concat(right)
  }
  return [points[0], points[end]]
}

function pointLineDistance(p: Point, a: Point, b: Point): number {
  const length = hypot(b.x - a.x, b.y - a.y)
  if (length === 0) return hypot(p.x - a.x, p.y - a.y)
  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (length * length)
  const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
  return hypot(p.x - proj.x, p.y - proj.y)
}

function orderQuad(corners: Point[]): Quad {
  const byY = corners.slice().sort((a, b) => a.y - b.y)
  const top = byY[0]
  const top2 = byY[1]
  const bottom2 = byY[2]
  const bottom = byY[3]
  const topLeft = top.x <= top2.x ? top : top2
  const topRight = top.x <= top2.x ? top2 : top
  const bottomLeft = bottom2.x <= bottom.x ? bottom2 : bottom
  const bottomRight = bottom2.x <= bottom.x ? bottom : bottom2
  return { topLeft, topRight, bottomRight, bottomLeft }
}

function sobelMagnitude(gray: Uint8Array, w: number, h: number): Float32Array {
  const mag = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        -gray[i - w - 1] +
        gray[i - w + 1] +
        -2 * gray[i - 1] +
        2 * gray[i + 1] +
        -gray[i + w - 1] +
        gray[i + w + 1]
      const gy =
        -gray[i - w - 1] +
        -2 * gray[i - w] +
        -gray[i - w + 1] +
        gray[i + w - 1] +
        2 * gray[i + w] +
        gray[i + w + 1]
      mag[i] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return mag
}

function thresholdEdges(mag: Float32Array, low: number): Uint8Array {
  const edges = new Uint8Array(mag.length)
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= low) edges[i] = 255
  }
  return edges
}

/** Small max-filter dilation to close gaps in the page outline. */
function dilate(edges: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(edges.length)
  for (let y = radius; y < h - radius; y++) {
    for (let x = radius; x < w - radius; x++) {
      let maxV = 0
      for (let dy = -radius; dy <= radius && maxV === 0; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (edges[(y + dy) * w + (x + dx)]) {
            maxV = 255
            break
          }
        }
      }
      out[y * w + x] = maxV
    }
  }
  return out
}

export function detectSkewAngle(
  gray: Uint8Array,
  w: number,
  h: number,
): { angleDeg: number; confidence: 'high' | 'low' | 'none' } {
  const mag = sobelMagnitude(gray, w, h)
  const edges = thresholdEdges(mag, 30)
  const edgeCount = edges.reduce((s, v) => s + (v ? 1 : 0), 0)
  if (edgeCount < 50) return { angleDeg: 0, confidence: 'none' }

  const thetas: number[] = []
  for (let t = -15; t <= 15; t += 0.5) thetas.push(t * DEG2RAD)
  for (let t = 75; t <= 105; t += 0.5) thetas.push(t * DEG2RAD)
  const d = Math.ceil(Math.hypot(w, h))
  const rhoOffset = d
  const accum = new Int32Array(thetas.length * (2 * d + 1))

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue
      for (let i = 0; i < thetas.length; i++) {
        const rho = Math.round(x * Math.cos(thetas[i]) + y * Math.sin(thetas[i])) + rhoOffset
        accum[i * (2 * d + 1) + rho]++
      }
    }
  }

  let bestVotes = 0
  let bestIndex = 0
  for (let i = 0; i < thetas.length; i++) {
    for (let r = 0; r <= 2 * d; r++) {
      const v = accum[i * (2 * d + 1) + r]
      if (v > bestVotes) {
        bestVotes = v
        bestIndex = i
      }
    }
  }

  // Minimum votes: at least one vote per ~50 edge pixels on the dominant angle.
  const minVotes = Math.max(5, Math.floor(edgeCount / 50))
  if (bestVotes < minVotes) return { angleDeg: 0, confidence: 'none' }

  let angle = thetas[bestIndex] / DEG2RAD
  if (angle > 45) angle -= 90
  // Keep tiny accidental corrections as 0 with no confidence change.
  if (Math.abs(angle) < 0.25) angle = 0

  // High confidence when the dominant line is clearly strongest.
  const confidence: 'high' | 'low' = bestVotes >= minVotes * 4 ? 'high' : 'low'
  return { angleDeg: angle, confidence }
}

/**
 * Fallback: use a brightness threshold to find a bright page on a dark
 * background (e.g., white paper on pavement). Returns null if no dominant
 * bright region is found.
 */
function findBrightPageBoundary(
  gray: Uint8Array,
  w: number,
  h: number,
  scale: number,
): { corners: Quad | null; confidence: 'high' | 'low' | 'none' } {
  const meanLum = gray.reduce((s, v) => s + v, 0) / gray.length
  // Paper should be substantially brighter than the background.
  const threshold = Math.min(230, Math.max(150, meanLum + 40))
  const visited = new Uint8Array(w * h)
  const components: Point[][] = []
  const queue: [number, number][] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (gray[idx] < threshold || visited[idx]) continue
      visited[idx] = 1
      queue.length = 0
      queue.push([x, y])
      const comp: Point[] = []
      while (queue.length) {
        const [cx, cy] = queue.pop()!
        comp.push({ x: cx, y: cy })
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            const nidx = ny * w + nx
            if (gray[nidx] < threshold || visited[nidx]) continue
            visited[nidx] = 1
            queue.push([nx, ny])
          }
        }
      }
      if (comp.length >= 200) components.push(comp)
    }
  }

  if (!components.length) return { corners: null, confidence: 'none' }

  const componentsByArea = components
    .map((c) => ({ comp: c, area: c.length }))
    .sort((a, b) => b.area - a.area)

  const borderThreshold = Math.max(8, Math.min(w, h) * 0.03)
  const imageArea = w * h

  for (const { comp } of componentsByArea) {
    const hull = convexHull(comp)
    if (hull.length < 4) continue
    const epsilon = Math.max(5, Math.hypot(w, h) / 120)
    const simplified = simplifyPolygon(hull, epsilon)
    const corners = simplified.length === 4 ? simplified : bestQuadrilateral(hull)
    const area = polygonArea(corners)
    const pageAreaRatio = area / imageArea
    if (pageAreaRatio < 0.15) continue

    const touchesBorder = corners.some(
      (p) =>
        p.x < borderThreshold ||
        p.y < borderThreshold ||
        p.x > w - borderThreshold ||
        p.y > h - borderThreshold,
    )
    if (touchesBorder) continue

    const fullCorners = orderQuad(
      corners.map((p) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) })),
    )
    return { corners: fullCorners, confidence: 'high' }
  }

  return { corners: null, confidence: 'none' }
}

/**
 * Find the largest roughly-quadrilateral page boundary in a grayscale image.
 * Returns corners in full-size coordinates.
 */
export function findDocumentBoundary(
  gray: Uint8Array,
  w: number,
  h: number,
  scale: number,
): { corners: Quad | null; confidence: 'high' | 'low' | 'none' } {
  const mag = sobelMagnitude(gray, w, h)
  let edges = thresholdEdges(mag, 10)
  edges = dilate(edges, w, h, 1)

  const visited = new Uint8Array(w * h)
  const components: Point[][] = []
  const queue: [number, number][] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!edges[idx] || visited[idx]) continue
      visited[idx] = 1
      queue.length = 0
      queue.push([x, y])
      const comp: Point[] = []
      while (queue.length) {
        const [cx, cy] = queue.pop()!
        comp.push({ x: cx, y: cy })
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            const nidx = ny * w + nx
            if (!edges[nidx] || visited[nidx]) continue
            visited[nidx] = 1
            queue.push([nx, ny])
          }
        }
      }
      if (comp.length >= 100) components.push(comp)
    }
  }

  if (!components.length) return { corners: null, confidence: 'none' }

  const componentsByArea = components
    .map((c, i) => ({ comp: c, area: c.length, i }))
    .sort((a, b) => b.area - a.area)

  const borderThreshold = Math.max(3, Math.min(w, h) * 0.02)
  const imageArea = w * h

  let chosenCorners: Point[] | null = null

  for (const { comp } of componentsByArea) {
    const hull = convexHull(comp)
    if (hull.length < 4) continue

    const epsilon = Math.max(3, Math.hypot(w, h) / 120)
    const simplified = simplifyPolygon(hull, epsilon)
    const corners = simplified.length === 4 ? simplified : bestQuadrilateral(hull)
    const area = polygonArea(corners)
    const pageAreaRatio = area / imageArea
    if (pageAreaRatio < 0.08) continue

    const touchesBorder = corners.some(
      (p) =>
        p.x < borderThreshold ||
        p.y < borderThreshold ||
        p.x > w - borderThreshold ||
        p.y > h - borderThreshold,
    )

    if (touchesBorder) {
      // Frame edge of the photo itself, not the document.
      continue
    }

    chosenCorners = corners
    break
  }

  if (chosenCorners == null) {
    // Edge detection may miss the page when it is surrounded by a high-contrast
    // background; fall back to brightness-based page segmentation.
    return findBrightPageBoundary(gray, w, h, scale)
  }

  const fullCorners = orderQuad(
    chosenCorners.map((p) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) })),
  )

  // Aspect sanity check.
  const { topLeft, topRight, bottomRight, bottomLeft } = fullCorners
  const topW = dist(topLeft, topRight)
  const bottomW = dist(bottomRight, bottomLeft)
  const leftH = dist(topLeft, bottomLeft)
  const rightH = dist(topRight, bottomRight)
  const aspect = (Math.max(topW, bottomW) + 1) / (Math.max(leftH, rightH) + 1)
  if (aspect < 1 / 4 || aspect > 4) {
    return { corners: null, confidence: 'none' }
  }

  const edgeRatio =
    Math.min(topW, bottomW) / Math.max(topW, bottomW) +
    Math.min(leftH, rightH) / Math.max(leftH, rightH)
  const confidence: 'high' | 'low' = edgeRatio > 1.4 ? 'high' : 'low'
  return { corners: fullCorners, confidence }
}

function bestQuadrilateral(hull: Point[]): Point[] {
  let best: Point[] = []
  let bestArea = 0
  const n = hull.length
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const area = polygonArea([hull[a], hull[b], hull[c], hull[d]])
          if (area > bestArea) {
            bestArea = area
            best = [hull[a], hull[b], hull[c], hull[d]]
          }
        }
      }
    }
  }
  return best.length ? best : hull
}

/**
 * Solve the 8-DOF perspective homography from the destination rectangle
 * (output pixels) to the source quad, then inverse-map every output pixel.
 */
export function warpPerspective(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  quad: Quad,
  dstW: number,
  dstH: number,
): Uint8Array {
  // Destination corners are the output rectangle.
  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 },
  ]
  const srcPts = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
  const H = solveHomography(dstPts, srcPts)

  const dst = new Uint8Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const denom = H[6] * x + H[7] * y + 1
      const sx = (H[0] * x + H[1] * y + H[2]) / denom
      const sy = (H[3] * x + H[4] * y + H[5]) / denom
      dst[y * dstW + x] = sampleGray(src, srcW, srcH, sx, sy)
    }
  }
  return dst
}

function solveHomography(src: Point[], dst: Point[]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const s = src[i]
    const d = dst[i]
    A.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x])
    A.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y])
    b.push(d.x, d.y)
  }
  return solveLinear(A, b).concat([1])
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length
  const M: number[][] = A.map((row, i) => row.concat(b[i]))
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      // Singular system; return identity-like fallback.
      return Array(n).fill(0)
    }
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    const div = M[col][col]
    for (let j = col; j <= n; j++) M[col][j] /= div
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = M[row][col]
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j]
    }
  }
  return M.map((row) => row[n])
}

function sampleGray(src: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1 || Number.isNaN(x) || Number.isNaN(y)) {
    return 255
  }
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const fx = x - x0
  const fy = y - y0
  const i00 = y0 * w + x0
  const i01 = y0 * w + x1
  const i10 = y1 * w + x0
  const i11 = y1 * w + x1
  return Math.round(
    src[i00] * (1 - fx) * (1 - fy) +
      src[i01] * fx * (1 - fy) +
      src[i10] * (1 - fx) * fy +
      src[i11] * fx * fy,
  )
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
export function rotateBilinear(
  src: Uint8Array,
  w: number,
  h: number,
  angleDeg: number,
): { data: Uint8Array; width: number; height: number } {
  const rad = -angleDeg * DEG2RAD
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  // Compute output bounding box.
  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => ({ x: c * p.x - s * p.y, y: s * p.x + c * p.y }))
  const minX = Math.min(...corners.map((p) => p.x))
  const maxX = Math.max(...corners.map((p) => p.x))
  const minY = Math.min(...corners.map((p) => p.y))
  const maxY = Math.max(...corners.map((p) => p.y))
  const outW = Math.ceil(maxX - minX)
  const outH = Math.ceil(maxY - minY)
  const tx = -minX
  const ty = -minY
  const invC = c
  const invS = -s // inverse of [c,-s;s,c] is [c,s;-s,c]
  const out = new Uint8Array(outW * outH)
  out.fill(255)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = invC * (x - tx) + invS * (y - ty)
      const sy = -s * (x - tx) + c * (y - ty)
      out[y * outW + x] = sampleGray(src, w, h, sx, sy)
    }
  }
  return { data: out, width: outW, height: outH }
}

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
