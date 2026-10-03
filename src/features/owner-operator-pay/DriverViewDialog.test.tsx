// @vitest-environment jsdom
/**
 * Staff answering "what is the driver seeing?" were asking the driver — someone on a truck
 * describing a screen to someone looking at a different one. This renders the driver's own
 * settlement component at phone width.
 *
 * Two properties are worth holding onto: it shows the driver's figures, not the office's
 * view of them, and it cannot be mistaken for the driver's session or used to act as them.
 */
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DriverViewDialog } from './DriverViewDialog'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'

vi.mock('@/features/driver-app/settlement/useTripDocs', () => ({
  // Reaches the DRIVER api, which a staff session has no token for. It degrades on its
  // own; stubbed here so the test is about the preview rather than about that.
  useTripDocs: () => ({ find: () => null, loading: false, refresh: vi.fn() }),
}))

const trip = (over: Record<string, unknown> = {}) => ({
  id: 'load-1', loadId: '14538', customer: 'WAYFINDER LOGISTICS',
  origin: 'DALLAS, TX', destination: 'OKLAHOMA CITY, OK',
  miles: 206, freightAmount: 1250, deliveredAt: '2026-10-02T18:00:00.000Z',
  readiness: {
    ready: false, payload: { InvoiceNo: '14538' }, sources: {},
    missingFields: [], missingDocuments: [] as string[], warnings: [],
  },
  ...over,
})

function row(over: Partial<OwnerOperatorPayRow> = {}): OwnerOperatorPayRow {
  return {
    driver: { id: 'drv-1', name: 'Ryne Test' },
    setting: { payPercent: 0.88, expensesBeforePercent: false },
    trips: [trip()],
    deductions: [], credits: [], debits: [], fixedDebits: [],
    heldTrips: [], heldFreight: 0,
    statement: { gross: 1250, factoringFee: 25, checkAmount: 1075 },
    ...over,
  } as unknown as OwnerOperatorPayRow
}

/* ShipmentRows calls useNavigate unconditionally, even read-only. */
const open = (over: Partial<OwnerOperatorPayRow> = {}) =>
  render(
    <MemoryRouter>
      <DriverViewDialog row={row(over)} periodStart="2026-09-27" onClose={vi.fn()} />
    </MemoryRouter>,
  )

describe('DriverViewDialog', () => {
  it('shows the driver’s own shipment row, PRO and all', () => {
    open()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('14538')).toBeInTheDocument()
    // Named in the header, so whoever is looking knows whose screen this is.
    expect(within(dialog).getByText('Ryne Test — driver app')).toBeInTheDocument()
  })

  it('shows the check the driver is shown, not the office’s gross', () => {
    open()
    expect(screen.getByRole('dialog').textContent).toContain('$1,075.00')
  })

  it('shows a held load as held, exactly as their phone does', () => {
    // The figure that matters: a preview showing what a held load WOULD have paid would
    // have staff quoting a driver a number that never arrives.
    const t = trip()
    open({ trips: [t], heldTrips: [{ trip: t, reason: 'NO_POD' }] } as Partial<OwnerOperatorPayRow>)
    expect(screen.getByRole('dialog').textContent).toMatch(/until the POD is in/i)
  })

  it('says plainly that it is a preview and not a sign-in', () => {
    // Someone looking at a driver's screen on their own desktop should be in no doubt
    // about whose session they are in.
    open()
    expect(screen.getByText(/not a sign-in as Ryne Test/)).toBeInTheDocument()
  })

  it('offers nothing to act with — no upload, no remove, no Send POD', () => {
    /*
     * Paperwork belongs to the driver and to the Loads page. Worse than a trap: those
     * controls navigate into the DRIVER app, so a staff member clicking Send POD would
     * leave the settlements page entirely and land in a session that is not theirs.
     */
    open()
    const dialog = screen.getByRole('dialog')
    const labels = within(dialog).queryAllByRole('button').map((b) => b.textContent ?? '')
    expect(labels.some((l) => /upload|remove|replace|send/i.test(l))).toBe(false)
    // The documents are still REPORTED, just not actionable.
    expect(dialog.textContent).toMatch(/POD in|POD needed/)
  })

  it('closes from the button and from the backdrop', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <DriverViewDialog row={row()} periodStart="2026-09-27" onClose={onClose} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close the driver view' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders a week with no loads rather than failing in front of staff', () => {
    open({ trips: [], statement: { gross: 0, factoringFee: 0, checkAmount: 0 } } as Partial<OwnerOperatorPayRow>)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
