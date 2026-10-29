// @vitest-environment jsdom
/**
 * A voided shipment keeps its PRO, and the header is where that is said out loud: the
 * number, a red VOIDED badge, and who voided it, when and why. Nothing deletes it and
 * nothing un-voids it, so this line is the end of the record.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ShipmentPageBody } from './components/ShipmentDrawer'
import type { ShipmentBundle, ShipmentRecord } from '@/types/tms'

const useShipmentContext = vi.hoisted(() => vi.fn())
vi.mock('./useShipmentContext', () => ({ useShipmentContext }))
vi.mock('./components/ShipmentDetail', () => ({ ShipmentDetail: () => <div>detail</div> }))
vi.mock('./components/StatusActions', () => ({ ShipmentRowActions: () => <div>actions</div> }))

function shipment(over: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: 'shp-1', number: 'S000001', status: 'DELIVERED', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function mountWith(row: ShipmentRecord) {
  const bundle = {
    shipment: row, orders: [], loads: [], loadCarriers: [], charges: [], financials: [], documents: [],
  } as unknown as ShipmentBundle
  useShipmentContext.mockReturnValue({
    bundle, loading: false, error: null, cancelDeleteAdminOnly: false,
    actions: { shipment: {} }, detailProps: {},
  })
  render(
    <MemoryRouter>
      <ShipmentPageBody
        shipmentId="shp-1"
        options={{ customers: [], locations: [], settings: null, isAdmin: true, currentUser: 'ryne@bcatcorp.com' }}
      />
    </MemoryRouter>,
  )
}

describe('the shipment header', () => {
  it('says VOIDED, by whom, when and why', () => {
    mountWith(shipment({
      voidedAt: '2026-04-04T15:30:00.000Z',
      voidedBy: 'ryne@bcatcorp.com',
      voidReason: 'Duplicate of S000002',
    }))
    expect(screen.getByText('VOIDED')).toBeTruthy()
    const note = screen.getByTestId('voided-note').textContent ?? ''
    expect(note).toContain('Voided by ryne@bcatcorp.com')
    expect(note).toContain('Duplicate of S000002')
  })

  it('says nothing of the sort on a live shipment', () => {
    mountWith(shipment())
    expect(screen.queryByText('VOIDED')).toBeNull()
    expect(screen.queryByTestId('voided-note')).toBeNull()
  })
})
