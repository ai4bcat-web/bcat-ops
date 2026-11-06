// @vitest-environment jsdom
/**
 * AT-plan risk 1: a rate con prints only its own carrier's lines. Carrier B's document never carries A's
 * linehaul, A's accessorials or an untagged CARRIER line; the untagged line rides on the primary alone.
 * One carrier prints exactly what it always did, untagged line included.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateConPanel } from './RateConPanel'
import type { LoadCarrierRecord, LoadChargeRecord, ShipmentBundle } from '@/types/tms'

const build = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ output: () => 'data:application/pdf;base64,AAAA' })))
const filename = vi.hoisted(() => vi.fn((load: string, version: number) => `rate-con-${load}-v${version}.pdf`))

vi.mock('@/lib/apiClient', () => ({
  listDivisions: vi.fn(async () => []),
  getRateConfirmUrl: vi.fn(async () => ''),
}))
vi.mock('@/lib/carrierRateCon', () => ({
  buildRateConPdf: build,
  rateConPdfBase64: vi.fn(() => 'AAAA'),
  rateConFilename: filename,
  joinRateConNotes: vi.fn(() => ''),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'dispatch@bcatcorp.com', userId: 'u1', groups: [] }) }))

const lc = (id: string, name: string, sequence: number): LoadCarrierRecord =>
  ({ id, loadId: 'load-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: name, sequence, rateConStatus: 'NOT_SENT' }) as LoadCarrierRecord
const charge = (id: string, code: string, amountCents: number, loadCarrierId: string | null, side = 'CARRIER'): LoadChargeRecord =>
  ({ id, loadId: 'load-1', side, code, label: code, amountCents, loadCarrierId, sortOrder: Number(id.slice(1)), calculatedBy: 'FLAT', rateCents: amountCents, count: 1 }) as unknown as LoadChargeRecord

const A = lc('lc-a', 'Swift', 1)
const B = lc('lc-b', 'Heartland', 2)
const CHARGES = [
  charge('c1', 'LINEHAUL', 60_000, 'lc-a'),
  charge('c2', 'DETENTION', 5_000, 'lc-a'),
  charge('c3', 'LINEHAUL', 20_000, 'lc-b'),
  charge('c4', 'LUMPER', 7_500, 'lc-b'),
  charge('c5', 'LINEHAUL', 200_000, null, 'CUSTOMER'),
  charge('c6', 'FSC', 1_100, null),
]

const bundleOf = (loadCarriers: LoadCarrierRecord[], charges = CHARGES) =>
  ({ loads: [{ id: 'load-1', loadNumber: 'S1-1', stops: [] }], orders: [], charges, loadCarriers }) as unknown as ShipmentBundle

async function previewOf(loadCarrier: LoadCarrierRecord, bundle: ShipmentBundle) {
  render(
    <MemoryRouter>
      <RateConPanel bundle={bundle} loadCarrier={loadCarrier} carrier={null} contacts={[]} settings={null} busy={false} onSend={vi.fn()} onVoid={vi.fn()} />
    </MemoryRouter>,
  )
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Preview/ })) })
  await waitFor(() => expect(build).toHaveBeenCalled())
  return build.mock.calls[0][0] as { charges: { label: string; amountCents: number }[]; totalCents: number }
}

beforeEach(() => { vi.clearAllMocks() })

describe('RateConPanel lines with several carriers', () => {
  it("the second carrier's rate con has its own linehaul and accessorials only", async () => {
    const input = await previewOf(B, bundleOf([A, B]))
    expect(input.charges).toEqual([
      { label: 'LINEHAUL', amountCents: 20_000 },
      { label: 'LUMPER', amountCents: 7_500 },
    ])
    expect(input.totalCents).toBe(27_500)
  })

  it('an untagged CARRIER line lands on the primary only; the customer side never prints', async () => {
    const input = await previewOf(A, bundleOf([A, B]))
    expect(input.charges.map((c) => c.label)).toEqual(['LINEHAUL', 'DETENTION', 'FSC'])
    expect(input.totalCents).toBe(66_100)
  })

  it('the download name carries the carrier when two are live, so the files cannot collide', async () => {
    render(
      <MemoryRouter>
        <RateConPanel bundle={bundleOf([A, B])} loadCarrier={B} carrier={null} contacts={[]} settings={null} busy={false} onSend={vi.fn()} onVoid={vi.fn()} />
      </MemoryRouter>,
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Preview/ })) })
    await screen.findByText('Download a copy')
    expect(filename).toHaveBeenCalledWith('S1-1-heartland', 1)
  })

  it('one carrier prints every CARRIER line it has, the untagged one included, under the plain load number', async () => {
    const input = await previewOf(A, bundleOf([A]))
    expect(input.charges.map((c) => c.label)).toEqual(['LINEHAUL', 'DETENTION', 'FSC'])
    await screen.findByText('Download a copy')
    expect(filename).toHaveBeenCalledWith('S1-1', 1)
  })
})
