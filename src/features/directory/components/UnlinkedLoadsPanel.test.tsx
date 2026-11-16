// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const setShipmentCustomer = vi.fn()
vi.mock('@/lib/apiClient', () => ({ setShipmentCustomer: (...a: unknown[]) => setShipmentCustomer(...a), listUnlinkedShipments: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/shipments/components/RepointCustomerDialog', () => ({
  RepointCustomerDialog: (p: { shipment: { number: string }; onRepointed?: (id: string) => void }) => (
    <div data-testid="link-dialog">{p.shipment.number}<button type="button" onClick={() => p.onRepointed?.('cus-9')}>pick</button></div>
  ),
}))

import { UnlinkedLoadsPanel } from './UnlinkedLoadsPanel'
import type { UnlinkedShipment } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'

const ship = (over: Partial<UnlinkedShipment>): UnlinkedShipment => ({
  id: 'shp-1', number: '20007', customerName: 'R&R Transport, Inc.', originCity: 'MADISON, WI', destinationCity: 'CHICAGO, IL',
  pickupAppt: '2026-11-09T14:00:00.000Z', deliveryAppt: null, status: 'DELIVERED', inLoadReview: true, updatedAt: null, ...over,
})
const rnr = { id: 'cus-1', name: 'R and R Transport', aliases: [], active: true } as CustomerRecord

function unlinkedOf(rows: UnlinkedShipment[]) {
  return { rows, total: rows.length, loading: false, error: null, loaded: true, refresh: vi.fn(), dropLinked: vi.fn() }
}
const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('UnlinkedLoadsPanel on a customer profile', () => {
  beforeEach(() => setShipmentCustomer.mockReset())
  const rows = [ship({}), ship({ id: 'shp-2', number: '20008', customerName: 'R & R Transport', inLoadReview: false }), ship({ id: 'shp-3', number: '14000', customerName: 'Coyne Transportation' })]

  it('lists the loads typed like this customer and not the others', () => {
    wrap(<UnlinkedLoadsPanel unlinked={unlinkedOf(rows)} customers={[rnr]} customer={rnr} />)
    expect(screen.getByText('20007')).toBeTruthy()
    expect(screen.getByText('20008')).toBeTruthy()
    expect(screen.queryByText('14000')).toBeNull()
    expect(screen.getAllByText('In Load Review')).toHaveLength(1)
  })

  it('links one load to this customer', async () => {
    setShipmentCustomer.mockResolvedValue({})
    const unlinked = unlinkedOf(rows)
    const onLinked = vi.fn()
    wrap(<UnlinkedLoadsPanel unlinked={unlinked} customers={[rnr]} customer={rnr} onLinked={onLinked} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Link to this customer' })[0])
    await waitFor(() => expect(onLinked).toHaveBeenCalled())
    expect(setShipmentCustomer).toHaveBeenCalledWith({ shipmentId: 'shp-2', customerId: 'cus-1' })
    expect(unlinked.dropLinked).toHaveBeenCalledWith(['shp-2'])
  })

  it('links the ticked loads together and reports the one that failed', async () => {
    setShipmentCustomer.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('already linked'))
    const unlinked = unlinkedOf(rows)
    wrap(<UnlinkedLoadsPanel unlinked={unlinked} customers={[rnr]} customer={rnr} />)
    fireEvent.click(screen.getByLabelText('Select 20007'))
    fireEvent.click(screen.getByLabelText('Select 20008'))
    fireEvent.click(screen.getByRole('button', { name: 'Link selected (2)' }))
    await waitFor(() => expect(setShipmentCustomer).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(unlinked.dropLinked).toHaveBeenCalled())
    expect(unlinked.dropLinked).toHaveBeenCalledWith(['shp-2'])
  })

  it('finds other unlinked loads by PRO with the search box', () => {
    wrap(<UnlinkedLoadsPanel unlinked={unlinkedOf(rows)} customers={[rnr]} customer={rnr} />)
    fireEvent.change(screen.getByLabelText('Search unlinked loads'), { target: { value: '14000' } })
    expect(screen.getByText('14000')).toBeTruthy()
    expect(screen.getByText('Other name')).toBeTruthy()
    expect(screen.queryByText('20007')).toBeNull()
  })
})

describe('UnlinkedLoadsPanel in the Directory', () => {
  it('lists every unlinked load and opens the shipment\'s link picker', () => {
    const unlinked = unlinkedOf([ship({}), ship({ id: 'shp-3', number: '14000', customerName: 'Coyne Transportation' })])
    wrap(<UnlinkedLoadsPanel unlinked={unlinked} customers={[rnr]} />)
    expect(screen.getByText('20007')).toBeTruthy()
    expect(screen.getByText('14000')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Link…' })[0])
    expect(screen.getByTestId('link-dialog').textContent).toContain('20007')
    fireEvent.click(screen.getByText('pick'))
    expect(unlinked.dropLinked).toHaveBeenCalledWith(['shp-1'])
  })
})
