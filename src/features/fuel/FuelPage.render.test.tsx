// @vitest-environment jsdom
/**
 * Fuel opens on this month with the EFS upload action; the range switch is mirrored into
 * the URL and the upload button opens the import modal.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    equipment: [{ id: 'eq-1', type: 'truck', unitNumber: '101', active: true, fuelCardNumbers: [] }],
    drivers: [],
    updateEquipment: vi.fn(),
  }),
}))
vi.mock('@/hooks/useFuelTransactions', () => ({
  useFuelTransactions: () => ({ transactions: [], loading: false, addTransactions: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/dashboard/DieselPriceWidget', () => ({ DieselPriceWidget: () => <div>diesel-stub</div> }))
vi.mock('@/features/expenses/FuelUploadModal', () => ({ FuelUploadModal: () => <div>upload-modal-stub</div> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { FuelPage } from './FuelPage'

const renderPage = () => render(<MemoryRouter><FuelPage /></MemoryRouter>)

describe('FuelPage render', () => {
  it('shows the heading, range switch and upload action', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Fuel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'This Month' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload EFS/ })).toBeTruthy()
    expect(screen.getByText('diesel-stub')).toBeTruthy()
  })

  it('opens the upload modal from the Upload EFS button', () => {
    renderPage()
    expect(screen.queryByText('upload-modal-stub')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Upload EFS/ }))
    expect(screen.getByText('upload-modal-stub')).toBeTruthy()
  })
})
