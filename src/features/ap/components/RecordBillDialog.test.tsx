// @vitest-environment jsdom
/**
 * Step AG: a queued invoice e-mail opens the Record-bill dialog pre-filled. A value on the e-mail
 * replaces the dialog's default; with no prefill the dialog is exactly what it was; and the
 * recorded bill's id reaches `onDone` so the queue can close its item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({ previewBill: vi.fn(), recordBill: vi.fn(), graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { RecordBillDialog } from './RecordBillDialog'

const PREVIEW = {
  readiness: { ready: true, reasons: [] },
  gate: { missing: [] },
  snapshot: {
    carrierName: 'Blue Line', billDate: '2026-11-04', dueAt: '2026-12-04', termsDays: 30, grossCents: 100_000, quickPay: false,
    quickPayFeeCents: 0, lines: [],
  },
  payee: { kind: 'CARRIER', paymentMethodId: null, remitTo: null },
  documents: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.previewBill.mockResolvedValue(PREVIEW)
  api.recordBill.mockResolvedValue({ bill: { id: 'bill-9', status: 'IN_REVIEW', netCents: 100_000 } })
})

const draw = (props: Partial<Parameters<typeof RecordBillDialog>[0]> = {}) =>
  render(<RecordBillDialog loadCarrierId="lc1" open onOpenChange={vi.fn()} onDone={vi.fn()} {...props} />)

describe('RecordBillDialog prefill', () => {
  it('shows the e-mail’s number, dates and amount instead of the defaults', async () => {
    draw({ prefill: { billNumber: 'INV-5521', billDate: '2026-11-01', dueAt: '2026-12-01', billedCents: 100_500 } })
    expect(await screen.findByLabelText('Carrier invoice number')).toHaveValue('INV-5521')
    expect(screen.getByLabelText('Bill date')).toHaveValue('2026-11-01')
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-12-01')
    expect(screen.getByLabelText('Billed amount')).toHaveValue('1005.00')
  })

  it('keeps the dialog’s own defaults when the e-mail lacked a value', async () => {
    draw({ prefill: { billNumber: 'INV-1', billDate: null, dueAt: null, billedCents: null } })
    expect(await screen.findByLabelText('Bill date')).toHaveValue('2026-11-04')
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-12-04')
    expect(screen.getByLabelText('Billed amount')).toHaveValue('1000.00')
  })

  it('without a prefill the invoice number starts blank, and onDone receives the recorded bill id', async () => {
    const onDone = vi.fn()
    draw({ onDone })
    expect(await screen.findByLabelText('Carrier invoice number')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('bill-9'))
  })
})
