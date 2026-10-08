/**
 * The scene that broke the edge detector: a white BOL on a yellow clipboard, in a truck,
 * with a shadow across its bottom. The outline must land on the paper — not the
 * clipboard, not the shadow line.
 */
import { describe, it, expect } from 'vitest'
import { findPaperQuad, paperMask } from './paperMask'
import { detectPageColor, scanFrameColor } from './capture'

type RGB = [number, number, number]
const BG: RGB = [28, 24, 22]          // dark cab
const CLIPBOARD: RGB = [236, 196, 32] // yellow
const PAPER: RGB = [238, 236, 232]
const INK: RGB = [20, 20, 20]

interface Rect { x: number; y: number; w: number; h: number }

function scene(w: number, h: number, paint: (x: number, y: number) => RGB): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = paint(x, y)
    const i = (y * w + x) * 4
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255
  }
  return out
}
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

/** Page on a clipboard on a dark seat, text lines on the page, a shadow over the lower third. */
function clipboardScene(w = 320, h = 420) {
  const board: Rect = { x: 40, y: 60, w: 240, h: 330 }
  const page: Rect = { x: 62, y: 82, w: 196, h: 270 }
  const rgba = scene(w, h, (x, y) => {
    let c: RGB = BG
    if (inside({ x, y }, board)) c = CLIPBOARD
    if (inside({ x, y }, page)) {
      c = PAPER
      // Lines of text, and a logo block.
      if (y > page.y + 30 && y < page.y + 220 && (y - page.y) % 14 < 4 && x > page.x + 12 && x < page.x + page.w - 12) c = INK
    }
    // A shadow across the bottom, falling on page, clipboard and seat alike.
    if (y > x * 0.4 + 240) c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55]
    return c
  })
  return { rgba, w, h, page }
}

const near = (p: { x: number; y: number }, x: number, y: number, tol = 5) =>
  Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol

describe('paperMask', () => {
  it('keeps the paper and drops the clipboard, in sun and in shadow', () => {
    const { rgba, w, h, page } = clipboardScene()
    const m = paperMask(rgba, w, h)
    expect(m[(page.y + 5) * w + page.x + 5]).toBe(1)        // lit paper
    expect(m[(page.y + page.h - 5) * w + page.x + 5]).toBe(1) // shadowed paper
    expect(m[(page.y + 5) * w + page.x - 10]).toBe(0)       // clipboard
    expect(m[10 * w + 10]).toBe(0)                          // seat
  })
})

describe('findPaperQuad', () => {
  it('outlines the page, not the clipboard it is clipped to, and ignores the shadow line', () => {
    const { rgba, w, h, page } = clipboardScene()
    const found = findPaperQuad(rgba, w, h)
    expect(found).not.toBeNull()
    const q = found!.quad
    expect(near(q.topLeft, page.x, page.y)).toBe(true)
    expect(near(q.topRight, page.x + page.w - 1, page.y)).toBe(true)
    expect(near(q.bottomLeft, page.x, page.y + page.h - 1)).toBe(true)
    expect(near(q.bottomRight, page.x + page.w - 1, page.y + page.h - 1)).toBe(true)
    expect(found!.confidence).toBe('high')
  })

  it('keeps a folded page whole — the crease must not split it into the bigger half', () => {
    const page: Rect = { x: 40, y: 30, w: 240, h: 340 }
    const rgba = scene(320, 400, (x, y) => {
      if (!inside({ x, y }, page)) return BG
      // A sharp fold across the middle: a dark band 6px wide, as a crease photographs up close.
      const mid = page.y + page.h / 2
      if (Math.abs(y - mid) <= 3) return [70, 68, 66]
      return PAPER
    })
    const found = findPaperQuad(rgba, 320, 400)
    expect(found).not.toBeNull()
    const q = found!.quad
    expect(near(q.topLeft, page.x, page.y)).toBe(true)
    expect(near(q.bottomRight, page.x + page.w - 1, page.y + page.h - 1)).toBe(true)
  })

  it('finds a page straight on a dark seat too', () => {
    const page: Rect = { x: 50, y: 40, w: 220, h: 300 }
    const rgba = scene(320, 400, (x, y) => (inside({ x, y }, page) ? PAPER : BG))
    const q = findPaperQuad(rgba, 320, 400)!.quad
    expect(near(q.topLeft, page.x, page.y)).toBe(true)
    expect(near(q.bottomRight, page.x + page.w - 1, page.y + page.h - 1)).toBe(true)
  })

  it('gives up on a page that runs out of the frame rather than cropping it short', () => {
    const page: Rect = { x: 50, y: -40, w: 220, h: 300 }
    const rgba = scene(320, 400, (x, y) => (inside({ x, y }, page) ? PAPER : BG))
    expect(findPaperQuad(rgba, 320, 400)).toBeNull()
  })

  it('cannot tell a white page from a white desk, and says so', () => {
    const rgba = scene(320, 400, () => PAPER)
    expect(findPaperQuad(rgba, 320, 400)).toBeNull()
  })

  it('is not fooled by a bright coloured thing the size of a page', () => {
    const board: Rect = { x: 40, y: 60, w: 240, h: 330 }
    const rgba = scene(320, 420, (x, y) => (inside({ x, y }, board) ? CLIPBOARD : BG))
    expect(findPaperQuad(rgba, 320, 420)).toBeNull()
  })
})

describe('the colour path end to end', () => {
  it('detectPageColor prefers the paper and falls back to edges on a white desk', () => {
    const { rgba, w, h, page } = clipboardScene()
    const found = detectPageColor({ data: rgba, width: w, height: h })!
    expect(near(found.quad.topLeft, page.x, page.y)).toBe(true)
    // All white: no colour boundary, no edges — nothing, rather than a guess.
    const blank = scene(160, 200, () => PAPER)
    expect(detectPageColor({ data: blank, width: 160, height: 200 })).toBeNull()
  })

  it('scanFrameColor flattens the page it found, at the page’s own proportions', () => {
    const { rgba, w, h, page } = clipboardScene()
    const out = scanFrameColor({ data: rgba, width: w, height: h })!
    expect(out).not.toBeNull()
    const ratio = out.gray.width / out.gray.height
    expect(ratio).toBeGreaterThan((page.w / page.h) * 0.9)
    expect(ratio).toBeLessThan((page.w / page.h) * 1.1)
  })
})
