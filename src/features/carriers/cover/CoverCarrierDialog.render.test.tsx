// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CarrierRecord } from '@/types/tms'
import { buildReviewCard, stubReviewCard } from '@/lib/integrations/mcpReview'
import { CoverCarrierDialog } from './CoverCarrierDialog'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  invite: vi.fn(),
  cover: vi.fn(),
  bundle: vi.fn(),
  refresh: vi.fn(),
  carriers: [] as unknown[],
  loading: false,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/apiClient', () => ({
  mcpPreviewCarrier: mocks.preview,
  mcpSendInvite: mocks.invite,
  coverCarrier: mocks.cover,
  getShipmentBundle: mocks.bundle,
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: mocks.carriers, loading: mocks.loading, error: null, refresh: mocks.refresh, replace: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

const NOW = Date.parse('2026-11-03T12:00:00Z')
const BODY = {
  DotNumber: 7000001,
  DocketNumber: 'MC900001',
  CompanyName: 'Zephyr Test Freight LLC',
  Status: 'ACTIVE',
  Emails: [{ Description: 'Dispatch', Email: 'dispatch@zephyr.example' }],
}
const liveCard = (packet: string | null = null) => {
  const card = buildReviewCard(BODY, {}, 'preview', NOW)!
  return packet ? { ...card, packet: { ...card.packet, status: packet as never } } : card
}
const live = (card = liveCard()) => ({ mode: 'LIVE' as const, reason: null, card, notFound: false })

function carrierRow(patch: Partial<CarrierRecord> = {}): CarrierRecord {
  return { id: 'car-1', name: 'Zephyr Test Freight', type: 'TL', status: 'PENDING', mcNumber: 'MC900001', createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch }
}

const onClose = vi.fn()
const onCovered = vi.fn()

function renderDialog() {
  return render(<CoverCarrierDialog shipmentId="shp-1" shipmentNumber="S000001" onClose={onClose} onCovered={onCovered} />)
}

async function lookUp(text: string) {
  fireEvent.change(screen.getByLabelText('Carrier MC or DOT'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('cover-lookup'))
}

function enterRate(value = '1500') {
  const input = screen.getByRole('textbox', { name: /carrier rate/i })
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.carriers = []
  mocks.loading = false
  mocks.preview.mockResolvedValue(live())
  mocks.refresh.mockResolvedValue(undefined)
  mocks.bundle.mockResolvedValue({ shipment: { id: 'shp-1', updatedAt: 'S-UPD' }, loads: [{ id: 'load-1', updatedAt: 'L-UPD' }] })
  mocks.cover.mockResolvedValue({ shipment: { id: 'shp-1' } })
})

