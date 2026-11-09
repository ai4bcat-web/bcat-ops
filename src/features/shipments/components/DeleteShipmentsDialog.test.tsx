// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { DeleteShipmentsResponse } from '@/lib/apiClient'

const { deleteShipments, restoreDeletedShipments } = vi.hoisted(() => ({
  deleteShipments: vi.fn(),
  restoreDeletedShipments: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  deleteShipments,
  restoreDeletedShipments,
  graphqlErrorText: () => '',
}))

import { DeleteShipmentsDialog } from './DeleteShipmentsDialog'

const empty = { invoices: [], carrierBills: [], commissions: [], factoringItems: [], payments: [], markers: [] }
const billed = {
  ...empty,
  invoices: [{ id: 'i1', number: 'INV-9', status: 'OPEN', totalCents: 150000, balanceCents: 50000 }],
  payments: [{ id: 'p1', model: 'ArPayment' as const, kind: 'ACH', amountCents: 100000 }],
}
const preview = (over: Partial<DeleteShipmentsResponse> = {}): DeleteShipmentsResponse => ({
  dryRun: true, force: false, exportPrefix: null, deleted: 0, failed: 0,
  results: [
    { shipmentId: 's1', number: 'S001', ok: true, outcome: 'PREVIEW', counts: { Shipment: 1, Load: 1 }, billing: empty },
    { shipmentId: 's2', number: 'S002', ok: false, outcome: 'REFUSED_BILLING', message: 'has billing', counts: { Shipment: 1 }, billing: billed },
  ],
  ...over,
})

const targets = [{ id: 's1', number: 'S001' }, { id: 's2', number: 'S002' }]

beforeEach(() => { vi.clearAllMocks() })

describe('DeleteShipmentsDialog', () => {
  it('lists each billing row exactly, and needs DELETE typed before it deletes only the clean shipment', async () => {
    deleteShipments.mockResolvedValueOnce(preview())
    const onDeleted = vi.fn()
    render(<DeleteShipmentsDialog shipments={targets} onClose={vi.fn()} onDeleted={onDeleted} />)

    const list = await screen.findByLabelText('Billing on S002')
    expect(list.textContent).toContain('Invoice INV-9')
    expect(list.textContent).toContain('1500.00')
    expect(list.textContent).toContain('500.00')
    expect(list.textContent).toContain('Customer payment p1')
    expect(deleteShipments).toHaveBeenCalledWith({ shipmentIds: ['s1', 's2'], dryRun: true, force: false, confirm: 'DELETE' })

    const button = screen.getByRole('button', { name: /^Delete 1 shipment$/ })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    expect(button).toBeEnabled()

    deleteShipments.mockResolvedValueOnce(preview({
      dryRun: false, exportPrefix: 'deletes/2026-11-09T10-00-00-000Z-ab12cd/', deleted: 1, failed: 1,
      results: [
        { shipmentId: 's1', number: 'S001', ok: true, outcome: 'DELETED', counts: { Shipment: 1 } },
        { shipmentId: 's2', number: 'S002', ok: false, outcome: 'REFUSED_BILLING', message: 'has billing', counts: {} },
      ],
    }))
    fireEvent.click(button)
    expect((await screen.findByTestId('export-prefix')).textContent).toBe('deletes/2026-11-09T10-00-00-000Z-ab12cd/')
    expect(deleteShipments).toHaveBeenLastCalledWith({ shipmentIds: ['s1', 's2'], dryRun: false, force: false, confirm: 'DELETE' })

    restoreDeletedShipments.mockResolvedValueOnce({ dryRun: false, exportPrefix: 'x', shipments: [{ id: 's1', number: 'S001' }], tables: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Restore deleted' }))
    await waitFor(() => expect(restoreDeletedShipments).toHaveBeenCalledWith({ exportPrefix: 'deletes/2026-11-09T10-00-00-000Z-ab12cd/', dryRun: false }))
    expect(await screen.findByText('Restore complete.')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onDeleted).toHaveBeenCalledWith({ restored: true })
  })

  it('force is a separate box that also needs FORCE typed, and re-previews with force', async () => {
    deleteShipments.mockResolvedValueOnce(preview())
    render(<DeleteShipmentsDialog shipments={targets} onClose={vi.fn()} onDeleted={vi.fn()} />)
    await screen.findByLabelText('Billing on S002')

    deleteShipments.mockResolvedValueOnce(preview({
      force: true,
      results: [
        { shipmentId: 's1', number: 'S001', ok: true, outcome: 'PREVIEW', counts: {}, billing: empty },
        { shipmentId: 's2', number: 'S002', ok: true, outcome: 'PREVIEW', counts: {}, billing: billed },
      ],
    }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Force/ }))
    await waitFor(() => expect(deleteShipments).toHaveBeenLastCalledWith({ shipmentIds: ['s1', 's2'], dryRun: true, force: true, confirm: 'DELETE' }))

    const button = await screen.findByRole('button', { name: /^Delete 2 shipments$/ })
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type FORCE to delete billing'), { target: { value: 'FORCE' } })
    expect(button).toBeEnabled()
  })

  it('shows a shared-payment refusal from a forced preview and offers no delete for it', async () => {
    deleteShipments.mockResolvedValueOnce(preview())
    render(<DeleteShipmentsDialog shipments={[targets[1]]} onClose={vi.fn()} onDeleted={vi.fn()} />)
    await screen.findByLabelText('Billing on S002')

    deleteShipments.mockResolvedValueOnce(preview({
      force: true,
      results: [{ shipmentId: 's2', number: 'S002', ok: false, outcome: 'REFUSED_SETTLEMENT', message: 'Payment p1 also pays S777; split it offline first', counts: {}, billing: billed }],
    }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Force/ }))
    expect((await screen.findByTestId('delete-message-s2')).textContent).toContain('split it offline')
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.change(screen.getByLabelText('Type FORCE to delete billing'), { target: { value: 'FORCE' } })
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled()
  })

  it('refuses a selection over the Lambda batch cap without calling it', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, number: `S${i}` }))
    render(<DeleteShipmentsDialog shipments={many} onClose={vi.fn()} onDeleted={vi.fn()} />)
    expect(screen.getByText(/at most 50/)).toBeTruthy()
    expect(deleteShipments).not.toHaveBeenCalled()
  })
})
