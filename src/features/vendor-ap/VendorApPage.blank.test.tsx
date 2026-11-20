// @vitest-environment jsdom
/**
 * An e-mailed invoice nothing was read from yet shows what it is (its subject) with a
 * "Needs details" mark, and can be read again from the row or all at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VendorPayable } from '@/types/vendorAp'

const reread = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const refresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const base: VendorPayable = {
  id: 'vp-ok',
  status: 'NEED_TO_PAY',
  source: 'EMAIL',
  subject: 'Fake read bill',
  vendor: 'Fake Read Vendor',
  invoiceNumber: 'INV-1',
  amount: 12_500,
  attachments: [],
  receivedAt: '2026-01-02T12:00:00Z',
  createdAt: '2026-01-02T12:00:00Z',
  updatedAt: '2026-01-02T12:00:00Z',
}
const items: VendorPayable[] = [
  base,
  { ...base, id: 'vp-blank-1', subject: 'Fwd: Invoices Available [000111]', vendor: undefined, invoiceNumber: undefined, amount: undefined, fromEmail: 'staff@example.test' },
  { ...base, id: 'vp-blank-2', subject: 'Fwd: Rental Billing Invoice 000222', vendor: undefined, invoiceNumber: undefined, amount: undefined },
]

vi.mock('@/hooks/useVendorPayables', () => ({
  useVendorPayables: () => ({
    items, loading: false, error: null, pendingIds: new Set<string>(), refresh,
    getPayableDetails: vi.fn(), updateDetails: vi.fn(), recordPayment: vi.fn(), reopenPayable: vi.fn(),
    removePayable: vi.fn(), getAttachmentUrl: vi.fn(),
  }),
}))
vi.mock('@/lib/apiClient', () => ({ rereadVendorPayable: reread }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.test', groups: [] }, hasPageAccess: () => false }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: { maintenanceInvoices: never[]; equipment: never[] }) => unknown) =>
    sel({ maintenanceInvoices: [], equipment: [] }),
}))

import { VendorApPage } from './VendorApPage'
import { needsDetails } from '@/lib/vendorApBlank'

describe('blank e-mailed invoices', () => {
  beforeEach(() => { reread.mockClear(); refresh.mockClear() })

  it('knows a blank e-mailed bill from a read one', () => {
    expect(needsDetails(items[0])).toBe(false)
    expect(needsDetails(items[1])).toBe(true)
    expect(needsDetails({ ...items[1], status: 'DONE' })).toBe(false)
    expect(needsDetails({ ...items[1], source: 'MAINTENANCE' })).toBe(false)
  })

  it('shows the subject and a Needs details mark where the vendor is blank', () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    expect(screen.getByText('Fwd: Invoices Available [000111]')).toBeTruthy()
    expect(screen.getAllByText('Needs details')).toHaveLength(2)
  })

  it('reads one row again from its own button, without opening the row', async () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    fireEvent.click(screen.getAllByRole('button', { name: /Re-read$/ })[0])
    await waitFor(() => expect(reread).toHaveBeenCalledWith('vp-blank-1'))
    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('reads every blank row from the toolbar button', async () => {
    render(<MemoryRouter><VendorApPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /Re-read 2 blank/ }))
    await waitFor(() => expect(reread).toHaveBeenCalledTimes(2))
    expect(reread.mock.calls.map((c) => c[0])).toEqual(['vp-blank-1', 'vp-blank-2'])
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
})
