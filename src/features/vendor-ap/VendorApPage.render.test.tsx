// @vitest-environment jsdom
/**
 * Smoke render for the vendor AP queue: it opens on what is still owed, and the Done
 * tab swaps to the paid rows.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VendorPayable } from '@/types/vendorAp'

const payable = (over: Partial<VendorPayable>): VendorPayable => ({
  id: 'vp-1',
  status: 'NEED_TO_PAY',
  source: 'EMAIL',
  subject: 'Fake bill',
  vendor: 'Fake Open Vendor',
  invoiceNumber: 'INV-1',
  amount: 12_500,
  attachments: [],
  receivedAt: '2026-01-02T12:00:00Z',
  createdAt: '2026-01-02T12:00:00Z',
  updatedAt: '2026-01-02T12:00:00Z',
  ...over,
})

const items = [
  payable({}),
  payable({ id: 'vp-2', status: 'DONE', vendor: 'Fake Paid Vendor', invoiceNumber: 'INV-2', paymentMethod: 'ACH' }),
]

vi.mock('@/hooks/useVendorPayables', () => ({
  useVendorPayables: () => ({
    items,
    loading: false,
    error: null,
    pendingIds: new Set<string>(),
    refresh: vi.fn().mockResolvedValue(undefined),
    getPayableDetails: vi.fn(),
    updateDetails: vi.fn(),
    recordPayment: vi.fn(),
    reopenPayable: vi.fn(),
    removePayable: vi.fn(),
    getAttachmentUrl: vi.fn(),
  }),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.test', groups: [] }, hasPageAccess: () => false }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: { maintenanceInvoices: never[]; equipment: never[] }) => unknown) =>
    sel({ maintenanceInvoices: [], equipment: [] }),
}))

import { VendorApPage } from './VendorApPage'

describe('VendorApPage render', () => {
  it('opens on the unpaid bills with the heading and search visible', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Vendors' })).toBeTruthy()
    expect(screen.getByPlaceholderText(/Search vendor/)).toBeTruthy()
    expect(screen.getByText('Fake Open Vendor')).toBeTruthy()
    expect(screen.queryByText('Fake Paid Vendor')).toBeNull()
  })

  it('the Done tab shows the paid bill instead', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('tab', { name: /Done/ }))
    expect(screen.getByText('Fake Paid Vendor')).toBeTruthy()
    expect(screen.queryByText('Fake Open Vendor')).toBeNull()
  })
})
