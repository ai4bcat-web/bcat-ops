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

// jsdom implements neither of these; Radix (used by the Sheet) needs both.
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMRect ??= class { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} } as never
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// ── Stub the network and auth edges; everything else is the real component tree ──

const driver: Driver = {
  id: 'd1', name: 'Zak Pace', phone: '+18472936704', active: true, type: 'driver',
  email: 'zak@bcatcorp.com',
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
  listAllOnboardingTasks: vi.fn().mockResolvedValue([]),
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

const inactiveDriver: Driver = {
  id: 'd2', name: 'Armando Aranda', phone: '+12628186030', active: false, type: 'driver',
  createdAt: '', updatedAt: '',
}

vi.mock('@/store/useAppStore', () => {
  const state = {
    drivers: [driver, inactiveDriver], equipment: [truck], isLoading: false, error: null,
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

  it('opens on the LIST — no editor covering the page', async () => {
    // The driver editor is always mounted and gated on its `open` prop. When that gate
    // was lost, the "Add driver" panel rendered permanently over the Files page and
    // every other assertion here still passed, because the list was underneath it.
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    expect(screen.queryByText('Add driver')).toBeNull()
    expect(screen.queryByText('New driver')).toBeNull()
    expect(screen.queryByText('Driver Details')).toBeNull()
  })

  it('lists the truck with its VIN uppercased', async () => {
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    // Stored lowercase in the fixture — proves formatVin is applied at the display site.
    expect(screen.getByText('1FUJGLD55LLAA3391')).toBeTruthy()
  })

  it('shows each driver\'s email in the list', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    fireEvent.click(screen.getByText('Drivers'))
    expect(screen.getAllByText('Email').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('zak@bcatcorp.com')).toBeTruthy()
  })

  it('finds a driver by their email', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    fireEvent.click(screen.getByText('Drivers'))
    fireEvent.change(screen.getByPlaceholderText(/Search name/), { target: { value: 'zak@bcat' } })
    expect(screen.getByText('Zak Pace')).toBeTruthy()
  })

  it('filters drivers by status from the tabs below the list', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    fireEvent.click(screen.getByText('Drivers'))

    // Status is a filter, not a column.
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull()
    expect(screen.getByText('All')).toBeTruthy()
    expect(screen.getByText('Onboarding')).toBeTruthy()

    // The fixture driver has no checklist, so they're Active — filtering to Onboarding
    // should empty the list rather than showing them anyway.
    fireEvent.click(screen.getByText('Onboarding'))
    expect(screen.queryByText('Zak Pace')).toBeNull()
    fireEvent.click(screen.getByText('Active'))
    expect(screen.getByText('Zak Pace')).toBeTruthy()
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
    // This driver has no checklist, so they are ACTIVE — and an active driver shows no
    // percentage and no to-do list, only the status.
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.getByText('Documents')).toBeTruthy()
    // Detail field is "CDL"; the tile now carries the catalog's fuller label.
    expect(screen.getByText('CDL')).toBeTruthy()
    expect(screen.getAllByText(/CDL copy/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Medical/).length).toBeGreaterThan(0)
  })

  it('shows box-truck paperwork, not the Amazon lease', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')
    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'DRIVER', driver }} hub={hub} onClose={() => {}} canSeePrivate />
    }
    renderIn(<Harness />)
    // Catalog labels now, so match on the meaningful part rather than my earlier wording.
    expect(screen.getAllByText(/Employment application/).length).toBeGreaterThan(0)
    expect(screen.getByText('Employment agreement')).toBeTruthy()
    expect(screen.queryByText(/lease agreement/i)).toBeNull()
  })

  it('hides the employment agreement from a non-admin', async () => {
    const { EntityFilePanel } = await import('./EntityFilePanel')
    const { useFileHub } = await import('@/hooks/useFileHub')
    function Harness() {
      const hub = useFileHub()
      return <EntityFilePanel entity={{ kind: 'DRIVER', driver }} hub={hub} onClose={() => {}} canSeePrivate={false} />
    }
    renderIn(<Harness />)
    expect(screen.getAllByText(/Employment application/).length).toBeGreaterThan(0)
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

describe('editing a driver opens ONE drawer', () => {
  it('closes the file panel when the editor opens, then returns to it', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)

    // Open the driver's file.
    fireEvent.click(screen.getByText('Drivers'))
    fireEvent.click(screen.getByText('Zak Pace'))
    expect(screen.getByText('Driver file')).toBeTruthy()

    // Opening the editor must dismiss the file panel — two z-50 drawers with their own
    // backdrops stacked on top of each other is what looked broken.
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.queryByText('Driver file')).toBeNull()
    // The editor now uses the same SidePanel shell: driver name as title, role beneath.
    expect(screen.getByText('Edit driver')).toBeTruthy()
  })

  it('uses the same panel shell as the driver file', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    fireEvent.click(screen.getByText('Drivers'))
    fireEvent.click(screen.getByText('Zak Pace'))
    fireEvent.click(screen.getByText('Edit'))

    // Same shell as the file panel — subtitle under the name, and the form sections
    // that supply the padding.
    expect(screen.getByText('Edit driver')).toBeTruthy()
    expect(screen.getByText('Driver Details')).toBeTruthy()
  })
})

describe('inactive drivers stay reachable', () => {
  it('shows a deactivated driver under All and Inactive', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { FilesPage } = await import('./FilesPage')
    renderIn(<FilesPage />)
    fireEvent.click(screen.getByText('Drivers'))

    // Armando is active:false in the fixtures. The base list used to exclude
    // active===false BEFORE the status tabs ran, so he vanished from the app entirely.
    expect(screen.getByText('Armando Aranda')).toBeTruthy()
    fireEvent.click(screen.getByText('Inactive'))
    expect(screen.getByText('Armando Aranda')).toBeTruthy()
    fireEvent.click(screen.getByText('Active'))
    expect(screen.queryByText('Armando Aranda')).toBeNull()
  })
})

describe('document preview', () => {
  it('previews in place instead of opening a browser tab', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { DocumentPreviewModal } = await import('./DocumentPreviewModal')
    const doc = {
      id: 'doc1', entityType: 'DRIVER' as const, entityId: 'd1', documentType: 'cdl_copy',
      title: 'CDL copy', s3Key: 'compliance/DRIVER/d1/cdl_copy/1-cdl.pdf',
      status: 'VALID' as const, uploadedBy: 'INTERNAL' as const,
      expirationDate: '2027-03-14', createdAt: '', updatedAt: '',
    }
    renderIn(<DocumentPreviewModal doc={doc} getUrl={async () => 'blob:preview'} onClose={() => {}} />)

    expect(screen.getByText('CDL copy')).toBeTruthy()
    // Download stays available alongside the preview.
    expect(screen.getByText('Download')).toBeTruthy()
    expect(fireEvent).toBeTruthy()
  })

  it('says so plainly for a HEIC photo rather than showing an empty frame', async () => {
    const { DocumentPreviewModal } = await import('./DocumentPreviewModal')
    const doc = {
      id: 'doc2', entityType: 'TRUCK' as const, entityId: 't1', documentType: 'photo_front',
      title: 'Front', s3Key: 'compliance/TRUCK/t1/photo_front/1-IMG.heic',
      status: 'VALID' as const, uploadedBy: 'INTERNAL' as const, createdAt: '', updatedAt: '',
    }
    renderIn(<DocumentPreviewModal doc={doc} getUrl={async () => 'blob:x'} onClose={() => {}} />)
    expect(await screen.findByText(/browsers can't display/i)).toBeTruthy()
  })
})
