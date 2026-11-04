// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UnmatchedOffers } from './UnmatchedOffers'

const mocks = vi.hoisted(() => ({ assign: vi.fn(), dismiss: vi.fn(), byNumber: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  assignInboundOffer: mocks.assign, dismissInboundOffer: mocks.dismiss, listShipmentsByNumber: mocks.byNumber,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function row(id: string, top: unknown) {
  return {
    id, shipmentId: 'UNMATCHED', channel: 'EMAIL', kind: 'CARRIER_OFFER', at: '2026-11-04T15:00:00Z', from: 'c@example.invalid', subject: 'Truck available', body: 'I can do it for 1900',
    offer: {
      source: 'EMAIL', boardProvider: null,
      extraction: { kind: 'OFFER', rateCents: 190_000, loadRefs: [], postingRef: null, origin: { city: 'Chicago', state: 'IL' }, destination: { city: 'Dallas', state: 'TX' }, carrier: { name: 'Hauler', mc: '123456' }, flags: [] },
      match: { state: top ? 'SUGGESTED' : 'UNMATCHED', how: 'LANE_DATE', score: 0.8, top, candidates: top ? [top] : [] },
      fieldMeta: { rateCents: { source: 'MODEL', confidence: 'low' } },
    },
  }
}

const TOP = { shipmentId: 's-9', shipmentNumber: 'L900', loadId: 'ld-9', score: 0.8, how: 'LANE_DATE', laneText: 'Chicago → Dallas', signals: [{ key: 'origin', points: 0.35, detail: 'origin city' }] }

const onChanged = vi.fn()
const draw = (rows: unknown[]) => render(<UnmatchedOffers rows={rows as never} loading={false} error={null} onChanged={onChanged} />)

beforeEach(() => { vi.clearAllMocks(); mocks.assign.mockResolvedValue({}); mocks.dismiss.mockResolvedValue({}) })

describe('UnmatchedOffers', () => {
  it('one click assigns the suggested load and changes nothing else', async () => {
    draw([row('m-1', TOP)])
    fireEvent.click(screen.getByTestId('cs-unmatched-assign-m-1'))
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith({ messageId: 'm-1', shipmentId: 's-9' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('without a suggestion the dialog resolves the typed PRO and sends only what the rep corrected', async () => {
    mocks.byNumber.mockResolvedValue([{ id: 's-7', number: 'L700' }])
    draw([row('m-2', null)])
    fireEvent.click(screen.getByTestId('cs-unmatched-assign-m-2'))
    fireEvent.change(await screen.findByTestId('cs-unmatched-load-input'), { target: { value: 'L700' } })
    fireEvent.change(screen.getByDisplayValue('1900'), { target: { value: '1850' } })
    fireEvent.click(screen.getByTestId('cs-unmatched-assign-confirm'))
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith({ messageId: 'm-2', shipmentId: 's-7', amountCents: 185_000 }))
  })

  it('refuses a PRO that does not exist and files nothing', async () => {
    mocks.byNumber.mockResolvedValue([])
    draw([row('m-3', null)])
    fireEvent.click(screen.getByTestId('cs-unmatched-assign-m-3'))
    fireEvent.change(await screen.findByTestId('cs-unmatched-load-input'), { target: { value: 'NOPE' } })
    fireEvent.click(screen.getByTestId('cs-unmatched-assign-confirm'))
    expect(await screen.findByText('No load with that ID.')).toBeTruthy()
    expect(mocks.assign).not.toHaveBeenCalled()
  })

  it('dismiss asks first and then deletes', async () => {
    draw([row('m-4', null)])
    fireEvent.click(screen.getByTestId('cs-unmatched-dismiss-m-4'))
    expect(mocks.dismiss).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('cs-unmatched-dismiss-confirm'))
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({ messageId: 'm-4' }))
  })
})
