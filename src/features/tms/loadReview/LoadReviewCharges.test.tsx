// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { LoadReviewCharges } from './LoadReviewCharges'
import { draftsOf, groupsOf, toRecalc, totalsOf } from './chargesEdit'
import type { ShipmentBundle } from '@/types/tms'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), recalc: vi.fn(), send: vi.fn(), carrier: vi.fn() }))

vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle,
  getTmsSettings: vi.fn(async () => ({ chargeCodes: [{ code: 'DETENTION', label: 'Detention' }] })),
  recalcCharges: mocks.recalc,
  sendRateCon: mocks.send,
  voidRateCon: vi.fn(),
  getCarrierBundle: mocks.carrier,
}))
vi.mock('@/features/carriers/components/RateConPanel', () => ({
  RateConPanel: ({ onSend }: { onSend: (input: { loadCarrierId: string; pdfBase64: string; to: string[] }) => Promise<void> }) =>
    <button onClick={() => void onSend({ loadCarrierId: 'lc-1', pdfBase64: 'cGRm', to: ['dispatch@sherifaj.com'] })}>Send for e-signature</button>,
}))

const line = (over: Record<string, unknown>) => ({
  orderId: 'o-1', loadId: 'load-1', loadCarrierId: null, label: null, calculatedBy: 'FLAT', count: 1, release: null, note: null,
  createdBy: 'x', createdAt: 't', updatedAt: 't', ...over,
})
const bundle = {
  shipment: { id: 'shp-1', version: 4 },
  orders: [{ id: 'o-1' }],
  loads: [{ id: 'load-1', miles: 300, weight: 20000 }],
  loadCarriers: [{ id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', kind: 'CARRIER', sequence: 0, carrierId: 'car-1', carrierName: 'SHERIFAJ TRUCKING INC', rateConStatus: 'SIGNED' }],
  charges: [
    line({ id: 'c1', side: 'CUSTOMER', code: 'LINEHAUL', label: 'Line Haul', rateCents: 165000, amountCents: 165000, isRate: true, sortOrder: 0 }),
    line({ id: 'c2', side: 'CUSTOMER', code: 'DETENTION', label: 'Detention', rateCents: 10000, amountCents: 10000, isRate: false, sortOrder: 1 }),
    line({ id: 'k1', side: 'CARRIER', orderId: null, loadCarrierId: 'lc-1', code: 'LINEHAUL', label: 'Line Haul', rateCents: 147000, amountCents: 147000, isRate: true, sortOrder: 2 }),
  ],
  financials: [{ id: 'load-1', frozenAt: null }],
  documents: [],
} as unknown as ShipmentBundle

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.bundle.mockResolvedValue(bundle)
  mocks.recalc.mockResolvedValue(bundle)
  mocks.send.mockResolvedValue(bundle)
  mocks.carrier.mockResolvedValue({ carrier: { id: 'car-1', name: 'SHERIFAJ TRUCKING INC', status: 'ACTIVE' }, contacts: [] })
})

describe('chargesEdit', () => {
  it('groups the customer side and each live carrier, priced like the server', () => {
    const drafts = draftsOf(bundle)
    const groups = groupsOf(bundle, drafts)
    expect(groups.map((g) => [g.title, g.totalCents])).toEqual([['Charge customer', 175000], ['Pay SHERIFAJ TRUCKING INC', 147000]])
    expect(totalsOf(bundle, drafts)).toMatchObject({ revenueCents: 175000, costCents: 147000, profitCents: 28000, marginBps: 1600 })
  })

  it('refuses a line with no code or a negative carrier line, and sends the full set otherwise', () => {
    const drafts = draftsOf(bundle)
    expect(toRecalc([...drafts, { ...drafts[0], key: 'n', id: null, code: ' ' }])).toMatchObject({ ok: false })
    expect(toRecalc(drafts.map((d) => (d.side === 'CARRIER' ? { ...d, rateCents: -1 } : d)))).toMatchObject({ ok: false })
    const ok = toRecalc(drafts)
    expect(ok.ok && ok.charges.map((c) => [c.id, c.side, c.code, c.rateCents, c.isRate])).toEqual([
      ['c1', 'CUSTOMER', 'LINEHAUL', 165000, true], ['c2', 'CUSTOMER', 'DETENTION', 10000, false], ['k1', 'CARRIER', 'LINEHAUL', 147000, true],
    ])
  })
})

