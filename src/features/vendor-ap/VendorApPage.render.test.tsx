// @vitest-environment jsdom
/**
 * Smoke render for the vendor AP queue: it opens on what is still owed, and the Done
 * tab swaps to the paid rows.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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
  payable({ id: 'vp-3', vendor: 'Fake Cheap Vendor', invoiceNumber: 'INV-3', amount: 900, payAsap: true }),
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

  it('draws the bills as a dense grid with sort, filter and column controls', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    const grid = screen.getByRole('table', { name: 'Vendor bills' })
    expect(within(grid).getByRole('columnheader', { name: /Vendor/ })).toBeTruthy()
    expect(within(grid).getByRole('button', { name: 'Filter Amount' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Columns/ })).toBeTruthy()
    expect(screen.getByTestId('vendor-count').textContent).toContain('Showing 2 of 2')
  })

  it('sorts the amount column by cents, not text', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    const vendors = () => within(screen.getByRole('table', { name: 'Vendor bills' })).getAllByRole('row').slice(1).map((r) => r.textContent?.match(/Fake \w+ Vendor/)?.[0])
    fireEvent.click(screen.getByRole('button', { name: /^Amount$/ }))
    expect(vendors()).toEqual(['Fake Cheap Vendor', 'Fake Open Vendor'])
    fireEvent.click(screen.getByRole('button', { name: /^Amount$/ }))
    expect(vendors()).toEqual(['Fake Open Vendor', 'Fake Cheap Vendor'])
  })

  it('the Quickpay tab keeps only the pay-ASAP bills', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('tab', { name: /Quickpay/ }))
    expect(screen.getByText('Fake Cheap Vendor')).toBeTruthy()
    expect(screen.queryByText('Fake Open Vendor')).toBeNull()
  })

  it('By vendor swaps to the vendor grid and a row click drills into that vendor', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('tab', { name: 'By vendor' }))
    const grid = screen.getByRole('table', { name: 'Vendors' })
    expect(within(grid).getByRole('columnheader', { name: /Owed/ })).toBeTruthy()
    fireEvent.click(within(grid).getByText('Fake Cheap Vendor'))
    expect(screen.getByRole('table', { name: 'Vendor bills' })).toBeTruthy()
    expect((screen.getByPlaceholderText(/Search vendor/) as HTMLInputElement).value).toBe('Fake Cheap Vendor')
  })

  it('keeps Mark done on an unpaid row', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    expect(screen.getAllByRole('button', { name: /Mark done/ }).length).toBe(2)
  })
})
