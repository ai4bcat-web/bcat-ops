// @vitest-environment jsdom
/** Smoke test: the Asset Documents page renders trucks, switches to trailers, and filters by search. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Equipment } from '@/types/equipment'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }))

const { truck, trailer } = vi.hoisted(() => {
  const base = {
    make: 'TestMake', model: 'TestModel', year: 2020, ownership: 'owned', insured: true,
    active: true, onTollwayAccount: false, createdAt: '', updatedAt: '',
  } as const
  return {
    truck: { ...base, id: 't1', type: 'truck', unitNumber: '214', vin: '1TESTVIN000000001', plate: 'TST111' } as Equipment,
    trailer: { ...base, id: 'tr1', type: 'trailer', unitNumber: '77', vin: '1TESTVIN000000002', plate: 'TST222' } as Equipment,
  }
})

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'test@example.com', userId: 'u1', groups: [] }, isAdmin: true, isOwner: true }),
}))

vi.mock('@/hooks/useFileHub', () => ({
  useFileHub: () => ({
    loading: false, error: null,
    docFor: () => undefined, docsForEntity: () => [], stateFor: () => 'missing', upload: vi.fn(),
  }),
}))

vi.mock('@/store/useAppStore', () => {
  const state = { drivers: [], equipment: [truck, trailer], isLoading: false }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { TruckDocumentsPage } from './TruckDocumentsPage'

afterEach(cleanup)

describe('TruckDocumentsPage renders', () => {
  it('shows the heading, tabs and the truck row', () => {
    render(<TruckDocumentsPage />)
    expect(screen.getByRole('heading', { name: 'Asset Documents' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Trucks/ })).toBeTruthy()
    expect(screen.getByText('#214')).toBeTruthy()
    expect(screen.queryByText('#77')).toBeNull()
  })

  it('Trailers tab swaps the rows', () => {
    render(<TruckDocumentsPage />)
    fireEvent.click(screen.getByRole('button', { name: /Trailers/ }))
    expect(screen.getByText('#77')).toBeTruthy()
    expect(screen.queryByText('#214')).toBeNull()
  })

  it('search with no match shows the empty state', () => {
    render(<TruckDocumentsPage />)
    fireEvent.change(screen.getByPlaceholderText('Search unit #, VIN, plate, make'), { target: { value: 'zzz' } })
    expect(screen.getByText('Nothing matches "zzz".')).toBeTruthy()
  })
})
