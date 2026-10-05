// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const api = {
  fetchPaperwork: vi.fn(),
  fetchPaperworkWeeks: vi.fn(),
  saveLoadTimes: vi.fn(),
  fetchSubmissions: vi.fn(),
  fetchRecentLoads: vi.fn(),
}
vi.mock('../driverApi', () => api)

const { PaperworkPage } = await import('./PaperworkPage')

function load(over: Record<string, unknown> = {}) {
  return {
    id: 'load-1',
    reference: '14538',
    customer: 'Wayfinder Logistics',
    deliveryAppt: '2026-10-06T15:00:00Z',
    pickupAppt: '2026-10-05T13:00:00Z',
    origin: 'Chicago, IL',
    destination: 'Indianapolis, IN',
    miles: 185,
    trailerNumber: 'TRL-42',
    commodity: 'Paper goods',
    weight: 41000,
    pieces: 22,
    notes: 'Dock 7',
    status: 'DELIVERED',
    stops: [],
    pod: { present: false, pages: 0, legibility: 'UNKNOWN', notes: null },
    pickupTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
    deliveryTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z')) // inside the 2026-10-04 week
  api.fetchPaperworkWeeks.mockResolvedValue([
    { weekStart: '2026-10-04', loadCount: 1, podsMissing: 1, podsIllegible: 0 },
  ])
  api.fetchPaperwork.mockResolvedValue({
    weekStart: '2026-10-04', loads: [load()], loadCount: 1, podsMissing: 1, podsIllegible: 0,
  })
  api.fetchSubmissions.mockResolvedValue([])
  api.fetchRecentLoads.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

function renderPage() {
  return render(<MemoryRouter><PaperworkPage /></MemoryRouter>)
}

describe('Ivan paperwork', () => {
  it('lists the week’s loads with their details', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('14538')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText('Wayfinder Logistics')).toBeTruthy()
    expect(screen.getByText(/Chicago, IL.*Indianapolis, IN/)).toBeTruthy()
    expect(screen.getByText('185')).toBeTruthy()
    expect(screen.getByText('TRL-42')).toBeTruthy()
    expect(screen.getByText('Paper goods')).toBeTruthy()
    expect(screen.getByText('41,000 lb')).toBeTruthy()
  })

  it('shows no rate and no settlement anywhere on the page', async () => {
    /*
     * The requirement that makes this a separate page. An Ivan driver is not settled a
     * percentage, so no money may appear — and because the payload has none, there is
     * nothing for the UI to accidentally render.
     */
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('14538')).toBeTruthy(), { timeout: 5000 })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\$/)
    expect(text).not.toMatch(/rate\b/i)
    expect(text).not.toMatch(/deduction|gross|check amount|settlement/i)
  })

  it('says which loads still need a POD', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('POD needed')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/1 load still need a POD/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Send POD/ })).toBeTruthy()
  })

  it('flags a POD that cannot be read, and says what was wrong with it', async () => {
    // Worse than a missing POD: the driver believes they are done.
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({
        pod: { present: true, pages: 2, legibility: 'UNREADABLE', notes: 'the photo is blurry — hold still and tap to focus' },
      })],
      loadCount: 1, podsMissing: 0, podsIllegible: 1,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('POD unreadable')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/blurry/)).toBeTruthy()
    expect(screen.getByText(/1 POD cannot be read/)).toBeTruthy()
    // And the way to fix it is on the row.
    expect(screen.getByRole('button', { name: /Replace POD/ })).toBeTruthy()
  })

  it('stays quiet when the POD is on file and readable', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({ pod: { present: true, pages: 3, legibility: 'OK', notes: null } })],
      loadCount: 1, podsMissing: 0, podsIllegible: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText(/POD on file · 3 pages/)).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText(/still need a POD/)).toBeNull()
    expect(screen.queryByText(/cannot be read/)).toBeNull()
  })

  it('defaults to the current week and offers history', async () => {
    api.fetchPaperworkWeeks.mockResolvedValue([
      { weekStart: '2026-09-27', loadCount: 4, podsMissing: 0, podsIllegible: 0 },
    ])
    renderPage()
    // The week in progress, even though the API listed only the one before it.
    await waitFor(() => expect(api.fetchPaperwork).toHaveBeenCalledWith('2026-10-04'), { timeout: 5000 })
  })

  it('offers to record times at both ends of the load', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Pickup times/ })).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: /Delivery times/ })).toBeTruthy()
  })

  it('shows recorded detention on the row', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({
        deliveryTimes: { timeIn: '2026-10-06T08:00', timeOut: '2026-10-06T11:30', notes: null, hours: 3.5, billable: true },
      })],
      loadCount: 1, podsMissing: 1, podsIllegible: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText(/Detention recorded/)).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/delivery 3.5h/)).toBeTruthy()
  })
})

