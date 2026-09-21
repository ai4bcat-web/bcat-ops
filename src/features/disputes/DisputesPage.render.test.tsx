// @vitest-environment jsdom
/**
 * The staff queue is where a dispute gets worked: pull the driver's files down to attach
 * to the Amazon case, then record what Amazon said with the status change.
 *
 * disputeEvidence.test.ts proves the array arithmetic. This proves the page wires it up —
 * a download actually saves bytes, and one save carries status + reply text + screenshot
 * without dropping the driver's upload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AmazonDispute, DisputeEvidence } from '@/types/dispute'

const updateAmazonDispute = vi.fn().mockResolvedValue(undefined)
const addAmazonDispute = vi.fn().mockResolvedValue(undefined)
const deleteAmazonDispute = vi.fn().mockResolvedValue(undefined)
const refreshAmazonDisputes = vi.fn().mockResolvedValue(undefined)
const disputes = vi.fn<() => AmazonDispute[]>(() => [])

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    amazonDisputes: disputes(),
    addAmazonDispute, updateAmazonDispute, deleteAmazonDispute, refreshAmazonDisputes,
    currentUserEmail: 'dennis@bcatcorp.com',
    drivers: [{ id: 'drv-chad', name: 'Chad Salerno', active: true }],
  }),
}))

const getDisputeEvidenceUrl = vi.fn(async (key: string) => `https://signed.example/${key}`)
const uploadDisputeResponseImage = vi.fn(async () => 'dispute-responses/d-1/9999-amazon.png')
const deleteDisputeResponseImage = vi.fn().mockResolvedValue(undefined)
const createAmazonTrip = vi.fn(async () => ({ id: 'trip-1' }))
const updateAmazonTrip = vi.fn().mockResolvedValue(undefined)
const deleteAmazonTrip = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/apiClient', () => ({
  getDisputeEvidenceUrl: (key: string) => getDisputeEvidenceUrl(key),
  uploadDisputeResponseImage: (id: string, file: File) => uploadDisputeResponseImage(id, file),
  deleteDisputeResponseImage: (key: string) => deleteDisputeResponseImage(key),
  createAmazonTrip: (input: unknown) => createAmazonTrip(input),
  updateAmazonTrip: (id: string, patch: unknown) => updateAmazonTrip(id, patch),
  deleteAmazonTrip: (id: string) => deleteAmazonTrip(id),
}))

const downloadFromUrl = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/download', () => ({ downloadFromUrl: (url: string, name: string) => downloadFromUrl(url, name) }))

import { DisputesPage } from './DisputesPage'

const confirmation: DisputeEvidence = {
  s3Key: 'dispute-proofs/sub-1/a.pdf', fileName: 'confirmation.pdf', contentType: 'application/pdf', size: 2048, kind: 'CONFIRMATION',
}
const photo: DisputeEvidence = {
  s3Key: 'dispute-proofs/sub-1/b.jpg', fileName: 'trailer.jpg', contentType: 'image/jpeg', size: 4096, kind: 'PHOTO',
}

const dispute = (over: Partial<AmazonDispute> = {}): AmazonDispute => ({
  id: 'd-1',
  driverName: 'Zak Pace',
  tripNumber: '112MP1BHQ',
  shipmentDate: '2026-02-03',
  payPeriod: '2026-02-01',
  amountPaid: 0,
  amountRequested: 250,
  description: 'Detention never paid',
  evidence: [confirmation, photo],
  status: 'PENDING',
  source: 'DRIVER_PORTAL',
  submittedAt: '2026-02-04T12:00:00.000Z',
  createdAt: '2026-02-04T12:00:00.000Z',
  updatedAt: '2026-02-04T12:00:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  disputes.mockReturnValue([dispute()])
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('DisputesPage evidence download', () => {
  it('saves a driver upload to disk instead of navigating away', async () => {
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: /2 files/ }))
    expect(await screen.findByText('Driver Upload (2)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Download confirmation.pdf' }))
    await waitFor(() => expect(downloadFromUrl).toHaveBeenCalledWith(
      'https://signed.example/dispute-proofs/sub-1/a.pdf', 'confirmation.pdf',
    ))
  })

  it('keeps the legacy Drive link reachable once staff attach a reply screenshot', async () => {
    const reply: DisputeEvidence = {
      s3Key: 'dispute-responses/d-1/1-old.png', fileName: 'old.png', contentType: 'image/png', size: 999, kind: 'AMAZON_RESPONSE',
    }
    disputes.mockReturnValue([dispute({ evidence: [reply], photoUrl: 'https://drive.google.com/file/proof' })])
    render(<DisputesPage />)

    expect(await screen.findByRole('link', { name: 'View proof' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /1 file/ })).toBeTruthy()
  })
})

describe('DisputesPage status update', () => {
  it('records status, Amazon reply and screenshot in one write, keeping driver evidence', async () => {
    render(<DisputesPage />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'Change status' }), { target: { value: 'PAID' } })
    expect(updateAmazonDispute).not.toHaveBeenCalled()   // nothing persists until Save

    fireEvent.change(await screen.findByLabelText('What Amazon said'), {
      target: { value: 'Case 8812 approved — $250 on the 3/7 remittance.' },
    })
    fireEvent.change(screen.getByLabelText('Amount Recovered ($)'), { target: { value: '250' } })

    const file = new File(['png-bytes'], 'amazon-reply.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('amazon-response-file'), { target: { files: [file] } })
    expect(await screen.findByText('amazon-reply.png')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    expect(uploadDisputeResponseImage).toHaveBeenCalledWith('d-1', file)

    const [id, patch] = updateAmazonDispute.mock.calls[0]
    expect(id).toBe('d-1')
    expect(patch.status).toBe('PAID')
    expect(patch.amazonResponse).toBe('Case 8812 approved — $250 on the 3/7 remittance.')
    expect(patch.resolvedAmount).toBe(250)
    expect(patch.amazonResponseBy).toBe('dennis@bcatcorp.com')
    expect(Date.parse(patch.amazonResponseAt)).not.toBeNaN()
    expect(patch.evidence).toEqual([
      confirmation,
      photo,
      {
        s3Key: 'dispute-responses/d-1/9999-amazon.png',
        fileName: 'amazon-reply.png',
        contentType: 'image/png',
        size: file.size,
        kind: 'AMAZON_RESPONSE',
      },
    ])
  })

  it('removes a staff screenshot on save and leaves the driver files alone', async () => {
    const reply: DisputeEvidence = {
      s3Key: 'dispute-responses/d-1/1-old.png', fileName: 'old.png', contentType: 'image/png', size: 999, kind: 'AMAZON_RESPONSE',
    }
    disputes.mockReturnValue([dispute({ evidence: [confirmation, photo, reply], amazonResponse: 'Denied, resubmit' })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Record Amazon response' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove old.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.evidence).toEqual([confirmation, photo])
    expect(patch.status).toBe('PENDING')
    await waitFor(() => expect(deleteDisputeResponseImage).toHaveBeenCalledWith('dispute-responses/d-1/1-old.png'))
  })

  it('keeps the driver upload when the row has no staff reply yet', async () => {
    render(<DisputesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Record Amazon response' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.evidence).toEqual([confirmation, photo])
    expect(patch.amazonResponse).toBeNull()
    expect(uploadDisputeResponseImage).not.toHaveBeenCalled()
  })

  it('keeps a reply another dispatcher attached while the sheet was open', async () => {
    render(<DisputesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Record Amazon response' }))

    // The 30 s poll lands a colleague's screenshot on the row under the open sheet; the
    // page re-renders (here: any page-level state change) and re-binds the live row.
    const theirs: DisputeEvidence = {
      s3Key: 'dispute-responses/d-1/2-theirs.png', fileName: 'theirs.png', contentType: 'image/png', size: 512, kind: 'AMAZON_RESPONSE',
    }
    disputes.mockReturnValue([dispute({ evidence: [confirmation, photo, theirs] })])
    fireEvent.change(screen.getByPlaceholderText(/Search driver/), { target: { value: 'Zak' } })
    fireEvent.change(screen.getByLabelText('What Amazon said'), { target: { value: 'Approved in full.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.evidence).toEqual([confirmation, photo, theirs])
    expect(deleteDisputeResponseImage).not.toHaveBeenCalled()
  })
})

/**
 * A recovered dispute is money that has to reach the driver's check exactly once: the
 * credit id on the row is the only thing standing between "paid" and "paid twice".
 */
