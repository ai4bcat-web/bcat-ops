// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { buildReviewCard } from '@/lib/integrations/mcpReview'
import { CarrierLookup } from './CarrierLookup'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  invite: vi.fn(),
  add: vi.fn(),
  carriers: [] as unknown[],
}))

vi.mock('@/lib/apiClient', () => ({ mcpPreviewCarrier: mocks.preview, mcpSendInvite: mocks.invite, mcpAddCarrier: mocks.add }))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: mocks.carriers, loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/features/carriers/cover/CoverCarrierDialog', () => ({
  CoverCarrierDialog: ({ shipmentId, initialQuery }: { shipmentId: string; initialQuery?: string }) => <div data-testid="cover-dialog" data-shipment={shipmentId} data-query={initialQuery} />,
}))

const NOW_MS = Date.parse('2026-11-05T12:00:00Z')
const NOW = '2026-11-05T12:00:00.000Z'
const cardFor = (mc: string, name: string, emails: string[]) => buildReviewCard({
  DotNumber: 7000001, DocketNumber: mc, CompanyName: name, Status: 'ACTIVE',
  Emails: emails.map((Email) => ({ Email })),
  CertData: { Certificates: [{ Coverages: [{ Type: 'Auto', ExpirationDate: '2099-01-01T00:00:00', CoverageLimit: '$1,000,000' }, { Type: 'Cargo', ExpirationDate: '2099-01-01T00:00:00', CoverageLimit: '$100,000' }] }] },
}, {}, 'preview', NOW_MS)!

const NEEDS = [{ id: 's-1', number: 'L100' }] as never

async function lookUp(text: string) {
  fireEvent.change(screen.getByTestId('cs-lookup-input'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('cs-lookup-go'))
  return screen.findByTestId('cs-lookup-card')
}

const renderLookup = () => render(<MemoryRouter><CarrierLookup needsCover={NEEDS} nowIso={NOW} /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.carriers = []
})

describe('Carrier Sales MC lookup', () => {
  it('a carrier in the directory leads with Set up · Active, then covers the chosen load', async () => {
    mocks.carriers = [{ id: 'car-1', name: 'Ivan Cartage', status: 'ACTIVE', mcNumber: 'MC900002', mcpStatus: 'ACCEPTABLE', lastLoadAt: '2026-10-30T12:00:00Z', loadCount: 14 }]
    mocks.preview.mockResolvedValue({ mode: 'LIVE', reason: null, notFound: false, card: cardFor('MC900002', 'Ivan Cartage LLC', ['ops@ivan.example']) })
    renderLookup()
    const card = await lookUp('MC 900002')

    expect(mocks.preview).toHaveBeenCalledWith({ mcNumber: 'MC900002' })
    expect(within(card).getByTestId('cs-lookup-card-standing').textContent).toBe('Set up · ActiveReady to cover')
    expect(within(card).getByTestId('cs-lookup-card-directory-line').textContent).toMatch(/14 loads/)
    fireEvent.click(within(card).getByTestId('cs-lookup-card-cover'))
    const dialog = await screen.findByTestId('cover-dialog')
    expect(dialog.dataset).toMatchObject({ shipment: 's-1', query: 'MC 900002' })
  })

  it('a carrier not in the directory says Not set up yet, lists MCP’s e-mails, and the invitation goes to the one address picked', async () => {
    mocks.preview.mockResolvedValue({ mode: 'LIVE', reason: null, notFound: false, card: cardFor('MC900001', 'Small Hauler LLC', ['a@small.example', 'b@small.example']) })
    mocks.invite.mockResolvedValue({ mode: 'LIVE', sent: true, message: 'sent', carrierLogged: false, threadLogged: false })
    renderLookup()
    const card = await lookUp('900001')

    expect(within(card).getByTestId('cs-lookup-card-standing').textContent).toMatch(/^Not set up yet/)
    expect(within(card).getByTestId('cs-lookup-card-emails').textContent).toMatch(/a@small.example, b@small.example/)
    const send = within(card).getByTestId('cs-lookup-card-send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    expect((within(card).getByTestId('cs-lookup-card-cover') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(send)
    fireEvent.click(await screen.findByLabelText('b@small.example')) // nothing is pre-selected
    fireEvent.click(await screen.findByTestId('mcp-invite-send'))
    await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith(expect.objectContaining({ mcNumber: 'MC900001', emails: ['b@small.example'], ensureCarrier: true })))
  })

  it('Add to directory creates the Pending row without inviting', async () => {
    mocks.preview.mockResolvedValue({ mode: 'LIVE', reason: null, notFound: false, card: cardFor('MC900001', 'Small Hauler LLC', ['a@small.example']) })
    mocks.add.mockResolvedValue({ carrierId: 'car-9', created: true, matchedBy: null })
    renderLookup()
    const card = await lookUp('MC 900001')
    fireEvent.click(within(card).getByTestId('cs-lookup-card-add'))
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ mcNumber: 'MC900001' }))
    expect(mocks.invite).not.toHaveBeenCalled()
  })

  it('a name is not looked up: MyCarrierPackets has no name search', async () => {
    renderLookup()
    fireEvent.change(screen.getByTestId('cs-lookup-input'), { target: { value: 'Ivan Cartage' } })
    fireEvent.click(screen.getByTestId('cs-lookup-go'))
    expect(await screen.findByText(/Enter an MC or DOT number/)).toBeTruthy()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
