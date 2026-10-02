/**
 * Cleaning a photographed page.
 *
 * The first version divided by a local average taken over a twenty-fourth of the short
 * edge — narrower than a paragraph of small print. Inside a dense block the "background"
 * was the text itself, so the ratio came out near 1 and the whole paragraph was flattened
 * to white. Cleaned PODs came out harder to read than the photographs they came from,
 * which is the one thing this step must never do.
 *
 * These test the properties that matter on a real page, not the arithmetic: shading goes,
 * ink stays dark, paper goes white, and dense text survives.
 */
import { describe, it, expect } from 'vitest'
import { Jimp } from 'jimp'
import { applyIlluminationCleanup, type JimpImage } from './geometry'

/** The structural slice the cleanup actually uses — see JimpImage in geometry.ts. */
type Img = JimpImage & { bitmap: { width: number; height: number; data: Uint8Array } }

function make(width: number, height: number, paint: (x: number, y: number) => number): Img {
  const img = new Jimp({ width, height, color: 0xffffffff }) as unknown as Img
  const { data } = img.bitmap
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(paint(x, y))))
      const p = (y * width + x) * 4
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
    }
  }
  return img
}

function grayAt(img: Img, x: number, y: number): number {
  return img.bitmap.data[(y * img.bitmap.width + x) * 4]
}

/** Mean brightness of a rectangle, for talking about regions rather than pixels. */
function meanOf(img: Img, x0: number, y0: number, w: number, h: number): number {
  let total = 0
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) total += grayAt(img, x, y)
  return total / (w * h)
}

const SIZE = 480

describe('applyIlluminationCleanup', () => {
  it('flattens a lighting gradient so one side of the page is not darker than the other', () => {
    // A dock photo: one half in shadow, nearly three times brighter at the lit edge.
    // Both halves are the same paper and must end up reading as the same paper.
    const shade = (x: number) => 90 + (x / SIZE) * 150
    const before = make(SIZE, SIZE, shade)
    const beforeGap = Math.abs(
      meanOf(before, 20, 20, 80, 440) - meanOf(before, SIZE - 100, 20, 80, 440),
    )

    const img = make(SIZE, SIZE, shade)
    applyIlluminationCleanup(img)
    const afterGap = Math.abs(
      meanOf(img, 20, 20, 80, 440) - meanOf(img, SIZE - 100, 20, 80, 440),
    )

    // Measured against the shading that was there, not an absolute figure: the averaging
    // window clamps at the frame edge, so a little always survives at the extreme margins.
    expect(afterGap).toBeLessThan(beforeGap * 0.2)
  })

  it('takes paper to white rather than leaving it grey', () => {
    const img = make(SIZE, SIZE, (x) => 120 + (x / SIZE) * 60)
    applyIlluminationCleanup(img)
    expect(meanOf(img, 40, 40, 400, 400)).toBeGreaterThan(240)
  })

  it('keeps a dense block of small print dark, instead of washing it out', () => {
    // The regression this version exists for. Thin dark lines packed two pixels apart
    // over a quarter of the page — narrower than any sensible lighting variation, and
    // exactly what a paragraph of 6pt print looks like to the algorithm.
    const img = make(SIZE, SIZE, (x, y) => {
      const inBlock = y > 160 && y < 280 && x > 60 && x < 420
      if (inBlock && y % 3 === 0) return 40
      return 200
    })
    applyIlluminationCleanup(img)

    let darkest = 255
    for (let y = 162; y < 278; y += 3) darkest = Math.min(darkest, meanOf(img, 100, y, 200, 1))
    // The ink rows must still read as ink.
    expect(darkest).toBeLessThan(110)
    // And the paper around the block must still read as paper.
    expect(meanOf(img, 100, 40, 200, 60)).toBeGreaterThan(230)
  })

  it('keeps reversed-out text inside a dark header band', () => {
    // A carrier's logo bar: white type on black. Over-stretching turns the whole band
    // solid and loses the words in it.
    const img = make(SIZE, SIZE, (x, y) => {
      const inBand = y > 40 && y < 90
      if (!inBand) return 210
      return x % 12 < 4 ? 235 : 20
    })
    applyIlluminationCleanup(img)
    const type = meanOf(img, 0, 50, 4, 30)
    const band = meanOf(img, 6, 50, 4, 30)
    expect(type - band).toBeGreaterThan(40)
  })

  it('keeps a shadowed margin readable instead of crushing it to black', () => {
    /*
     * A page held in someone's hand against a dark seat: the left strip is both shaded and
     * next to something much darker than paper. Estimating the background as a local MEAN
     * mixed the two, so the shaded margin divided to almost nothing and went solid black —
     * on a real bill of lading (14515) that swallowed the SHIP FROM and SHIP TO addresses
     * entirely. A percentile sits above the dark surround, so neither moves it.
     */
    const img = make(SIZE, SIZE, (x, y) => {
      if (x < 60) return 18                       // the hand and the seat behind the page
      const paper = x < 180 ? 95 : 215            // the page, its left third in shadow
      const inShadowedText = x > 80 && x < 170 && y % 8 < 2
      return inShadowedText ? paper * 0.35 : paper
    })
    applyIlluminationCleanup(img)

    // The shaded paper must still read as paper...
    expect(meanOf(img, 90, 2, 70, 4)).toBeGreaterThan(200)
    // ...and the text on it must still read as text, not as part of one black block.
    const textRows = [8, 16, 24, 32].map((y) => meanOf(img, 90, y, 70, 2))
    for (const row of textRows) expect(row).toBeLessThan(140)
  })

  it('does not turn a nearly blank page black', () => {
    // With almost no ink, the darkest five per cent of the page is still paper. The
    // clamp is what stops the stretch from treating it as ink.
    const img = make(SIZE, SIZE, () => 205)
    applyIlluminationCleanup(img)
    expect(meanOf(img, 40, 40, 400, 400)).toBeGreaterThan(240)
  })

  it('writes an opaque greyscale image, which is what a POD is', () => {
    const img = make(64, 64, (x) => 100 + x)
    applyIlluminationCleanup(img)
    const p = (10 * 64 + 10) * 4
    const { data } = img.bitmap
    expect(data[p]).toBe(data[p + 1])
    expect(data[p + 1]).toBe(data[p + 2])
    expect(data[p + 3]).toBe(255)
  })

  it('survives a degenerate image rather than throwing inside the Lambda', () => {
    const tiny = new Jimp({ width: 1, height: 1, color: 0x808080ff }) as unknown as Img
    expect(() => applyIlluminationCleanup(tiny)).not.toThrow()
  })
})
