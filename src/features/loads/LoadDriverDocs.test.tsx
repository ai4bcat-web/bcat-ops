// @vitest-environment jsdom
/**
 * A driver could scan a POD or a rate confirmation, see it in their own app, and the office
 * would see an empty slot on the load and chase them for it. The drawer read only the rate
 * confirmation on the Load row and the PODs JobsDone had linked.
 *
 * What matters here is the matching: a submission belongs to a load by its loadId, or by the
 * PRO the driver typed, and by nothing looser than that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { LoadDriverDocs } from './LoadDriverDocs'
import type { SubmissionWithDocs } from '@/lib/driverSubmissionsClient'

const listDriverSubmissions = vi.hoisted(() => vi.fn())
const getDriverDocUrl = vi.hoisted(() => vi.fn())
const removeDriverDocs = vi.hoisted(() => vi.fn())
const replaceDriverDocs = vi.hoisted(() => vi.fn())
const queueDriverDocScan = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/driverSubmissionsClient', () => ({
  listDriverSubmissions, getDriverDocUrl, removeDriverDocs, replaceDriverDocs,
  DRIVER_DOC_ACCEPT: 'image/jpeg,image/png,application/pdf',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/podsClient', () => ({ queueDriverDocScan }))

function sub(over: Partial<SubmissionWithDocs> = {}): SubmissionWithDocs {
  return {
    id: 'sub-1', driverId: 'drv-1', driverName: 'Chad Salerno',
    source: 'PWA', loadId: null, referenceNumber: null,
    createdAt: '2026-10-01T12:00:00Z',
    docs: [{
      id: 'doc-1', submissionId: 'sub-1', driverId: 'drv-1', kind: 'POD',
      s3Key: 'driver-docs/drv-1/sub-1/POD/1.pdf', fileName: 'POD-2026-10-01.pdf',
      contentType: 'application/pdf', pageNumber: 1, uploadedAt: '2026-10-01T12:00:00Z',
    }],
    ...over,
  } as SubmissionWithDocs
}

beforeEach(() => {
  vi.clearAllMocks()
  getDriverDocUrl.mockResolvedValue('https://s3.test/doc.pdf')
})

describe('LoadDriverDocs', () => {
  it('shows a POD the driver attached to this load', async () => {
    listDriverSubmissions.mockResolvedValue([sub({ loadId: 'load-1' })])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)

    expect(await screen.findByText('POD-2026-10-01.pdf')).toBeInTheDocument()
    expect(screen.getByText(/Chad Salerno · from the driver app/)).toBeInTheDocument()
    // The row opens a preview in place. It used to be a link to a presigned URL in a new
    // tab, which is not a preview: the question in front of a POD is "is this the right
    // document", and answering it should not cost you the load you were looking at.
    const row = await screen.findByRole('button', { name: /Preview POD-2026-10-01\.pdf/ })
    fireEvent.click(row)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByTitle(/POD · PRO 14538/)).toHaveAttribute('src', 'https://s3.test/doc.pdf'),
    )
  })

  it('matches on the PRO the driver typed when no load was attached', async () => {
    // This is the common case: the driver sends a POD before anyone links it to the load.
    listDriverSubmissions.mockResolvedValue([sub({ referenceNumber: 'PRO 14538' })])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538  " kind="POD" />)
    expect(await screen.findByText('POD-2026-10-01.pdf')).toBeInTheDocument()
  })

  it('never shows another load’s paperwork', async () => {
    listDriverSubmissions.mockResolvedValue([
      sub({ loadId: 'load-OTHER', referenceNumber: '99999' }),
    ])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)
    await waitFor(() => expect(listDriverSubmissions).toHaveBeenCalled())
    expect(screen.queryByText('POD-2026-10-01.pdf')).not.toBeInTheDocument()
  })

  it('keeps the two document kinds apart', async () => {
    listDriverSubmissions.mockResolvedValue([
      sub({
        loadId: 'load-1',
        docs: [{
          id: 'rc-1', submissionId: 'sub-1', driverId: 'drv-1', kind: 'RATECON',
          s3Key: 'driver-docs/drv-1/sub-1/RATECON/1.pdf', fileName: 'RateCon.pdf',
          contentType: 'application/pdf', pageNumber: 1, uploadedAt: '2026-10-01T12:00:00Z',
        }],
      } as Partial<SubmissionWithDocs>),
    ])
    const { rerender } = render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)
    await waitFor(() => expect(listDriverSubmissions).toHaveBeenCalled())
    expect(screen.queryByText('RateCon.pdf')).not.toBeInTheDocument()

    rerender(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="RATECON" />)
    expect(await screen.findByText('RateCon.pdf')).toBeInTheDocument()
  })

  it('names a staff upload as such, not as the driver app', async () => {
    listDriverSubmissions.mockResolvedValue([
      sub({ loadId: 'load-1', source: 'STAFF', submittedByEmail: 'jenny@bcatcorp.com' }),
    ])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)
    expect(await screen.findByText(/uploaded by staff/)).toBeInTheDocument()
  })

  it('says nothing at all when the driver has sent nothing', async () => {
    listDriverSubmissions.mockResolvedValue([])
    const { container } = render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)
    await waitFor(() => expect(listDriverSubmissions).toHaveBeenCalled())
    // The upload control sits right beside this; an empty heading would be noise.
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('surfaces a read failure instead of implying nothing was sent', async () => {
    listDriverSubmissions.mockRejectedValue(new Error('Network down'))
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)
    expect(await screen.findByText('Network down')).toBeInTheDocument()
  })
})

/**
 * A document that never got cleaned up should be fixable from the load, not by asking a
 * driver to send it again. Two separate things have to be true before it is done: every
 * page has been looked at, and they have been merged into the one PDF everything
 * downstream reads.
 */
