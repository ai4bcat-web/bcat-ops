// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const api = {
  fetchPaperwork: vi.fn(),
  fetchPaperworkWeeks: vi.fn(),
  setStopDetention: vi.fn(),
  recordStopEvent: vi.fn(),
  fetchSubmissions: vi.fn(),
  fetchRecentLoads: vi.fn(),
  // The PM line on the home screen reads the driver's profile.
  fetchMe: vi.fn(),
  fetchTrucks: vi.fn(),
  selectTruck: vi.fn(),
}
vi.mock('../driverApi', () => api)

const { PaperworkPage } = await import('./PaperworkPage')
const { clearCachedProgram } = await import('../useDriverProgram')

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
    stops: [stop('st-pu', 'pickup', '2026-10-07'), stop('st-de', 'delivery', '2026-10-07')],
    pod: { present: false, pages: 0, legibility: 'UNKNOWN', notes: null },
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
    weekStart: '2026-10-04', today: '2026-10-07', loads: [load()], loadCount: 1, podsMissing: 1, podsIllegible: 0,
  })
  api.fetchSubmissions.mockResolvedValue([])
  api.fetchRecentLoads.mockResolvedValue([])
  // useDriverPm caches the profile at module level — clear it or one test's truck leaks
  // into the next, which is also the real sign-out requirement.
  clearCachedProgram()
  api.fetchMe.mockResolvedValue({
    driverId: 'd1', name: 'Jason Smith', email: 'j@x.com', payGroup: 'LOCAL',
    program: 'PAPERWORK', active: true, pm: null,
  })
})
afterEach(() => vi.useRealTimers())

function renderPage() {
  return render(<MemoryRouter><PaperworkPage /></MemoryRouter>)
}

describe('Ivan paperwork — the day sheet', () => {
  it("opens on today and shows that day's stops with the load's details", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    // Tue, Oct 7 2026 — fetched as the week of Sun Oct 4.
    expect(api.fetchPaperwork).toHaveBeenCalledWith('2026-10-04')
    expect(screen.getByText(/Wed, Oct 7/)).toBeTruthy()
    expect(screen.getByText('Batory Oakley')).toBeTruthy()
    expect(screen.getByText('Eagle Foods')).toBeTruthy()
    expect(screen.getAllByText('14538').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Wayfinder Logistics').length).toBeGreaterThan(0)
  })

  it('shows no rate and no settlement anywhere on the page', async () => {
    /*
     * The requirement that makes this a separate page. An Ivan driver is not settled a
     * percentage, so no money may appear — and because the payload has none, there is
     * nothing for the UI to accidentally render.
     */
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\$/)
    expect(text).not.toMatch(/rate\b/i)
    expect(text).not.toMatch(/deduction|gross|check amount|settlement/i)
  })

  it('steps back a day and shows only that day; forward stops at today', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07',
      loads: [
        load({ id: 'l-mon', reference: '14570', stops: [stop('m-pu', 'pickup', '2026-10-06'), stop('m-de', 'delivery', '2026-10-06')] }),
        load({ id: 'l-tue', reference: '14571', stops: [stop('t-pu', 'pickup', '2026-10-07')] }),
      ],
      loadCount: 2, podsMissing: 0, podsIllegible: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getAllByText('14571')).toHaveLength(1)
    expect(screen.queryByText('14570')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next day' })).toHaveProperty('disabled', true)

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(screen.getByText(/Tue, Oct 6/)).toBeTruthy())
    expect(screen.queryByText('Today')).toBeNull()
    expect(screen.getAllByText('14570')).toHaveLength(2) // its pickup and its delivery
    expect(screen.queryByText('14571')).toBeNull()
    // Same week: no second fetch.
    expect(api.fetchPaperwork).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy())
  })

  it('fetches the other week when paging crosses into it', async () => {
    const { fireEvent } = await import('@testing-library/react')
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    api.fetchPaperwork.mockResolvedValue({ weekStart: '2026-09-27', loads: [], loadCount: 0, podsMissing: 0, podsIllegible: 0 })
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(api.fetchPaperwork).toHaveBeenLastCalledWith('2026-09-27'))
    await waitFor(() => expect(screen.getByText(/Sat, Oct 3/)).toBeTruthy())
  })

  it('jumps to a picked day from the calendar, never past today', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07',
      loads: [load({ id: 'l-sun', reference: '14560', stops: [stop('s-de', 'delivery', '2026-10-04')] })],
      loadCount: 1, podsMissing: 0, podsIllegible: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-04' } })
    await waitFor(() => expect(screen.getByText(/Sun, Oct 4/)).toBeTruthy())
    expect(screen.getByText('14560')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-09' } })
    expect(screen.getByText(/Sun, Oct 4/)).toBeTruthy()
  })

  it("says what the week still owes, so Tuesday's missed POD is not lost by Friday", async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07', loads: [load()], loadCount: 1, podsMissing: 1, podsIllegible: 0,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText(/1 load this week still needs a POD/)).toBeTruthy(), { timeout: 5000 })
  })

  it('flags a POD that cannot be read on the delivery, and says what was wrong with it', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07',
      loads: [load({ pod: { present: true, pages: 2, legibility: 'UNREADABLE', notes: 'the photo is blurry — hold still and tap to focus' } })],
      loadCount: 1, podsMissing: 0, podsIllegible: 1,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('POD unreadable')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/blurry/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Replace POD/ })).toBeTruthy()
  })

  it('offers the POD back to the driver once one is on file', async () => {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07',
      loads: [load({ pod: { present: true, pages: 3, legibility: 'OK', notes: null } })],
      loadCount: 1, podsMissing: 0, podsIllegible: 0,
    })
    api.fetchSubmissions.mockResolvedValue([{
      id: 'sub-1', status: 'SENT', loadId: 'load-1', referenceNumber: '14538', createdAt: '2026-10-07T18:00:00Z', docs: [],
      documents: [{ kind: 'POD', docId: 'combined-POD', pageCount: 3, enhanced: true, contentType: 'application/pdf', combined: true }],
    }])
    renderPage()
    await waitFor(() => expect(screen.getByText(/POD on file · 3 pages/)).toBeTruthy(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: /View POD \(3 pages\)/ })).toBeTruthy())
  })

  it('no longer asks the driver to type in and out times', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: /Pickup times/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delivery times/ })).toBeNull()
  })
})