/*
 * The page is rendered in two places: the driver's dark phone shell, and the staff
 * "View as driver" frame, which is a white panel in the staff theme. It was written with
 * hardcoded dark classes (text-white on bg-slate-900), so inside the staff frame it drew
 * white text on white — an admin saw an empty card with a Retry button and no message.
 * SettlementPage has always used the semantic classes and renders correctly in both.
 */
describe('rendering inside the staff View-as-driver frame', () => {
  it('uses theme-aware classes, never hardcoded dark ones', async () => {
    const { readFileSync } = await import('node:fs')
    const files = [
      'src/features/driver-app/paperwork/PaperworkPage.tsx',
      'src/features/driver-app/paperwork/PaperworkRows.tsx',
      'src/features/driver-app/paperwork/LoadTimesSheet.tsx',
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} must not hardcode dark-only colours`).not.toMatch(/text-white|text-slate-\d|bg-slate-\d|#0b1220/)
    }
  })

  it('shows the error message rather than an empty card', async () => {
    api.fetchPaperworkWeeks.mockRejectedValue(new Error('Driver has no active pay setting'))
    renderPage()
    await waitFor(() => expect(screen.getByText('Driver has no active pay setting')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
  })
})

describe('the ELD badge on a load', () => {
  it('flags a run that leaves the 150 air-mile radius', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({
        eld: {
          status: 'REQUIRED', required: true, farthestMiles: 201, farthestCity: 'INDIANAPOLIS, IN',
          label: 'ELD logs required — INDIANAPOLIS, IN is 201 air miles from Pleasant Prairie, WI',
        },
      })],
      loadCount: 1, podsMissing: 1, podsIllegible: 0, eldRequired: 1,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('ELD logs required')).toBeTruthy(), { timeout: 5000 })
    // And the reason, so the driver can check it against the run they actually made.
    expect(screen.getByText(/201 air miles from Pleasant Prairie, WI/)).toBeTruthy()
  })

  it('says nothing on a local run', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({
        eld: {
          status: 'NOT_REQUIRED', required: false, farthestMiles: 50, farthestCity: 'CHICAGO, IL',
          label: 'No ELD logs required — stays within 150 air miles of Pleasant Prairie, WI',
        },
      })],
      loadCount: 1, podsMissing: 1, podsIllegible: 0, eldRequired: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('14538')).toBeTruthy(), { timeout: 5000 })
    // A "no logs needed" chip on every local load would be noise — this list is mostly local.
    expect(screen.queryByText(/ELD/)).toBeNull()
  })

  it('asks the driver to check when a stop could not be placed', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04',
      loads: [load({
        eld: {
          status: 'UNKNOWN', required: false, farthestMiles: 50, farthestCity: 'CHICAGO, IL',
          label: 'Check whether ELD logs are required — could not locate CTSI WAREHOUSE',
        },
      })],
      loadCount: 1, podsMissing: 1, podsIllegible: 0, eldRequired: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Check ELD')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/could not locate CTSI WAREHOUSE/)).toBeTruthy()
  })

  it('says nothing when the API predates the field', async () => {
    // A cached PWA bundle can meet an older API. Absent must not read as "no logs needed".
    renderPage()
    await waitFor(() => expect(screen.getByText('14538')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText(/ELD/)).toBeNull()
  })
})