describe('a document that was never scanned', () => {
  const loose = (over: Partial<SubmissionWithDocs> = {}) =>
    sub({
      loadId: 'load-1',
      combinedPodKey: null,
      docs: [{
        id: 'd1', submissionId: 'sub-1', driverId: 'drv-1', kind: 'POD',
        s3Key: 'k1', fileName: 'POD.jpg', contentType: 'image/jpeg',
        pageNumber: 1, uploadedAt: '2026-10-01T12:00:00Z', scanStatus: 'ORIGINAL_ONLY',
      }],
      ...over,
    } as Partial<SubmissionWithDocs>)

  it('offers to clean it up and combine it', async () => {
    listDriverSubmissions.mockResolvedValue([loose()])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)

    const fix = await screen.findByRole('button', { name: /Clean it up and combine/ })
    fireEvent.click(fix)
    await waitFor(() => expect(queueDriverDocScan).toHaveBeenCalledWith('sub-1', 'POD'))
  })

  it('does not offer it for a document already cleaned and merged', async () => {
    listDriverSubmissions.mockResolvedValue([
      sub({
        loadId: 'load-1',
        combinedPodKey: 'driver-docs/drv-1/sub-1/POD/combined.pdf',
        docs: [{
          id: 'd1', submissionId: 'sub-1', driverId: 'drv-1', kind: 'POD',
          s3Key: 'k1', fileName: 'POD.jpg', contentType: 'image/jpeg',
          pageNumber: 1, uploadedAt: '2026-10-01T12:00:00Z', scanStatus: 'READY',
          enhancedKey: 'k1.enhanced.jpg',
        }],
      } as Partial<SubmissionWithDocs>),
    ])
    render(<LoadDriverDocs loadId="load-1" proNumber="14538" kind="POD" />)

    await screen.findByText(/cleaned scan/)
    expect(screen.queryByRole('button', { name: /Clean it up and combine/ })).not.toBeInTheDocument()
  })
})
