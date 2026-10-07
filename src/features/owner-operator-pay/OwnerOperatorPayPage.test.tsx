// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OwnerOperatorPayPage } from './OwnerOperatorPayPage'
import type { OwnerOperatorPayRow, OwnerOperatorPayState } from '@/hooks/useOwnerOperatorPay'
import { OWNER_OP_FIRST_PERIOD, type OwnerOpTrip } from '@/lib/ownerOperatorTrips'
import { weekLabelLong } from '@/features/driver-pay/week'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'
import { FACTORING_FEE_LABEL, type DriverPayStatement } from '@/lib/driverPay'
import type { OtrReadiness } from '@/lib/otrInvoice'
import { DRIVER_PORTAL_URL } from '@/lib/driverPortal'

const useOwnerOperatorPayMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useOwnerOperatorPay', () => ({
  useOwnerOperatorPay: useOwnerOperatorPayMock,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.com' } }),
}))

vi.mock('@/lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiClient')>()
  return {
    ...actual,
    payCreditsDeployed: () => true,
  }
})

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

function baseDriver(over: Partial<Driver> = {}): Driver {
  return {
    id: 'd1',
    name: 'Test Driver',
    phone: '+15551234567',
    active: true,
    colorKey: 'driver-1',
    email: 'driver@example.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Driver
}

function baseSetting(over: Partial<DriverPaySetting> = {}): DriverPaySetting {
  return {
    id: 's1',
    driverId: 'd1',
    payPercent: 0.42,
    expensesBeforePercent: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as DriverPaySetting
}

function baseStatement(over: Partial<DriverPayStatement> = {}): DriverPayStatement {
  return {
    gross: 0,
    payPercent: 0.42,
    expensesBeforePercent: true,
    driverAmount: 0,
    totalDeductions: 0,
    factoringFee: 0,
    factoringFeePct: 0.02,
    subtotal: 0,
    totalCredits: 0,
    totalDebits: 0,
    payBeforeCredits: 0,
    checkAmount: 0,
    ...over,
  } as DriverPayStatement
}

function readiness(over: Partial<OtrReadiness> = {}): OtrReadiness {
  return { ready: false, payload: {}, sources: {}, missingFields: [], missingDocuments: [], warnings: [], ...over }
}

function trip(over: Partial<OwnerOpTrip> = {}): OwnerOpTrip {
  return {
    id: 't1',
    loadId: 'TMS-1',
    customer: 'Acme',
    origin: 'Chicago, IL',
    destination: 'Detroit, MI',
    miles: 100,
    freightAmount: 500,
    deliveredAt: '2026-09-29T10:00:00Z',
    ...over,
  }
}

function baseRow(over: Partial<OwnerOperatorPayRow> = {}): OwnerOperatorPayRow {
  return {
    driver: baseDriver(over.driver),
    setting: baseSetting(over.setting),
    baseSetting: baseSetting(over.baseSetting),
    trips: over.trips ?? [],
    fuel: 0,
    fuelTxns: [],
    deductions: over.deductions ?? [],
    oneOffs: over.oneOffs ?? [],
    credits: over.credits ?? [],
    debits: over.debits ?? [],
    fixedDebits: over.fixedDebits ?? [],
    statement: baseStatement(over.statement),
    heldTrips: over.heldTrips ?? [],
    heldFreight: over.heldFreight ?? 0,
    duplicateTripIds: over.duplicateTripIds ?? new Set<string>(),
  }
}

function basePayState(over: Partial<OwnerOperatorPayState> = {}) {
  return {
    loading: false,
    error: null,
    // Default to a healthy POD check; the outage path has its own test.
    podsKnown: true,
    rows: [] as OwnerOperatorPayRow[],
    unconfigured: [] as Driver[],
    refresh: vi.fn(),
    saveSetting: vi.fn(),
    addDeduction: vi.fn(),
    removeDeduction: vi.fn(),
    addCredit: vi.fn(),
    updateCredit: vi.fn(),
    removeCredit: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-30T12:00:00Z')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OwnerOperatorPayPage', () => {
  it('disables the previous-week control on the first owner-operator period', () => {
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /previous week/i })).toBeDisabled()
    expect(screen.getByText(weekLabelLong(OWNER_OP_FIRST_PERIOD))).toBeInTheDocument()
  })

  /*
   * Roy had PRO 14570 assigned to him on 2 Oct for delivery on the 5th — the following pay
   * week. Forward navigation stopped at the current week, so for two days the load existed,
   * was on him, and there was no button that would show it. Dispatch books ahead; this page
   * has to be able to look ahead.
   */
  it('lets you look at a week that has not happened yet', () => {
    // The clock is Wed 30 Sep, so the page opens on the 27 Sep week.
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    const next = screen.getByRole('button', { name: /next week/i })
    expect(next).not.toBeDisabled()
    expect(screen.queryByText(/Upcoming/)).not.toBeInTheDocument()

    fireEvent.click(next)

    // The week Roy's load actually delivers in.
    expect(screen.getByText(weekLabelLong('2026-10-04'))).toBeInTheDocument()
    // And it is labelled, so scheduled work is not read as a check anyone is owed.
    expect(screen.getByText(/Upcoming — not delivered yet/)).toBeInTheDocument()
  })

  it('drops the upcoming label once you come back to this week', () => {
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /next week/i }))
    expect(screen.getByText(/Upcoming/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /this week/i }))
    expect(screen.queryByText(/Upcoming/)).not.toBeInTheDocument()
    expect(screen.getByText(weekLabelLong(OWNER_OP_FIRST_PERIOD))).toBeInTheDocument()
  })

  it('renders a driver row with brokerage loads and check amount', () => {
    const row = baseRow({
      trips: [
        {
          id: 't1',
          loadId: 'TMS-123',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 250,
          freightAmount: 450,
          deliveredAt: '2026-09-29T10:00:00Z',
        },
      ],
      statement: baseStatement({
        gross: 450,
        driverAmount: 189,
        subtotal: 450,
        payBeforeCredits: 189,
        checkAmount: 189,
      }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getAllByText('Test Driver').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('TMS-123')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Chicago, IL → Detroit, MI')).toBeInTheDocument()
    expect(screen.getByText('250')).toBeInTheDocument()
    expect(screen.getAllByText('$450.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('$189.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Check amount').closest('div')?.parentElement).toHaveTextContent('$189.00')
  })

  it('renders the driver app URL once, at the top, and never per driver card', () => {
    const rows = [
      baseRow({ driver: baseDriver({ id: 'd1', name: 'Chad Salerno', email: 'chad@example.com' }) }),
      baseRow({
        driver: baseDriver({ id: 'd2', name: 'Lee Lara', email: 'lee@example.com' }),
        setting: baseSetting({ id: 's2', driverId: 'd2' }),
      }),
    ]
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getAllByText(DRIVER_PORTAL_URL)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /copy the driver app url/i })).toHaveLength(1)
    // …and it sits in the page header, above the driver cards.
    const header = screen.getByRole('heading', { name: /Owner Operator Settlements/i }).parentElement!
    expect(header).toContainElement(screen.getByText(DRIVER_PORTAL_URL))
    // The open card carries its own driver's address and nobody else's.
    expect(screen.getByText('chad@example.com')).toBeInTheDocument()
    expect(screen.queryByText('lee@example.com')).not.toBeInTheDocument()
  })

  it('shows the open card’s own sign-in email, falling back when the driver record has a blank one', () => {
    const row = baseRow({
      driver: baseDriver({ email: '' }),
      setting: baseSetting({ email: 'pay@example.com' }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getByText('pay@example.com')).toBeInTheDocument()
    expect(screen.getByText(/sets their own password/i)).toBeInTheDocument()
  })

  it('says plainly when a driver has no email and so cannot sign in', () => {
    const row = baseRow({
      driver: baseDriver({ name: 'Roy Workman', email: '' }),
      setting: baseSetting({ email: null }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getByText(/No email on file/)).toHaveTextContent('Roy Workman cannot sign in to the driver app')
    expect(screen.queryByText(/sets their own password/i)).not.toBeInTheDocument()
  })

  it('lists the factoring fee on a week with no loads and on a week with loads', () => {
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    const { unmount } = render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
    expect(screen.getByText(FACTORING_FEE_LABEL).parentElement).toHaveTextContent('($0.00)')
    unmount()

    const withTrips = baseRow({
      trips: [{
        id: 't1', loadId: 'TMS-7', customer: 'Acme', origin: 'Chicago, IL', destination: 'Detroit, MI',
        miles: 100, freightAmount: 500, deliveredAt: '2026-09-29T10:00:00Z',
      }],
      statement: baseStatement({ gross: 500, driverAmount: 211.2, factoringFee: 10, totalDeductions: 10, checkAmount: 211.2 }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [withTrips] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
    expect(screen.getByText(FACTORING_FEE_LABEL).parentElement).toHaveTextContent('($10.00)')
  })

  it('exports the factoring fee line on a week with no loads', async () => {
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    const blobs: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
    URL.revokeObjectURL = () => {}
    try {
      render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
      fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
      expect(await blobs[0].text()).toContain('"Factoring fee (2%)","0"')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('adds weekly mileage at miles × cost per mile and carries it into the card total', async () => {
    const addDeduction = vi.fn().mockResolvedValue(undefined)
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()], addDeduction }))
    const { rerender } = render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    fireEvent.change(screen.getByLabelText('Mileage miles'), { target: { value: '2494' } })
    fireEvent.change(screen.getByLabelText('Mileage cost per mile'), { target: { value: '0.086' } })
    expect(screen.getByText('= $214.48')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add mileage deduction/i }))
    })

    expect(addDeduction).toHaveBeenCalledTimes(1)
    expect(addDeduction).toHaveBeenCalledWith({
      driverId: 'd1',
      periodStart: OWNER_OP_FIRST_PERIOD,
      label: 'Lease mileage — 2494 mi @ $0.086/mi',
      amount: 214.48,
      date: null,
    })

    // What the driver sees once the week reloads with that deduction on it.
    const settled = baseRow({
      deductions: [{ label: 'Lease mileage — 2494 mi @ $0.086/mi', amount: 214.48 }],
      statement: baseStatement({ totalDeductions: 214.48, checkAmount: -214.48 }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [settled], addDeduction }))
    rerender(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
    expect(screen.getByText('Lease mileage — 2494 mi @ $0.086/mi')).toBeInTheDocument()
    expect(screen.getByText('Total deductions').parentElement).toHaveTextContent('($214.48)')
  })

  it('prefers the driver record email over the pay-setting email', () => {
    const row = baseRow({
      driver: baseDriver({ email: 'driver@example.com' }),
      setting: baseSetting({ email: 'pay@example.com' }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.queryByText('pay@example.com')).not.toBeInTheDocument()
    expect(screen.getAllByText('driver@example.com').length).toBeGreaterThanOrEqual(1)
  })

  it('surfaces missing factoring fields and summarises ready vs blocked trips', () => {
    const row = baseRow({
      trips: [
        {
          id: 't1',
          loadId: 'TMS-1',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 100,
          freightAmount: 500,
          deliveredAt: '2026-09-29T10:00:00Z',
          readiness: readiness({ missingFields: ['BrokerMC', 'FromZip'], missingDocuments: ['POD'] }),
        },
        {
          id: 't2',
          loadId: 'TMS-2',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 100,
          freightAmount: 500,
          deliveredAt: '2026-09-30T10:00:00Z',
          readiness: readiness({ ready: true, payload: { InvoiceNo: 'PRO2' } }),
        },
      ],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getAllByText('Broker MC').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Origin ZIP').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('1 of 2 ready').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1 blocked').length).toBeGreaterThanOrEqual(1)
  })

  it('exports every factoring column in the CSV', async () => {
    const row = baseRow({
      trips: [{
        id: 't1',
        loadId: 'TMS-1',
        customer: 'Acme',
        origin: 'Chicago, IL',
        destination: 'Detroit, MI',
        miles: 100,
        freightAmount: 500,
        deliveredAt: '2026-09-29T10:00:00Z',
        readiness: readiness({
          ready: true,
          payload: {
            InvoiceNo: 'PRO9', PoNumber: 'PO9', BrokerMC: '999', InvoiceAmount: 500, InvoiceDate: '2026-09-29',
            FromCity: 'CHICAGO', FromState: 'IL', FromZip: '60601', ToCity: 'DETROIT', ToState: 'MI', ToZip: '48201',
          },
        }),
      }],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    const blobs: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
    URL.revokeObjectURL = () => {}
    try {
      render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
      fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
      const text = await blobs[0].text()
      for (const header of [
        'PRO #', 'PO #', 'Broker MC', 'Invoice amount', 'Invoice date',
        'Origin city', 'Origin state', 'Origin ZIP', 'Dest city', 'Dest state', 'Dest ZIP',
        'POD', 'Rate confirmation',
      ]) {
        expect(text).toContain(header)
      }
      expect(text).toContain('PRO9')
      expect(text).toContain('60601')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
  it('leads the trips table with PRO # and PO #', () => {
    // They are how the office and OTR both name a load, so they come before the
    // internal Load ID rather than after it.
    const row = baseRow({
      trips: [trip({ readiness: readiness({ payload: { InvoiceNo: '13364', PoNumber: 'PO-7' } }) })],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers.slice(0, 3)).toEqual(['PRO #', 'PO #', 'Load ID'])

    const cells = screen.getByText('13364').closest('tr')!.querySelectorAll('td')
    expect(cells[0]).toHaveTextContent('13364')
    expect(cells[1]).toHaveTextContent('PO-7')
    expect(cells[2]).toHaveTextContent('TMS-1')
  })

  it('leaves the PRO blank rather than standing another id in for it', () => {
    // A load built with no PRO yet must not show the Load ID in the PRO column —
    // someone would factor against a number OTR has never heard of.
    const row = baseRow({ trips: [trip({ readiness: readiness({ payload: { PoNumber: 'PO-7' } }) })] })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    const cells = screen.getByText('PO-7').closest('tr')!.querySelectorAll('td')
    // The field label stands in for the value, which is how every other missing
    // factoring field reads on this page.
    expect(cells[0]).toHaveTextContent('Invoice number (PRO)')
    expect(cells[0]).not.toHaveTextContent('TMS-1')
  })

  it('holds a load with no POD off the check and says why', () => {
    const held = trip({ id: 't-held', freightAmount: 900, readiness: readiness({ missingDocuments: ['POD'] }) })
    const row = baseRow({
      trips: [held],
      heldTrips: [{ trip: held, reason: 'NO_POD' }],
      heldFreight: 900,
      statement: baseStatement({ gross: 0, driverAmount: 0 }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    /*
     * The amount is SHOWN on a held load, not replaced by the word "Held".
     *
     * Everyone already knows the POD is missing — the POD column says so two cells along.
     * What the office needs is what the load is worth, because that is the size of the
     * reason to chase the driver. 900 freight x 42% = $378.00, still excluded from the
     * check and still labelled.
     */
    // This fixture sets expensesBeforePercent, so the driver amount IS the freight: $900.
    // Asserted on the cell itself, since "$900.00" also appears in the excluded-total line.
    const label = screen.getByText('POD required')
    expect(label.parentElement?.textContent).toContain('$900.00')
    expect(screen.queryByText(/Held — POD required/)).not.toBeInTheDocument()

    // And it is still off the check, which is the part that must not drift.
    expect(screen.getByText(/excludes \$900\.00 held for POD/)).toBeInTheDocument()
    expect(screen.getAllByText(/1 held off this check/).length).toBeGreaterThanOrEqual(1)
  })

  it('pays a load whose POD is on file, with no held notice', () => {
    const row = baseRow({
      trips: [trip({ freightAmount: 900, readiness: readiness({ ready: true }) })],
      statement: baseStatement({ gross: 900, driverAmount: 378 }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.queryByText(/Held — POD required/)).not.toBeInTheDocument()
    expect(screen.queryByText(/held for POD/)).not.toBeInTheDocument()
  })

  it('offers an upload where a POD or rate confirmation is missing', () => {
    const row = baseRow({
      trips: [trip({
        readiness: readiness({ missingDocuments: ['POD', 'Rate confirmation'], payload: { InvoiceNo: '13364' } }),
      })],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    // The row where someone discovers the document is missing is the row that should
    // let them fix it.
    expect(screen.getByRole('button', { name: 'Upload POD for 13364' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload Rate con for 13364' })).toBeInTheDocument()
  })

  it('warns, and holds nothing, when the PODs could not be checked', () => {
    const row = baseRow({
      trips: [trip({ freightAmount: 900, readiness: readiness({ missingDocuments: ['POD'] }) })],
      heldTrips: [],
      heldFreight: 0,
      statement: baseStatement({ gross: 900, driverAmount: 378 }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row], podsKnown: false }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    expect(screen.getByText(/PODs could not be checked/)).toBeInTheDocument()
    expect(screen.queryByText(/Held — POD required/)).not.toBeInTheDocument()
  })

  it('marks held loads in the CSV and zeroes their pay column', async () => {
    const held = trip({ id: 't-held', freightAmount: 900, readiness: readiness({ missingDocuments: ['POD'] }) })
    const row = baseRow({
      trips: [held],
      heldTrips: [{ trip: held, reason: 'NO_POD' }],
      heldFreight: 900,
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    const blobs: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
    URL.revokeObjectURL = () => {}
    try {
      render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)
      fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
      const text = await blobs[0].text()
      expect(text).toContain('On this check')
      expect(text).toContain('Held — POD required')
      expect(text).toContain('Held for POD (not paid)')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('shows a missing POD as blocking and a missing rate con as an ordinary to-do', () => {
    // Only the POD holds pay. Painting both amber trains people to ignore the colour
    // that actually means something.
    const row = baseRow({
      trips: [trip({
        readiness: readiness({ missingDocuments: ['POD', 'Rate confirmation'], payload: { InvoiceNo: '13364' } }),
      })],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<MemoryRouter><OwnerOperatorPayPage /></MemoryRouter>)

    const pod = screen.getByRole('button', { name: 'Upload POD for 13364' })
    const rc = screen.getByRole('button', { name: 'Upload Rate con for 13364' })
    expect(pod.title).toMatch(/not paid without it/)
    expect(rc.title).toMatch(/optional here/)
    expect(rc.title).toMatch(/factoring queue/)
  })
})
