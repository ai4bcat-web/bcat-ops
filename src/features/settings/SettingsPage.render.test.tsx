// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TmsSettings } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'admin@bcatcorp.com' }, isAdmin: true, isOwner: false }) }))
vi.mock('@/lib/apiClient', () => ({
  listDivisions: vi.fn(async () => []),
  saveDivision: vi.fn(),
  getTmsSettings: vi.fn(async () => ({ id: 'default', defaultPaymentTermsDays: 30, accessorialCodes: ['POD', 'BOL'] } as TmsSettings)),
  saveTmsSettings: vi.fn(),
}))

const { SettingsPage } = await import('./SettingsPage')

describe('SettingsPage', () => {
  it('renders admin-only division and TMS settings sections', async () => {
    render(<SettingsPage />)
    expect(screen.getAllByText('Divisions').length).toBeGreaterThan(0)
    expect(screen.getAllByText('TMS defaults').length).toBeGreaterThan(0)
  })

  it('Add division opens the create form', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByText('Add division')).toBeTruthy())
    expect(screen.queryByText('Key *')).toBeNull()
    fireEvent.click(screen.getByText('Add division'))
    expect(screen.getByText('Key *')).toBeTruthy()
  })
})
