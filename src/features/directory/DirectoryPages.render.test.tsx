// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CustomerRecord, LocationRecord, Division } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

const customers: CustomerRecord[] = [
  {
    id: 'c1', name: 'Metz Logistics', contactName: 'John', contactEmail: 'john@metz.com', contactPhone: '+15550001',
    notes: '', mcNumber: '12345', dotNumber: '67890', billingEmail: 'billing@metz.com', billingContactName: 'Jane',
    billingPhone: '+15550002', billingAddress: { street: '100 Main St', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    paymentTermsDays: 30, creditLimitCents: 50000, creditHoldFlag: false, requiredDocsForInvoice: ['POD', 'BOL'],
    defaultDivisionKey: null, defaultSalesRepId: null, aliases: ['METZ'], normalizedName: 'metz logistics',
    active: true, apptWorkflow: 'NONE', mergedIntoId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
]

const locations: LocationRecord[] = [
  {
    id: 'l1', name: 'Metz Warehouse', city: 'Chicago', state: 'IL', zip: '60601', country: 'US',
    customerName: 'Metz Logistics', apptContactName: 'Dock', apptContactEmail: 'dock@metz.com', apptContactPhone: null,
    notes: '', lat: 41.878, lng: -87.629, timezone: 'America/Chicago', geohash6: 'dp3wmq',
    facilityType: 'SHIPPER', hours: '08:00-16:00', apptRule: 'APPT', apptLeadTimeHours: 24,
    dockNotes: '', lumperNotes: '', detentionNotes: '', contacts: [], customerIds: ['c1'], aliases: ['METZ WH'],
    normalizedName: 'metz warehouse', normalizedAddress: '100 main st chicago il 60601 us',
    active: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as LocationRecord,
]

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'admin@bcatcorp.com' }, isAdmin: true, isOwner: false }) }))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers,
    locations,
    loading: false,
    error: null,
    refresh: vi.fn(),
    addCustomer: vi.fn(),
    saveCustomer: vi.fn(),
    archiveCustomer: vi.fn(),
    addLocation: vi.fn(),
    saveLocation: vi.fn(),
    archiveLocation: vi.fn(),
  }),
}))
vi.mock('@/lib/apiClient', () => ({
  listDivisions: vi.fn(async () => [{ id: 'd1', key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true, createdAt: '', updatedAt: '' } satisfies Division]),
  previewLocationMerge: vi.fn(async () => ({ sourceId: 'l1', targetId: 'l1', loadCount: 0 })),
  startLocationMerge: vi.fn(async () => ({ id: 'j1', sourceId: 'l1', targetId: 'l1', status: 'PENDING', processedCount: 0 })),
  resumeLocationMerge: vi.fn(async () => ({ id: 'j1', sourceId: 'l1', targetId: 'l1', status: 'RUNNING', processedCount: 1 })),
  listLocationMergeJobs: vi.fn(async () => []),
  geocodeAddress: vi.fn(),
  autocompleteAddress: vi.fn(async () => []),
  getPlaceDetails: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : ''),
}))

const { CustomersPage, LocationsPage } = await import('./DirectoryPages')

describe('DirectoryPages', () => {
  it('renders the customer list', () => {
    render(<CustomersPage />)
    expect(screen.getByText('Metz Logistics')).toBeTruthy()
    expect(screen.getByText(/MC 12345/)).toBeTruthy()
  })

  it('renders the location list', () => {
    render(<LocationsPage />)
    expect(screen.getByText('Metz Warehouse')).toBeTruthy()
  })

  it('shows the location merge dialog for admins', async () => {
    render(<LocationsPage />)
    fireEvent.click(screen.getByTitle('Merge'))
    await waitFor(() => expect(screen.getByText('Merge locations (admin only)')).toBeTruthy())
  })

  // Both modals stay mounted across opens; the form hooks seed state once. Without a
  // per-record key, Edit showed a blank form and Save would have wiped the record.
  it('Edit location opens pre-filled with that record, after Add was opened first', async () => {
    render(<LocationsPage />)
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(screen.getByText('Add location')).toBeTruthy())
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Add location')).toBeNull())
    fireEvent.click(screen.getByTitle('Edit'))
    await waitFor(() => expect(screen.getByText('Edit location')).toBeTruthy())
    expect(screen.getByDisplayValue('Metz Warehouse')).toBeTruthy()
    expect(screen.getByDisplayValue('Chicago')).toBeTruthy()
  })

  it('Edit customer opens pre-filled with that record', async () => {
    render(<CustomersPage />)
    fireEvent.click(screen.getByTitle('Edit'))
    await waitFor(() => expect(screen.getByText('Edit customer')).toBeTruthy())
    expect(screen.getByDisplayValue('Metz Logistics')).toBeTruthy()
  })
})
