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

  it('sends a tms-only user to the Shipments board', () => {
    auth.hasPageAccess = (key) => key === 'tms'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/shipments')
  })

  it('sends a calendar-only user (lost page-dashboard) to /calendar', () => {
    auth.hasPageAccess = (key) => key === 'calendar'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/calendar')
  })

  it('prefers /dashboard over the Shipments board when a user holds both grants', () => {
    auth.hasPageAccess = (key) => key === 'dashboard' || key === 'tms'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/dashboard')
  })

  it('sends an admin or owner (every grant) to /dashboard', () => {
    auth.hasPageAccess = () => true
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/dashboard')
  })

  it('sends a loadReview-only user to Load Review', () => {
    auth.hasPageAccess = (key) => key === 'loadReview'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/load-review')
  })

  it('sends a carriers-only user to the Carriers page (under Profiles)', () => {
    auth.hasPageAccess = (key) => key === 'carriers'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/tms/carriers')
  })

  it('shows a user with no page the no-access card instead of redirecting', () => {
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/)
    expect(screen.getByText('No page access')).toBeInTheDocument()
  })

  it('sends the dashboard grant (Ruben) to /dashboard', () => {
    auth.hasPageAccess = (key) => key === 'dashboard'
    renderRedirect()
    expect(screen.getByTestId('path')).toHaveTextContent('/dashboard')
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

  describe('the /dashboard guard', () => {
    function renderGuarded(path: string) {
      return render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/dashboard" element={<RequirePage page="dashboard"><div data-testid="dash">dashboard</div></RequirePage>} />
            <Route path="/tms/shipments" element={<RequirePage page={['loads', 'tms']}><div data-testid="ship">shipments</div></RequirePage>} />
            <Route path="/calendar" element={<RequirePage page="calendar"><div data-testid="cal">calendar</div></RequirePage>} />
            <Route path="*" element={<CurrentPath />} />
          </Routes>
        </MemoryRouter>
      )
    }

    it('opens for the dashboard grant, and for an admin, who holds every grant', () => {
      auth.hasPageAccess = (key) => key === 'dashboard'
      renderGuarded('/dashboard').unmount()
      auth.hasPageAccess = () => true
      renderGuarded('/dashboard')
      expect(screen.getByTestId('dash')).toBeInTheDocument()
    })

    it('sends a user who lost the grant to a page they can open, once, without a loop', () => {
      auth.hasPageAccess = (key) => key === 'calendar'
      renderGuarded('/dashboard')
      expect(screen.getByTestId('cal')).toBeInTheDocument()
    })

    it('sends a tms-only user to the Shipments board, which accepts their grant', () => {
      auth.hasPageAccess = (key) => key === 'tms'
      renderGuarded('/dashboard')
      expect(screen.getByTestId('ship')).toBeInTheDocument()
    })

    it('shows the no-access card, not an error or a loop, to a user who can open nothing', () => {
      renderGuarded('/dashboard')
      expect(screen.getByText('No page access')).toBeInTheDocument()
    })
  })
})
