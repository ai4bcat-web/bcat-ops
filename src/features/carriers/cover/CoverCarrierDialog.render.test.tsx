// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CarrierRecord } from '@/types/tms'
import { buildReviewCard, stubReviewCard } from '@/lib/integrations/mcpReview'
import { MemoryRouter } from 'react-router-dom'
import { CoverCarrierDialog } from './CoverCarrierDialog'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  byMc: vi.fn(),
  pull: vi.fn(),
  invite: vi.fn(),
  cover: vi.fn(),
  add: vi.fn(),
  bundle: vi.fn(),
  refresh: vi.fn(),
  carriers: [] as unknown[],
  loading: false,
  admin: false,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/apiClient', () => ({
  mcpPreviewCarrier: mocks.preview,
  mcpSendInvite: mocks.invite,
  carriersByMc: mocks.byMc,
  carriersByDot: vi.fn(async () => []),
  pullMcpCarrier: mocks.pull,
  coverCarrier: mocks.cover,
  addCarrier: mocks.add,
  getShipmentBundle: mocks.bundle,
  getTmsSettings: vi.fn(async () => null),
  listCustomers: vi.fn(async () => [{ id: 'cust-1', name: 'Acme' }]),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: mocks.carriers, loading: mocks.loading, error: null, refresh: mocks.refresh, replace: vi.fn() }),
}))
vi.mock('@/features/shipments/trackingModeControl', () => ({
  TrackingModeControl: ({ shipment, load, customer, onSaved }: { shipment: { id: string }; load: { id: string } | null; customer: { id: string } | null; onSaved: () => void }) => (
    <div data-testid="tracking-mode-control" data-shipment={shipment.id} data-load={load?.id} data-customer={customer?.id ?? ''}>
      <button data-testid="tracking-confirm" onClick={onSaved}>Confirm</button>
    </div>
  ),
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: mocks.admin, isOwner: false }) }))

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
  return render(<MemoryRouter><CoverCarrierDialog shipmentId="shp-1" shipmentNumber="S000001" onClose={onClose} onCovered={onCovered} /></MemoryRouter>)
}

async function lookUp(text: string) {
  fireEvent.change(screen.getByLabelText('Carrier name, MC or DOT'), { target: { value: text } })
  await act(async () => { fireEvent.click(screen.getByTestId('cover-lookup')) })
}

function enterRate(value = '1500') {
  const input = screen.getByRole('textbox', { name: /carrier rate/i })
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.byMc.mockResolvedValue([])
  mocks.pull.mockResolvedValue({ carrierId: 'car-1', result: 'SYNCED' })
  mocks.carriers = []
  mocks.loading = false
  mocks.admin = false
  mocks.preview.mockResolvedValue(live())
  mocks.refresh.mockResolvedValue(undefined)
  mocks.bundle.mockResolvedValue({ shipment: { id: 'shp-1', updatedAt: 'S-UPD' }, loads: [{ id: 'load-1', updatedAt: 'L-UPD' }], loadCarriers: [] })
  mocks.cover.mockResolvedValue({ shipment: { id: 'shp-1', customerId: 'cust-1' }, loads: [{ id: 'load-1' }] })
})

