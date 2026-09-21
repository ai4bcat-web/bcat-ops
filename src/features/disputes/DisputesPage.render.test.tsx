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
    drivers: [
      { id: 'drv-chad', name: 'Chad Salerno', active: true },
      { id: 'drv-zak', name: 'Zak Pace', active: true },
      { id: 'drv-retired', name: 'Retired Driver', active: false },
      { id: 'drv-broker', name: 'Broker Bob', active: true, type: 'broker' },
    ],
  }),
}))

const getDisputeEvidenceUrl = vi.fn(async (key: string) => `https://signed.example/${key}`)
const uploadDisputeResponseImage = vi.fn(async () => 'dispute-responses/d-1/9999-amazon.png')
const deleteDisputeResponseImage = vi.fn().mockResolvedValue(undefined)
const uploadDisputeStaffProof = vi.fn(async () => 'dispute-staff-proofs/d-1/9999-confirmation.png')
const deleteDisputeStaffProof = vi.fn().mockResolvedValue(undefined)
const createAmazonTrip = vi.fn(async () => ({ id: 'trip-1' }))
const updateAmazonTrip = vi.fn().mockResolvedValue(undefined)
const deleteAmazonTrip = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/apiClient', () => ({
  getDisputeEvidenceUrl: (key: string) => getDisputeEvidenceUrl(key),
  uploadDisputeResponseImage: (id: string, file: File) => uploadDisputeResponseImage(id, file),
  deleteDisputeResponseImage: (key: string) => deleteDisputeResponseImage(key),
  uploadDisputeStaffProof: (id: string, file: File, kind: string) => uploadDisputeStaffProof(id, file, kind),
  deleteDisputeStaffProof: (key: string) => deleteDisputeStaffProof(key),
  createAmazonTrip: (input: unknown) => createAmazonTrip(input),
  updateAmazonTrip: (id: string, patch: unknown) => updateAmazonTrip(id, patch),
  deleteAmazonTrip: (id: string) => deleteAmazonTrip(id),
}))

vi.mock('@/lib/disputePortalClient', () => ({ uuid: () => 'new-dispute-id' }))

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

  it('deletes the settlement shipment with the dispute, so no phantom row keeps paying', async () => {
    disputes.mockReturnValue([chadsDispute({
      status: 'PAID', resolvedAmount: 180.5,
      settlementTripId: 'trip-1', settlementPeriodStart: '2026-02-01', settlementDriverId: 'drv-chad',
    })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete dispute' }))

    await waitFor(() => expect(deleteAmazonTrip).toHaveBeenCalledWith('trip-1'))
    expect(deleteAmazonDispute).toHaveBeenCalledWith('d-1')
  })

  it('drops the shipment when the edit sheet moves a posted dispute off Paid', async () => {
    disputes.mockReturnValue([chadsDispute({
      status: 'PAID', resolvedAmount: 180.5,
      settlementTripId: 'trip-1', settlementPeriodStart: '2026-02-01', settlementDriverId: 'drv-chad',
    })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }))
    fireEvent.change(await screen.findByLabelText('Dispute status'), { target: { value: 'POSTED' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(deleteAmazonTrip).toHaveBeenCalledWith('trip-1'))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.status).toBe('POSTED')
    expect(patch.settlementTripId).toBeNull()
  })

  it('re-prices the posted shipment when the recovered amount is edited', async () => {
    disputes.mockReturnValue([chadsDispute({
      status: 'PAID', resolvedAmount: 180.5,
      settlementTripId: 'trip-1', settlementPeriodStart: '2026-02-01', settlementDriverId: 'drv-chad',
    })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }))
    fireEvent.change(await screen.findByLabelText('Recovered amount ($)'), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(updateAmazonTrip).toHaveBeenCalledTimes(1))
    expect(deleteAmazonTrip).not.toHaveBeenCalled()
    const [tripId, input] = updateAmazonTrip.mock.calls[0]
    expect(tripId).toBe('trip-1')
    expect(input).toMatchObject({ periodStart: '2026-02-01', freightAmount: 200, driverId: 'drv-chad' })
  })
})

