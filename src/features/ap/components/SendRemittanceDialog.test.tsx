// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ApPaymentRecord } from '@/types/tms'

const api = vi.hoisted(() => ({
  getCarrier: vi.fn(), getTmsSettings: vi.fn(), listBillsByCarrier: vi.fn(), listDivisions: vi.fn(),
  markRemittanceSent: vi.fn(), renderRemittancePdf: vi.fn(), sendRemittance: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

import { SendRemittanceDialog } from './SendRemittanceDialog'

const payment = {
  id: 'app-1', carrierId: 'car-1', reference: 'ACH-77', paidAt: '2026-11-18T12:00:00.000Z', amountCents: 95_000, method: 'ACH',
  applications: [{ billId: 'b1', amountCents: 95_000 }],
  remitTo: { payeeEmail: 'accounting@carrier.test' },
} as unknown as ApPaymentRecord

beforeEach(() => {
  vi.clearAllMocks()
  api.getCarrier.mockResolvedValue({ id: 'car-1', name: 'Carrier', email: null })
  api.listDivisions.mockResolvedValue([])
  api.listBillsByCarrier.mockResolvedValue([{ id: 'b1', billNumber: 'THEIR-INV-1', shipmentNumber: '14525', loadNumber: null, netCents: 95_000 }])
  api.sendRemittance.mockResolvedValue({ emailStatus: 'SENT', to: ['accounting@carrier.test'], cc: ['billing@bcatcorp.com'], subject: 's', body: 'b', downloads: [] })
})

describe('SendRemittanceDialog', () => {
  it('pre-fills the standing copy and sends it with the remittance', async () => {
    api.getTmsSettings.mockResolvedValue({})
    render(<SendRemittanceDialog payment={payment} open onOpenChange={() => {}} onDone={() => {}} />)
    expect(await screen.findByText('billing@bcatcorp.com')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /^Send/ }))
    await waitFor(() => expect(api.sendRemittance).toHaveBeenCalled())
    expect(api.sendRemittance.mock.calls[0][0]).toMatchObject({ to: ['accounting@carrier.test'], cc: ['billing@bcatcorp.com'] })
  })

  it('uses the saved list, and leaves it empty when the admin saved none', async () => {
    api.getTmsSettings.mockResolvedValue({ remittanceCcEmails: [] })
    render(<SendRemittanceDialog payment={payment} open onOpenChange={() => {}} onDone={() => {}} />)
    await screen.findByText('accounting@carrier.test')
    expect(screen.queryByText('billing@bcatcorp.com')).toBeNull()
  })

  it('does not copy the payee twice when the payee is the copy address', async () => {
    api.getTmsSettings.mockResolvedValue({ remittanceCcEmails: ['accounting@carrier.test', 'ap@bcatcorp.com'] })
    render(<SendRemittanceDialog payment={payment} open onOpenChange={() => {}} onDone={() => {}} />)
    expect(await screen.findByText('ap@bcatcorp.com')).toBeTruthy()
    expect(screen.getAllByText('accounting@carrier.test')).toHaveLength(1)
  })

  it('previews the PRO without the carrier invoice number', async () => {
    api.getTmsSettings.mockResolvedValue({})
    render(<SendRemittanceDialog payment={payment} open onOpenChange={() => {}} onDone={() => {}} />)
    await screen.findByText('billing@bcatcorp.com')
    expect(document.body.textContent).toContain('14525')
    expect(document.body.textContent).not.toContain('THEIR-INV-1')
  })
})
