// @vitest-environment jsdom
/**
 * Invoices lists posted repair invoices; New Invoice opens the entry form.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    equipment: [{ id: 'eq-1', type: 'truck', unitNumber: '101', nickname: 'Test Truck', active: true }],
    maintenanceInvoices: [
      { id: 'inv-1', equipmentId: 'eq-1', date: '2026-01-15', vendor: 'Test Repair Shop', description: 'Brake job', amount: 120000, invoiceNumber: 'T-1' },
    ],
    maintenanceTasks: [],
    addMaintenanceInvoice: vi.fn(),
    updateMaintenanceInvoice: vi.fn(),
    deleteMaintenanceInvoice: vi.fn(),
    refreshMaintenanceInvoices: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'tester@example.com' }, hasPageAccess: () => true }),
}))
vi.mock('@/lib/apiClient', () => ({ sendMaintenanceInvoiceToVendorAp: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { InvoicesPage } from './InvoicesPage'

const renderPage = () => render(<MemoryRouter><InvoicesPage /></MemoryRouter>)

describe('InvoicesPage render', () => {
  it('shows the heading, tabs, New Invoice control and the invoice row', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Review Queue/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /New Invoice/ })).toBeTruthy()
    expect(screen.getByText('Test Repair Shop')).toBeTruthy()
  })

  it('opens the New Invoice form', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /New Invoice/ }))
    expect(screen.getByText('Invoice Details')).toBeTruthy()
  })
})