describe('DisputesPage — paying a recovery onto a settlement', () => {
  const chadsDispute = (over: Partial<AmazonDispute> = {}) =>
    dispute({ driverName: 'Chad Salerno', status: 'POSTED', ...over })

  const openPaidSheet = async () => {
    fireEvent.change(await screen.findByRole('combobox', { name: 'Change status' }), { target: { value: 'PAID' } })
    return screen.findByLabelText('Add to settlement week')
  }

  const pickCurrentWeek = (select: HTMLElement) => {
    const option = Array.from((select as HTMLSelectElement).options).find((o) => /current week/.test(o.textContent ?? ''))!
    fireEvent.change(select, { target: { value: option.value } })
    return option.value
  }

  it('books a DISPUTE shipment for the matched driver on the chosen week and links it to the row', async () => {
    disputes.mockReturnValue([chadsDispute()])
    render(<DisputesPage />)

    const week = pickCurrentWeek(await openPaidSheet())
    fireEvent.change(screen.getByLabelText('Amount Recovered ($)'), { target: { value: '180.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(createAmazonTrip).toHaveBeenCalledTimes(1))
    expect(createAmazonTrip.mock.calls[0][0]).toMatchObject({
      driverId: 'drv-chad',
      periodStart: week,
      loadId: 'DISPUTE 2026-02-03',
      freightAmount: 180.5,
      status: 'Completed',
      notes: 'Amazon dispute — Trip 112MP1BHQ',
    })
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.settlementTripId).toBe('trip-1')
    expect(patch.settlementPeriodStart).toBe(week)
    expect(patch.settlementDriverId).toBe('drv-chad')
  })

  it('moves the shipment it already booked instead of paying the recovery twice', async () => {
    disputes.mockReturnValue([chadsDispute({
      status: 'PAID', resolvedAmount: 180.5,
      settlementTripId: 'trip-1', settlementPeriodStart: '2026-02-01', settlementDriverId: 'drv-chad',
    })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Record Amazon response' }))
    const week = pickCurrentWeek(await screen.findByLabelText('Add to settlement week'))
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(updateAmazonTrip).toHaveBeenCalledTimes(1))
    expect(createAmazonTrip).not.toHaveBeenCalled()
    const [tripId, input] = updateAmazonTrip.mock.calls[0]
    expect(tripId).toBe('trip-1')
    expect(input).toMatchObject({ periodStart: week, freightAmount: 180.5, loadId: 'DISPUTE 2026-02-03' })
  })

  it('takes the shipment back off the check when the recovery stops being paid', async () => {
    disputes.mockReturnValue([chadsDispute({
      status: 'PAID', resolvedAmount: 180.5,
      settlementTripId: 'trip-1', settlementPeriodStart: '2026-02-01', settlementDriverId: 'drv-chad',
    })])
    render(<DisputesPage />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'Change status' }), { target: { value: 'REJECTED' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(deleteAmazonTrip).toHaveBeenCalledWith('trip-1'))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.status).toBe('REJECTED')
    expect(patch.settlementTripId).toBeNull()
    expect(patch.settlementPeriodStart).toBeNull()
  })

  it('refuses to post a recovery with no amount keyed', async () => {
    disputes.mockReturnValue([chadsDispute({ amountRequested: null })])
    render(<DisputesPage />)

    pickCurrentWeek(await openPaidSheet())
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))

    await waitFor(() => expect(createAmazonTrip).not.toHaveBeenCalled())
    expect(updateAmazonDispute).not.toHaveBeenCalled()
  })
})
