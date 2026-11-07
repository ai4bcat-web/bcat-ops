// @vitest-environment jsdom
/** Smoke test: the Load Intake page renders with an empty queue and the tabs are clickable. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const refresh = vi.fn()
vi.mock('@/hooks/useIntakeItems', () => ({
  useIntakeItems: () => ({ items: [], loading: false, refresh, updateItem: vi.fn() }),
}))
vi.mock('@/hooks/useResolveLoads', () => ({ useResolveLoads: vi.fn() }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [] }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'test@example.com' } }) }))
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/features/shipments/components/NewShipmentDialog', () => ({ NewShipmentDialog: () => null }))

vi.mock('@/store/useAppStore', () => {
  const state = {
    loads: [], newShipmentPrefill: null,
    setSelectedLoad: vi.fn(), openNewShipment: vi.fn(), closeNewShipment: vi.fn(),
  }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { IntakePage } from './IntakePage'

afterEach(cleanup)

describe('IntakePage renders', () => {
  it('shows the heading, Refresh and the empty active queue', () => {
    render(<IntakePage />)
    expect(screen.getByRole('heading', { name: 'Load Intake' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(screen.getByText('No active items — all clear')).toBeTruthy()
  })

  it('Refresh calls the hook and switching tab keeps the queue rendering', () => {
    render(<IntakePage />)
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(refresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'BCAT Logistics' }))
    expect(screen.getByText('No active items — all clear')).toBeTruthy()
  })
})
