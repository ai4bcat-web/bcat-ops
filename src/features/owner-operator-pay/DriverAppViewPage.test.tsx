// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import type { Driver } from '@/types'

vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn(async () => ({ tokens: { idToken: { toString: () => 'staff-tok' } } })) }))

// Both driver pages are stubbed: this file is about which one is chosen, not what they render.
vi.mock('@/features/driver-app/settlement/SettlementPage', () => ({
  SettlementPage: () => <div data-testid="settlement-page">settlement</div>,
}))
vi.mock('@/features/driver-app/paperwork/PaperworkPage', () => ({
  PaperworkPage: () => <div data-testid="paperwork-page">paperwork</div>,
}))

const setSupplier = vi.fn()
const setImpersonation = vi.fn()
vi.mock('@/features/driver-app/driverApi', () => ({
  setDriverTokenSupplier: (fn: unknown) => setSupplier(fn),
  setDriverImpersonation: (id: unknown) => setImpersonation(id),
}))

const driversMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: driversMock }))

const { DriverAppViewPage } = await import('./DriverAppViewPage')

function driver(over: Partial<Driver> = {}): Driver {
  return { id: 'd1', name: 'Charles Best', active: true, type: 'company', ...over } as Driver
}

function renderAs(d: Driver) {
  driversMock.mockReturnValue({ drivers: [d] })
  return render(
    <MemoryRouter initialEntries={[`/driver-view/${d.id}`]}>
      <Routes><Route path="/driver-view/:driverId" element={<DriverAppViewPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('viewing a driver’s app as an admin', () => {
  it('shows an Ivan driver their paperwork, not a settlement', async () => {
    /*
     * This frame was hardcoded to the settlement, which was right while only owner
     * operators had an app. On Ivan Driver App it rendered a settlement an Ivan driver does
     * not have — and the API now refuses that outright, so the panel came up empty.
     */
    renderAs(driver({ fleetGroup: 'LOCAL' }))
    await waitFor(() => expect(screen.getByTestId('paperwork-page')).toBeInTheDocument())
    expect(screen.queryByTestId('settlement-page')).not.toBeInTheDocument()
  })

  it('shows an owner operator their settlement', async () => {
    renderAs(driver({ name: 'Roy Workman', fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR' }))
    await waitFor(() => expect(screen.getByTestId('settlement-page')).toBeInTheDocument())
    expect(screen.queryByTestId('paperwork-page')).not.toBeInTheDocument()
  })

  it('keeps the settlement for a driver whose fleet is unset', async () => {
    // Same fail-safe as driverProgramOf: never take a pay page away on a blank record.
    renderAs(driver({ fleetGroup: undefined, driverType: undefined }))
    await waitFor(() => expect(screen.getByTestId('settlement-page')).toBeInTheDocument())
  })

  it('installs the impersonation before the page under it mounts', async () => {
    renderAs(driver({ fleetGroup: 'LOCAL' }))
    await waitFor(() => expect(screen.getByTestId('paperwork-page')).toBeInTheDocument())
    expect(setImpersonation).toHaveBeenCalledWith('d1')
    expect(setSupplier).toHaveBeenCalled()
  })

  it('says whose account is being viewed', async () => {
    renderAs(driver({ fleetGroup: 'LOCAL' }))
    await waitFor(() => expect(screen.getByText(/Charles Best — their app, live/)).toBeInTheDocument())
    expect(screen.getByText(/written to the audit log/)).toBeInTheDocument()
  })
})
