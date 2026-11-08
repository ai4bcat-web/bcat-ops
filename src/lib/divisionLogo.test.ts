import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUrl = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify/storage', () => ({ getUrl }))

import { fetchDivisionLogoDataUrl } from './divisionLogo'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]

function respond(bytes: number[] | Uint8Array, init: { ok?: boolean } = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: init.ok ?? true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  })))
}

beforeEach(() => {
  getUrl.mockReset()
  getUrl.mockResolvedValue({ url: new URL('https://bucket.example/brand/logo') })
})

describe('fetchDivisionLogoDataUrl', () => {
  it('returns a png data URL for PNG bytes', async () => {
    respond(PNG)
    const url = await fetchDivisionLogoDataUrl('brand/logos/a.png')
    expect(url).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`)
  })

  it('returns a jpeg data URL for JPEG bytes', async () => {
    respond(JPEG)
    expect(await fetchDivisionLogoDataUrl('brand/logos/a.jpg')).toMatch(/^data:image\/jpeg;base64,/)
  })

  it.each([
    ['html', Array.from(new TextEncoder().encode('<html>denied</html>'))],
    ['svg', Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))],
    ['webp', Array.from(new TextEncoder().encode('RIFF....WEBPVP8 '))],
  ])('refuses %s bytes whatever the content-type says', async (_n, bytes) => {
    respond(bytes)
    expect(await fetchDivisionLogoDataUrl('brand/logos/a')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    respond(PNG, { ok: false })
    expect(await fetchDivisionLogoDataUrl('brand/logos/a.png')).toBeNull()
  })

  it('returns null when the signed URL cannot be made', async () => {
    getUrl.mockRejectedValue(new Error('denied'))
    respond(PNG)
    expect(await fetchDivisionLogoDataUrl('brand/logos/a.png')).toBeNull()
  })

  it('returns null when the fetch fails or aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    expect(await fetchDivisionLogoDataUrl('brand/logos/a.png')).toBeNull()
  })

  it('returns null for a logo over 2 MB', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(PNG)
    respond(big)
    expect(await fetchDivisionLogoDataUrl('brand/logos/a.png')).toBeNull()
  })
})
