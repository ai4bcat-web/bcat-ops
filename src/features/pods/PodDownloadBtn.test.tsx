// @vitest-environment jsdom
/**
 * Downloading a POD.
 *
 * A presigned URL lasts fifteen minutes. The list signed one when a row was expanded and
 * handed it to the download button, so a POD page left open longer than that produced a
 * dead link — and S3 answers an expired signature with a 403 carrying no CORS headers, so
 * the browser reports "Failed to fetch", which names neither the cause nor the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PodDownloadBtn } from './PodShared'

const getPodAssets = vi.hoisted(() => vi.fn())
const downloadPodAsPdf = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const error = vi.hoisted(() => vi.fn())

vi.mock('@/lib/podsClient', () => ({ getPodAssets }))
vi.mock('@/lib/podDownload', () => ({ downloadPodAsPdf }))
vi.mock('sonner', () => ({ toast: { error, success: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  getPodAssets.mockResolvedValue({
    enhancedUrl: 'https://s3.test/enhanced.pdf?sig=fresh',
    originalUrl: 'https://s3.test/original.jpg?sig=fresh',
    // Signed with a Content-Disposition, for when reading the bytes is blocked.
    enhancedDownloadUrl: 'https://s3.test/enhanced.pdf?sig=fresh&dl=1',
    originalDownloadUrl: 'https://s3.test/original.jpg?sig=fresh&dl=1',
  })
})

function click(variant: 'enhanced' | 'original' = 'enhanced') {
  render(<PodDownloadBtn podId="pod-1" variant={variant} filename="POD-14538.pdf" label="Enhanced" />)
  fireEvent.click(screen.getByRole('button'))
}

describe('PodDownloadBtn', () => {
  it('signs the URL at the moment of the click, not when the row was opened', async () => {
    click()
    await waitFor(() => expect(getPodAssets).toHaveBeenCalledWith('pod-1'))
    await waitFor(() =>
      expect(downloadPodAsPdf).toHaveBeenCalledWith(
        'https://s3.test/enhanced.pdf?sig=fresh',
        'POD-14538.pdf',
        'https://s3.test/enhanced.pdf?sig=fresh&dl=1',
      ),
    )
  })

  it('takes the raw photo when that is what was asked for', async () => {
    click('original')
    await waitFor(() =>
      expect(downloadPodAsPdf).toHaveBeenCalledWith(
        'https://s3.test/original.jpg?sig=fresh',
        'POD-14538.pdf',
        'https://s3.test/original.jpg?sig=fresh&dl=1',
      ),
    )
  })

  it('says there is no cleaned copy rather than fetching nothing', async () => {
    // Previously this called fetch(undefined), which fails in a way that reads as a broken
    // button rather than as a POD that has not been through the cleanup.
    getPodAssets.mockResolvedValue({ enhancedUrl: undefined, originalUrl: 'https://s3.test/o.jpg' })
    click()
    await waitFor(() => expect(error).toHaveBeenCalledWith('There is no cleaned copy of this POD yet'))
    expect(downloadPodAsPdf).not.toHaveBeenCalled()
  })

  it('surfaces a failure instead of leaving the button looking dead', async () => {
    downloadPodAsPdf.mockRejectedValueOnce(new Error('Server returned 403'))
    click()
    await waitFor(() => expect(error).toHaveBeenCalledWith('Server returned 403'))
  })

  it('re-enables itself after a failure, so it can be tried again', async () => {
    downloadPodAsPdf.mockRejectedValueOnce(new Error('nope'))
    click()
    await waitFor(() => expect(error).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  })
})
