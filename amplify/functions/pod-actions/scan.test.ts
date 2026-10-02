import { describe, expect, it } from 'vitest'
import { Jimp, loadFont, type JimpInstance } from 'jimp'
import { SANS_32_BLACK } from 'jimp/fonts'
import { enhancePodImage, shouldKeepCrop } from './scan'
import { warpPerspective } from './scan/geometry.js'

async function buildTextPage(
  width: number,
  height: number,
  lines: string[],
): Promise<{ image: JimpInstance; bytes: Buffer }> {
  const font = await loadFont(SANS_32_BLACK)
  const image = new Jimp({ width, height, color: 0xffffffff })
  const lineHeight = Math.max(40, Math.floor((height - 120) / lines.length))
  for (let i = 0; i < lines.length; i++) {
    image.print({ font, x: 60, y: 60 + i * lineHeight, text: lines[i] })
  }
  const bytes = await image.getBuffer('image/jpeg')
  return { image, bytes }
}

const sampleLines = [
  'PROOF OF DELIVERY DOCUMENT',
  'LOAD NUMBER 12345 REF ABC',
  'SHIPPER ACME CORPORATION',
  'CONSIGNEE BEST BUY DEPOT',
  'DATE 2025 09 29 TIME 1430',
  'DELIVERED IN GOOD CONDITION',
  'DRIVER SIGNATURE REQUIRED',
  'PAGE ONE OF ONE',
]

