// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { reconcileMock, createMock, releaseMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(),
  createMock: vi.fn(),
  releaseMock: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  reconcileBilling: reconcileMock,
  createMissingApRecords: createMock,
  releaseToBilling: releaseMock,
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BillingGapsPanel } from './BillingGapsPanel'

const gap = {
  orderId: 'o1', shipmentId: 's1', shipmentNumber: '20027', customerName: 'THE ROYAL GROUP', releasedAt: null, arStatus: 'UNPAID',
  arMissing: false, arReason: null,
  apMissing: [{ loadCarrierId: 'lc1', carrierName: 'SHERIFAJ TRUCKING INC', grossCents: 147000 }],
  apUnbillable: [],
}

describe('BillingGapsPanel', () => {
  beforeEach(() => { reconcileMock.mockReset(); createMock.mockReset(); releaseMock.mockReset() })

  it('renders nothing when every released load reached AR and AP', async () => {
    reconcileMock.mockResolvedValue({ gaps: [], checked: 3 })
    const { container } = render(<BillingGapsPanel />)
    await waitFor(() => expect(reconcileMock).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('lists a load missing from AP and creates its record on request', async () => {
    reconcileMock.mockResolvedValueOnce({ gaps: [gap], checked: 1 }).mockResolvedValue({ gaps: [], checked: 1 })
    createMock.mockResolvedValue({ gaps: [] })
    const onFixed = vi.fn()
    render(<BillingGapsPanel onFixed={onFixed} />)
    expect(await screen.findByText(/Missing from AP\/AR: 1 released load/)).toBeTruthy()
    expect(screen.getByText(/Not in AP: SHERIFAJ TRUCKING INC/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create AP record' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('o1'))
    await waitFor(() => expect(onFixed).toHaveBeenCalled())
  })
})
