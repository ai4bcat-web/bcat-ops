// @vitest-environment jsdom
/**
 * Smoke render for the dispatch inbox: the page mounts under the TMS shell with every
 * data hook stubbed, shows its heading and primary action, and the filter control opens.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.test' }, isAdmin: false, isOwner: false }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [], updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [], updateLoad: vi.fn() }) }))
vi.mock('@/hooks/useLoadPaperwork', () => ({ useLoadPaperwork: () => ({ index: null, refresh: vi.fn() }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useDriverPhones: () => [] }))
vi.mock('@/hooks/useDispatch', () => ({
  useDispatch: () => ({
    conversations: [],
    selectedId: null,
    thread: [],
    threadLoading: false,
    loading: false,
    error: null,
    status: { configured: true, dispatchNumber: null, ringing: 0, slackBridge: false },
    select: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: { equipment: never[] }) => unknown) => sel({ equipment: [] }),
}))
vi.mock('@/lib/apiClient', () => ({ listTruckLocations: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/driverSubmissionsClient', () => ({ staffUploadDriverDoc: vi.fn() }))

import { DispatchPage } from './DispatchPage'

describe('DispatchPage render', () => {
  it('shows the heading, the new-message action and the empty inbox', () => {
    render(<MemoryRouter><DispatchPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Dispatch' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /New message/ })).toBeTruthy()
    expect(screen.getByText('No conversations here.')).toBeTruthy()
    expect(screen.getByText('Pick a conversation, or start a new message.')).toBeTruthy()
  })

  it('opens the filter dialog from the list toolbar', () => {
    render(<MemoryRouter><DispatchPage /></MemoryRouter>)
    fireEvent.click(screen.getByTitle('Filter by driver type or driver'))
    expect(screen.getByText('Filter conversations')).toBeTruthy()
  })
})
