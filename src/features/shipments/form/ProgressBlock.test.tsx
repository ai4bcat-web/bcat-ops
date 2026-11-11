// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'
import { ProgressBlock } from './ProgressBlock'

vi.mock('./useShipmentActivity', () => ({
  useShipmentActivity: () => ({
    entries: [{ id: 'a1', entityType: 'LOAD_CARRIER', entityId: 'lc1', action: 'COVER_CARRIER', user: 'dee@bcatcorp.com', changes: {}, createdAt: '2026-11-10T11:05:00.000Z' }],
    at: Date.now(), error: null,
  }),
}))

const staff = [{ id: 'dee@bcatcorp.com', email: 'dee@bcatcorp.com', name: 'Dee Park' }] as never
const bundle = (carriers: object[]) => ({
  shipment: { id: 'shp-1', number: '20018', status: 'OPEN', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T10:00:00.000Z' },
  orders: [{ id: 'o1' }], loads: [{ id: 'l1', assignmentType: 'CARRIER' }], loadCarriers: carriers,
}) as unknown as ShipmentBundle

describe('ProgressBlock', () => {
  it('an open load says what to do next: cover it', () => {
    render(<ProgressBlock bundle={bundle([])} staff={staff} />)
    expect(screen.getByTestId('rail-next-step').textContent).toMatch(/Next:.*Cover it/)
    expect(screen.getByTestId('rail-prog-created').getAttribute('data-state')).toBe('done')
    expect(screen.getByTestId('rail-prog-covered').getAttribute('data-state')).toBe('next')
    expect(screen.queryByTestId('rail-uncover')).toBeNull()
  })

  it('a covered load shows the carrier and who covered it, and offers Uncover', () => {
    const onUncover = vi.fn()
    const lc = { id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Acme Freight', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T11:00:00.000Z', assignmentStatus: 'ASSIGNED_SETUP_PENDING' }
    render(<ProgressBlock bundle={bundle([lc])} staff={staff} onUncover={onUncover} />)
    const row = screen.getByTestId('rail-prog-covered')
    expect(row.getAttribute('data-state')).toBe('done')
    expect(row.textContent).toContain('Acme Freight')
    expect(row.textContent).toContain('by Dee Park')
    fireEvent.click(screen.getByTestId('rail-uncover'))
    expect(onUncover).toHaveBeenCalledTimes(1)
  })

  it('renders nothing in create mode', () => {
    const { container } = render(<ProgressBlock bundle={null} staff={staff} />)
    expect(container.innerHTML).toBe('')
  })
})
