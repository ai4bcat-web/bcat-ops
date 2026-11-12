// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierBillsPanel } from './CarrierBillsPanel'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), record: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ getShipmentBundle: mocks.bundle, recordBill: mocks.record }))

const lc = (id: string, name: string, sequence: number, over: Record<string, unknown> = {}) =>
  ({ id, loadId: 'load-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: name, sequence, rateConStatus: 'SIGNED', invoiceId: null, ...over })
const line = (id: string, side: string, code: string, amountCents: number, loadCarrierId: string | null, isRate = code === 'LINEHAUL') =>
  ({ id, side, code, amountCents, loadCarrierId, isRate })

function bundleWith(loadCarriers: unknown[], charges: unknown[]) {
  return { loads: [{ id: 'load-1' }], loadCarriers, charges }
}

const CHARGES = [
  line('c1', 'CUSTOMER', 'LINEHAUL', 100_000, null),
  line('c2', 'CARRIER', 'LINEHAUL', 60_000, 'lc-a'),
  line('c3', 'CARRIER', 'DETENTION', 5_000, 'lc-a'),
  line('c4', 'CARRIER', 'LINEHAUL', 20_000, 'lc-b'),
]

const onChanged = vi.fn(async () => {})
const renderPanel = () => render(<MemoryRouter><CarrierBillsPanel shipmentId="shp-1" onChanged={onChanged} /></MemoryRouter>)

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.bundle.mockResolvedValue(bundleWith([lc('lc-a', 'Swift', 1), lc('lc-b', 'Heartland', 2, { rateConStatus: 'SENT' })], CHARGES))
  mocks.record.mockResolvedValue({})
})

describe('CarrierBillsPanel', () => {
  it('shows one column per live carrier with its rate, accessorials, rate con and bill state, and the margin on gross', async () => {
    renderPanel()
    const a = await screen.findByTestId('carrier-bill-lc-a')
    const b = screen.getByTestId('carrier-bill-lc-b')
    expect(a.textContent).toContain('Swift')
    expect(a.textContent).toContain('Rate con signed')
    expect(a.textContent).toContain('Bill not recorded')
    expect(screen.getByTestId('carrier-bill-rate-lc-a').textContent).toBe('Rate $600.00')
    expect(a.textContent).toContain('Accessorials $50.00')
    expect(b.textContent).toContain('Rate con not signed')
    expect(screen.getByTestId('carrier-bills-margin').textContent).toBe('Customer $1,000.00 − carriers $850.00 = margin $150.00')
  })

  it('names a carrier with no rate', async () => {
    mocks.bundle.mockResolvedValue(bundleWith([lc('lc-a', 'Swift', 1), lc('lc-b', 'Heartland', 2)], CHARGES.slice(0, 3)))
    renderPanel()
    const b = await screen.findByTestId('carrier-bill-lc-b')
    expect(b.textContent).toContain('Rate missing')
    expect(screen.getByTestId('carrier-bill-lc-a').textContent).not.toContain('Rate missing')
  })

  it('Record all bills records each carrier in turn, lists the result per carrier and refreshes the review', async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId('record-all-bills'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocks.record.mock.calls).toEqual([[{ loadCarrierId: 'lc-a' }], [{ loadCarrierId: 'lc-b' }]])
    expect(screen.getByTestId('record-result-lc-a').textContent).toBe('Swift: Bill recorded')
    expect(screen.getByTestId('record-result-lc-b').textContent).toBe('Heartland: Bill recorded')
  })

  it('a refusal on the second carrier names it, leaves the first recorded, and a re-run only tries what is left', async () => {
    mocks.record.mockImplementation(async (input: { loadCarrierId: string }) => {
      if (input.loadCarrierId === 'lc-b') throw new Error('Rate con is not signed')
      return {}
    })
    renderPanel()
    await screen.findByTestId('record-all-bills')
    mocks.bundle.mockResolvedValue(bundleWith([lc('lc-a', 'Swift', 1, { invoiceId: 'cb:lc-a:1' }), lc('lc-b', 'Heartland', 2)], CHARGES))
    fireEvent.click(screen.getByTestId('record-all-bills'))
    await waitFor(() => expect(screen.getByTestId('record-result-lc-b').textContent).toBe('Heartland: Failed — Rate con is not signed'))
    expect(screen.getByTestId('record-result-lc-a').textContent).toBe('Swift: Bill recorded')

    // The server now reports A as billed; the panel re-reads after the run.
    await waitFor(() => expect(screen.getByTestId('carrier-bill-lc-a').textContent).toContain('Bill recorded'))
    mocks.record.mockClear()
    mocks.record.mockResolvedValue({})
    fireEvent.click(screen.getByTestId('record-all-bills'))
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1))
    expect(mocks.record).toHaveBeenCalledWith({ loadCarrierId: 'lc-b' })
  })

  it('renders nothing for a single carrier', async () => {
    mocks.bundle.mockResolvedValue(bundleWith([lc('lc-a', 'Swift', 1)], CHARGES))
    renderPanel()
    await waitFor(() => expect(mocks.bundle).toHaveBeenCalled())
    expect(screen.queryByTestId('carrier-bills')).toBeNull()
  })

  it('with minCarriers 1 a single carrier can have its bill recorded in place, with the optional bill details', async () => {
    mocks.bundle.mockResolvedValue(bundleWith([lc('lc-a', 'Swift', 1)], CHARGES.slice(0, 3)))
    render(<MemoryRouter><CarrierBillsPanel shipmentId="shp-1" minCarriers={1} onChanged={onChanged} /></MemoryRouter>)
    await screen.findByTestId('carrier-bill-lc-a')
    fireEvent.change(screen.getByLabelText('Carrier bill number'), { target: { value: 'INV-77' } })
    fireEvent.change(screen.getByLabelText('Carrier bill date'), { target: { value: '2026-11-10' } })
    fireEvent.change(screen.getByLabelText('Carrier bill amount'), { target: { value: '650.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record bill' }))
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1))
    expect(mocks.record).toHaveBeenCalledWith({ loadCarrierId: 'lc-a', billNumber: 'INV-77', billDate: '2026-11-10', billedCents: 65050 })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
