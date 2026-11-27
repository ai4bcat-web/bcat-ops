// @vitest-environment jsdom
/** The Auto Shipper Loads page: rows and payment states for someone with both money grants, and nothing monetary without them. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('Mark paid and Pay carrier link to Payments Received and Accounts Payable on that invoice and bill', async () => {
    api.listShipmentsByCustomer.mockImplementation(async (id: string) => (id === 'c-auto' ? [shipment('s1', '14730'), shipment('s2', '14731'), shipment('s3', '14732')] : []))
    api.listOrdersByShipmentIds.mockResolvedValue([
      { id: 'o1', shipmentId: 's1', customerId: 'c-auto', revenueCents: 120900 },
      { id: 'o2', shipmentId: 's2', customerId: 'c-auto', revenueCents: 150000 },
      { id: 'o3', shipmentId: 's3', customerId: 'c-auto', revenueCents: 90000 },
    ])
    api.listInvoicesByCustomer.mockResolvedValue([
      { id: 'i1', number: '14730', shipmentId: 's1', customerId: 'c-auto', status: 'PAID', invoiceDate: '2026-11-22', issuedAt: '2026-11-22T10:00:00Z', totalCents: 120900, paidCents: 120900, balanceCents: 0 },
      { id: 'i3', number: '14732', shipmentId: 's3', customerId: 'c-auto', status: 'ISSUED', invoiceDate: '2026-11-22', issuedAt: '2026-11-22T10:00:00Z', totalCents: 90000, paidCents: 0, balanceCents: 90000 },
    ])
    api.listLoadCarriersByShipmentIds.mockResolvedValue([
      { id: 'L2', shipmentId: 's2', loadId: 'l2', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car2', carrierName: 'Matrix Inc', carrierRateCents: 100000 },
      { id: 'L3', shipmentId: 's3', loadId: 'l3', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car3', carrierName: 'Landstar', carrierRateCents: 70000 },
    ])
    api.listBillsByCarrier.mockImplementation(async (id: string) => (id === 'car3'
      ? [{ id: 'b3', loadCarrierId: 'L3', shipmentId: 's3', carrierId: 'car3', carrierName: 'Landstar', payeeKind: 'CARRIER', status: 'TO_BE_PAID', recordedAt: '2026-11-23T10:00:00Z', netCents: 70000, balanceCents: 70000 }]
      : []))
    renderPage()
    await screen.findAllByText('14732')
    const markPaid = within(screen.getByTestId('asl-customer-action-14732')).getByRole('link', { name: 'Mark paid' })
    const mp = new URL(markPaid.getAttribute('href')!, 'http://x')
    expect(mp.pathname).toBe('/tms/payments-received')
    expect(mp.searchParams.get('record')).toBe('1')
    expect(mp.searchParams.get('customer')).toBe('c-auto')
    expect(mp.searchParams.getAll('invoice')).toEqual(['i3'])
    // A paid invoice has no button; an uninvoiced load says why and links to Mark invoiced.
    expect(screen.queryByTestId('asl-customer-action-14730')).toBeNull()
    const notInvoiced = screen.getByTestId('asl-customer-action-14731')
    expect(within(notInvoiced).getByText('Not invoiced yet')).toBeTruthy()
    expect(within(notInvoiced).getByRole('link', { name: 'Mark invoiced' }).getAttribute('href')).toBe('/tms/invoicing?tab=ready')
    expect(within(notInvoiced).queryByRole('link', { name: 'Mark paid' })).toBeNull()
    // Carrier buttons: pay an approved bill, record the bill for a leg with none.
    const pay = new URL(within(screen.getByTestId('asl-carrier-action-14732')).getByRole('link', { name: 'Pay carrier' }).getAttribute('href')!, 'http://x')
    expect(pay.pathname).toBe('/tms/invoicing/payable')
    expect(pay.searchParams.get('payBill')).toBe('b3')
    const record = new URL(within(screen.getByTestId('asl-carrier-action-14731')).getByRole('link', { name: 'Record bill' }).getAttribute('href')!, 'http://x')
    expect(record.searchParams.get('recordLeg')).toBe('L2')
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
    expect(screen.queryByText('Mark paid')).toBeNull()
    expect(screen.queryByText('Pay carrier')).toBeNull()
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