describe('CoverCarrierDialog', () => {
  it('an ACTIVE directory carrier is assigned straight away, without calling MyCarrierPackets', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    renderDialog()
    await lookUp('MC 900001')

    expect((await screen.findByTestId('cover-packet-status')).textContent).toBe('Packet complete, acceptable')
    expect(mocks.preview).not.toHaveBeenCalled()
    enterRate()
    fireEvent.click(screen.getByTestId('cover-assign'))

    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(1))
    expect(mocks.cover).toHaveBeenCalledWith({ loadId: 'load-1', expectedUpdatedAt: 'L-UPD', carrierId: 'car-1', carrierRateCents: 150_000 })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onCovered).toHaveBeenCalled()
  })

  it('a lookup submitted while the directory is still loading runs when it finishes, not never', async () => {
    mocks.loading = true
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    const view = renderDialog()
    await lookUp('MC 900001')
    expect(screen.queryByTestId('cover-directory')).toBeNull()
    mocks.loading = false
    view.rerender(<CoverCarrierDialog shipmentId="shp-1" shipmentNumber="S000001" onClose={onClose} onCovered={onCovered} />)
    expect(await screen.findByTestId('cover-directory')).toBeTruthy()
  })

  it('will not assign until a rate is entered', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    renderDialog()
    await lookUp('MC 900001')
    expect((await screen.findByTestId('cover-assign') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a non-active carrier that was never invited is looked up on MCP and assigned only after the packet is sent', async () => {
    mocks.carriers = [carrierRow()]
    mocks.invite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'sent', carrierId: 'car-1', carrierLogged: true, threadLogged: true })
    renderDialog()
    await lookUp('MC 900001')

    await screen.findByTestId('cover-mcp-card')
    expect(mocks.preview).toHaveBeenCalledWith({ mcNumber: 'MC900001' })
    enterRate()
    expect(screen.queryByTestId('cover-assign')).toBeNull()
    fireEvent.click(screen.getByTestId('cover-send-packet'))
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))

    await waitFor(() => expect(mocks.invite).toHaveBeenCalledTimes(1))
    expect(mocks.invite).toHaveBeenCalledWith(expect.objectContaining({
      email: 'dispatch@zephyr.example', carrierId: 'car-1', shipmentId: 'shp-1', loadId: 'load-1', ensureCarrier: true,
    }))
    // The invite landed before the assignment, and the assignment is for the row the invite made.
    await waitFor(() => expect(mocks.cover).toHaveBeenCalledWith(expect.objectContaining({ carrierId: 'car-1', carrierRateCents: 150_000 })))
    expect(mocks.invite.mock.invocationCallOrder[0]).toBeLessThan(mocks.cover.mock.invocationCallOrder[0]!)
  })

  it('a carrier already invited but not yet set up is assigned as waiting for setup, with no second packet', async () => {
    mocks.carriers = [carrierRow({ mcpInvitedAt: '2026-11-01T10:00:00.000Z', mcpInvitedTo: 'ops@zephyr.example', mcpStatus: 'INVITED' })]
    renderDialog()
    await lookUp('MC 900001')
    await screen.findByTestId('cover-mcp-card')
    enterRate()
    expect(screen.getByTestId('cover-assign').textContent).toMatch(/waiting for carrier setup/)
    fireEvent.click(screen.getByTestId('cover-assign'))
    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(1))
    expect(mocks.invite).not.toHaveBeenCalled()
  })

  it('a carrier MCP does not know is not in the directory: the packet is the only way in, and a STUB invite assigns nothing', async () => {
    const stub = stubReviewCard({ mcNumber: 'MC274623' }, NOW)
    mocks.preview.mockResolvedValue({ mode: 'STUB', reason: 'credentials not configured', card: stub, notFound: false })
    mocks.invite.mockResolvedValue({ mode: 'STUB', sent: false, message: 'STUB: nothing was sent.', carrierLogged: false, threadLogged: false })
    renderDialog()
    await lookUp('MC 274623')
    await screen.findByTestId('cover-mcp-card')
    enterRate()
    expect(screen.getByTestId('cover-stub-reason').textContent).toMatch(/credentials not configured/)
    fireEvent.click(screen.getByTestId('cover-send-packet'))
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))

    expect((await screen.findByTestId('cover-error')).textContent).toMatch(/not assigned/)
    expect(mocks.cover).not.toHaveBeenCalled()
  })

  it('an UNACCEPTABLE packet blocks assignment outright', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'UNACCEPTABLE' })]
    renderDialog()
    await lookUp('MC 900001')
    expect((await screen.findByTestId('cover-blocked')).textContent).toMatch(/unacceptable/)
    enterRate()
    expect((screen.getByTestId('cover-assign') as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.cover).not.toHaveBeenCalled()
  })

  it('a MODERATE packet assigns only with the warning acknowledged, and sends the acknowledgement', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'MODERATE' })]
    renderDialog()
    await lookUp('MC 900001')
    await screen.findByTestId('cover-warning')
    enterRate()
    expect((screen.getByTestId('cover-assign') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('Acknowledge moderate risk'))
    fireEvent.click(screen.getByTestId('cover-assign'))
    await waitFor(() => expect(mocks.cover).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeWarnings: ['MCP_MODERATE'] })))
  })

  it('shows the server’s refusal inline and stays open', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    mocks.cover.mockRejectedValue(new Error('This load already has a carrier.'))
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(await screen.findByTestId('cover-assign'))
    expect((await screen.findByTestId('cover-error')).textContent).toBe('This load already has a carrier.')
    expect(onClose).not.toHaveBeenCalled()
  })
})
