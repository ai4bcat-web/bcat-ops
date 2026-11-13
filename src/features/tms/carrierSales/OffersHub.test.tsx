// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import { OffersHub } from './OffersHub'

const mocks = vi.hoisted(() => ({
  listCarrierOffers: vi.fn(),
  listOfferThread: vi.fn(),
  listActivePostings: vi.fn(),
  listShipmentsByNumber: vi.fn(),
  mcpPreviewCarrier: vi.fn(),
  rejectOffer: vi.fn(),
  mcpSendInvite: vi.fn(),
  mcpAddCarrier: vi.fn(),
  carriers: [] as unknown[],
}))

vi.mock('@/lib/apiClient', () => ({ ...mocks, csAction: vi.fn() }))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: mocks.carriers, loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: false, isOwner: false }) }))
vi.mock('@/features/quotes/components/AcceptOfferDialog', () => ({
  AcceptOfferDialog: ({ quote }: { quote: { id: string } }) => <div data-testid="accept-dialog">{quote.id}</div>,
}))
vi.mock('@/features/quotes/components/CounterDialog', () => ({
  CounterDialog: ({ quote }: { quote: { id: string } }) => <div data-testid="counter-dialog">{quote.id}</div>,
}))

const LIVE_CARD = {
  source: 'LIVE', identity: { legalName: 'Hauler LLC', mcNumber: 'MC999999' }, operating: {}, risk: { totalPoints: 100, tone: 'green', categories: [] },
  insurance: [], packet: { status: 'NOT_INVITED', label: 'Not invited', completed: false, rawStatuses: [] },
  emails: [{ address: 'dispatch@hauler.example', source: 'MCP_APPROVED', label: 'Dispatch' }, { address: 'owner@hauler.example', source: 'MCP_PROFILE', label: 'Carrier profile / FMCSA' }],
}

const SHIPMENT = { id: 's-1', number: 'L100', originCity: 'Chicago', destinationCity: 'Dallas', pickupAppt: '2026-11-06T14:00:00Z', equipmentType: 'Van', postedBoards: ['DAT'] }

function offer(id: string, over: Record<string, unknown> = {}) {
  return {
    id, side: 'BUY', status: 'RECEIVED_REPLY', shipmentId: 's-1', amountCents: 185_000, carrierName: 'Hauler', carrierMc: '123456',
    carrierEmail: 'dispatch@hauler.example.invalid', offerSource: 'EMAIL', offerMessageRef: 'msg:cs:1', createdAt: '2026-11-04T15:00:00Z', version: 1,
    vetting: { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'COMPLETED' },
    carrierRisk: { mcpRiskScore: 120, mcpStatus: 'COMPLETED', packetComplete: true },
    ...over,
  }
}

function inbound(id: string, channel: 'EMAIL' | 'VOICE', state: string, over: Record<string, unknown> = {}) {
  return {
    id, shipmentId: 's-1', kind: 'CARRIER_OFFER', channel, at: '2026-11-04T15:00:00Z', from: 'x@example.invalid', subject: 'Re L100', body: 'body text',
    offer: {
      source: channel === 'VOICE' ? 'CALL' : 'EMAIL', boardProvider: null,
      extraction: { kind: 'OFFER', rateCents: 185_000, carrier: { mc: '123456', name: 'Hauler' }, equipment: 'Dry van', availableAt: 'Thu', flags: [] },
      match: { state, how: 'LOAD_REF_SUBJECT', score: 0.9, top: null, candidates: [] }, quoteId: null, quoteNumber: null,
      call: channel === 'VOICE' ? { callSid: 'CA1', recordingUrl: 'https://rec.example.invalid/1' } : null,
    },
    ...over,
  }
}

function Harness({ initial = null, openOffers = null }: { initial?: string | null; openOffers?: never[] | null }) {
  const [load, setLoad] = useState<string | null>(initial)
  return (
    <MemoryRouter>
      <OffersHub shipments={[SHIPMENT] as never} loadParam={load} onLoadChange={setLoad} openOffers={openOffers} openOffersError={null} onChanged={vi.fn()} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listActivePostings.mockResolvedValue([{ id: 'post:s-1:DAT', shipmentId: 's-1', status: 'POSTED', rateCents: 200_000, originCity: 'Chicago', destinationCity: 'Dallas', offerCount: 2 }])
  mocks.listCarrierOffers.mockResolvedValue({ offers: [offer('Q1')] })
  mocks.listOfferThread.mockResolvedValue([])
  mocks.listShipmentsByNumber.mockResolvedValue([])
})

