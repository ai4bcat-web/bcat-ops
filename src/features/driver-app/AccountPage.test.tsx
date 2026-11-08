// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Outlet } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'

const api = { fetchMe: vi.fn(), fetchTrucks: vi.fn(), selectTruck: vi.fn() }
vi.mock('./driverApi', () => api)
vi.mock('./useDriverAuth', () => ({ useDriverAuth: () => ({ signOut: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { AccountPage } = await import('./AccountPage')

/** Stands in for DriverApp: owns the one theme instance and hands it down through the Outlet. */
function Shell() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  return <Outlet context={{ theme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }} />
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchMe.mockResolvedValue({
    driverId: 'd1', name: 'Jason', email: 'j@example.com', payGroup: 'AMAZON', active: true,
    program: 'SETTLEMENT', truck: { id: 'eq-1', unitNumber: '3114' },
  })
})

describe('AccountPage appearance', () => {
  it('offers dark from the default light theme and flips back', async () => {
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="account" element={<AccountPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to light theme' }))
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  it('has no appearance row outside the driver shell', async () => {
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route path="account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Jason')).toBeInTheDocument()
    expect(screen.queryByText('Appearance')).toBeNull()
  })
})