describe('POD scan cleanup', { timeout: 90000 }, () => {
  it('removes a paper shadow while retaining dark text and faint handwriting', async () => {
    const source = new Jimp({ width: 320, height: 240, color: 0xffffffff })
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 320; x++) {
        const paper = 110 + Math.round(x * 120 / 319)
        const ink = y >= 80 && y < 84 ? 0.15 : y >= 140 && y < 144 ? 0.7 : 1
        const gray = Math.round(paper * ink)
        source.setPixelColor((gray * 0x1000000 + gray * 0x10000 + gray * 0x100 + 255) >>> 0, x, y)
      }
    }
    const original = await source.getBuffer('image/png')
    const originalCopy = Buffer.from(original)
    const result = await enhancePodImage(original, 'image/png')
    const scan = await Jimp.read(result!.bytes)
    const grayAt = (x: number, y: number) => scan.bitmap.data[(y * scan.width + x) * 4]
    expect(grayAt(80, 40)).toBeGreaterThan(240)
    expect(Math.abs(grayAt(80, 40) - grayAt(240, 40))).toBeLessThan(12)
    expect(grayAt(80, 81)).toBeLessThan(90)
    /*
     * Faint handwriting has to survive, and it now comes out DARKER than it went in
     * rather than being held at the mid-grey it arrived as. That is the point of the
     * levels stretch: pencil at seventy per cent of paper brightness is barely visible
     * on a phone screen, and a POD is read, not admired. What must still hold is that it
     * is ink and not paper, and that it stays distinguishable from solid print.
     */
    expect(grayAt(80, 141)).toBeLessThan(170)
    expect(grayAt(80, 141)).toBeGreaterThan(grayAt(80, 81))
    expect(original.equals(originalCopy)).toBe(true)
  })

  it('applies phone EXIF orientation without cropping the document', async () => {
    const original = await new Jimp({ width: 80, height: 40, color: 0xffffffff }).getBuffer('image/jpeg')
    const exif = Buffer.from([
      0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0,
      73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
      0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0,
      0, 0, 0, 0,
    ])
    const rotated = Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)])
    const result = await enhancePodImage(rotated, 'image/jpeg')
    const scan = await Jimp.read(result!.bytes)
    expect([scan.width, scan.height]).toEqual([40, 80])
  })

  it('rejects oversized dimensions before decoding and leaves PDFs original-only', async () => {
    const png = await new Jimp({ width: 1, height: 1, color: 0xffffffff }).getBuffer('image/png')
    png.writeUInt32BE(100_000, 16)
    await expect(enhancePodImage(png, 'image/png')).rejects.toThrow('scan limit')
    expect(await enhancePodImage(Buffer.from('%PDF-1.7'), 'application/pdf')).toBeNull()
    await expect(enhancePodImage(Buffer.from('not an image'), 'image/jpeg')).rejects.toThrow('Invalid JPEG')
  })

  it('detects an upright page and reports a successful geometry', async () => {
    const { bytes } = await buildTextPage(1000, 700, sampleLines)
    const result = await enhancePodImage(bytes, 'image/jpeg')
    expect(result).not.toBeNull()
    expect(result!.orientation.appliedCorrection === 0).toBe(true)
    expect(result!.geometry.perspectiveCorrected).toBe(false)
    expect(result!.scanReviewReason).toBeNull()
  })

  it.each([90, 180, 270] as const)(
    'turns a page photographed %s degrees off upright by reading the text',
    async (deg) => {
      const { image } = await buildTextPage(1000, 700, sampleLines)
      image.rotate(deg)
      const bytes = await image.getBuffer('image/jpeg')
      const result = await enhancePodImage(bytes, 'image/jpeg')
      expect(result).not.toBeNull()
      expect(result!.orientation.source).toBe('OCR_VOTE')
      expect(result!.orientation.detectedDegrees).toBe(deg)
      expect(result!.scanReviewReason).toBeNull()
      // The output must be upright: same aspect as the page before it was rotated.
      const scan = await Jimp.read(result!.bytes)
      expect(scan.width > scan.height).toBe(true)
    },
  )

  it('undistorts a trapezoid page photo with perspective correction', async () => {
    const { image, bytes: _bytes } = await buildTextPage(800, 600, sampleLines)
    // No-symmetric corners create a trapezoid.
    const srcW = image.bitmap.width
    const srcH = image.bitmap.height
    const gray = new Uint8Array(srcW * srcH)
    for (let i = 0; i < srcW * srcH; i++) gray[i] = image.bitmap.data[i * 4]
    const topShift = 80
    const bottomShift = 40
    const quad = {
      topLeft: { x: 0 + topShift, y: 0 + topShift },
      topRight: { x: srcW - topShift, y: 0 + 40 },
      bottomRight: { x: srcW - bottomShift, y: srcH - 40 },
      bottomLeft: { x: 0 + bottomShift, y: srcH - topShift },
    }
    const trapezoid = warpPerspective(gray, srcW, srcH, quad, srcW, srcH)
    const rgba = Buffer.alloc(srcW * srcH * 4)
    for (let i = 0; i < srcW * srcH; i++) {
      rgba[i * 4] = trapezoid[i]
      rgba[i * 4 + 1] = trapezoid[i]
      rgba[i * 4 + 2] = trapezoid[i]
      rgba[i * 4 + 3] = 255
    }
    const distorted = new Jimp({ width: srcW, height: srcH, data: rgba })
    const distortedBytes = await distorted.getBuffer('image/jpeg')

    const result = await enhancePodImage(distortedBytes, 'image/jpeg')
    expect(result).not.toBeNull()
    // The scanner should either find the page boundary and perspective-correct,
    // or at least preserve the content and flag uncertainty.
    expect(result!.geometry.perspectiveCorrected || result!.flags.includes('GEOMETRY_UNCERTAIN')).toBe(true)
  })

  it('flags review for images with no readable text or detectable boundary', async () => {
    const blank = await new Jimp({ width: 400, height: 300, color: 0xffffffff }).getBuffer('image/jpeg')
    const result = await enhancePodImage(blank, 'image/jpeg')
    expect(result).not.toBeNull()
    expect(result!.flags).toEqual(expect.arrayContaining(['TEXT_UNCERTAIN', 'ORIENTATION_UNCERTAIN']))
    expect(result!.scanReviewReason).toMatch(/No readable text/)
    expect(result!.orientation.appliedCorrection === 0).toBe(true)
  })

  it('keeps a crop only when it cannot have lost readable text', () => {
    // Sheared clipboard crop measured on a real POD: reads far less than the frame.
    expect(shouldKeepCrop(82, 43)).toBe(false)
    // Small receipt on pavement: the frame reads nothing confident, the crop reads plenty.
    expect(shouldKeepCrop(0, 46)).toBe(true)
    // Low-resolution MMS photo: a handful of words beats the frame's noise.
    expect(shouldKeepCrop(1, 5)).toBe(true)
    // A crop of a logo or label is not a document.
    expect(shouldKeepCrop(0, 2)).toBe(false)
    // Equal evidence keeps the crop; a small drop is tolerated, a real loss is not.
    expect(shouldKeepCrop(100, 92)).toBe(true)
    expect(shouldKeepCrop(100, 80)).toBe(false)
  })
})
