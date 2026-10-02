// @vitest-environment jsdom
/**
 * A driver picked a document and landed back on the upload screen with nothing saved.
 *
 * The picker decoded every photo itself and threw the file away when that failed — and on
 * an iPhone it fails routinely, because the Files app hands back whatever is on disk
 * whatever the accept list says, and for a photo from any recent iPhone that is HEIC. A
 * failed decode leaves an <img> with naturalWidth 0, which read as "no usable dimensions".
 *
 * Downscaling is now an optimisation. It saves a driver at a dock several megabytes of
 * upload, and when it cannot be done the original file goes up instead: the server cleans
 * PODs anyway, and a POD that arrives unconverted beats one that never arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prepareFile } from './imagePrep'

const heic = () => new File([new Uint8Array([1, 2, 3, 4])], 'IMG_4312.HEIC', { type: 'image/heic' })
const jpeg = () => new File([new Uint8Array([0xff, 0xd8])], 'photo.jpg', { type: 'image/jpeg' })
const pdf = () => new File([new Uint8Array([0x25, 0x50])], 'scan.pdf', { type: 'application/pdf' })

beforeEach(() => {
  vi.unstubAllGlobals()
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => undefined
})

describe('prepareFile', () => {
  it('sends a photo it cannot decode rather than dropping it', async () => {
    // The whole bug. Both decode paths fail, as they do for HEIC on a browser without it.
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) { queueMicrotask(() => this.onerror?.()) }
    })

    const file = heic()
    const page = await prepareFile(file)
    expect(page.blob).toBe(file)
    expect(page.fileName).toBe('IMG_4312.HEIC')
    expect(page.byteSize).toBe(file.size)
  })

  it('treats a zero-sized decode as the failure it is', async () => {
    // An <img> that "loads" with naturalWidth 0 is how a HEIC fails on older Safari — it
    // looks like success, and reading a size off it threw.
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('Image', class {
      naturalWidth = 0
      width = 0
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    })
    const file = heic()
    expect((await prepareFile(file)).blob).toBe(file)
  })

  it('passes a PDF through untouched, whatever its declared type', async () => {
    // A scanner app's output IS the document; re-encoding would rasterize its text away.
    const file = pdf()
    expect((await prepareFile(file)).blob).toBe(file)
    const odd = new File([new Uint8Array([1])], 'SCAN.PDF', { type: 'application/octet-stream' })
    expect((await prepareFile(odd)).blob).toBe(odd)
  })

  it('downscales when the browser can decode, which is the point of doing this at all', async () => {
    const bitmap = { width: 4000, height: 3000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('ImageBitmap', class {})

    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(['x'], { type: 'image/jpeg' })),
    }
    vi.spyOn(document, 'createElement').mockReturnValueOnce(canvas as unknown as HTMLCanvasElement)

    const page = await prepareFile(jpeg())
    expect(page.contentType).toBe('image/jpeg')
    // 4000x3000 fitted to a 2000px long edge.
    expect(canvas.width).toBe(2000)
    expect(canvas.height).toBe(1500)
  })

  it('falls back to the original when the canvas refuses', async () => {
    // A picture past this phone's canvas limits. The file still has to reach the office.
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }))
    vi.stubGlobal('ImageBitmap', class {})
    vi.spyOn(document, 'createElement').mockReturnValueOnce({
      width: 0, height: 0, getContext: () => null,
    } as unknown as HTMLCanvasElement)

    const file = jpeg()
    expect((await prepareFile(file)).blob).toBe(file)
  })
})