function stop(id: string, type: 'pickup' | 'delivery', date: string, over: Record<string, unknown> = {}) {
  return {
    id, type, sequence: type === 'pickup' ? 0 : 1, name: type === 'pickup' ? 'Batory Oakley' : 'Eagle Foods',
    city: 'Chicago', state: 'IL', appt: `${date}T17:00:00.000Z`, apptType: 'exact', apptEnd: null,
    date, detention: false, yours: true, arrivedAt: null, departedAt: null, etaAt: null, etaBasis: null, ...over,
  }
}

describe("today's sheet", () => {
  function todayWeek(loads: unknown[]) {
    api.fetchPaperwork.mockResolvedValue({
      weekStart: '2026-10-04', today: '2026-10-07', loads, loadCount: loads.length, podsMissing: 0, podsIllegible: 0,
    })
  }

  it("lists today's pickups and deliveries, and nothing from another day", async () => {
    todayWeek([
      load({ id: 'l-a', reference: '14570', stops: [stop('a-pu', 'pickup', '2026-10-07'), stop('a-de', 'delivery', '2026-10-08')] }),
      load({ id: 'l-b', reference: '14571', stops: [stop('b-pu', 'pickup', '2026-10-06'), stop('b-de', 'delivery', '2026-10-07')] }),
    ])
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    // One pickup (14570's) and one delivery (14571's) are today's work.
    expect(screen.getAllByText('Pickup')).toHaveLength(1)
    expect(screen.getAllByText('Delivery')).toHaveLength(1)
  })

  it('puts a detention box on every stop, and the POD button on deliveries only', async () => {
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-07'), stop('st-de', 'delivery', '2026-10-07')] })])
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByText(/2 hours or longer from your appointment time/)).toHaveLength(2)
    expect(screen.getAllByText(/in and out times on the BOL/)).toHaveLength(2)
    // Each card leads with its status button; the POD button appears once delivered.
    expect(screen.getByRole('button', { name: 'On site at pickup' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'On site at delivery' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send POD/ })).toBeNull()
  })

  it('flags detention at the stop the driver ticked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.setStopDetention.mockResolvedValue(undefined)
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-07'), stop('st-de', 'delivery', '2026-10-07')] })])
    renderPage()
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2), { timeout: 5000 })
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    await waitFor(() => expect(api.setStopDetention).toHaveBeenCalledWith({ loadId: 'load-1', stopId: 'st-de', detention: true }))
    await waitFor(() => expect(screen.getByText(/Detention — flagged/)).toBeTruthy())
  })

  it('shows the BCAT PRO #, the PO # and the PU # on every card', async () => {
    todayWeek([load({ poNumber: '212775896', pickupNumber: '1750128', stops: [stop('st-pu', 'pickup', '2026-10-07')] })])
    renderPage()
    await waitFor(() => expect(screen.getByText('BCAT PRO #')).toBeTruthy(), { timeout: 5000 })
    const card = screen.getByText('BCAT PRO #').closest('li')!
    expect(card.textContent).toMatch(/14538/)
    expect(card.textContent).toMatch(/PO #\s*212775896/)
    expect(card.textContent).toMatch(/PU #\s*1750128/)
  })

  it('walks a pickup from On site to Departed, stamping each on the load', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.recordStopEvent.mockResolvedValueOnce({ at: '2026-10-07T14:12:00.000Z', eta: null })
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-07')] })])
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /On site at pickup/ })).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: /On site at pickup/ }))
    await waitFor(() => expect(api.recordStopEvent).toHaveBeenCalledWith({ loadId: 'load-1', stopId: 'st-pu', event: 'ARRIVED' }))
    await waitFor(() => expect(screen.getByText(/On site since 9:12 AM/)).toBeTruthy())
    api.recordStopEvent.mockResolvedValueOnce({ at: '2026-10-07T15:40:00.000Z', eta: { stopId: 'st-de', etaAt: '2026-10-07T16:05:00.000Z', basis: 'motive' } })
    fireEvent.click(screen.getByRole('button', { name: /^Departed$/ }))
    await waitFor(() => expect(api.recordStopEvent).toHaveBeenLastCalledWith({ loadId: 'load-1', stopId: 'st-pu', event: 'DEPARTED' }))
    await waitFor(() => expect(screen.getByText(/Departed 10:40 AM/)).toBeTruthy())
  })

  it('Delivered sends the event and opens the POD scanner for that load', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { Routes, Route, useLocation } = await import('react-router-dom')
    api.recordStopEvent.mockResolvedValueOnce({ at: '2026-10-07T19:10:00.000Z', eta: null })
    todayWeek([load({ stops: [stop('st-de', 'delivery', '2026-10-07', { arrivedAt: '2026-10-07T18:30:00.000Z' })] })])
    const Scanner = () => { const loc = useLocation(); return <div>SCANNER {loc.search}</div> }
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/driver/scan" element={<Scanner />} />
          <Route path="*" element={<PaperworkPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Delivered — send POD/ })).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: /On site at delivery/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Delivered — send POD/ }))
    await waitFor(() => expect(api.recordStopEvent).toHaveBeenCalledWith({ loadId: 'load-1', stopId: 'st-de', event: 'DEPARTED' }))
    // Straight into the scanner, on this load.
    await waitFor(() => expect(screen.getByText(/SCANNER/).textContent).toMatch(/kind=pod.*ref=14538.*loadId=load-1/))
  })

  it('shows the ETA on a delivery the driver is rolling toward, and says where it came from', async () => {
    todayWeek([load({ stops: [
      stop('st-pu', 'pickup', '2026-10-07', { departedAt: '2026-10-07T15:40:00.000Z' }),
      stop('st-de', 'delivery', '2026-10-07', { etaAt: '2026-10-07T16:05:00.000Z', etaBasis: 'motive' }),
    ] })])
    renderPage()
    await waitFor(() => expect(screen.getByText(/ETA 11:05 AM/)).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/from your truck/)).toBeTruthy()
  })

  it('says the appointment is the estimate when another driver delivers', async () => {
    todayWeek([load({ stops: [stop('st-de', 'delivery', '2026-10-07', { etaAt: '2026-10-07T17:00:00.000Z', etaBasis: 'appt' })] })])
    renderPage()
    await waitFor(() => expect(screen.getByText(/ETA 12:00 PM/)).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/the appointment time/)).toBeTruthy()
  })

  it("does not put another driver's delivery on this driver's sheet", async () => {
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-07'), stop('st-de', 'delivery', '2026-10-07', { yours: false })] })])
    renderPage()
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getAllByText('Pickup')).toHaveLength(1)
    expect(screen.queryByText('Delivery')).toBeNull()
  })

  it('offers photos / other documents on every stop, and opens the camera for that stop', async () => {
    const { fireEvent, render: r } = await import('@testing-library/react')
    const { Routes, Route, useLocation } = await import('react-router-dom')
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-07'), stop('st-de', 'delivery', '2026-10-07')] })])
    const Scanner = () => { const loc = useLocation(); return <div>SCANNER {loc.search}</div> }
    r(
      <MemoryRouter>
        <Routes>
          <Route path="/driver/scan" element={<Scanner />} />
          <Route path="*" element={<PaperworkPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Add photos \/ docs/ })).toHaveLength(2), { timeout: 5000 })
    fireEvent.click(screen.getAllByRole('button', { name: /Add photos \/ docs/ })[0])
    await waitFor(() => expect(screen.getByText(/SCANNER/).textContent).toMatch(/kind=misc.*loadId=load-1.*stopId=st-pu.*stopLabel=Pickup/))
  })

  it('says so when nothing is scheduled today', async () => {
    todayWeek([load({ stops: [stop('st-pu', 'pickup', '2026-10-05'), stop('st-de', 'delivery', '2026-10-06')] })])
    renderPage()
    await waitFor(() => expect(screen.getByText(/No pickups or deliveries scheduled today/)).toBeTruthy(), { timeout: 5000 })
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
      'src/features/driver-app/paperwork/TodayStops.tsx',
      'src/features/driver-app/paperwork/DayLogs.tsx',
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} must not hardcode dark-only colours`).not.toMatch(/text-white|text-slate-\d|bg-slate-\d|#0b1220/)
    }
  })

  it('shows the error message rather than an empty card', async () => {
    api.fetchPaperwork.mockRejectedValue(new Error('Driver has no active pay setting'))
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
    await waitFor(() => expect(screen.getByText(/ELD logs required today/)).toBeTruthy(), { timeout: 5000 })
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
    await waitFor(() => expect(screen.getAllByText('14538')[0]).toBeTruthy(), { timeout: 5000 })
    /*
     * A "no logs needed" chip on every local load would be noise — this list is mostly
     * local. Matched on the badge and the explanation specifically: the week summary strip
     * carries an "ELD logs" count label, which is a different thing and should stay.
     */
    expect(screen.queryByText(/ELD logs required/)).toBeNull()
    expect(screen.queryByText(/Check ELD/)).toBeNull()
    // Said out loud, at the top: silence would read as "nobody checked".
    expect(screen.getByText(/No ELD logs needed today/)).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText(/Check ELD today/)).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/could not locate CTSI WAREHOUSE/)).toBeTruthy()
  })

  it('says nothing when the API predates the field', async () => {
    // A cached PWA bundle can meet an older API. Absent must not read as "no logs needed".
    renderPage()
    await waitFor(() => expect(screen.getAllByText('14538')[0]).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText(/ELD logs required/)).toBeNull()
    expect(screen.queryByText(/Check ELD/)).toBeNull()
    expect(screen.queryByText(/No ELD logs needed/)).toBeNull()
  })
})

describe('the PM line on the home screen', () => {
  function withPm(pm: Record<string, unknown> | null) {
    api.fetchMe.mockResolvedValue({
      driverId: 'd1', name: 'Jason Smith', email: 'j@x.com', payGroup: 'LOCAL',
      program: 'PAPERWORK', active: true, pm,
    })
  }

  it('shows when the next PM is due', async () => {
    withPm({
      state: 'OK', nextDueAt: 125_000, remaining: 15_000, currentOdometer: 110_000,
      lastPmMileage: 100_000, lastPmDate: '2026-08-01',
      label: 'Next PM in 15,000 mi — at 125,000 mi', truckNumber: '009',
    })
    renderPage()
    // The gauge leads with the miles remaining and draws a bar across the interval; the
    // label sentence moved into the bar's own component (PmGauge).
    await waitFor(() => expect(screen.getByText('15,000 mi to next PM')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(screen.getByText(/Truck 009/)).toBeTruthy()
    expect(screen.getByText(/110,000 mi/)).toBeTruthy()
  })

  it('says so when the PM is overdue', async () => {
    withPm({
      state: 'OVERDUE', nextDueAt: 125_000, remaining: -1_500, currentOdometer: 126_500,
      lastPmMileage: 100_000, lastPmDate: null,
      label: 'PM overdue by 1,500 mi — it was due at 125,000 mi', truckNumber: '009',
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('PM overdue by 1,500 mi')).toBeTruthy(), { timeout: 5000 })
  })

  it('says nothing when the driver has no truck assigned', async () => {
    // An empty gauge on a page about paperwork is noise.
    withPm(null)
    renderPage()
    await waitFor(() => expect(screen.getAllByText('14538')[0]).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText(/Next PM|PM overdue|PM due|not scheduled/)).toBeNull()
  })

  it('says nothing when the API predates the field', async () => {
    api.fetchMe.mockResolvedValue({
      driverId: 'd1', name: 'Jason Smith', email: 'j@x.com', payGroup: 'LOCAL',
      program: 'PAPERWORK', active: true,
    })
    renderPage()
    await waitFor(() => expect(screen.getAllByText('14538')[0]).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText(/Next PM|PM overdue|PM due|not scheduled/)).toBeNull()
  })

  it('does not take the page down when the profile call fails', async () => {
    api.fetchMe.mockRejectedValue(new Error('offline'))
    renderPage()
    await waitFor(() => expect(screen.getAllByText('14538')[0]).toBeTruthy(), { timeout: 5000 })
  })
})
