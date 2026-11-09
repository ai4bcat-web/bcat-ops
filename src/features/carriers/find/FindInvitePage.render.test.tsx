// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CarrierRecord } from '@/types/tms'
import { buildReviewCard, stubReviewCard } from '@/lib/integrations/mcpReview'
import { FindInvitePage } from './FindInvitePage'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  get: vi.fn(),
  invite: vi.fn(),
  refresh: vi.fn(),
  carriers: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/apiClient', () => ({
  mcpPreviewCarrier: mocks.preview,
  mcpGetCarrier: mocks.get,
  mcpSendInvite: mocks.invite,
  mcpAddCarrier: vi.fn(),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: mocks.carriers, loading: false, error: null, refresh: mocks.refresh, replace: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

const NOW = Date.parse('2026-11-03T12:00:00Z')
const BODY = {
  DotNumber: 7000001,
  DocketNumber: 'MC900001',
  CompanyName: 'Zephyr Test Freight LLC',
  Status: 'ACTIVE',
  RiskAssessmentDetails: { TotalPoints: 450, OverallRating: 'Moderate', Insurance: { TotalPoints: 300, OverallRating: 'Moderate', Infractions: [{ Description: 'Cargo limit below $100,000', Points: 300 }] } },
  CertData: { Certificates: [{ Coverages: [{ InsurerName: 'Fake Mutual', Type: 'Cargo', PolicyNumber: 'P-1', ExpirationDate: '2099-01-01T00:00:00', CoverageLimit: '$100,000' }] }] },
  Emails: [{ Description: 'Dispatch', Email: 'dispatch@zephyr.example' }, { Email: 'owner@zephyr.example' }],
}
const liveCard = () => buildReviewCard(BODY, {}, 'preview', NOW)!
const live = (card = liveCard()) => ({ mode: 'LIVE' as const, reason: null, card, notFound: false })

function carrierRow(patch: Partial<CarrierRecord> = {}): CarrierRecord {
  return { id: 'car-1', name: 'Zephyr Test Freight', type: 'TL', status: 'ACTIVE', mcNumber: 'MC-900001', createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch }
}

function renderPage(url = '/tms/carriers/find') {
  return render(<MemoryRouter initialEntries={[url]}><FindInvitePage /></MemoryRouter>)
}

async function search(text: string) {
  fireEvent.change(screen.getByLabelText('Find a carrier'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('mcp-search'))
  await screen.findByTestId('mcp-review-card')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.carriers = []
  mocks.preview.mockResolvedValue(live())
  mocks.get.mockResolvedValue({ mode: 'LIVE', reason: null, card: buildReviewCard({ ...BODY, CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'Invited' }] }, {}, 'data', NOW), notFound: false })
  mocks.refresh.mockResolvedValue(undefined)
})

