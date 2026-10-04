/**
 * The scorer has to stay QUIET on a good page and specific on a bad one. These build the
 * four pages that actually come in off a phone and assert which bucket each lands in.
 */
import { describe, it, expect } from 'vitest'
import { scoreLegibility, laplacianVariance, inkFraction } from './legibility'

const W = 1200
const H = 1600

/** A readable POD: white paper with crisp black text-like marks across it. */
function goodPage(w = W, h = H): Uint8Array {
  const g = new Uint8Array(w * h).fill(248)
  // Rows of hard-edged glyph blocks — high local contrast, a few percent coverage.
  for (let line = 0; line < 40; line += 1) {
    const y0 = 40 + line * 38
    for (let x = 60; x < w - 60; x += 14) {
      for (let dy = 0; dy < 12; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const y = y0 + dy
          if (y < h) g[y * w + x + dx] = 12
        }
      }
    }
  }
  return g
}

/** The same page photographed while moving: every edge smeared. */
function blurred(src: Uint8Array, w = W, h = H, passes = 14): Uint8Array {
  let cur = Uint8Array.from(src)
  for (let p = 0; p < passes; p += 1) {
    const next = Uint8Array.from(cur)
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x
        next[i] = (cur[i - 1] + cur[i + 1] + cur[i - w] + cur[i + w] + cur[i]) / 5
      }
    }
    cur = next
  }
  return cur
}

describe('scoreLegibility', () => {
  it('passes a well-shot page without complaining', async () => {
    const r = scoreLegibility(goodPage(), W, H)
    expect(r.legibility).toBe('OK')
    expect(r.score).toBeGreaterThanOrEqual(60)
    // Silence is the point: a note here would train drivers to ignore the warning.
    expect(r.notes).toBe('')
  })

  it('catches a photo taken on the move and says to hold still', () => {
    const r = scoreLegibility(blurred(goodPage()), W, H)
    expect(r.legibility).not.toBe('OK')
    expect(r.detail.focus).toBeLessThan(50)
    expect(r.notes).toMatch(/blurry/)
  })

  it('catches a blank or blown-out page', () => {
    // Paper, nothing on it — the "I photographed the back" case.
    const r = scoreLegibility(new Uint8Array(W * H).fill(250), W, H)
    expect(r.legibility).toBe('UNREADABLE')
    expect(r.notes).toMatch(/blank or washed out/)
  })

  it('catches a page lost in shadow or under a thumb', () => {
    const g = new Uint8Array(W * H).fill(250)
    // Most of the frame dark: that is not writing.
    for (let i = 0; i < g.length * 0.7; i += 1) g[i] = 20
    const r = scoreLegibility(g, W, H)
    expect(r.legibility).not.toBe('OK')
    expect(r.notes).toMatch(/covering the page|shadow/)
  })

  it('catches a page shot from too far away even when it is sharp', () => {
    // Same crisp content, far too few pixels to resolve a signature.
    const w = 400
    const h = 520
    const r = scoreLegibility(goodPage(w, h), w, h)
    expect(r.detail.resolution).toBeLessThan(50)
    expect(r.notes).toMatch(/get closer/i)
  })

  it('reports UNKNOWN rather than guessing when the buffer does not match', () => {
    const r = scoreLegibility(new Uint8Array(10), W, H)
    expect(r.legibility).toBe('UNKNOWN')
    expect(r.notes).toBe('')
  })

  it('scores a page by its worst axis, not its average', () => {
    // Sharp and well-filled, but tiny: the score must follow the resolution, because a
    // page you cannot resolve is unreadable however good the focus is.
    const w = 420
    const h = 560
    const r = scoreLegibility(goodPage(w, h), w, h)
    expect(r.score).toBe(Math.min(r.detail.focus, r.detail.ink, r.detail.resolution))
  })
})

describe('the measures themselves', () => {
  it('laplacianVariance collapses as an image is blurred', () => {
    const sharp = laplacianVariance(goodPage(), W, H)
    const soft = laplacianVariance(blurred(goodPage()), W, H)
    expect(sharp).toBeGreaterThan(soft * 5)
  })

  it('inkFraction measures against the page’s own paper level, not pure white', () => {
    // A grey scan: paper at 200, ink at 10. A fixed white threshold would read this as
    // almost entirely ink; the percentile must see it as a normal page.
    const g = new Uint8Array(W * H).fill(200)
    for (let i = 0; i < g.length * 0.05; i += 1) g[i] = 10
    const f = inkFraction(g)
    expect(f).toBeGreaterThan(0.03)
    expect(f).toBeLessThan(0.08)
  })

  it('inkFraction of blank paper is effectively zero', () => {
    expect(inkFraction(new Uint8Array(1000).fill(255))).toBe(0)
  })
})
