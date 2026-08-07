// @vitest-environment jsdom
/**
 * Smoke tests that the Files hub and its driver panel actually RENDER.
 *
 * Every other test in this repo exercises pure logic. None of them would catch the
 * failure mode that matters most here: a component that throws on mount — a
 * temporal-dead-zone reference, a hook called conditionally, a map over something
 * undefined — which shows the user a blank page while the whole suite stays green.
 *
 * That gap is real: an earlier version of fileHub.ts built TRUCK_FILE_SLOTS from a
 * helper declared below it, which typechecked and passed every test but would have
 * thrown on import in the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

// ── Stub the network and auth edges; everything else is the real component tree ──

const driver: Driver = {
  id: 'd1', name: 'Zak Pace', phone: '+18472936704', active: true, type: 'driver',
  cdl: 'CDL-A IL-8823901', cdlExpiration: '2027-03-14', medCardExpiration: '2026-11-01',
  fleetGroup: 'BOX_TRUCK', assignedTruckId: 't1', createdAt: '', updatedAt: '',
}

const truck: Equipment = {
  id: 't1', type: 'truck', unitNumber: '214', vin: '1fujgld55llaa3391', plate: 'P123456',
  make: 'Freightliner', model: 'Cascadia', year: 2020, ownership: 'owned', insured: true,
  active: true, onTollwayAccount: false, fleetGroup: 'LOCAL', createdAt: '', updatedAt: '',
}

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com', userId: 'u1', groups: [] }, isAdmin: true, isOwner: true }),
}))

vi.mock('@/lib/complianceClient', () => ({
  listAllComplianceDocuments: vi.fn().mockResolvedValue([]),
  listOnboardingTasks: vi.fn().mockResolvedValue([]),
  ensureComplianceSettings: vi.fn().mockResolvedValue({
    id: 's1', settingsKey: 'GLOBAL', portalEmailsPaused: true, escalationEmailsPaused: true,
    privateDocumentTypes: null, createdAt: '', updatedAt: '',
  }),
  updateComplianceSettings: vi.fn(),
  createComplianceDocument: vi.fn(),
  updateComplianceDocument: vi.fn(),
  uploadComplianceDocument: vi.fn(),
  getComplianceDocUrl: vi.fn().mockResolvedValue('https://example.test/x.pdf'),
  isAcceptedDoc: () => true,
  ACCEPTED_DOC_EXT: '.pdf',
  generateChecklist: vi.fn(),
  setTaskStatus: vi.fn(),
  updateOnboardingTask: vi.fn(),
  createOnboardingInvite: vi.fn(),
  generateInviteToken: () => 'tok',
  inviteExpiry: () => '2026-12-31',
  buildPortalUrl: (t: string) => `https://portal.test/${t}`,
  writeComplianceAudit: vi.fn(),
  sendOnboardingEmail: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  driverTrailerFieldDeployed: () => true,
  uploadDriverPhoto: vi.fn(),
  deleteDriverPhoto: vi.fn(),
}))

vi.mock('@/store/useAppStore', () => {
  const state = {
    drivers: [driver], equipment: [truck], isLoading: false, error: null,
    updateDriver: vi.fn(), updateEquipment: vi.fn(), addDriver: vi.fn(), deleteDriver: vi.fn(),
    assignTruckToDriver: vi.fn(),
  }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

const renderIn = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => { vi.clearAllMocks() })

describe('Files hub renders', () => {
  it('mounts without throwing and shows both tabs', async () => {
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    expect(screen.getByText('Files')).toBeTruthy()
    expect(screen.getByText('Trucks')).toBeTruthy()
    expect(screen.getByText('Drivers')).toBeTruthy()
  })

  it('lists the truck with its VIN uppercased', async () => {
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    // Stored lowercase in the fixture — proves formatVin is applied at the display site.
    expect(screen.getByText('1FUJGLD55LLAA3391')).toBeTruthy()
  })

  it('shows the admin-only Private docs control', async () => {
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    expect(screen.getByText('Private docs')).toBeTruthy()
  })
})

describe('driver file panel renders', () => {
  it('mounts with the onboarding section, progress and document tiles', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')

    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'DRIVER', driver }} hub={hub} onClose={() => {}} canSeePrivate />
    }
    renderIn(<Harness />)

    expect(screen.getByText('Zak Pace')).toBeTruthy()
    expect(screen.getByText('Onboarding')).toBeTruthy()
    // 0% for a driver with no checklist — the deliberate choice, asserted on screen.
    expect(screen.getByText('0%')).toBeTruthy()
    expect(screen.getByText('Documents')).toBeTruthy()
    // "CDL" appears twice — as a detail field and as a document tile. Both are correct.
    expect(screen.getAllByText('CDL').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Medical card')).toBeTruthy()
  })

  it('shows box-truck paperwork, not the Amazon lease', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')
    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'DRIVER', driver }} hub={hub} onClose={() => {}} canSeePrivate />
    }
    renderIn(<Harness />)
    expect(screen.getByText('Job application')).toBeTruthy()
    expect(screen.getByText('Employment agreement')).toBeTruthy()
    expect(screen.queryByText('Lease agreement')).toBeNull()
  })

  it('hides the employment agreement from a non-admin', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')
    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'DRIVER', driver }} hub={hub} onClose={() => {}} canSeePrivate={false} />
    }
    renderIn(<Harness />)
    expect(screen.getByText('Job application')).toBeTruthy()
    expect(screen.queryByText('Employment agreement')).toBeNull()
  })

  it('renders a truck file with its photo slots', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')
    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'TRUCK', truck }} hub={hub} onClose={() => {}} canSeePrivate />
    }
    renderIn(<Harness />)
    expect(screen.getByText('Truck 214')).toBeTruthy()
    expect(screen.getByText('VIN plate')).toBeTruthy()
    // I-PASS is Local/Box Truck only, and this truck is LOCAL.
    expect(screen.getByText('I-PASS')).toBeTruthy()
  })
})
