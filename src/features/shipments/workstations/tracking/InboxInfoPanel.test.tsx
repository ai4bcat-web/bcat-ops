// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { LoadCarrierRecord, ShipmentBundle } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { InboxChatHeader } from './InboxChatHeader'
import { InboxInfoPanel } from './InboxInfoPanel'
import { INBOX_INFO_STORAGE_KEY, useInboxInfoOpen } from './useInboxInfoOpen'
import { legGeometry } from './statusTimeline'

const row = { id: 'S1', number: 'S001', loadStatus: 'IN_TRANSIT' } as ShipmentRow

function bundleWith(leg: Partial<LoadCarrierRecord>): ShipmentBundle {
  return {
    shipment: { id: 'S1' }, orders: [], charges: [], financials: [],
    loads: [{ id: 'l1', shipmentId: 'S1', status: 'IN_TRANSIT', stops: [] }],
    loadCarriers: [{ id: 'c1', loadId: 'l1', shipmentId: 'S1', status: 'ACTIVE', kind: 'CARRIER', ...leg }],
  } as unknown as ShipmentBundle
}

function Harness({ leg }: { leg: Partial<LoadCarrierRecord> }) {
  const [open, setOpen] = useInboxInfoOpen()
  const bundle = bundleWith(leg)
  const geo = legGeometry(bundle, 'S1')
  return (
    <MemoryRouter>
      <InboxChatHeader row={row} leg={geo.leg} pingAt="2026-10-29T11:56:00Z" nowMs={Date.parse('2026-10-29T12:00:00Z')} infoOpen={open} onToggleInfo={() => setOpen(!open)} />
      {open && <InboxInfoPanel row={row} bundle={bundle} geo={geo} eta={null} nowMs={0} onClose={() => setOpen(false)} />}
    </MemoryRouter>
  )
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('Inbox info panel', () => {
  it('closing persists to localStorage and stays closed after a remount', () => {
    localStorage.setItem(INBOX_INFO_STORAGE_KEY, 'open')
    const first = render(<Harness leg={{ driverName: 'Jake' }} />)
    expect(screen.getByTestId('inbox-info-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close info panel' }))
    expect(screen.queryByTestId('inbox-info-panel')).not.toBeInTheDocument()
    expect(localStorage.getItem(INBOX_INFO_STORAGE_KEY)).toBe('closed')
    first.unmount()
    render(<Harness leg={{ driverName: 'Jake' }} />)
    expect(screen.queryByTestId('inbox-info-panel')).not.toBeInTheDocument()
  })

  it('the header info button reopens it', () => {
    localStorage.setItem(INBOX_INFO_STORAGE_KEY, 'closed')
    render(<Harness leg={{ driverName: 'Jake' }} />)
    const toggle = screen.getByRole('button', { name: 'Shipment info' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('inbox-info-panel')).toBeInTheDocument()
    expect(localStorage.getItem(INBOX_INFO_STORAGE_KEY)).toBe('open')
  })

  it('offers a call link only when a driver phone exists', () => {
    localStorage.setItem(INBOX_INFO_STORAGE_KEY, 'open')
    const { unmount } = render(<Harness leg={{ driverName: 'Jake', driverPhone: '+15550101' }} />)
    expect(screen.getAllByRole('link', { name: 'Call Jake' }).length).toBeGreaterThan(0)
    for (const a of screen.getAllByRole('link', { name: 'Call Jake' })) expect(a).toHaveAttribute('href', 'tel:+15550101')
    unmount()
    render(<Harness leg={{ driverName: 'Jake' }} />)
    expect(screen.queryByRole('link', { name: 'Call Jake' })).not.toBeInTheDocument()
  })

  it('never claims presence: no ONLINE text, only the last ping', () => {
    localStorage.setItem(INBOX_INFO_STORAGE_KEY, 'open')
    render(<Harness leg={{ driverName: 'Jake', driverPhone: '+15550101' }} />)
    expect(document.body.textContent).not.toMatch(/online/i)
    expect(screen.getByTestId('inbox-last-ping')).toHaveTextContent('Last ping 4 min ago')
    expect(screen.getByTestId('inbox-last-ping')).toHaveAttribute('data-fresh', 'true')
  })
})
