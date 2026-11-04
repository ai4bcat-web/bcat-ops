// @vitest-environment jsdom
/** The Tracking desk: rate-con-sent shipments grouped by assignee. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TrackingWorkstation } from './TrackingWorkstation'
import type { ShipmentRow } from '../shipmentViews'

const now = Date.parse('2026-10-29T12:00:00Z')
const api = vi.hoisted(() => ({
  assignTracker: vi.fn(),
  runCheckCallPlan: vi.fn(),
  requestPod: vi.fn(),
  getShipmentBundle: vi.fn(),
  getTmsSettings: vi.fn(),
  listTrackingLinksByShipment: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
const refresh = vi.fn(async () => {})
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
let shipments: ShipmentRow[] = []
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'me@bcatcorp.com', userId: 'u-me', groups: ['ADMIN'] }, isAdmin: true, isOwner: false }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments, loading: false, error: null, refresh }) }))
vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({ nameOf: (id: string | null | undefined) => id ?? '—', me: { id: 'u-me' } }),
}))
// The real picker reads the staff list; here it offers fixed choices.
vi.mock('@/components/TrackerPicker', () => ({
  TrackerPicker: ({ onChange, 'aria-label': label }: { onChange: (id: string | null) => void; 'aria-label'?: string }) => (
    <div role="group" aria-label={label}>
      <button type="button" onClick={() => onChange('u-bob')}>pick Bob</button>
      <button type="button" onClick={() => onChange(null)}>pick nobody</button>
    </div>
  ),
}))

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: id,
    status: 'DISPATCHED',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    originCity: 'Austin, TX',
    destinationCity: 'Dallas, TX',
    pickupAppt: '2026-10-29T14:00:00Z',
    deliveryAppt: '2026-10-30T10:00:00Z',
    rateConStatus: 'SENT',
    createdBy: 'rep@bcatcorp.com',
    updatedBy: 'rep@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

const mine = row('S-MINE', { trackerId: 'u-me', trackerName: 'Me Myself' })
const mine2 = row('S-MINE2', { trackerId: 'u-me', trackerName: 'Me Myself' })
const ann = row('S-ANN', { trackerId: 'u-ann', trackerName: 'Ann Lee' })
const loose = row('S-LOOSE')
const unsent = row('S-UNSENT', { rateConStatus: 'NOT_SENT', trackerId: 'u-ann', trackerName: 'Ann Lee' })
const podDue = row('S-PODDUE', { status: 'DELIVERED', trackerId: 'u-ann', trackerName: 'Ann Lee', docsMissing: ['POD'] })
const podIn = row('S-PODIN', { status: 'DELIVERED', trackerId: 'u-ann', trackerName: 'Ann Lee', docsMissing: [] })
const overdue = row('S-OVERDUE', { trackerId: 'u-ann', trackerName: 'Ann Lee', nextCheckCallAt: '2026-10-29T11:25:00Z' })

function Probe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderPage(initial = '/tms/tracking') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/tms/tracking" element={<><TrackingWorkstation /><Probe /></>} />
        <Route path="/tms/tracking/links" element={<Probe />} />
        <Route path="/tms/shipments/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
}

function ids(): string[] {
  return [...document.querySelectorAll('[data-testid="tracking-row"]')].map((el) => el.getAttribute('data-shipment-id') ?? '')
}

function trackingRow(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="tracking-row"][data-shipment-id="${id}"]`)
  if (!el) throw new Error(`tracking row ${id} not rendered`)
  return el as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(now)
  localStorage.clear()
  shipments = [mine, mine2, ann, loose, unsent, podDue, podIn, overdue]
  api.getTmsSettings.mockResolvedValue(null)
  api.listTrackingLinksByShipment.mockResolvedValue([])
  api.assignTracker.mockResolvedValue({ updated: [], skipped: [] })
  api.runCheckCallPlan.mockResolvedValue({ action: 'CADENCE', reason: 'Asked the driver', messages: [] })
  api.requestPod.mockResolvedValue({ messages: [] })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('scope', () => {
  it('lists only shipments whose rate confirmation was sent, until asked for the rest', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(ids()).not.toContain('S-UNSENT')
    expect(ids()).toContain('S-LOOSE')

    fireEvent.click(screen.getByRole('button', { name: /Include loads without a TMS rate con/ }))
    expect(ids()).toContain('S-UNSENT')
  })

  it('keeps delivered shipments out of Active; POD due holds the ones without a POD, Closed the rest', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids()).toContain('S-ANN'))
    expect(ids()).not.toContain('S-PODDUE')
    expect(ids()).not.toContain('S-PODIN')

    fireEvent.click(screen.getByRole('tab', { name: 'POD due' }))
    expect(ids()).toEqual(['S-PODDUE'])

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }))
    expect(ids()).toEqual(['S-PODIN'])
  })
})

describe('assignee navigation', () => {
  it('opens on My loads when I track something, and writes the choice to ?assignee=', async () => {
    renderPage()
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(ids().sort()).toEqual(['S-MINE', 'S-MINE2'])

    fireEvent.click(screen.getByRole('tab', { name: /^Unassigned/ }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?assignee=unassigned'))
    expect(ids()).toEqual(['S-LOOSE'])
  })

  it('opens on All when nothing is mine', async () => {
    shipments = [ann, loose]
    renderPage()
    await waitFor(() => expect(ids().sort()).toEqual(['S-ANN', 'S-LOOSE']))
  })

  it('All groups by Assignee by default: Unassigned first, then one section per person A to Z, rows under their header', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    const keys = screen.getAllByTestId('dense-group').map((el) => el.getAttribute('data-group-key'))
    expect(keys).toEqual(['unassigned', 'u-ann', 'u-me'])
    // Rows follow their header in the one table: the Ann Lee header precedes only Ann's rows.
    const order = [...document.querySelectorAll('[data-testid="dense-group"], [data-testid="tracking-row"]')]
      .map((el) => el.getAttribute('data-group-key') ?? `row:${el.getAttribute('data-tracker-id')}`)
    expect(order).toEqual([
      'unassigned', 'row:',
      'u-ann', 'row:u-ann', 'row:u-ann',
      'u-me', 'row:u-me', 'row:u-me',
    ])
  })

  it('Group by switches the sections, and None lists the rows flat', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'status' } })
    expect(screen.getAllByTestId('dense-group').map((el) => el.getAttribute('data-group-key'))).toEqual(['DISPATCHED'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'none' } })
    expect(screen.queryAllByTestId('dense-group')).toHaveLength(0)
    expect(ids().length).toBe(5)
  })

  it('says so when nothing is assigned to me', async () => {
    shipments = [ann]
    renderPage('/tms/tracking?assignee=me')
    expect(await screen.findByTestId('tracking-empty')).toHaveTextContent('Nothing assigned to you')
  })
})

describe('row actions', () => {
  it('opens the shipment Tracking tab on a row click, but not when ticking its checkbox', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(within(trackingRow('S-ANN')).getByRole('checkbox'))
    expect(screen.getByTestId('location')).toHaveTextContent('/tms/tracking')

    fireEvent.click(trackingRow('S-ANN'))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tms/shipments/S-ANN?tab=tracking'))
  })

  it('reassigns the selected rows of a section in one call', async () => {
    renderPage()
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(within(trackingRow('S-MINE')).getByRole('checkbox'))
    fireEvent.click(within(trackingRow('S-MINE2')).getByRole('checkbox'))
    fireEvent.click(within(screen.getByRole('group', { name: 'Reassign 2 selected' })).getByText('pick Bob'))

    await waitFor(() => expect(api.assignTracker).toHaveBeenCalledWith({ shipmentIds: ['S-MINE', 'S-MINE2'], trackerId: 'u-bob' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('assigns or clears one row through the row menu', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    const menu = within(trackingRow('S-LOOSE'))
    fireEvent.click(menu.getByRole('button', { name: 'Assign tracker…' }))
    fireEvent.click(menu.getByText('pick nobody'))
    await waitFor(() => expect(api.assignTracker).toHaveBeenCalledWith({ shipmentIds: ['S-LOOSE'], trackerId: null }))
  })

  it('reports shipments the server refused to assign', async () => {
    api.assignTracker.mockResolvedValue({ updated: [], skipped: [{ shipmentId: 'S-LOOSE', reason: 'Shipment is voided' }] })
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    const menu = within(trackingRow('S-LOOSE'))
    fireEvent.click(menu.getByRole('button', { name: 'Assign tracker…' }))
    fireEvent.click(menu.getByText('pick Bob'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('S-LOOSE: Shipment is voided'))
  })

  it('requests a check call from the row menu', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(within(trackingRow('S-ANN')).getByRole('button', { name: 'Request check call' }))
    await waitFor(() => expect(api.runCheckCallPlan).toHaveBeenCalledWith({ shipmentId: 'S-ANN' }))
  })

  it('offers Request POD only once the shipment is delivered', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(within(trackingRow('S-ANN')).getByRole('button', { name: 'Request POD' })).toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: 'POD due' }))
    fireEvent.click(within(trackingRow('S-PODDUE')).getByRole('button', { name: 'Request POD' }))
    await waitFor(() => expect(api.requestPod).toHaveBeenCalledWith({ shipmentId: 'S-PODDUE' }))
  })
})

describe('computed cells', () => {
  it('flags an overdue check call and a POD that is needed', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(within(trackingRow('S-OVERDUE')).getByText('overdue 35 m')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'POD due' }))
    expect(within(trackingRow('S-PODDUE')).getByText('POD needed')).toBeInTheDocument()
  })
})

describe('legacy Inbox links', () => {
  it('sends ?tab=inbox&shipment= to the shipment Tracking tab', async () => {
    renderPage('/tms/tracking?tab=inbox&shipment=S-ANN')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tms/shipments/S-ANN?tab=tracking'))
  })

  it('offers no Inbox tab', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(screen.queryByRole('tab', { name: 'Inbox' })).not.toBeInTheDocument()
  })
})

describe('navigation', () => {
  it('Manage links reaches the Customer Links page', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /Manage links/i }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tms/tracking/links'))
  })
})

describe('dense grid', () => {
  it('has no side filter panel', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: /^Filters$/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Statuses')).not.toBeInTheDocument()
  })

  it('a header type-ahead narrows the rows', async () => {
    shipments = [
      row('S-A', { trackerId: 'u-ann', trackerName: 'Ann Lee', originCity: 'Austin, TX' }),
      row('S-B', { trackerId: 'u-ann', trackerName: 'Ann Lee', originCity: 'Boise, ID' }),
    ]
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Filter Lane' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Lane' }), { target: { value: 'boise' } })
    expect(ids()).toEqual(['S-B'])
    fireEvent.click(screen.getByRole('button', { name: /Clear 1 filter/ }))
    expect(ids().sort()).toEqual(['S-A', 'S-B'])
  })

  it('the Tracker multi-select narrows to one person', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Filter Tracker' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracker: Ann Lee' }))
    expect(ids().sort()).toEqual(['S-ANN', 'S-OVERDUE'])
  })

  it('the Next check numeric range keeps only overdue calls', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Filter Next check' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Next check max' }), { target: { value: '0' } })
    expect(ids()).toEqual(['S-OVERDUE'])
  })

  it('sorts a column on click, ascending then descending', async () => {
    shipments = [
      row('S-B', { customerName: 'Beta' }),
      row('S-C', { customerName: 'Gamma' }),
      row('S-A', { customerName: 'Alpha' }),
    ]
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids()).toHaveLength(3))
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'none' } })
    const header = within(screen.getByRole('columnheader', { name: /Customer/ })).getByRole('button', { name: 'Customer' })
    fireEvent.click(header)
    expect(ids()).toEqual(['S-A', 'S-B', 'S-C'])
    fireEvent.click(header)
    expect(ids()).toEqual(['S-C', 'S-B', 'S-A'])
  })

  it('restores the viewer\'s density, columns and group-by on the next visit', async () => {
    const first = renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Comfortable' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'status' } })
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Carrier DOT/MC' }))
    first.unmount()

    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: 'Comfortable' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('status')
    expect(screen.queryByRole('columnheader', { name: /Carrier DOT\/MC/ })).not.toBeInTheDocument()
  })

  it('keeps the PRO column sticky and the summary strip collapsed until asked for', async () => {
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    const pro = screen.getByRole('columnheader', { name: /Shipment #/ })
    expect(pro).toHaveClass('tms-dg-sticky')
    expect(within(trackingRow('S-ANN')).getAllByRole('cell')[1]).toHaveClass('tms-dg-sticky')
    expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Summary/ }))
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('Loads')
  })

  it('draws a bounded number of rows however many loads there are', async () => {
    shipments = Array.from({ length: 400 }, (_, i) => row(`S-${String(i).padStart(3, '0')}`, { trackerId: 'u-ann', trackerName: 'Ann Lee' }))
    renderPage('/tms/tracking?assignee=all')
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    expect(ids().length).toBeLessThan(60)
    expect(screen.getByText('Show 100 more')).toBeInTheDocument()
  })
})
