// @vitest-environment jsdom
/** The Auto shipper loads page: rows and payment states for someone with both money grants, and nothing monetary without them. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const api = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listShipmentsByCustomer: vi.fn(),
  listOrdersByShipmentIds: vi.fn(),
  listCarShippingByShipmentIds: vi.fn(),
  listInvoicesByCustomer: vi.fn(),
  listLoadCarriersByShipmentIds: vi.fn(),
  listBillsByCarrier: vi.fn(),
  listCarrierPaymentInfo: vi.fn(),
}))
const auth = vi.hoisted(() => ({
  user: { userId: 'u', email: 'ryne@bcatcorp.com', groups: [] as string[] },
  isAdmin: false,
  isOwner: false,
  access: new Set<string>(),
  hasPageAccess(key: string) { return this.access.has(key) },
}))

vi.mock('@/lib/apiClient', () => ({ ...api, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth, useAuthUser: () => auth.user }))

import { AutoShipperLoadsPage } from './AutoShipperLoadsPage'

const shipment = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  id, number, status: 'DELIVERED', customerId: 'c-auto', customerName: 'AUTO SHIPPER', pickupAppt: '2026-11-20T15:00:00Z', deliveryAppt: '2026-11-24T15:00:00Z',
  originCity: 'Chicago', destinationCity: 'Dallas', ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  auth.user = { userId: 'u', email: 'ryne@bcatcorp.com', groups: [] }
  auth.access = new Set(['autoShipperLoads', 'invoicing', 'carrierPay'])
  api.listCustomers.mockResolvedValue([{ id: 'c-auto', name: 'AUTO SHIPPER', invoiceChannel: 'SQUARE' }, { id: 'c-other', name: 'Danisco', invoiceChannel: null }])
  api.listShipmentsByCustomer.mockImplementation(async (id: string) => (id === 'c-auto' ? [shipment('s1', '14730'), shipment('s2', '14731')] : []))
  api.listOrdersByShipmentIds.mockResolvedValue([
    { id: 'o1', shipmentId: 's1', customerId: 'c-auto', revenueCents: 120900 },
    { id: 'o2', shipmentId: 's2', customerId: 'c-auto', revenueCents: 150000 },
  ])
  api.listCarShippingByShipmentIds.mockResolvedValue(new Map([
    ['s1', { payer: { name: 'Pat Doe', email: 'pat@example.com', phone: '5555550100' }, vehicle: { year: '2021', make: 'Honda', model: 'Accord' } }],
  ]))
  api.listInvoicesByCustomer.mockResolvedValue([
    { id: 'i1', number: '14730', shipmentId: 's1', customerId: 'c-auto', status: 'PAID', invoiceDate: '2026-11-22', issuedAt: '2026-11-22T10:00:00Z', totalCents: 120900, paidCents: 120900, balanceCents: 0 },
  ])
  api.listLoadCarriersByShipmentIds.mockResolvedValue([
    { id: 'L1', shipmentId: 's1', loadId: 'l1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car1', carrierName: 'Galeski Trucking', carrierRateCents: 90000 },
    { id: 'L2', shipmentId: 's2', loadId: 'l2', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car2', carrierName: 'Matrix Inc', carrierRateCents: 100000 },
  ])
  api.listBillsByCarrier.mockImplementation(async (id: string) => (id === 'car1'
    ? [{ id: 'b1', loadCarrierId: 'L1', shipmentId: 's1', carrierId: 'car1', carrierName: 'Galeski Trucking', payeeKind: 'CARRIER', status: 'PAID', recordedAt: '2026-11-23T10:00:00Z', netCents: 90000, balanceCents: 0, paidAt: '2026-11-26T12:00:00Z' }]
    : []))
  api.listCarrierPaymentInfo.mockResolvedValue([])
})
afterEach(cleanup)

const renderPage = () => render(<MemoryRouter><AutoShipperLoadsPage /></MemoryRouter>)

describe('AutoShipperLoadsPage', () => {
  it('lists the auto shipper loads with the customer and carrier payment states', async () => {
    renderPage()
    expect(await screen.findAllByText('14730')).toBeTruthy()
    expect(screen.getAllByText('14731').length).toBeGreaterThan(0)
    // Only the auto shipper customer's shipments were read.
    expect(api.listShipmentsByCustomer).toHaveBeenCalledWith('c-auto')
    expect(api.listShipmentsByCustomer).not.toHaveBeenCalledWith('c-other')
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Not invoiced').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No bill yet').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Customers owe').length).toBeGreaterThan(0)
    // Carrier names link to the bill (or the shipment's Carrier Pay tab when no bill exists).
    const galeski = screen.getAllByRole('link', { name: 'Galeski Trucking' })[0]
    expect(galeski.getAttribute('href')).toBe('/tms/invoicing/payable/bills/b1')
    expect(screen.getAllByRole('link', { name: 'Matrix Inc' })[0].getAttribute('href')).toContain('/tms/shipments/s2/edit?tab=carrierPay')
  })

  it('the Carrier unpaid tab keeps only loads with a carrier still to pay', async () => {
    renderPage()
    await screen.findAllByText('14730')
    fireEvent.click(screen.getByRole('tab', { name: /Carrier unpaid \(1\)/ }))
    await waitFor(() => expect(screen.queryAllByText('14730')).toHaveLength(0))
    expect(screen.getAllByText('14731').length).toBeGreaterThan(0)
  })

  it('shows no customer or carrier money, and reads none, to someone without the AR and AP grants', async () => {
    auth.access = new Set(['autoShipperLoads'])
    renderPage()
    expect(await screen.findAllByText('14730')).toBeTruthy()
    expect(api.listInvoicesByCustomer).not.toHaveBeenCalled()
    expect(api.listLoadCarriersByShipmentIds).not.toHaveBeenCalled()
    expect(api.listBillsByCarrier).not.toHaveBeenCalled()
    expect(screen.queryByText('Customers owe')).toBeNull()
    expect(screen.queryByText('Carriers to pay')).toBeNull()
    expect(screen.queryByText('Galeski Trucking')).toBeNull()
    expect(screen.queryByText('$1,209.00')).toBeNull()
    expect(screen.queryByRole('tab', { name: /Customer unpaid/ })).toBeNull()
  })

  it('a person limited to the fleet profiles (Jason) sees no money even with the grants', async () => {
    auth.user = { userId: 'j', email: 'jason@bcatcorp.com', groups: [] }
    renderPage()
    expect(await screen.findAllByText('14730')).toBeTruthy()
    expect(api.listInvoicesByCustomer).not.toHaveBeenCalled()
    expect(api.listBillsByCarrier).not.toHaveBeenCalled()
    expect(screen.queryByText('Customers owe')).toBeNull()
    expect(screen.queryByText('Galeski Trucking')).toBeNull()
  })
})
