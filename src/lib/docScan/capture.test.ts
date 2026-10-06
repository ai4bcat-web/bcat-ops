/**
 * The scanner runs on the phone, before the upload, because every problem it catches is
 * fixable in the two seconds the driver is still standing in front of the document — and
 * none of them is fixable afterwards.
 */
import { describe, it, expect } from 'vitest'
import {
  toGray, detectPage, scaleQuad, outputSize, assessReadability,
  enhanceForReading, downscale, scanFrame, type GrayFrame,
} from './capture'

/** A dark frame with a light rectangle in it — a page on a truck seat. */
function pageOnDarkBackground(
  w = 400, h = 300,
  rect = { x: 60, y: 45, w: 280, h: 210 },
  paper = 230, bg = 30,
): GrayFrame {
  const data = new Uint8Array(w * h).fill(bg)
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) data[y * w + x] = paper
  }
  // A little ink so the page is not a flat block.
  for (let y = rect.y + 30; y < rect.y + 40; y++) {
    for (let x = rect.x + 20; x < rect.x + 200; x++) data[y * w + x] = 20
  }
  return { data, width: w, height: h }
}

const flat = (v: number, w = 120, h = 90): GrayFrame =>
  ({ data: new Uint8Array(w * h).fill(v), width: w, height: h })

describe('toGray', () => {
  it('weights the channels the way the server does, so both see the same page', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    const g = toGray(rgba, 2, 1)
    expect(g.data[0]).toBe(0)
    expect(g.data[1]).toBe(255)
  })

  it('keeps the frame size', () => {
    const g = toGray(new Uint8ClampedArray(4 * 6 * 4), 4, 6)
    expect([g.width, g.height]).toEqual([4, 6])
  })
})

describe('detectPage', () => {
  it('finds a page lying on a dark surface', () => {
    const found = detectPage(pageOnDarkBackground())
    expect(found).not.toBeNull()
    // Corners land on the rectangle, within the tolerance edge detection works to.
    expect(found!.quad.topLeft.x).toBeGreaterThan(40)
    expect(found!.quad.topLeft.x).toBeLessThan(85)
    expect(found!.quad.bottomRight.y).toBeGreaterThan(230)
  })

  it('returns null rather than guessing at an empty frame', () => {
    // A wrong outline is worse than none: it tells the driver the app has the page while
    // it is about to crop the signature off.
    expect(detectPage(flat(128, 300, 300))).toBeNull()
  })
})

describe('outputSize', () => {
  it('keeps the page proportions rather than forcing a shape', () => {
    const size = outputSize({
      topLeft: { x: 0, y: 0 }, topRight: { x: 300, y: 0 },
      bottomRight: { x: 300, y: 600 }, bottomLeft: { x: 0, y: 600 },
    })
    expect(size.width / size.height).toBeCloseTo(0.5, 1)
  })

  it('caps the long edge so a 12MP phone shot is not uploaded whole', () => {
    const size = outputSize({
      topLeft: { x: 0, y: 0 }, topRight: { x: 8000, y: 0 },
      bottomRight: { x: 8000, y: 6000 }, bottomLeft: { x: 0, y: 6000 },
    })
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2000)
  })

  it('never returns a zero dimension, whatever degenerate quad it is handed', () => {
    const size = outputSize({
      topLeft: { x: 5, y: 5 }, topRight: { x: 5, y: 5 },
      bottomRight: { x: 5, y: 5 }, bottomLeft: { x: 5, y: 5 },
    })
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  })
})

describe('scaleQuad', () => {
  it('moves a quad from detection coordinates to full resolution', () => {
    const q = scaleQuad({
      topLeft: { x: 1, y: 2 }, topRight: { x: 3, y: 2 },
      bottomRight: { x: 3, y: 4 }, bottomLeft: { x: 1, y: 4 },
    }, 4)
    expect(q.topLeft).toEqual({ x: 4, y: 8 })
    expect(q.bottomRight).toEqual({ x: 12, y: 16 })
  })
})

describe('assessReadability', () => {
  it('names a dark shot and says what to do about it', () => {
    const r = assessReadability(flat(10))
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/dark/i)
  })

  it('names a blown-out shot', () => {
    expect(assessReadability(flat(250)).problem).toMatch(/washed out/i)
  })

  it('names a flat shot', () => {
    expect(assessReadability(flat(128)).problem).toMatch(/flat/i)
  })

  it('catches a blurry page that is otherwise well exposed', () => {
    // Bright, good range, no edges anywhere — exactly what a smeared photo looks like.
    const w = 200, h = 200
    const data = new Uint8Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = 40 + Math.floor((i / data.length) * 180)
    expect(assessReadability({ data, width: w, height: h }).problem).toMatch(/blurry/i)
  })

  it('passes a real page with ink on it', () => {
    const r = assessReadability(pageOnDarkBackground())
    expect(r.ok).toBe(true)
    expect(r.problem).toBeNull()
  })

  it('reports the measurements, not only the verdict', () => {
    const r = assessReadability(pageOnDarkBackground())
    expect(r.sharpness).toBeGreaterThan(0)
    expect(r.brightness).toBeGreaterThan(0)
    expect(r.contrast).toBeGreaterThan(0)
  })
})

describe('enhanceForReading', () => {
  it('pushes paper to white and ink to black', () => {
    const before = pageOnDarkBackground(200, 150, { x: 20, y: 15, w: 160, h: 120 }, 180, 90)
    const after = enhanceForReading(before)
    const max = Math.max(...after.data)
    const min = Math.min(...after.data)
    expect(max).toBe(255)
    expect(min).toBe(0)
  })

  it('is not thrown off by one blown pixel', () => {
    // Percentiles, not min/max: a single speck must not flatten the whole page.
    const f = pageOnDarkBackground(200, 150, { x: 20, y: 15, w: 160, h: 120 }, 170, 80)
    f.data[0] = 255
    const after = enhanceForReading(f)
    const bright = [...after.data].filter((v) => v > 200).length
    expect(bright).toBeGreaterThan(1000)
  })

  it('keeps the frame size', () => {
    const after = enhanceForReading(flat(100, 32, 24))
    expect([after.width, after.height]).toEqual([32, 24])
  })
})

describe('downscale', () => {
  it('resizes without reading outside the source', () => {
    const small = downscale(pageOnDarkBackground(400, 300), 40, 30)
    expect([small.width, small.height]).toEqual([40, 30])
    expect(small.data.length).toBe(40 * 30)
  })
})

describe('scanFrame — the whole thing', () => {
  it('finds, flattens and cleans a page in one pass', () => {
    const out = scanFrame(pageOnDarkBackground(800, 600, { x: 120, y: 90, w: 560, h: 420 }))
    expect(out).not.toBeNull()
    expect(out!.gray.width).toBeGreaterThan(100)
    // Cropped to the page: the dark surround is gone.
    expect(out!.gray.width).toBeLessThan(800)
  })

  it('returns null on a frame with no page in it, rather than cropping to noise', () => {
    expect(scanFrame(flat(128, 400, 400))).toBeNull()
  })
})
