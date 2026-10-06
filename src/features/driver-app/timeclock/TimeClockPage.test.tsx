// @vitest-environment jsdom
/**
 * The driver's clock. What matters here is what it will NOT let a driver do: edit their own
 * card, see a PTO button they do not accrue, or watch an open shift inflate today's total.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const api = { fetchTimeClock: vi.fn(), punchTimeClock: vi.fn() }
vi.mock('../driverApi', () => api)

const { TimeClockPage } = await import('./TimeClockPage')

const WEEK = {
  weekStart: '2026-10-05',
  weekEnd: '2026-10-11',
  workedMinutes: 495,
  holidayMinutes: 0,
  ptoMinutes: 0,
  totalMinutes: 495,
  open: false,
  days: [
    { date: '2026-10-05', workedMinutes: 495, holidayMinutes: 0, ptoMinutes: 0, totalMinutes: 495, open: false,
      rows: [{ id: 'r1', driverId: 'd1', workDate: '2026-10-05', kind: 'WORK',
               clockInAt: '2026-10-05T12:00:00Z', clockOutAt: '2026-10-05T20:15:00Z', minutes: 495 }] },
    ...['2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'].map((date) => ({
      date, workedMinutes: 0, holidayMinutes: 0, ptoMinutes: 0, totalMinutes: 0, open: false, rows: [],
    })),
  ],
}

function respond(over: Record<string, unknown> = {}) {
  api.fetchTimeClock.mockResolvedValue({
    today: '2026-10-05',
    week: WEEK,
    weeks: ['2026-10-05', '2026-09-28'],
    openShift: null,
    ptoEligible: false,
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.punchTimeClock.mockResolvedValue({ ok: true })
  respond()
})

describe('the clock button', () => {
  it('offers Clock in when no shift is running', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Clock in')).toBeTruthy())
    expect(screen.getByText('Not clocked in')).toBeTruthy()
  })

  it('offers Clock out, and says why today still reads zero', async () => {
    /*
     * An open shift is worth nothing until it closes, so a driver standing there working
     * sees 0h. Saying so is the difference between a rule and a bug.
     */
    respond({ openShift: { id: 'r9', driverId: 'd1', workDate: '2026-10-05', kind: 'WORK', clockInAt: '2026-10-05T12:00:00Z', clockOutAt: null } })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Clock out')).toBeTruthy())
    expect(screen.getByText(/counted once you clock out/)).toBeTruthy()
  })

  it('punches in', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Clock in')).toBeTruthy())
    fireEvent.click(screen.getByText('Clock in'))
    await waitFor(() => expect(api.punchTimeClock).toHaveBeenCalledWith('IN', undefined))
  })
})

describe('the week', () => {
  it('shows the total and the split', async () => {
    render(<TimeClockPage />)
    // Appears three times on purpose: the week total, the Worked stat, and Monday's day
    // total — the whole week was one shift, so all three are the same number.
    await waitFor(() => expect(screen.getAllByText('8h 15m').length).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('Week total')).toBeTruthy()
    expect(screen.getByText('Worked')).toBeTruthy()
    expect(screen.getByText('Holiday')).toBeTruthy()
    expect(screen.getByText('PTO')).toBeTruthy()
  })

  it('shows all seven days, including the empty ones', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Mon, Oct 5/)).toBeTruthy())
    expect(screen.getByText(/Sun, Oct 11/)).toBeTruthy()
  })

  it('tells the driver when the office changed a row', async () => {
    // Shown, not hidden — a corrected card should never be a silent one.
    const corrected = structuredClone(WEEK)
    corrected.days[0].rows[0] = { ...corrected.days[0].rows[0], correctedBy: 'ryne@bcatcorp.com' } as never
    respond({ week: corrected })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/corrected by the office/)).toBeTruthy())
  })
})

describe('holiday and PTO', () => {
  it('offers a paid holiday', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Add a paid holiday for today/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Add a paid holiday for today/))
    await waitFor(() => expect(api.punchTimeClock).toHaveBeenCalledWith('HOLIDAY', { date: '2026-10-05' }))
  })

  it('hides PTO from a driver who does not accrue it', async () => {
    // Only Jason and Chuck. Everyone else never sees the button.
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Add a paid holiday/)).toBeTruthy())
    expect(screen.queryByText(/Use PTO for today/)).toBeNull()
  })

  it('offers PTO to a driver who does', async () => {
    respond({ ptoEligible: true })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Use PTO for today/)).toBeTruthy())
  })

  it('names the paid holidays rather than leaving it to memory', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Thanksgiving/)).toBeTruthy())
  })
})

