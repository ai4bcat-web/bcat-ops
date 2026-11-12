// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OwnerOperatorSettlementsPage } from './OwnerOperatorSettlementsPage'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'

const auth = vi.hoisted(() => ({ value: { isAdmin: false, isOwner: false, grants: new Set<string>() } }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAdmin: auth.value.isAdmin, isOwner: auth.value.isOwner, hasPageAccess: (k: string) => auth.value.grants.has(k) }),
}))

// Both views are stubs here: they have their own suites. This one is about the page that hosts them.
type Props = { week?: string | null; onWeek?: (w: string) => void; viewSwitch?: React.ReactNode; initialDriverId?: string | null }
vi.mock('./OwnerOperatorPayPage', () => ({
  OwnerOperatorPayPage: ({ week, onWeek, viewSwitch, initialDriverId }: Props) => (
    <div data-testid="standard-view">{viewSwitch}<span data-testid="std-week">{String(week)}</span><span data-testid="std-driver">{String(initialDriverId)}</span>
      <button onClick={() => onWeek?.('2026-09-20')}>go back</button></div>
  ),
}))
vi.mock('@/features/driver-pay/DriverPayPage', () => ({
  DriverPayPage: ({ week, viewSwitch, initialDriverId }: Props) => (
    <div data-testid="amazon-view">{viewSwitch}<span data-testid="am-week">{String(week)}</span><span data-testid="am-driver">{String(initialDriverId)}</span></div>
  ),
}))

function Where() { const l = useLocation(); return <span data-testid="where">{l.pathname + l.search}</span> }
function mount(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/owner-operator-pay" element={<><OwnerOperatorSettlementsPage /><Where /></>} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { auth.value = { isAdmin: true, isOwner: false, grants: new Set() } })

describe('OwnerOperatorSettlementsPage', () => {
  it('opens on the standard view and flips to Amazon weeks in place, keeping the week', () => {
    mount('/owner-operator-pay?week=2026-10-04')
    expect(screen.getByTestId('standard-view')).toBeInTheDocument()
    expect(screen.getByTestId('std-week')).toHaveTextContent('2026-10-04')
    fireEvent.click(screen.getByRole('button', { name: 'Amazon weeks' }))
    expect(screen.getByTestId('amazon-view')).toBeInTheDocument()
    expect(screen.getByTestId('am-week')).toHaveTextContent('2026-10-04')
    expect(screen.getByTestId('where')).toHaveTextContent('view=amazon')
    fireEvent.click(screen.getByRole('button', { name: 'Standard weeks' }))
    expect(screen.getByTestId('standard-view')).toBeInTheDocument()
  })

  it('an old /driver-pay link (?view=amazon&week&driver) opens the Amazon week with that driver', () => {
    mount('/owner-operator-pay?view=amazon&week=2026-03-29&driver=drv-9')
    expect(screen.getByTestId('amazon-view')).toBeInTheDocument()
    expect(screen.getByTestId('am-week')).toHaveTextContent('2026-03-29')
    expect(screen.getByTestId('am-driver')).toHaveTextContent('drv-9')
  })

  it('stepping back before the first owner-operator week (Sep 27) moves to the Amazon view', () => {
    expect('2026-09-20' < OWNER_OP_FIRST_PERIOD).toBe(true)
    mount('/owner-operator-pay?week=2026-10-04')
    fireEvent.click(screen.getByText('go back'))
    expect(screen.getByTestId('amazon-view')).toBeInTheDocument()
    expect(screen.getByTestId('am-week')).toHaveTextContent('2026-09-20')
  })

  it('offers only the views the person holds a grant for', () => {
    auth.value = { isAdmin: false, isOwner: false, grants: new Set(['driverPay']) }
    mount('/owner-operator-pay')
    expect(screen.getByTestId('amazon-view')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Standard weeks' })).toBeNull()
    auth.value = { isAdmin: false, isOwner: false, grants: new Set(['ownerOperatorPay']) }
    mount('/owner-operator-pay?view=amazon')
    expect(screen.getAllByTestId('standard-view').length).toBeGreaterThan(0)
  })
})
