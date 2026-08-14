// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { saveBlob, downloadFromUrl } from './download'

/**
 * The bug these guard against: pointing an <a download> at a presigned S3 URL does not save
 * the file. `download` is ignored cross-origin, so the browser navigates to S3 and the PDF
 * viewer replaces the page. The fix is to fetch the bytes and save a same-origin blob: URL —
 * so the assertion that matters is that the anchor's href is a blob:, never the remote URL.
 */

const S3_URL = 'https://bucket.s3.us-east-1.amazonaws.com/private/cdl.pdf?X-Amz-Signature=abc'

let clicked: HTMLAnchorElement[] = []
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  clicked = []
  createObjectURL = vi.fn(() => 'blob:https://ops.bcatcorp.com/deadbeef')
  revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
  // Record clicks instead of letting jsdom attempt a navigation.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saveBlob', () => {
  it('saves via a blob: URL and the requested filename', () => {
    saveBlob(new Blob(['x'], { type: 'application/pdf' }), 'cdl.pdf')

    expect(clicked).toHaveLength(1)
    expect(clicked[0].href).toBe('blob:https://ops.bcatcorp.com/deadbeef')
    expect(clicked[0].download).toBe('cdl.pdf')
  })

  it('removes the anchor and revokes the object URL afterwards', () => {
    saveBlob(new Blob(['x']), 'cdl.pdf')

    expect(document.body.contains(clicked[0])).toBe(false)
    expect(revokeObjectURL).not.toHaveBeenCalled() // not synchronously — Safari cancels the save
    vi.advanceTimersByTime(10_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://ops.bcatcorp.com/deadbeef')
  })
})

describe('downloadFromUrl', () => {
  it('fetches the remote file and never puts the S3 URL on the anchor', async () => {
    const blob = new Blob(['pdf bytes'], { type: 'application/pdf' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob })))

    await downloadFromUrl(S3_URL, 'cdl.pdf')

    expect(fetch).toHaveBeenCalledWith(S3_URL)
    expect(clicked).toHaveLength(1)
    // The whole point: the anchor points at a blob, so the browser saves instead of navigating.
    expect(clicked[0].href).toBe('blob:https://ops.bcatcorp.com/deadbeef')
    expect(clicked[0].href).not.toContain('amazonaws.com')
    expect(clicked[0].download).toBe('cdl.pdf')
  })

  it('throws on a failed fetch so the caller can toast instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, blob: async () => new Blob() })))

    await expect(downloadFromUrl(S3_URL, 'cdl.pdf')).rejects.toThrow('403')
    expect(clicked).toHaveLength(0)
  })
})