describe('what a driver cannot do', () => {
  it('offers no way to edit a shift', async () => {
    /*
     * A driver editing their own card after the fact is the one thing that would make
     * these numbers arguable. Corrections belong to staff, on the record, with a name.
     */
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Mon, Oct 5/)).toBeTruthy())
    expect(screen.queryByText(/Edit/i)).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not offer holiday or PTO on a past week', async () => {
    // Backdating is a correction, and corrections are the office's.
    respond({ week: { ...WEEK, weekStart: '2026-09-28' }, weeks: ['2026-10-05', '2026-09-28'] })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Week total')).toBeTruthy())
    expect(screen.queryByText(/Add a paid holiday/)).toBeNull()
  })
})

describe('when staff are viewing a driver’s app', () => {
  it('shows the clock but will not let it be punched', async () => {
    /*
     * The server refuses an impersonated punch outright — an admin must never clock a
     * driver in. The button is disabled so staff meet an explanation rather than a 403.
     */
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: true, readOnly: true,
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Clock in')).toBeTruthy())
    expect((screen.getByRole('button', { name: /Clock in/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/can only be punched by them/)).toBeTruthy()
  })

  it('does not let staff add a holiday or PTO either', async () => {
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: true, readOnly: true,
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/Add a paid holiday/)).toBeTruthy())
    expect((screen.getByRole('button', { name: /Add a paid holiday/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Use PTO/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('still shows the week, because that is the point of looking', async () => {
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: false, readOnly: true,
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Week total')).toBeTruthy())
    expect(screen.getAllByText('8h 15m').length).toBeGreaterThanOrEqual(2)
  })

  it('lets a real driver punch normally', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Clock in')).toBeTruthy())
    expect((screen.getByRole('button', { name: /Clock in/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('overnight loads on the time clock', () => {
  const overnight = {
    weekStart: '2026-10-05',
    grossCents: 240_000,
    loads: [
      { id: 'l1', reference: '14536', origin: 'CICERO, IL', destination: 'NEWTON, IA',
        deliveredOn: '2026-10-06', rateCents: 150_000 },
      { id: 'l2', reference: '13660', origin: 'URBANDALE, IA', destination: 'CHICAGO, IL',
        deliveredOn: '2026-10-08', rateCents: 90_000 },
    ],
  }

  it('lists the period’s runs with the gross total', async () => {
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: false, overnight,
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Overnight loads')).toBeTruthy())
    expect(screen.getByText('$2,400.00')).toBeTruthy()
    expect(screen.getByText(/2 runs this period/)).toBeTruthy()
    expect(screen.getByText('$1,500.00')).toBeTruthy()
    expect(screen.getByText('$900.00')).toBeTruthy()
  })

  it('says the total is gross', async () => {
    /*
     * Ivan drivers have nothing deducted, so a "net" line would be the same number wearing
     * a label that invites a hunt for a difference that does not exist. Saying gross once
     * is the honest version.
     */
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: false, overnight,
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText(/gross/)).toBeTruthy())
    expect(screen.queryByText(/net/i)).toBeNull()
  })

  it('shows nothing at all in a period with no overnight runs', async () => {
    // Most Ivan weeks are entirely local; an empty money section every week would be noise.
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: false, overnight: { weekStart: '2026-10-05', loads: [], grossCents: 0 },
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Week total')).toBeTruthy())
    expect(screen.queryByText('Overnight loads')).toBeNull()
  })

  it('shows nothing when the API predates the field', async () => {
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('Week total')).toBeTruthy())
    expect(screen.queryByText('Overnight loads')).toBeNull()
  })

  it('shows a dash for a run with no rate recorded, not a zero', async () => {
    // "$0.00" would read as "this run paid nothing", which is a different claim.
    api.fetchTimeClock.mockResolvedValue({
      today: '2026-10-05', week: WEEK, weeks: ['2026-10-05'], openShift: null,
      ptoEligible: false,
      overnight: { weekStart: '2026-10-05', grossCents: 0,
        loads: [{ id: 'l3', reference: '14999', origin: 'A', destination: 'NEWTON, IA',
                  deliveredOn: '2026-10-07', rateCents: null }] },
    })
    render(<TimeClockPage />)
    await waitFor(() => expect(screen.getByText('14999')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
  })
})
