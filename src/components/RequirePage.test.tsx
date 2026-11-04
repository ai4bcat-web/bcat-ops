// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { LandingRedirect, RequirePage } from './RequirePage'

const auth = vi.hoisted(() => ({
  hasPageAccess: (_key: string) => false,
  isOwner: false,
  isAdmin: false,
}))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

function CurrentPath() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

function renderRedirect(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LandingRedirect />
              <CurrentPath />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('LandingRedirect', () => {
  beforeEach(() => {
    auth.hasPageAccess = () => false
    auth.isOwner = false
    auth.isAdmin = false
  })

  it('sends a loads-only user to /tms/shipments', () => {
    auth.hasPageAccess = (key) => key === 'loads'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/shipments')
  })

  it('still sends a tms-granted user to the Brokerage dashboard', () => {
    auth.hasPageAccess = (key) => key === 'tms'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/dashboard')
  })

  it('sends a loadReview-only user to Load Review', () => {
    auth.hasPageAccess = (key) => key === 'loadReview'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/load-review')
  })

  it('sends a carriers-only user to /tms/carriers', () => {
    auth.hasPageAccess = (key) => key === 'carriers'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/carriers')
  })

  it('shows a user with no page the no-access card instead of redirecting', () => {
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/)
    expect(screen.getByText('No page access')).toBeInTheDocument()
  })
})

describe('RequirePage', () => {
  beforeEach(() => {
    auth.hasPageAccess = () => false
    auth.isOwner = false
    auth.isAdmin = false
  })

  it('lets a loads-only user into /tms/shipments', () => {
    auth.hasPageAccess = (key) => key === 'loads'
    render(
      <MemoryRouter>
        <RequirePage page={['loads', 'tms']}>
          <div data-testid="content">shipments page</div>
        </RequirePage>
      </MemoryRouter>
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
  })
})
