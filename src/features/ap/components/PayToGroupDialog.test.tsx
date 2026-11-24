// @vitest-environment jsdom
/**
 * The pay-to group dialog: a payee with no bank details holds the payment, unless the bills were already paid
 * outside the app (the money moved in Chase), in which case the recording goes through with the no-remittance flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PayToGroupDialog } from './PayToGroupDialog'
import type { CarrierBillRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { recordApPaymentGroup } = vi.hoisted(() => ({ recordApPaymentGroup: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  recordApPaymentGroup,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))

function bill(id: string, carrierId: string, carrierName: string, cents: number): CarrierBillRecord {
  return {
    id,
    carrierId,
    carrierName,
    shipmentNumber: id,
    status: 'TO_BE_PAID',
    balanceCents: cents,
    netCents: cents,
    remitTo: { name: 'Test Factor', method: 'ACH' },
  } as unknown as CarrierBillRecord
}

const BILLS = [bill('14001', 'car-a', 'Alpha Trucking', 115_000), bill('14002', 'car-b', 'Beta Express', 130_000)]
const BLOCKS = { '14001': 'Test Factor has no bank details on file for ACH.', '14002': 'Test Factor has no bank details on file for ACH.' }

const renderIt = (payBlocks?: Record<string, string>) => render(
  <PayToGroupDialog payTo="Test Factor" bills={BILLS} payBlocks={payBlocks} open onOpenChange={vi.fn()} onDone={vi.fn()} />,
)
const post = () => screen.getByRole('button', { name: /^Post / }) as HTMLButtonElement

describe('PayToGroupDialog with no bank details on file', () => {
  beforeEach(() => {
    recordApPaymentGroup.mockReset()
    recordApPaymentGroup.mockResolvedValue({ duplicate: false })
  })

  it('holds the payment and tells the user how to record one made elsewhere', () => {
    renderIt(BLOCKS)
    expect(screen.getByTestId('pay-group-blocked').textContent).toMatch(/no bank details on file for ACH/)
    expect(screen.getByTestId('pay-group-blocked').textContent).toMatch(/Check 'Already paid outside the app' to record a payment you made elsewhere\./)
    expect(post().disabled).toBe(true)
  })

  it('posts with suppressRemittance once "Already paid outside the app" is ticked', async () => {
    renderIt(BLOCKS)
    fireEvent.click(screen.getByLabelText(/Already paid outside the app/))
    await waitFor(() => expect(post().disabled).toBe(false))
    expect(screen.queryByTestId('pay-group-blocked')).toBeNull()
    fireEvent.click(post())
    await waitFor(() => expect(recordApPaymentGroup).toHaveBeenCalledTimes(1))
    expect(recordApPaymentGroup.mock.calls[0][0]).toMatchObject({ billIds: ['14001', '14002'], suppressRemittance: true })
  })

  it('with bank details on file it posts and sends the remittance as before', async () => {
    renderIt()
    expect(screen.queryByTestId('pay-group-blocked')).toBeNull()
    fireEvent.click(post())
    await waitFor(() => expect(recordApPaymentGroup).toHaveBeenCalledTimes(1))
    expect(recordApPaymentGroup.mock.calls[0][0]).not.toHaveProperty('suppressRemittance')
  })
})