describe('LoadReviewCharges', () => {
  it('shows each side, the live AP line, and saves an edit through RECALC_CHARGES', async () => {
    const onChanged = vi.fn(async () => {})
    render(<LoadReviewCharges shipmentId="shp-1" onChanged={onChanged} />)
    expect(await screen.findByText('Charge customer')).toBeTruthy()
    expect(screen.getByTestId('lr-ap-note').textContent).toContain('SHERIFAJ TRUCKING INC — $1,470.00')

    fireEvent.click(screen.getByRole('button', { name: 'Edit charges' }))
    const carrier = screen.getByRole('region', { name: 'Pay SHERIFAJ TRUCKING INC' })
    const rate = within(carrier).getByLabelText('Rate')
    fireEvent.change(rate, { target: { value: '1500' } })
    fireEvent.blur(rate)
    expect(screen.getByTestId('lr-ap-note').textContent).toContain('$1,500.00')
    expect(within(carrier).getByRole('note').textContent).toContain('$1,470.00 → $1,500.00')

    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))
    await waitFor(() => expect(mocks.recalc).toHaveBeenCalledTimes(1))
    expect(mocks.recalc).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shp-1', expectedVersion: 4 }))
    const sent = mocks.recalc.mock.calls[0][0].charges as { id?: string; rateCents: number }[]
    expect(sent.find((c) => c.id === 'k1')?.rateCents).toBe(150000)
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('adds and removes a customer line', async () => {
    render(<LoadReviewCharges shipmentId="shp-1" onChanged={vi.fn(async () => {})} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit charges' }))
    const customer = screen.getByRole('region', { name: 'Charge customer' })
    fireEvent.click(within(customer).getByRole('button', { name: /Remove Detention/ }))
    fireEvent.click(within(customer).getByRole('button', { name: /Add line/ }))
    const codes = within(customer).getAllByLabelText('Charge code')
    fireEvent.change(codes[codes.length - 1], { target: { value: 'lumper' } })
    const rates = within(customer).getAllByLabelText('Rate')
    fireEvent.change(rates[rates.length - 1], { target: { value: '75' } })
    fireEvent.blur(rates[rates.length - 1])
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))
    await waitFor(() => expect(mocks.recalc).toHaveBeenCalledTimes(1))
    const sent = mocks.recalc.mock.calls[0][0].charges as { id?: string; code: string; rateCents: number; side: string; orderId: string | null }[]
    expect(sent.some((c) => c.id === 'c2')).toBe(false)
    expect(sent.find((c) => c.code === 'LUMPER')).toMatchObject({ side: 'CUSTOMER', rateCents: 7500, orderId: 'o-1' })
  })

  it('is read-only once released', async () => {
    render(<LoadReviewCharges shipmentId="shp-1" readOnly onChanged={vi.fn(async () => {})} />)
    expect(await screen.findByText('Charge customer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit charges' })).toBeNull()
    expect(screen.queryByTestId('lr-ap-note')).toBeNull()
  })

  it('asks before the rate confirmation e-mails the carrier', async () => {
    const onChanged = vi.fn(async () => {})
    render(<LoadReviewCharges shipmentId="shp-1" onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /Rate confirmation/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send for e-signature' }))
    expect(mocks.send).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('alertdialog', { name: 'Send rate confirmation' })
    expect(confirm.textContent).toContain('dispatch@sherifaj.com')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send it' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ loadCarrierId: 'lc-1', to: ['dispatch@sherifaj.com'] })))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
