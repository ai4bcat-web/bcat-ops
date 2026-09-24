// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './AuthContext'
import { RequirePage } from '@/components/RequirePage'

const auth = vi.hoisted(() => ({
  email: 'dennis@bcatcorp.com',
  groups: ['page-loads'] as string[] | null,
  cachedGroups: ['page-settings'] as string[],
  refreshError: null as Error | null,
}))
vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: async () => ({ userId: 'staff', username: auth.email, signInDetails: { loginId: auth.email } }),
  fetchAuthSession: async (options?: { forceRefresh?: boolean }) => {
    if (options?.forceRefresh && auth.refreshError) throw auth.refreshError
    const groups = options?.forceRefresh ? auth.groups : auth.cachedGroups
    // Amplify resolves with no tokens once the refresh token is revoked.
    return groups === null ? {} : { tokens: { accessToken: { payload: { 'cognito:groups': groups } } } }
  },
  signIn: vi.fn(), signOut: vi.fn(), confirmSignIn: vi.fn(),
}))

function StaffView() {
  const { loading, user, hasPageAccess } = useAuth()
  if (loading) return <p>Checking access</p>
  if (!user) return <p>Signed out</p>
  return <>
    <nav>{hasPageAccess('loads') && <a href="/loads">Loads</a>}{hasPageAccess('settings') && <a href="/settings">Settings</a>}</nav>
    <Routes>
      <Route path="/settings" element={<RequirePage page="settings"><p>Protected settings content</p></RequirePage>} />
      <Route path="/loads" element={<RequirePage page="loads"><p>Allowed loads content</p></RequirePage>} />
    </Routes>
  </>
}
function openSettings() {
  return render(<MemoryRouter initialEntries={['/settings']}><AuthProvider><StaffView /></AuthProvider></MemoryRouter>)
}

beforeEach(() => {
  auth.email = 'dennis@bcatcorp.com'
  auth.groups = ['page-loads']
  auth.cachedGroups = ['page-loads']
  auth.refreshError = null
})
afterEach(cleanup)

describe('explicit staff page grants', () => {
  it('does not let Dennis bypass navigation or direct-route grants', async () => {
    openSettings()
    await screen.findByText('Allowed loads content')
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
    expect(screen.queryByText('Protected settings content')).toBeNull()
  })

  it('lets the Cognito ADMIN group open every page without grants', async () => {
    auth.email = 'staff@bcatcorp.com'
    auth.groups = auth.cachedGroups = ['ADMIN']
    openSettings()
    await screen.findByText('Protected settings content')
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Loads', 'Settings'])
  })

  it('keeps the owner able to administer the site without page grants', async () => {
    auth.email = 'ryne@bcatcorp.com'
    auth.groups = auth.cachedGroups = []
    openSettings()
    await screen.findByText('Protected settings content')
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy()
  })

  it('uses current grants rather than an older cached session', async () => {
    auth.email = 'staff@bcatcorp.com'
    auth.cachedGroups = ['page-settings']
    openSettings()
    await screen.findByText('Allowed loads content')
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
  })

  it('removes navigation and open-page access after revocation while signed in', async () => {
    auth.email = 'staff@bcatcorp.com'
    auth.groups = auth.cachedGroups = ['page-settings', 'page-loads']
    openSettings()
    await screen.findByText('Protected settings content')
    auth.groups = ['page-loads']
    fireEvent.focus(window)
    await waitFor(() => expect(screen.queryByText('Protected settings content')).toBeNull())
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
    expect(await screen.findByText('Allowed loads content')).toBeTruthy()
    auth.groups = []
    fireEvent.focus(window)
    await screen.findByText('No page access')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('signs a revoked session out instead of showing it as a permissions problem', async () => {
    auth.email = 'staff@bcatcorp.com'
    auth.groups = auth.cachedGroups = ['page-settings']
    openSettings()
    await screen.findByText('Protected settings content')
    auth.groups = null                      // disabled account: refresh returns no tokens
    fireEvent.focus(window)
    await screen.findByText('Signed out')
    expect(screen.queryByText('No page access')).toBeNull()
  })

  it('keeps a working session when a background grant refresh fails', async () => {
    auth.email = 'staff@bcatcorp.com'
    auth.groups = auth.cachedGroups = ['page-settings']
    openSettings()
    await screen.findByText('Protected settings content')
    auth.refreshError = new Error('network down')
    fireEvent.focus(window)
    await waitFor(() => expect(screen.getByText('Protected settings content')).toBeTruthy())
    expect(screen.queryByText('Signed out')).toBeNull()
  })
})
