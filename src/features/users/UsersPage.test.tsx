// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { UserProfileRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
  listCognitoUsers: vi.fn(),
  listUserProfiles: vi.fn(),
  getUserGroups: vi.fn(),
  setUserPageGroups: vi.fn(),
  createCognitoUser: vi.fn(),
  setUserAdmin: vi.fn(),
  setUserRole: vi.fn(),
  setUserTeams: vi.fn(),
  setUserClaims: vi.fn(),
  updateUserProfile: vi.fn(),
  reinviteUser: vi.fn(),
  forceSignOut: vi.fn(),
  getTmsSettings: vi.fn(),
  listOwnershipDivisions: vi.fn(),
  setUserDivisions: vi.fn(),
  disableCognitoUser: vi.fn(),
  enableCognitoUser: vi.fn(),
  deleteCognitoUser: vi.fn(),
  resetCognitoPassword: vi.fn(),
}))

const auth = vi.hoisted(() => ({ loading: false, isOwner: true }))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('@/lib/apiClient', () => mocks)
vi.mock('sonner', () => ({ toast: toastMock }))

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

const profile = (over: Partial<UserProfileRecord> & { id: string }): UserProfileRecord => ({
  email: over.id,
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  auth.isOwner = true
  auth.loading = false
  mocks.listUserProfiles.mockResolvedValue([])
  mocks.getTmsSettings.mockResolvedValue({ id: 'default', teams: [] })
  mocks.listOwnershipDivisions.mockResolvedValue([])
})

describe('UsersPage', () => {
  it('shows owner as full access and lets admins manage page toggles', async () => {
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), username: 'owner', email: 'ryne@bcatcorp.com' },
      { ...sampleUser(), username: 'admin1', email: 'admin@example.com' },
    ])
    mocks.getUserGroups.mockResolvedValue([])
    mocks.setUserPageGroups.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText(/ryne@bcatcorp\.com/)).toBeInTheDocument())

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

  it('lets a non-owner admin set a role but not grant admin or delete', async () => {
    auth.isOwner = false
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), groups: [], profile: profile({ id: 'u-1', email: 'test@example.com', role: 'NONE' }) },
    ])

    renderPage()
    await waitFor(() => expect(screen.getByText(/test@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    expect(await screen.findByLabelText('Role for test@example.com')).toBeEnabled()

    const makeAdmin = screen.getByRole('button', { name: /Make admin/ })
    expect(makeAdmin).toBeDisabled()
    expect(makeAdmin).toHaveAttribute('title', 'Only the owner can do this')

    const del = screen.getByRole('button', { name: /Delete/ })
    expect(del).toBeDisabled()
    expect(del).toHaveAttribute('title', 'Only the owner can do this')
    expect(mocks.getUserGroups).not.toHaveBeenCalled()
  })

  it('sets the role by username and warns that it applies at next sign-in', async () => {
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), groups: [], profile: profile({ id: 'u-1', email: 'test@example.com', role: 'NONE' }) },
    ])
    mocks.setUserRole.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText(/test@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    fireEvent.change(await screen.findByLabelText('Role for test@example.com'), { target: { value: 'MANAGER' } })

    await waitFor(() => expect(mocks.setUserRole).toHaveBeenCalledWith('u-1', 'MANAGER'))
    expect(await screen.findByText(/apply the next time they sign in/i)).toBeInTheDocument()
  })

  it('writes the division codes a profile works in, offering only the live businesses', async () => {
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), groups: [], profile: profile({ id: 'u-1', email: 'test@example.com', divisions: ['BROKERAGE'] }) },
    ])
    mocks.listOwnershipDivisions.mockResolvedValue([
      { id: 'ASSETS', code: 'ASSETS', name: 'Assets', sortOrder: 1, active: true },
      { id: 'BROKERAGE', code: 'BROKERAGE', name: 'Brokerage', sortOrder: 2, active: true },
      { id: 'OLD', code: 'OLD', name: 'Retired', sortOrder: 3, active: false },
    ])
    mocks.setUserDivisions.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText(/test@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    const assets = await screen.findByRole('button', { name: 'Assets' })
    expect(screen.getByRole('button', { name: 'Brokerage' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Retired' })).not.toBeInTheDocument()

    fireEvent.click(assets)
    await waitFor(() => expect(mocks.setUserDivisions).toHaveBeenCalledWith('u-1', ['BROKERAGE', 'ASSETS']))
  })

  it('shows the Lambda refusal word for word', async () => {
    const refusal = 'Forbidden: only the owner may grant the ADMIN role.'
    mocks.listCognitoUsers.mockResolvedValue([
      { ...sampleUser(), groups: [], profile: profile({ id: 'u-1', email: 'test@example.com', role: 'NONE' }) },
    ])
    mocks.setUserRole.mockRejectedValue(new Error(refusal))

    renderPage()
    await waitFor(() => expect(screen.getByText(/test@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    const select = await screen.findByLabelText('Role for test@example.com')
    fireEvent.change(select, { target: { value: 'ADMIN' } })

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(refusal))
    // The optimistic role is rolled back and no sign-in notice is shown.
    await waitFor(() => expect(select).toHaveValue('NONE'))
    expect(screen.queryByText(/apply the next time they sign in/i)).not.toBeInTheDocument()
  })

  it('locks the pages a role grants and saves only the extra grants', async () => {
    mocks.listCognitoUsers.mockResolvedValue([
      {
        ...sampleUser(),
        groups: ['role-CUSTOMER_REP', 'page-loads'],
        profile: profile({ id: 'u-1', email: 'test@example.com', role: 'CUSTOMER_REP', extraPages: [] }),
      },
    ])
    mocks.setUserPageGroups.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText(/test@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    const pages = await waitFor(() => screen.getAllByTestId('user-page-toggle'))
    // The `loads` grant is labelled "Shipments" — one list, one word (Step R).
    const loads = pages.find((b) => b.textContent?.startsWith('Shipments'))!
    const dashboard = pages.find((b) => b.textContent?.startsWith('Dashboard'))!

    expect(loads).toHaveTextContent('from role')
    expect(loads).toBeDisabled()
    fireEvent.click(loads)
    expect(mocks.setUserPageGroups).not.toHaveBeenCalled()

    fireEvent.click(dashboard)
    await waitFor(() => expect(mocks.setUserPageGroups).toHaveBeenCalledWith('u-1', ['dashboard']))
    expect(dashboard).toHaveTextContent('extra')
  })

  it('invites with the chosen role', async () => {
    mocks.listCognitoUsers.mockResolvedValue([])
    mocks.createCognitoUser.mockResolvedValue(undefined)

    renderPage()
    await waitFor(() => expect(screen.getByText('No users found.')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'AR_AP' } })
    fireEvent.click(screen.getByRole('button', { name: /Send Invite/ }))

    await waitFor(() => expect(mocks.createCognitoUser).toHaveBeenCalledWith('new@example.com', { role: 'AR_AP', teamKeys: [] }))
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
    await waitFor(() => expect(screen.getByText(/editor@example\.com/)).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Toggle permissions'))

    const pageButtons = await waitFor(() => screen.getAllByTestId('user-page-toggle'))
    const dashboardButton = pageButtons.find((b) => b.textContent?.includes('Dashboard'))
    const loadsButton = pageButtons.find((b) => b.textContent?.includes('Shipments'))

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
    await waitFor(() => expect(screen.getByText(/a@example\.com/)).toBeInTheDocument())

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