describe('DisputesPage — DisputeModal driver roster select', () => {
  it('creates a manual dispute with a roster driver name and confirmation proof saved to the row', async () => {
    render(<DisputesPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New Dispute' }))
    const driverSelect = await screen.findByRole('combobox', { name: 'Driver name' })

    // Brokers and inactive drivers are excluded from the roster.
    const options = Array.from((driverSelect as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toContain('Chad Salerno')
    expect(options).toContain('Zak Pace')
    expect(options).not.toContain('Broker Bob')
    expect(options).not.toContain('Retired Driver')

    fireEvent.change(driverSelect, { target: { value: 'Zak Pace' } })
    fireEvent.change(screen.getByPlaceholderText('112MP1BHQ'), { target: { value: 'NEW-TRIP' } })
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '99' } })

    const confirmationInput = screen.getByLabelText(/Trip confirmation email/)
    fireEvent.change(confirmationInput, { target: { files: [new File(['x'], 'confirm.png', { type: 'image/png' })] } })

    fireEvent.click(screen.getByRole('button', { name: /Create Dispute/ }))

    await waitFor(() => expect(addAmazonDispute).toHaveBeenCalledTimes(1))
    const [input] = addAmazonDispute.mock.calls[0]
    expect(input.driverName).toBe('Zak Pace')
    expect(input.tripNumber).toBe('NEW-TRIP')
    expect(input.amountRequested).toBe(99)
    expect(input.source).toBe('MANUAL')
    expect(input.evidence).toHaveLength(1)
    expect(input.evidence[0]).toMatchObject({ kind: 'CONFIRMATION', s3Key: 'dispute-staff-proofs/d-1/9999-confirmation.png' })
  })

  it('preserves an unmatched driver name when editing a legacy dispute', async () => {
    disputes.mockReturnValue([dispute({ driverName: 'Legacy Driver', status: 'PENDING' })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }))
    const driverSelect = await screen.findByRole('combobox', { name: 'Driver name' })

    expect((driverSelect as HTMLSelectElement).value).toBe('Legacy Driver')
    expect(screen.getByRole('option', { name: /Legacy Driver \(not in roster\)/ })).toBeTruthy()

    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '110' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.driverName).toBe('Legacy Driver')
    expect(patch.amountRequested).toBe(110)
  })

  it('lets staff switch an unmatched legacy driver to an active roster driver', async () => {
    disputes.mockReturnValue([dispute({ driverName: 'Legacy Driver', status: 'PENDING' })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }))
    const driverSelect = await screen.findByRole('combobox', { name: 'Driver name' })

    fireEvent.change(driverSelect, { target: { value: 'Chad Salerno' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    expect(patch.driverName).toBe('Chad Salerno')
  })

  it('requires a confirmation file for a new manual dispute', async () => {
    render(<DisputesPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New Dispute' }))
    await screen.findByRole('combobox', { name: 'Driver name' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Driver name' }), { target: { value: 'Zak Pace' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Dispute/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/confirmation/i))
    expect(addAmazonDispute).not.toHaveBeenCalled()
  })

  it('rejects an invalid confirmation file and keeps the form intact', async () => {
    render(<DisputesPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New Dispute' }))
    await screen.findByRole('combobox', { name: 'Driver name' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Driver name' }), { target: { value: 'Zak Pace' } })
    fireEvent.change(screen.getByPlaceholderText('112MP1BHQ'), { target: { value: 'BAD-TRIP' } })

    const confirmationInput = screen.getByLabelText(/Trip confirmation email/)
    fireEvent.change(confirmationInput, { target: { files: [new File(['x'], 'bad.svg', { type: 'image/svg+xml' })] } })

    fireEvent.click(screen.getByRole('button', { name: /Create Dispute/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/screenshot/i))
    expect(addAmazonDispute).not.toHaveBeenCalled()
  })

  it('preserves driver portal evidence and Amazon responses while editing staff proof', async () => {
    const staffConfirmation: DisputeEvidence = {
      s3Key: 'dispute-staff-proofs/d-1/old-confirmation.pdf',
      fileName: 'old-confirmation.pdf',
      contentType: 'application/pdf',
      size: 2048,
      kind: 'CONFIRMATION',
    }
    const staffPhoto: DisputeEvidence = {
      s3Key: 'dispute-staff-proofs/d-1/old-photo.jpg',
      fileName: 'old-photo.jpg',
      contentType: 'image/jpeg',
      size: 4096,
      kind: 'PHOTO',
    }
    const reply: DisputeEvidence = {
      s3Key: 'dispute-responses/d-1/amazon.png',
      fileName: 'amazon.png',
      contentType: 'image/png',
      size: 1024,
      kind: 'AMAZON_RESPONSE',
    }
    disputes.mockReturnValue([dispute({
      source: 'MANUAL',
      evidence: [confirmation, photo, staffConfirmation, staffPhoto, reply],
    })])
    render(<DisputesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }))
    await screen.findByText('Staff Proof (2)')

    fireEvent.click(screen.getByRole('button', { name: /Remove old-confirmation\.pdf/ }))
    const photoInput = screen.getByLabelText(/Optional photos/)
    fireEvent.change(photoInput, { target: { files: [new File(['x'], 'new.jpg', { type: 'image/jpeg' })] } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(updateAmazonDispute).toHaveBeenCalledTimes(1))
    const [, patch] = updateAmazonDispute.mock.calls[0]
    const keys = patch.evidence.map((e: DisputeEvidence) => e.s3Key)
    expect(keys).toContain(confirmation.s3Key)
    expect(keys).toContain(photo.s3Key)
    expect(keys).toContain(reply.s3Key)
    expect(keys).toContain(staffPhoto.s3Key)
    expect(keys).not.toContain(staffConfirmation.s3Key)
    expect(keys).toContain('dispute-staff-proofs/d-1/9999-confirmation.png')
    await waitFor(() => expect(deleteDisputeStaffProof).toHaveBeenCalledWith(staffConfirmation.s3Key))
  })

  it('cleans up newly uploaded orphan files when a manual save fails', async () => {
    addAmazonDispute.mockRejectedValueOnce(new Error('network down'))
    render(<DisputesPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New Dispute' }))
    await screen.findByRole('combobox', { name: 'Driver name' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Driver name' }), { target: { value: 'Zak Pace' } })

    const confirmationInput = screen.getByLabelText(/Trip confirmation email/)
    fireEvent.change(confirmationInput, { target: { files: [new File(['x'], 'confirm.png', { type: 'image/png' })] } })

    fireEvent.click(screen.getByRole('button', { name: /Create Dispute/ }))

    await waitFor(() => expect(deleteDisputeStaffProof).toHaveBeenCalledWith('dispute-staff-proofs/d-1/9999-confirmation.png'))
    expect(addAmazonDispute).toHaveBeenCalledTimes(1)
    // The chosen file stays in the drop zone so the user can retry.
    expect(screen.getByText('confirm.png')).toBeTruthy()
  })
})