describe('CoverCarrierDialog', () => {
  it('an ACTIVE directory carrier is assigned straight away: the lookup card says Active with us and the MCP read gates nothing', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    renderDialog()
    await lookUp('MC 900001')

    expect((await screen.findByTestId('cover-packet-status')).textContent).toBe('Packet complete, acceptable')
    expect((await screen.findByTestId('cover-lookup-card-active')).textContent).toBe('Active with us — ready to cover')
    enterRate()
    fireEvent.click(screen.getByTestId('cover-assign'))

    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(1))
    expect(mocks.cover).toHaveBeenCalledWith({ loadId: 'load-1', expectedUpdatedAt: 'L-UPD', carrierId: 'car-1', carrierRateCents: 150_000 })
    expect(onCovered).toHaveBeenCalled()
  })

  it('missing certificates / W-9 / agreement come back as a checkbox; ticking it and assigning again sends their keys', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    mocks.cover.mockRejectedValueOnce(new Error('Acknowledge these before booking: No cargo certificate is on file for this carrier. No W-9 is on file for this carrier. [ack:NO_CARGO_CERT,NO_W9]'))
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(screen.getByTestId('cover-assign'))

    const warn = await screen.findByTestId('cover-server-warning')
    expect(warn.textContent).toMatch(/No cargo certificate is on file/)
    expect(screen.queryByTestId('cover-error')).toBeNull()
    fireEvent.click(screen.getByLabelText('Acknowledge the missing documents'))
    fireEvent.click(screen.getByTestId('cover-assign'))

    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(2))
    expect(mocks.cover.mock.calls[1][0]).toMatchObject({ carrierId: 'car-1', acknowledgeWarnings: ['NO_CARGO_CERT', 'NO_W9'] })
  })

  it('a blocked cover offers an admin "Override and cover", which needs a reason and sends it', async () => {
    mocks.admin = true
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    mocks.cover.mockRejectedValueOnce(new Error('Zephyr cannot be assigned: No cargo insurance covering the pickup date is on file. [override:INSURANCE_EXPIRED:CARGO]'))
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(screen.getByTestId('cover-assign'))

    expect((await screen.findByTestId('cover-error')).textContent).toBe('Zephyr cannot be assigned: No cargo insurance covering the pickup date is on file.')
    const submit = screen.getByTestId('cover-override-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'COI checked with the agent' } })
    fireEvent.click(submit)

    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(2))
    expect(mocks.cover.mock.calls[1][0]).toMatchObject({ carrierId: 'car-1', overrideReason: 'COI checked with the agent' })
  })

  it('a non-admin sees the refusal but no override', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    mocks.cover.mockRejectedValueOnce(new Error('Zephyr cannot be assigned: No cargo insurance covering the pickup date is on file. [override:INSURANCE_EXPIRED:CARGO]'))
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(screen.getByTestId('cover-assign'))

    await screen.findByTestId('cover-error')
    expect(screen.queryByTestId('cover-override')).toBeNull()
  })

  it('a directory carrier MyCarrierPackets never synced (no MCP status) is pulled on lookup', async () => {
    const aljex = carrierRow({ status: 'ACTIVE', mcpStatus: null })
    mocks.carriers = [aljex]
    mocks.byMc.mockResolvedValue([aljex])
    renderDialog()
    await lookUp('MC 900001')
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledWith('car-1'))
  })

  it('a carrier invited but not Active yet is pulled from MyCarrierPackets on lookup and shows Active at once', async () => {
    const pending = carrierRow({ status: 'PENDING', mcpInvitedAt: '2026-11-09T20:29:16.000Z', mcpStatus: 'ACCEPTABLE' })
    mocks.carriers = [pending]
    mocks.byMc.mockResolvedValueOnce([pending]).mockResolvedValueOnce([{ ...pending, status: 'ACTIVE' }])
    renderDialog()
    await lookUp('MC 900001')
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledWith('car-1'))
    expect((await screen.findByTestId('cover-lookup-card-active')).textContent).toBe('Active with us — ready to cover')
  })

  it('a load that already has a live carrier gets another one through addCarrier, with the legs the rep ticks, never a replacement', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    const stops = [{ id: 'st-1', type: 'pickup', city: 'Dallas' }, { id: 'st-2', type: 'delivery', city: 'Austin' }]
    const live = { id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', kind: 'CARRIER' }
    mocks.bundle.mockResolvedValue({ shipment: { id: 'shp-1', updatedAt: 'S-UPD' }, loads: [{ id: 'load-1', updatedAt: 'L-UPD', stops }], loadCarriers: [live] })
    mocks.add.mockResolvedValue({ shipment: { id: 'shp-1', customerId: 'cust-1' }, loads: [{ id: 'load-1' }], loadCarriers: [live] })
    render(<MemoryRouter><CoverCarrierDialog shipmentId="shp-1" bundle={await mocks.bundle()} onClose={onClose} onCovered={onCovered} /></MemoryRouter>)
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(await screen.findByLabelText('All stops'))
    fireEvent.click(await screen.findByTestId('cover-leg-st-2'))
    fireEvent.click(screen.getByTestId('cover-assign'))

    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1))
    expect(mocks.add).toHaveBeenCalledWith({ loadId: 'load-1', expectedUpdatedAt: 'L-UPD', carrierId: 'car-1', carrierRateCents: 150_000, legStopIds: ['st-2'] })
    expect(mocks.cover).not.toHaveBeenCalled()
  })

  it('after the cover it stays open on the Tracking section for this load and customer, and Done closes it (feedback 9)', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(await screen.findByTestId('cover-assign'))

    const control = await screen.findByTestId('tracking-mode-control')
    expect(onClose).not.toHaveBeenCalled()
    expect(control.getAttribute('data-shipment')).toBe('shp-1')
    expect(control.getAttribute('data-load')).toBe('load-1')
    await waitFor(() => expect(control.getAttribute('data-customer')).toBe('cust-1'))
    fireEvent.click(screen.getByTestId('cover-done'))
    expect(onClose).toHaveBeenCalled()
  })

  it('a failed cover never shows the tracking section, so there is nothing to confirm against a load that is not covered', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    mocks.cover.mockRejectedValue(new Error('nope'))
    renderDialog()
    await lookUp('MC 900001')
    enterRate()
    fireEvent.click(await screen.findByTestId('cover-assign'))
    await screen.findByTestId('cover-error')
    expect(screen.queryByTestId('tracking-mode-control')).toBeNull()
  })

  it('a lookup submitted while the directory is still loading runs when it finishes, not never', async () => {
    mocks.loading = true
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    const view = renderDialog()
    await lookUp('MC 900001')
    expect(screen.queryByTestId('cover-directory')).toBeNull()
    mocks.loading = false
    view.rerender(<MemoryRouter><CoverCarrierDialog shipmentId="shp-1" shipmentNumber="S000001" onClose={onClose} onCovered={onCovered} /></MemoryRouter>)
    expect(await screen.findByTestId('cover-directory')).toBeTruthy()
  })

  it('a rate and carrier handed in by the shipment form are prefilled, so Assign needs no retyping', async () => {
    mocks.carriers = [carrierRow({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' })]
    render(<MemoryRouter><CoverCarrierDialog shipmentId="shp-1" initialQuery="900001" initialRateCents={190_000} onClose={onClose} onCovered={onCovered} /></MemoryRouter>)
    expect(await screen.findByTestId('cover-directory')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: /carrier rate/i }) as HTMLInputElement).value).toMatch(/1,?900/)
    fireEvent.click(screen.getByTestId('cover-assign'))
    await waitFor(() => expect(mocks.cover).toHaveBeenCalledWith(expect.objectContaining({ carrierId: 'car-1', carrierRateCents: 190_000 })))
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
    fireEvent.click(await screen.findByLabelText('dispatch@zephyr.example')) // nothing is pre-selected
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))

    await waitFor(() => expect(mocks.invite).toHaveBeenCalledTimes(1))
    expect(mocks.invite).toHaveBeenCalledWith(expect.objectContaining({
      emails: ['dispatch@zephyr.example'], carrierId: 'car-1', shipmentId: 'shp-1', loadId: 'load-1', ensureCarrier: true,
    }))
    // The invite landed before the assignment, and the assignment is for the row the invite made.
    await waitFor(() => expect(mocks.cover).toHaveBeenCalledWith(expect.objectContaining({ carrierId: 'car-1', carrierRateCents: 150_000 })))
    expect(mocks.invite.mock.invocationCallOrder[0]).toBeLessThan(mocks.cover.mock.invocationCallOrder[0]!)
  })

  it('after the packet goes out, a missing-documents warning is acknowledged and the footer assigns that carrier without sending a second packet', async () => {
    mocks.carriers = [carrierRow()]
    mocks.invite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'sent', carrierId: 'car-1', carrierLogged: true, threadLogged: true })
    mocks.cover.mockRejectedValueOnce(new Error('Acknowledge these before booking: No W-9 is on file for this carrier. [ack:MISSING_DOC:W9,MISSING_DOC:COI_CARGO]'))
    renderDialog()
    await lookUp('MC 900001')
    await screen.findByTestId('cover-mcp-card')
    enterRate()
    fireEvent.click(screen.getByTestId('cover-send-packet'))
    fireEvent.click(await screen.findByLabelText('dispatch@zephyr.example'))
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))

    expect((await screen.findByTestId('cover-server-warning')).textContent).toMatch(/No W-9 is on file/)
    expect(screen.queryByTestId('cover-error')).toBeNull()
    expect((screen.getByTestId('cover-assign-target') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Acknowledge the missing documents'))
    fireEvent.click(screen.getByTestId('cover-assign-target'))

    await waitFor(() => expect(mocks.cover).toHaveBeenCalledTimes(2))
    expect(mocks.cover.mock.calls[1][0]).toMatchObject({ carrierId: 'car-1', acknowledgeWarnings: ['MISSING_DOC:W9', 'MISSING_DOC:COI_CARGO'] })
    expect(mocks.invite).toHaveBeenCalledTimes(1)
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

  it('a STUB lookup says "Stub, no MCP call": no recipient to send to, so nothing is invited and nothing is assigned', async () => {
    const stub = stubReviewCard({ mcNumber: 'MC274623' }, NOW)
    mocks.preview.mockResolvedValue({ mode: 'STUB', reason: 'credentials not configured', card: stub, notFound: false })
    renderDialog()
    await lookUp('MC 274623')
    await screen.findByTestId('cover-mcp-card')
    enterRate()
    expect(screen.getByTestId('cover-stub-reason').textContent).toMatch(/credentials not configured/)
    const cardSend = screen.getByTestId('cover-lookup-card-send') as HTMLButtonElement
    expect(cardSend.disabled).toBe(true)
    expect(cardSend.title).toMatch(/^Stub, no MCP call/)
    fireEvent.click(screen.getByTestId('cover-send-packet'))
    expect((await screen.findByTestId('mcp-invite-send') as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.invite).not.toHaveBeenCalled()
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
