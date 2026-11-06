// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { HoursPeriodView } from './HoursPeriodView'
import { summarizePayPeriod, type TimeClockRow } from '@/lib/timeClock'
import { payForPeriod } from '@/lib/hoursPay'
import type { DriverHoursRow } from '@/lib/hoursView'

const START = '2026-10-12'
const work = (id: string, driverId: string, date: string, minutes: number): TimeClockRow =>
  ({ id, driverId, workDate: date, kind: 'WORK', clockInAt: `${date}T13:00:00Z`, clockOutAt: `${date}T21:00:00Z`, minutes, source: 'DRIVER' })
const leave = (id: string, driverId: string, date: string, kind: 'PTO' | 'HOLIDAY'): TimeClockRow =>
  ({ id, driverId, workDate: date, kind, clockInAt: null, clockOutAt: null, minutes: 480, note: kind === 'PTO' ? 'dentist' : null, source: 'STAFF' })

function row(driverId: string, name: string, rows: TimeClockRow[], rate: number | null, showPay = true): DriverHoursRow {
  const period = summarizePayPeriod(START, rows)
  return { driverId, name, period, pay: showPay ? payForPeriod(period.days.map((d) => ({ date: d.date, minutes: d.totalMinutes })), rate ? { hourlyRate: rate } : {}) : null }
}

const ann = row('a', 'Ann Lee', [work('1', 'a', '2026-10-12', 480), work('2', 'a', '2026-10-13', 495), leave('3', 'a', '2026-10-14', 'PTO'), leave('4', 'a', '2026-10-19', 'HOLIDAY')], 20)
const bob = row('b', 'Bob Ray', [work('5', 'b', '2026-10-12', 240)], null)

function view(over: Partial<React.ComponentProps<typeof HoursPeriodView>> = {}) {
  const props: React.ComponentProps<typeof HoursPeriodView> = {
    rows: [ann, bob], periodLabel: 'Oct 12 – Oct 25', defaultRateFrom: START, showPay: true, motive: {}, ptoYear: '2026', ptoDays: { a: 1, b: 0 },
    rateInfo: (id) => ({ currentFrom: null, rate: id === 'a' ? 20 : null }),
    onSaveRate: vi.fn().mockResolvedValue(undefined), onExportCsv: vi.fn(),
    editing: null, setEditing: vi.fn(), saving: false, onStartEdit: vi.fn(), onSaveEdit: vi.fn(),
    ...over,
  }
  render(<HoursPeriodView {...props} />)
  return props
}

describe('HoursPeriodView', () => {
  it('starts collapsed, one row per driver, with worked / PTO / holiday / total hours and the 2-week pay', () => {
    view()
    const a = screen.getByRole('region', { name: 'Ann Lee' })
    // 8:00 + 8:15 worked, 8:00 PTO, 8:00 holiday = 32:15 total at $20 = $645.00
    for (const t of ['16:15', '8:00', '32:15']) expect(within(a).getAllByText(t).length).toBeGreaterThan(0)
    expect(within(a).getByText('$645.00')).toBeTruthy()
    expect(within(a).getByText('$20.00')).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'Ann Lee day by day' })).toBeNull()
  })

  it('the summary bar and the footer carry the same totals', () => {
    view()
    const bar = screen.getByRole('group', { name: /Summary for/ })
    expect(within(bar).getByText('2')).toBeTruthy()                 // drivers
    expect(within(bar).getByText('36:15')).toBeTruthy()             // 32:15 + 4:00
    expect(within(bar).getByText('$645.00')).toBeTruthy()           // Bob has no rate: not counted
    const foot = screen.getByLabelText('Totals')
    expect(within(foot).getByText('36:15')).toBeTruthy()
    expect(within(foot).getByText('$645.00')).toBeTruthy()
  })

  it('a driver with no rate shows Set rate and a dash for pay, never $0', () => {
    view()
    const b = screen.getByRole('region', { name: 'Bob Ray' })
    expect(within(b).getByRole('button', { name: 'Set rate' })).toBeTruthy()
    expect(within(b).getByText('—')).toBeTruthy()
    expect(b.textContent).not.toMatch(/\$0/)
  })

  it('expanding a driver shows the day-by-day table with PTO and holiday days and week subtotals; Expand all opens everyone', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Ann Lee' }))
    const t = screen.getByRole('table', { name: 'Ann Lee day by day' })
    expect(within(t).getAllByRole('row').length).toBeGreaterThanOrEqual(14 + 1 + 2)
    expect(within(t).getByText('PTO day')).toBeTruthy()
    expect(within(t).getByText('Paid holiday')).toBeTruthy()
    expect(within(t).getByText('Week 1 subtotal')).toBeTruthy()
    expect(within(t).getByText('Week 2 subtotal')).toBeTruthy()
    expect(within(t).getByText('dentist')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Ann Lee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByRole('table', { name: 'Bob Ray day by day' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByRole('table', { name: 'Bob Ray day by day' })).toBeNull()
  })

  it('without pay access there is no Rate, Pay, Set rate, editor or dollar sign anywhere', () => {
    view({ showPay: false, rows: [row('a', 'Ann Lee', [work('1', 'a', '2026-10-12', 480)], 20, false)] })
    expect(document.body.textContent).not.toMatch(/\$|Rate|2-week pay|Total pay|Set rate/)
    expect(screen.queryByRole('button', { name: /rate/i })).toBeNull()
  })

  it('the rate editor defaults the date to the period start and saves the dollars and the date', async () => {
    const props = view()
    fireEvent.click(within(screen.getByRole('region', { name: 'Bob Ray' })).getByRole('button', { name: 'Set rate' }))
    const editor = screen.getByRole('group', { name: 'Bob Ray hourly rate' })
    expect((within(editor).getByLabelText('Effective from') as HTMLInputElement).value).toBe(START)
    fireEvent.change(within(editor).getByLabelText('Hourly rate'), { target: { value: '23.5' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rate' }))
    await waitFor(() => expect(props.onSaveRate).toHaveBeenCalledWith('b', 23.5, START))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Bob Ray hourly rate' })).toBeNull())
  })

  it('a refused rate keeps the editor open and shows why', async () => {
    view({ onSaveRate: vi.fn().mockRejectedValue(new Error('The current rate began 2026-11-02')) })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Ann Lee hourly rate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/began 2026-11-02/)
    expect(screen.getByRole('group', { name: 'Ann Lee hourly rate' })).toBeTruthy()
  })
})
