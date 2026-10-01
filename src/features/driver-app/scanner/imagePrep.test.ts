// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { preparePage, type PageSource, type PreparePageOptions } from './imagePrep'

interface FakeCanvas extends HTMLCanvasElement {
  drawArgs: unknown[] | null
}

function createFakeCanvas(initialBlobSize = 5000): FakeCanvas {
  const fake = {
    width: 0,
    height: 0,
    drawArgs: null as unknown[] | null,
    getContext: () => ({
      drawImage: (...args: unknown[]) => {
        fake.drawArgs = args
      },
    }),
    toBlob: (callback: (blob: Blob | null) => void) => {
      callback(new Blob(['x'.repeat(initialBlobSize)], { type: 'image/jpeg' }))
    },
  }
  return fake as unknown as FakeCanvas
}

function makeOptions(initialBlobSize = 5000): PreparePageOptions {
  return { createCanvas: () => createFakeCanvas(initialBlobSize) }
}

describe('preparePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('downscales an oversized landscape image so the longest edge is <= 2000px', async () => {
    const canvas = createFakeCanvas()
    const source: PageSource = { width: 4000, height: 3000 }

    await preparePage(source, 'landscape.jpg', { createCanvas: () => canvas })

    expect(canvas.width).toBe(2000)
    expect(canvas.height).toBe(1500)
    expect(canvas.width / canvas.height).toBeCloseTo(4000 / 3000, 5)
  })

  it('downscales an oversized portrait image and preserves aspect ratio', async () => {
    const canvas = createFakeCanvas()
    const source: PageSource = { width: 3000, height: 4000 }

    await preparePage(source, 'portrait.jpg', { createCanvas: () => canvas })

    expect(canvas.width).toBe(1500)
    expect(canvas.height).toBe(2000)
    expect(canvas.height / canvas.width).toBeCloseTo(4000 / 3000, 5)
  })

  it('leaves a small image unchanged', async () => {
    const canvas = createFakeCanvas()
    const source: PageSource = { width: 1600, height: 900 }

    await preparePage(source, 'small.jpg', { createCanvas: () => canvas })

    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(900)
  })

  it('returns a PendingPage with jpeg contentType, correct byteSize, and a blob', async () => {
    const blobSize = 12345
    const source: PageSource = { width: 1000, height: 1000 }

    const page = await preparePage(source, 'page.jpg', makeOptions(blobSize))

    expect(page.fileName).toBe('page.jpg')
    expect(page.contentType).toBe('image/jpeg')
    expect(page.byteSize).toBe(blobSize)
    expect(page.blob).toBeInstanceOf(Blob)
    expect(page.blob.type).toBe('image/jpeg')
  })

  it('draws the source onto the canvas at the target dimensions', async () => {
    const canvas = createFakeCanvas()
    const source: PageSource = { width: 4000, height: 3000 }

    await preparePage(source, 'drawn.jpg', { createCanvas: () => canvas })

    expect(canvas.drawArgs).not.toBeNull()
    const args = canvas.drawArgs as unknown[]
    expect(args[0]).toBe(source)
    expect(args[1]).toBe(0)
    expect(args[2]).toBe(0)
    expect(args[3]).toBe(2000)
    expect(args[4]).toBe(1500)
  })

  it('rejects a source with zero dimensions', async () => {
    await expect(preparePage({ width: 0, height: 0 }, 'bad.jpg', makeOptions())).rejects.toThrow(
      'no usable dimensions',
    )
  })

  it('passes a PDF file through without canvas encoding', async () => {
    const pdf = new File(['pdf-bytes'], 'delivery.pdf', { type: 'application/pdf' })
    const page = await preparePage(pdf, 'fallback-name.pdf')

    expect(page.contentType).toBe('application/pdf')
    expect(page.byteSize).toBe(pdf.size)
    expect(page.fileName).toBe('delivery.pdf')
    expect(page.blob).toBe(pdf)
  })
})
