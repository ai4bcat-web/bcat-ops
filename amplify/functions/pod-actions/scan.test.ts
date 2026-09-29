import { describe, expect, it } from 'vitest'
import { Jimp } from 'jimp'
import { enhancePodImage } from './scan'

describe('POD scan cleanup', () => {
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
    expect(grayAt(80, 141)).toBeGreaterThan(100)
    expect(grayAt(80, 141)).toBeLessThan(225)
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
})