describe('FindInvitePage', () => {
  it('looks a carrier up by MC through both MCP calls and renders the review card: chips, risk gauge, insurance, approved e-mails', async () => {
    renderPage()
    await search('MC 900001')

    // Only the MC that was typed is sent: a bare guess at the DOT would hit another carrier.
    expect(mocks.preview).toHaveBeenCalledWith({ mcNumber: 'MC900001' })
    expect(mocks.get).toHaveBeenCalledWith({ mcNumber: 'MC900001' })
    expect(screen.getByTestId('mcp-card-name').textContent).toBe('Zephyr Test Freight LLC')
    expect(within(screen.getByTestId('mcp-card-chips')).getByText(/Operating: ACTIVE/)).toBeTruthy()
    expect(within(screen.getByTestId('mcp-card-risk')).getByRole('img').getAttribute('aria-label')).toMatch(/450 points, Moderate/)
    expect(within(screen.getByTestId('mcp-risk-insurance')).getByText(/Cargo limit below \$100,000/)).toBeTruthy()
    expect(within(screen.getByTestId('mcp-card-insurance')).getByText('Fake Mutual')).toBeTruthy()
    expect(within(screen.getByTestId('mcp-card-approved')).getByText(/dispatch@zephyr.example/)).toBeTruthy()
    await waitFor(() => expect(within(screen.getByTestId('mcp-card-chips')).getByText('Invited')).toBeTruthy()) // GetCarrierData folded in
    expect(screen.queryByText(/STUB: sample data/)).toBeNull()
  })

  it('STUB mode is labelled and says why', async () => {
    const stub = stubReviewCard({ mcNumber: 'MC274623' }, NOW)
    mocks.preview.mockResolvedValue({ mode: 'STUB', reason: 'MyCarrierPackets credentials are not configured.', card: stub, notFound: false })
    mocks.get.mockResolvedValue({ mode: 'STUB', reason: 'x', card: stub, notFound: false })
    renderPage()
    await search('MC 274623')

    expect(screen.getByText(/STUB: sample data, not this carrier/)).toBeTruthy()
    expect(screen.getByTestId('mcp-stub-reason').textContent).toMatch(/credentials are not configured/)
    expect(screen.getByTestId('mcp-review-card').getAttribute('data-source')).toBe('STUB')
  })

  it('a carrier already in the directory leads with Set up with us, its status, its packet standing and a profile link', async () => {
    mocks.carriers = [carrierRow({ mcpStatus: 'ACCEPTABLE', mcpInvitedAt: '2026-10-20T10:00:00.000Z', mcpInvitedTo: 'ops@zephyr.example' })]
    renderPage()
    await search('MC 900001')

    const card = screen.getByTestId('find-lookup-card')
    expect(card.dataset.inDirectory).toBe('true')
    expect(within(card).getByTestId('find-lookup-card-standing').textContent).toMatch(/^Set up with us · ACTIVEPacket complete/)
    expect(within(card).getByTestId('find-lookup-card-active').textContent).toBe('Active with us — ready to cover')
    expect(within(card).getByTestId('find-lookup-card-open').getAttribute('href')).toBe('/tms/carriers/car-1')
    expect(within(card).queryByTestId('find-lookup-card-add')).toBeNull()
  })

  it('a carrier not in the directory says so, lists every MCP e-mail, and can be sent a packet or added without one', async () => {
    renderPage()
    await search('MC 900001')
    const card = screen.getByTestId('find-lookup-card')
    expect(card.dataset.inDirectory).toBe('false')
    expect(within(card).getByTestId('find-lookup-card-standing').textContent).toMatch(/^Not in directory/)
    expect(within(card).getByTestId('find-lookup-card-emails').textContent).toMatch(/dispatch@zephyr.example, owner@zephyr.example/)
    expect((within(card).getByTestId('find-lookup-card-send') as HTMLButtonElement).disabled).toBe(false)
    expect((within(card).getByTestId('find-lookup-card-add') as HTMLButtonElement).disabled).toBe(false)
  })

  it('nothing is pre-selected; the invitation goes to the one address picked; from a load the carrier id, shipment and load go with it', async () => {
    mocks.carriers = [carrierRow()]
    mocks.invite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'Packet invitation sent to dispatch@zephyr.example, owner@zephyr.example.', carrierLogged: true, threadLogged: true })
    renderPage('/tms/carriers/find?shipmentId=ship-1&loadId=load-1')
    await search('MC 900001')
    fireEvent.click(screen.getByTestId('find-lookup-card-send'))

    const list = await screen.findByTestId('mcp-invite-recipients')
    expect(within(list).getAllByRole('radio').map((c) => (c as HTMLInputElement).checked)).toEqual([false, false])
    expect((screen.getByTestId('mcp-invite-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(list).getByLabelText('dispatch@zephyr.example'))
    fireEvent.click(within(list).getByLabelText('owner@zephyr.example'))
    expect(within(list).getAllByRole('radio').map((c) => (c as HTMLInputElement).checked)).toEqual([false, true])
    fireEvent.click(within(list).getByLabelText('dispatch@zephyr.example'))
    fireEvent.click(screen.getByTestId('mcp-invite-send'))

    await waitFor(() => expect(mocks.invite).toHaveBeenCalledTimes(1))
    expect(mocks.invite).toHaveBeenCalledWith({
      mcNumber: 'MC900001', emails: ['dispatch@zephyr.example'], carrierId: 'car-1', carrierName: 'Zephyr Test Freight LLC', shipmentId: 'ship-1', loadId: 'load-1', ensureCarrier: true,
    })
    expect((await screen.findByTestId('mcp-invite-result')).textContent).toMatch(/Noted on the shipment thread.*Logged on the carrier/)
  })

  it('a typed address is validated first, then added and selected on its own', async () => {
    renderPage()
    await search('MC 900001')
    fireEvent.click(screen.getByTestId('find-lookup-card-send'))
    await screen.findByLabelText('owner@zephyr.example')

    fireEvent.change(screen.getByLabelText('Add another address'), { target: { value: 'not-an-email' } })
    fireEvent.click(screen.getByTestId('mcp-invite-add'))
    expect(await screen.findByText('That is not a valid e-mail address.')).toBeTruthy()

    mocks.invite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'sent', carrierLogged: false, threadLogged: false })
    fireEvent.change(screen.getByLabelText('Add another address'), { target: { value: 'New@Carrier.com' } })
    fireEvent.click(screen.getByTestId('mcp-invite-add'))
    fireEvent.click(screen.getByTestId('mcp-invite-send'))
    await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith(expect.objectContaining({ emails: ['new@carrier.com'], mcNumber: 'MC900001' })))
  })

  it('send stays disabled until one address is picked: nothing is pre-selected', async () => {
    renderPage()
    await search('MC 900001')
    fireEvent.click(screen.getByTestId('find-lookup-card-send'))
    await screen.findByLabelText('dispatch@zephyr.example')
    expect((screen.getByTestId('mcp-invite-send') as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.invite).not.toHaveBeenCalled()
  })

  it('a stub lookup says "Stub, no MCP call", lists no e-mails, and the send is disabled with the reason', async () => {
    const stub = stubReviewCard({ mcNumber: 'MC274623' }, NOW)
    mocks.preview.mockResolvedValue({ mode: 'STUB', reason: 'r', card: stub, notFound: false })
    mocks.get.mockResolvedValue({ mode: 'STUB', reason: 'r', card: stub, notFound: false })
    renderPage()
    await search('MC 274623')
    const card = screen.getByTestId('find-lookup-card')
    expect(within(card).getByTestId('find-lookup-card-standing').textContent).toMatch(/Stub, no MCP call/)
    expect(within(card).queryByTestId('find-lookup-card-emails')).toBeNull()
    const send = within(card).getByTestId('find-lookup-card-send') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.title).toMatch(/^Stub, no MCP call/)
    expect(mocks.invite).not.toHaveBeenCalled()
  })

  it('a name searches our directory only; MyCarrierPackets is not called', async () => {
    mocks.carriers = [carrierRow({ id: 'car-9', name: 'Ivan Cartage', mcNumber: '274623' })]
    renderPage()
    fireEvent.change(screen.getByLabelText('Find a carrier'), { target: { value: 'ivan' } })
    fireEvent.click(screen.getByTestId('mcp-search'))

    const results = await screen.findByTestId('mcp-name-results')
    expect(within(results).getByRole('link', { name: 'Ivan Cartage' }).getAttribute('href')).toBe('/tms/carriers/car-9')
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('opens straight on the carrier a launch point names, and says when MCP has no record', async () => {
    mocks.preview.mockResolvedValue({ mode: 'LIVE', reason: null, card: null, notFound: true })
    mocks.get.mockResolvedValue({ mode: 'LIVE', reason: null, card: null, notFound: true })
    renderPage('/tms/carriers/find?mc=MC555')
    expect(await screen.findByText('No MyCarrierPackets record')).toBeTruthy()
    expect(mocks.preview).toHaveBeenCalledWith({ mcNumber: 'MC555' })
    expect(screen.queryByTestId('mcp-review-card')).toBeNull()
  })
})