describe('OffersHub', () => {
  it('typing a PRO selects the load and lists its offers with source, packet and risk', async () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('cs-offers-load-input'), { target: { value: 'L100' } })
    fireEvent.submit(screen.getByTestId('cs-offers-load-input').closest('form')!)
    expect(await screen.findByTestId('cs-offers-table')).toBeTruthy()
    expect(mocks.listCarrierOffers).toHaveBeenCalledWith('s-1')
    expect(within(await screen.findByTestId('cs-offer-carrier-Q1')).getByText('MC 123456')).toBeTruthy()
    expect(screen.getByTestId('cs-offer-rate-Q1').textContent).toContain('$1,850.00')
    expect(screen.getByTestId('cs-offer-rate-Q1').textContent).toContain('-7% vs posted')
    expect(screen.getByTestId('cs-offer-source-Q1').textContent).toContain('E-mail')
    expect(screen.getByTestId('cs-offer-packet-Q1').textContent).toContain('Packet complete')
    expect(screen.getByTestId('cs-offer-risk-Q1').textContent).toContain('120 pts')
  })

  it('says so when no load has that ID', async () => {
    render(<Harness initial="NOPE-1" />)
    expect(await screen.findByTestId('cs-offers-no-load')).toBeTruthy()
    expect(mocks.listCarrierOffers).not.toHaveBeenCalled()
  })

  it('an offer from a carrier outside the directory cannot be accepted (the gate’s own words); Send setup packet needs no e-mail on the offer: the card lists MCP’s addresses and sends to the one picked of them', async () => {
    mocks.listCarrierOffers.mockResolvedValue({
      offers: [offer('Q2', { carrierMc: '999999', carrierEmail: null, vetting: { known: false, bookable: false, blockers: ['Carrier is not in the directory.'], warnings: [], status: null, mcpStatus: null }, carrierRisk: undefined })],
    })
    mocks.mcpPreviewCarrier.mockResolvedValue({ mode: 'LIVE', reason: null, notFound: false, card: LIVE_CARD })
    mocks.mcpSendInvite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'Packet invitation sent', emails: ['dispatch@hauler.example', 'owner@hauler.example'], carrierLogged: false, threadLogged: true })
    render(<Harness initial="L100" />)
    const accept = (await screen.findByTestId('cs-offer-accept-Q2')) as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    expect(accept.title).toBe('Carrier is not in the directory.')
    const setup = screen.getByTestId('cs-offer-setup-packet-Q2') as HTMLButtonElement
    expect(setup.disabled).toBe(false)
    fireEvent.click(setup)

    const card = await screen.findByTestId('cs-lookup-card')
    expect(card.dataset.inDirectory).toBe('false')
    expect(within(card).getByTestId('cs-lookup-card-standing').textContent).toMatch(/^Not set up yet/)
    expect(within(card).getByTestId('cs-lookup-card-emails').textContent).toMatch(/dispatch@hauler.example, owner@hauler.example/)
    fireEvent.click(within(card).getByTestId('cs-lookup-card-send'))
    fireEvent.click(await screen.findByLabelText('dispatch@hauler.example')) // nothing is pre-selected
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))
    await waitFor(() => expect(mocks.mcpSendInvite).toHaveBeenCalledWith({
      mcNumber: '999999', emails: ['dispatch@hauler.example'], carrierId: undefined, carrierName: 'Hauler LLC', shipmentId: 's-1', loadId: undefined, ensureCarrier: true,
    }))
  })

  it('a directory carrier shows Set up with us, its status and packet standing first', async () => {
    mocks.carriers = [{ id: 'car-1', name: 'Hauler LLC', status: 'ACTIVE', mcNumber: 'MC999999', mcpStatus: 'ACCEPTABLE' }]
    mocks.listCarrierOffers.mockResolvedValue({
      offers: [offer('Q4', { carrierMc: '999999', vetting: { known: false, bookable: false, blockers: ['x'], warnings: [], status: null, mcpStatus: null }, carrierRisk: undefined })],
    })
    mocks.mcpPreviewCarrier.mockResolvedValue({ mode: 'LIVE', reason: null, notFound: false, card: LIVE_CARD })
    render(<Harness initial="L100" />)
    fireEvent.click(await screen.findByTestId('cs-offer-setup-packet-Q4'))
    const card = await screen.findByTestId('cs-lookup-card')
    expect(within(card).getByTestId('cs-lookup-card-standing').textContent).toBe('Set up · ActiveReady to cover')
    expect(within(card).getByTestId('cs-lookup-card-open').getAttribute('href')).toBe('/tms/carriers/car-1')
    mocks.carriers = []
  })

  it('Check MCP looks the MC up once and labels a stub answer', async () => {
    mocks.listCarrierOffers.mockResolvedValue({
      offers: [offer('Q3', { carrierMc: '999999', vetting: { known: false, bookable: false, blockers: ['x'], warnings: [], status: null, mcpStatus: null }, carrierRisk: undefined })],
    })
    mocks.mcpPreviewCarrier.mockResolvedValue({ mode: 'STUB', reason: 'no credentials', notFound: false, card: { source: 'STUB', risk: { totalPoints: 450, tone: 'amber' } } })
    render(<Harness initial="L100" />)
    const button = await screen.findByTestId('cs-offer-check-mcp-Q3')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('cs-offer-risk-Q3').textContent).toContain('450 pts'))
    expect(screen.getByTestId('cs-offer-risk-Q3').textContent).toContain('STUB')
    expect(mocks.mcpPreviewCarrier).toHaveBeenCalledTimes(1)
    expect(mocks.mcpPreviewCarrier).toHaveBeenCalledWith({ mcNumber: '999999' })
    expect(screen.queryByTestId('cs-offer-check-mcp-Q3')).toBeNull()
  })

  it('Accept and Counter open the existing dialogs; Reject calls the existing action', async () => {
    mocks.rejectOffer.mockResolvedValue({})
    render(<Harness initial="L100" />)
    fireEvent.click(await screen.findByTestId('cs-offer-accept-Q1'))
    expect(screen.getByTestId('accept-dialog').textContent).toBe('Q1')
    fireEvent.click(screen.getByTestId('cs-offer-counter-Q1'))
    expect(screen.getByTestId('counter-dialog').textContent).toBe('Q1')
    fireEvent.click(screen.getByTestId('cs-offer-reject-Q1'))
    await waitFor(() => expect(mocks.rejectOffer).toHaveBeenCalledWith({ quoteId: 'Q1', expectedVersion: 1 }))
  })

  it('the thread shows an e-mail and a phone item, the covered-late chip, and only https recordings', async () => {
    mocks.listOfferThread.mockResolvedValue([
      inbound('m-1', 'EMAIL', 'MATCHED'),
      inbound('m-2', 'VOICE', 'COVERED_LATE'),
    ])
    render(<Harness initial="L100" />)
    const mail = await screen.findByTestId('cs-thread-item-m-1')
    const call = screen.getByTestId('cs-thread-item-m-2')
    expect(within(mail).getByLabelText('E-mail')).toBeTruthy()
    expect(within(call).getByLabelText('Phone call')).toBeTruthy()
    expect(mail.textContent).toContain('Offered $1,850.00 · MC 123456')
    expect(call.textContent).toContain('Arrived after cover')
    expect(within(call).getByText('Recording').getAttribute('href')).toBe('https://rec.example.invalid/1')
    expect(mail.textContent).not.toContain('Arrived after cover')
  })

  it('a later withdrawal paints “Carrier withdrew?” on that carrier’s open offer', async () => {
    mocks.listOfferThread.mockResolvedValue([
      inbound('m-1', 'EMAIL', 'MATCHED'),
      { ...inbound('m-2', 'EMAIL', 'MATCHED', { at: '2026-11-04T16:00:00Z' }), offer: { ...inbound('x', 'EMAIL', 'MATCHED').offer, extraction: { ...inbound('x', 'EMAIL', 'MATCHED').offer.extraction, kind: 'WITHDRAW' } } },
    ])
    render(<Harness initial="L100" />)
    expect(await screen.findByText('Carrier withdrew?')).toBeTruthy()
  })
})
