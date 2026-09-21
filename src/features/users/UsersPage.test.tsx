// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
  listCognitoUsers: vi.fn(),
  getUserGroups: vi.fn(),
  setUserPageGroups: vi.fn(),
  createCognitoUser: vi.fn(),
  setUserAdmin: vi.fn(),
  disableCognitoUser: vi.fn(),
  enableCognitoUser: vi.fn(),
  resetCognitoPassword: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ loading: false, isOwner: true }),
}))

vi.mock('@/lib/apiClient', () => mocks)

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UsersPage } from './UsersPage'

function renderPage() {
  return render(
    <MemoryRouter>
      <UsersPage />
    </MemoryRouter>,
  )
}

const sampleUser = (over: Record<string, unknown> = {}) => ({
  username: 'u-1',
  email: 'test@example.com',
  status: 'CONFIRMED',
  enabled: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UsersPage', () => {
  it('shows owner as full access and lets non-owner admins manage page toggles', async () => {
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), username: 'owner', email: 'ryne@bcatcorp.com' },
      { ...sampleUser(), username: 'admin1', email: 'admin@example.com' },
    ])
    mocks.getUserGroups.mockResolvedValue([])
    mocks.setUserPageGroups.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText('ryne@bcatcorp.com')).toBeInTheDocument())

    expect(screen.getByText('Full access')).toBeInTheDocument()

    const toggles = screen.getAllByLabelText('Toggle permissions')
    expect(toggles).toHaveLength(2)
    fireEvent.click(toggles[1])

    const dashboardButton = (await waitFor(() => screen.getAllByTestId('user-page-toggle'))).find(
      (b) => b.textContent?.includes('Dashboard'),
    )
    expect(dashboardButton).toBeInTheDocument()

    fireEvent.click(dashboardButton!)
    await waitFor(() => expect(mocks.setUserPageGroups).toHaveBeenCalledTimes(1))
    expect(mocks.setUserPageGroups).toHaveBeenLastCalledWith('admin1', ['dashboard'])
  })

  it('disables page toggles while saving and prevents overlapping save requests for one user', async () => {
    let resolveSave: (value: void) => void = () => {}
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve
    })

    mocks.listCognitoUsers.mockResolvedValue([{ ...sampleUser(), username: 'u-2', email: 'editor@example.com' }])
    mocks.getUserGroups.mockResolvedValue([])
    mocks.setUserPageGroups.mockReturnValue(savePromise)

    renderPage()
    await waitFor(() => expect(screen.getByText('editor@example.com')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    const pageButtons = await waitFor(() => screen.getAllByTestId('user-page-toggle'))
    const dashboardButton = pageButtons.find((b) => b.textContent?.includes('Dashboard'))
    const loadsButton = pageButtons.find((b) => b.textContent?.includes('Loads'))

    expect(dashboardButton).toBeDefined()
    expect(loadsButton).toBeDefined()
    fireEvent.click(dashboardButton!)
    await waitFor(() => expect(mocks.setUserPageGroups).toHaveBeenCalledTimes(1))
    expect(mocks.setUserPageGroups).toHaveBeenLastCalledWith('u-2', ['dashboard'])

    // While save is in flight, page toggles for this user are disabled …
    expect(dashboardButton!).toBeDisabled()
    expect(loadsButton!).toBeDisabled()

    // … and clicking another toggle does not start a second request.
    fireEvent.click(loadsButton!)
    expect(mocks.setUserPageGroups).toHaveBeenCalledTimes(1)

    resolveSave()
    await waitFor(() => expect(dashboardButton!).not.toBeDisabled())
  })

  it('globally disables page toggles across users while any save is in flight', async () => {
    let resolveSave: (value: void) => void = () => {}
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve
    })

    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), username: 'u-a', email: 'a@example.com' },
      { ...sampleUser(), username: 'u-b', email: 'b@example.com' },
    ])
    mocks.getUserGroups.mockResolvedValue([])
    mocks.setUserPageGroups.mockReturnValue(savePromise)

    renderPage()
    await waitFor(() => expect(screen.getByText('a@example.com')).toBeInTheDocument())

    const cards = screen.getAllByTestId('user-card')
    expect(cards).toHaveLength(2)

    // Expand both user cards.
    const toggles = screen.getAllByLabelText('Toggle permissions')
    fireEvent.click(toggles[0])
    fireEvent.click(toggles[1])

    const aDashboard = await waitFor(() =>
      within(cards[0])
        .getAllByTestId('user-page-toggle')
        .find((b) => b.textContent?.includes('Dashboard')),
    )
    const bDashboard = within(cards[1])
      .getAllByTestId('user-page-toggle')
      .find((b) => b.textContent?.includes('Dashboard'))

    expect(aDashboard).toBeDefined()
    expect(bDashboard).toBeDefined()

    fireEvent.click(aDashboard!)
    await waitFor(() => expect(mocks.setUserPageGroups).toHaveBeenCalledTimes(1))
    expect(mocks.setUserPageGroups).toHaveBeenLastCalledWith('u-a', ['dashboard'])

    // User B's toggles are disabled even though the in-flight save is for user A.
    expect(aDashboard!).toBeDisabled()
    expect(bDashboard!).toBeDisabled()

    // Clicking user B's toggle does not fire a second request.
    fireEvent.click(bDashboard!)
    expect(mocks.setUserPageGroups).toHaveBeenCalledTimes(1)

    resolveSave()
    await waitFor(() => expect(aDashboard!).not.toBeDisabled())
    await waitFor(() => expect(bDashboard!).not.toBeDisabled())
  })
})
