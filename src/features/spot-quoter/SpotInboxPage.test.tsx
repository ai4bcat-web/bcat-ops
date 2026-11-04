// @vitest-environment jsdom
/**
 * The Spot inbox is where a rep turns a customer's e-mail into a quote and a Gmail draft.
 * What is worth defending: the honest state of the connection (never a simulated inbox
 * mistaken for Gmail, never a dev-only shortcut offered on a real stack), the rules that
 * stop a bad quote (below the floor, a stub market price nobody acknowledged), and that
 * "Send" only ever happens behind a confirmation showing what Gmail will send — and never
 * on the dev stack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { SpotRequestRecord, SpotStatusView } from '@/lib/spot/types'

const api = vi.hoisted(() => ({
  spotAction: vi.fn(),
  listCustomers: vi.fn(),
  getTmsSettings: vi.fn(),
  priceFromMarket: vi.fn(),
  listLaneSamples: vi.fn(),
  listLaneSamplesByZip3: vi.fn(),
  createCustomer: vi.fn(),
  saveQuote: vi.fn(),
  sendQuote: vi.fn(),
  getQuote: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

const auth = vi.hoisted(() => ({
  user: { email: 'jane.rep@bcatcorp.com', userId: 'u1', groups: [] as string[] },
  isAdmin: false,
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth, useAuthUser: () => auth.user }))
vi.mock('@/features/quotes/components/ConvertQuoteDialog', () => ({ ConvertQuoteDialog: () => null }))

import { SpotInboxPage } from './SpotInboxPage'

const SETTINGS = { id: 'default', enabled: true, allowAutoSend: false, autoSendDailyCapPerRep: 25 }
const CONNECTION = {
  id: 'u1', userEmail: 'jane.rep@bcatcorp.com', mode: 'GOOGLE', status: 'CONNECTED', googleEmail: 'jane.rep@bcatcorp.com',
  settings: { autoSend: false, watchLabel: null, lookbackDays: 2, signature: '', replyTemplateId: 'DEFAULT', notifyNew: true }, version: 3,
}

function status(over: Partial<SpotStatusView> = {}): SpotStatusView {
  return {
    devStack: false,
    gmailProvider: { mode: 'LIVE', health: null },
    datProvider: { mode: 'STUB' },
    connection: CONNECTION,
    settings: SETTINGS,
    ...over,
  } as unknown as SpotStatusView
}

const EXTRACTION = {
  customerName: null, contactName: 'Pat', contactPhone: null,
  stops: [
    { type: 'PICKUP', name: null, city: 'Chicago', state: 'IL', zip: '60601', dateStr: null, time: null },
    { type: 'DELIVERY', name: null, city: 'Dallas', state: 'TX', zip: '75201', dateStr: null, time: null },
  ],
  pickupDate: '2026-11-10', deliveryDate: null, equipment: 'dry van', equipmentType: 'VAN', lengthFt: 53, mode: 'FTL',
  weightLbs: 40000, pieces: null, commodity: 'paper', temperatureF: null, hazmat: null, accessorials: [], targetRateDollars: null, notes: null,
}

function request(over: Partial<SpotRequestRecord> = {}): SpotRequestRecord {
  return {
    id: 'sr:u1:m1', userId: 'u1', gmailMessageId: 'm1', gmailThreadId: 't1', receivedAt: '2026-11-04T10:00:00Z',
    fromEmail: 'pat@zz-acme.test', fromName: 'Pat', subject: 'Van Chicago to Dallas', bodyText: 'Need a van Chicago to Dallas',
    status: 'NEW', classification: { kind: 'QUOTE_REQUEST', confidence: 'high', reason: 'x' },
    extraction: EXTRACTION,
    fieldMeta: {
      origin: { source: 'MODEL', confidence: 'high' },
      destination: { source: 'MODEL', confidence: 'low' },
      equipment: { source: 'REP', confidence: 'high', confirmed: true },
    },
    missingFields: [], customerId: 'c1', matchHow: 'EMAIL', ttlEpoch: 0, version: 1,
    ...over,
  } as unknown as SpotRequestRecord
}

const STUB_ANSWER = {
  answer: { averageCents: 200000, lowCents: 180000, highCents: 220000, fuelCents: 0, perMileCents: 200, miles: 1000, reports: 0, days: 0, stub: true, source: 'DAT_RATEVIEW', message: 'STUB — no DAT call was made' },
  targetBps: 2000, floorBps: 1200, autoReply: false, suggestedSellCents: 250000, belowFloor: false, floorSellCents: 227000, marginAtSuggested: 0.2,
}

const RESPONSE = {
  to: 'pat@zz-acme.test', subject: 'Re: Van Chicago to Dallas', body: 'Rate $2,600 Chicago, IL to Dallas, TX & back', mailto: '', gmailUrl: '', rateCents: 260000, hasLink: false,
}

interface Setup { status?: SpotStatusView; rows?: SpotRequestRecord[]; detail?: SpotRequestRecord }
function setup(o: Setup = {}) {
  const rows = o.rows ?? [request()]
  const detail = o.detail ?? rows[0]
  api.spotAction.mockImplementation(async (action: string) => {
    switch (action) {
      case 'SPOT_STATUS': return o.status ?? status()
      case 'SPOT_LIST_REQUESTS': return { rows: rows.map(({ bodyText: _b, ...r }) => r), cursor: null }
      case 'SPOT_COUNT': return { new: rows.length, needsInfo: 0, needsAttention: 0 }
      case 'SPOT_GET_REQUEST': return { request: detail }
      case 'SPOT_SUGGEST_RESPONSE': return RESPONSE
      default: return {}
    }
  })
}
const calls = (action: string) => api.spotAction.mock.calls.filter((c) => c[0] === action)

const draw = (url = '/tms/rates/spot') =>
  render(<MemoryRouter initialEntries={[url]}><SpotInboxPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAdmin = false
  auth.user.groups = []
  api.listCustomers.mockResolvedValue([{ id: 'c1', name: 'ZZ Acme', status: 'ACTIVE' }])
  api.getTmsSettings.mockResolvedValue({ marginTargetBps: 2000, marginFloorBps: 1200 })
  api.priceFromMarket.mockResolvedValue(STUB_ANSWER)
  api.listLaneSamples.mockResolvedValue([])
  api.listLaneSamplesByZip3.mockResolvedValue([])
})

describe('Spot inbox connection states', () => {
  it('explains an unconfigured Gmail and offers no dev shortcut on a real stack', async () => {
    setup({ status: status({ gmailProvider: { mode: 'STUB', health: null }, connection: null }) })
    draw()
    expect(await screen.findByTestId('spot-not-configured')).toBeInTheDocument()
    expect(screen.queryByTestId('spot-connect-simulated')).toBeNull()
    expect(screen.queryByTestId('spot-sim-load')).toBeNull()
  })

  it('offers the simulated inbox on the dev stack and connects it', async () => {
    setup({ status: status({ devStack: true, gmailProvider: { mode: 'STUB', health: null }, connection: null }) })
    draw()
    fireEvent.click(await screen.findByTestId('spot-connect-simulated'))
    await waitFor(() => expect(calls('SPOT_CONNECT_SIMULATED')).toHaveLength(1))
  })

  it('paints a simulated inbox as simulated and lets a sample mail be loaded', async () => {
    setup({ status: status({ devStack: true, connection: { ...CONNECTION, mode: 'SIMULATED' } as never }) })
    draw()
    expect(await screen.findByTestId('spot-simulated-badge')).toHaveTextContent('SIMULATED INBOX')
    fireEvent.change(screen.getByTestId('spot-sim-fixture'), { target: { value: 'req-van-clear' } })
    fireEvent.click(screen.getByTestId('spot-sim-load'))
    await waitFor(() => expect(calls('SPOT_SIM_INJECT')[0][1]).toEqual({ fixtureId: 'req-van-clear' }))
    await waitFor(() => expect(calls('SPOT_POLL_NOW').length).toBeGreaterThan(0))
  })

  it('shows Connect Gmail when the provider is live and the rep has not connected', async () => {
    setup({ status: status({ connection: null }) })
    draw()
    expect(await screen.findByTestId('spot-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('spot-sim-load')).toBeNull()
  })

  it('says so when the quoter is switched off org-wide', async () => {
    setup({ status: status({ settings: { ...SETTINGS, enabled: false } as never }) })
    draw()
    expect(await screen.findByTestId('spot-disabled')).toBeInTheDocument()
  })

  it('offers no send, draft or auto-send controls anywhere', async () => {
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    expect(await screen.findByTestId('spot-copy')).toBeInTheDocument()
    expect(screen.getByTestId('spot-readonly-chip')).toBeInTheDocument()
    for (const id of ['spot-create-draft', 'spot-send-now', 'spot-update-draft', 'spot-autosend-chip', 'spot-autosend-toggle']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(screen.queryByText(/auto-send/i)).toBeNull()
  })
})

describe('Spot request detail', () => {
  it('lists the request with its lane and opens the detail with a chip per field', async () => {
    setup()
    draw()
    const row = await screen.findByTestId('spot-row-sr:u1:m1')
    expect(screen.getByText('Chicago, IL → Dallas, TX')).toBeInTheDocument()
    fireEvent.click(row)
    expect(await screen.findByTestId('spot-detail-body')).toBeInTheDocument()
    expect(screen.getByTestId('spot-field-chip-origin')).toHaveAttribute('data-status', 'AUTO')
    expect(screen.getByTestId('spot-field-chip-destination')).toHaveAttribute('data-status', 'LOW')
    expect(screen.getByTestId('spot-field-chip-equipment')).toHaveAttribute('data-status', 'CONFIRMED')
    expect(screen.getByTestId('spot-field-chip-deliveryDate')).toHaveAttribute('data-status', 'MISSING')
  })

  it('labels a stub market price as STUB and holds Create until the rep acknowledges it', async () => {
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    await screen.findByTestId('spot-market-stub')
    await waitFor(() => expect(screen.getByTestId('spot-rate-input')).toHaveValue('2500'))
    expect(screen.queryByTestId('spot-market-live')).toBeNull()
    expect(screen.getByTestId('spot-create-quote')).toBeDisabled()
    fireEvent.click(screen.getByTestId('spot-stub-ack'))
    expect(screen.getByTestId('spot-create-quote')).toBeEnabled()
  })

  it('marks a live market LIVE', async () => {
    api.priceFromMarket.mockResolvedValue({ ...STUB_ANSWER, answer: { ...STUB_ANSWER.answer, stub: false } })
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    expect(await screen.findByTestId('spot-market-live')).toBeInTheDocument()
    expect(screen.queryByTestId('spot-stub-ack')).toBeNull()
  })

  it('blocks a rate under the floor for a rep but lets a manager through', async () => {
    api.priceFromMarket.mockResolvedValue({ ...STUB_ANSWER, answer: { ...STUB_ANSWER.answer, stub: false } })
    setup()
    const { unmount } = draw('/tms/rates/spot?request=sr:u1:m1')
    const input = await screen.findByTestId('spot-rate-input')
    await waitFor(() => expect(input).not.toHaveValue(''))
    fireEvent.change(input, { target: { value: '1' } })
    expect(screen.getByTestId('spot-below-floor')).toBeInTheDocument()
    expect(screen.getByTestId('spot-create-quote')).toBeDisabled()
    unmount()

    auth.user.groups = ['role-MANAGER']
    draw('/tms/rates/spot?request=sr:u1:m1')
    const input2 = await screen.findByTestId('spot-rate-input')
    await waitFor(() => expect(input2).not.toHaveValue(''))
    fireEvent.change(input2, { target: { value: '1' } })
    expect(screen.getByTestId('spot-below-floor')).toBeInTheDocument()
    expect(screen.getByTestId('spot-create-quote')).toBeEnabled()
  })

  it('creates the quote with its link, linked to the request, and sends nothing', async () => {
    api.priceFromMarket.mockResolvedValue({ ...STUB_ANSWER, answer: { ...STUB_ANSWER.answer, stub: false } })
    api.saveQuote.mockResolvedValue({ quote: { id: 'Q000123' }, pricing: {} })
    api.sendQuote.mockResolvedValue({ quote: { id: 'Q000123' }, link: 'x', sent: false, subject: '', body: '' })
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    const input = await screen.findByTestId('spot-rate-input')
    await waitFor(() => expect(input).not.toHaveValue(''))
    fireEvent.change(input, { target: { value: '2600' } })
    fireEvent.click(screen.getByTestId('spot-create-quote'))
    await waitFor(() => expect(api.sendQuote).toHaveBeenCalled())
    const saved = api.saveQuote.mock.calls[0][0]
    expect(saved).toMatchObject({ side: 'SELL', spotRequestId: 'sr:u1:m1', customerId: 'c1', customerRepId: 'jane.rep@bcatcorp.com', rateType: 'SPOT' })
    expect(saved.lines[0]).toMatchObject({ code: 'LINEHAUL', rateCents: 260000 })
    expect(api.sendQuote.mock.calls[0][0]).toMatchObject({ quoteId: 'Q000123', via: 'COPY' })
    // The response is re-fetched against the new quote so it carries the accept link.
    await waitFor(() => expect(calls('SPOT_SUGGEST_RESPONSE').some((c) => (c[1] as { quoteId?: string }).quoteId === 'Q000123')).toBe(true))
    expect(calls('SPOT_MARK_SENT')).toHaveLength(0)
  })

  it('cannot quote until a customer is chosen', async () => {
    setup({ rows: [request({ customerId: null, matchHow: 'NONE' })] })
    draw('/tms/rates/spot?request=sr:u1:m1')
    await screen.findByTestId('spot-create-prospect')
    expect(screen.getByTestId('spot-create-quote')).toBeDisabled()
  })

  it('copies the edited response, logs the copy, and leaves the request unchanged', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    const body = await screen.findByTestId('spot-resp-body')
    await waitFor(() => expect(body).toHaveValue(RESPONSE.body))
    fireEvent.change(body, { target: { value: 'Edited by the rep: $2,700' } })
    fireEvent.click(screen.getByTestId('spot-copy'))
    await waitFor(() => expect(calls('SPOT_LOG_COPIED')).toHaveLength(1))
    expect(writeText).toHaveBeenCalledWith('Edited by the rep: $2,700')
    expect(calls('SPOT_LOG_COPIED')[0][1]).toMatchObject({ requestId: 'sr:u1:m1' })
    expect(calls('SPOT_MARK_SENT')).toHaveLength(0)
  })

  it('opens Gmail compose with the recipient, subject and body encoded', async () => {
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    const body = await screen.findByTestId('spot-resp-body')
    await waitFor(() => expect(body).toHaveValue(RESPONSE.body))
    const link = screen.getByTestId('spot-open-compose')
    const url = new URL(link.getAttribute('href') as string)
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/')
    expect(url.searchParams.get('to')).toBe('pat@zz-acme.test')
    expect(url.searchParams.get('su')).toBe('Re: Van Chicago to Dallas')
    expect(url.searchParams.get('body')).toBe(RESPONSE.body)
    expect(link.getAttribute('href')).toContain('%26')
    expect(link).toHaveAttribute('target', '_blank')
    const mail = screen.getByTestId('spot-open-mailto').getAttribute('href') as string
    expect(mail.startsWith('mailto:pat@zz-acme.test?')).toBe(true)
    expect(decodeURIComponent(mail)).toContain(RESPONSE.body)
  })

  it('stays pending until the rep marks it sent, then lets them mark won or lost with a reason', async () => {
    setup()
    const { unmount } = draw('/tms/rates/spot?request=sr:u1:m1')
    expect(screen.queryByTestId('spot-mark-won')).toBeNull()
    fireEvent.click(await screen.findByTestId('spot-mark-sent'))
    await waitFor(() => expect(calls('SPOT_MARK_SENT')[0][1]).toEqual({ requestId: 'sr:u1:m1' }))
    unmount()

    const sent = request({ status: 'SENT', sentAt: '2026-11-04T10:05:00Z', quoteId: 'Q1' })
    setup({ detail: sent, rows: [sent] })
    draw('/tms/rates/spot?request=sr:u1:m1')
    fireEvent.click(await screen.findByTestId('spot-mark-won'))
    await waitFor(() => expect(calls('SPOT_MARK_OUTCOME')[0][1]).toEqual({ requestId: 'sr:u1:m1', outcome: 'WON' }))
    fireEvent.click(screen.getByTestId('spot-mark-lost'))
    fireEvent.change(await screen.findByTestId('spot-lost-reason'), { target: { value: 'went with a cheaper carrier' } })
    fireEvent.click(screen.getByTestId('spot-lost-confirm'))
    await waitFor(() => expect(calls('SPOT_MARK_OUTCOME')[1][1]).toEqual({ requestId: 'sr:u1:m1', outcome: 'LOST', lostReason: 'went with a cheaper carrier' }))
  })

  it('sends only the fields the rep changed', async () => {
    setup()
    draw('/tms/rates/spot?request=sr:u1:m1')
    const weight = await screen.findByTestId('spot-f-weightLbs')
    expect(screen.getByTestId('spot-save-fields')).toBeDisabled()
    fireEvent.change(weight, { target: { value: '42000' } })
    fireEvent.click(screen.getByTestId('spot-save-fields'))
    await waitFor(() => expect(calls('SPOT_UPDATE_FIELDS')).toHaveLength(1))
    expect(calls('SPOT_UPDATE_FIELDS')[0][1]).toEqual({ requestId: 'sr:u1:m1', patch: { weightLbs: 42000 }, expectedVersion: 1 })
  })
})
