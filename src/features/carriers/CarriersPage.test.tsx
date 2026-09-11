// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const listCarrierContacts = vi.fn().mockResolvedValue([])
const listCarrierCampaigns = vi.fn().mockResolvedValue([])
const listCarrierReplies = vi.fn().mockResolvedValue([])
const createCarrierContact = vi.fn().mockResolvedValue({ id: 'c-new' })
const batchCreateCarrierContacts = vi.fn().mockResolvedValue([{ id: 'c-new' }])
const createCarrierCampaign = vi.fn().mockResolvedValue({
  id: 'camp-1',
  lane: 'IL_IA' as const,
  name: 'Test',
  subject: 'Subj',
  bodyHtml: '<p>body</p>',
  senderAccounts: ['a@instantly.ai'],
  dailyLimit: 200,
  leadCount: 600,
  status: 'draft' as const,
  pushedCount: 0,
  errorText: null,
  sentCount: 0,
  openCount: 0,
  replyCount: 0,
  bounceCount: 0,
  unsubscribeCount: 0,
  analyticsAt: null,
  createdBy: 'ryne@bcatcorp.com',
  startedAt: null,
  completedAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
})
const updateCarrierReply = vi.fn().mockResolvedValue({})
const carrierBlast = vi.fn().mockResolvedValue({ ok: true, accounts: [] })

vi.mock('@/lib/apiClient', () => ({
  listCarrierContacts: (...args: unknown[]) => listCarrierContacts(...args),
  listCarrierCampaigns: (...args: unknown[]) => listCarrierCampaigns(...args),
  listCarrierReplies: (...args: unknown[]) => listCarrierReplies(...args),
  createCarrierContact: (...args: unknown[]) => createCarrierContact(...args),
  batchCreateCarrierContacts: (...args: unknown[]) => batchCreateCarrierContacts(...args),
  createCarrierCampaign: (...args: unknown[]) => createCarrierCampaign(...args),
  updateCarrierReply: (...args: unknown[]) => updateCarrierReply(...args),
  updateCarrierContact: vi.fn().mockResolvedValue({}),
  updateCarrierCampaign: vi.fn().mockResolvedValue({}),
  deleteCarrierContact: vi.fn().mockResolvedValue({}),
  deleteCarrierCampaign: vi.fn().mockResolvedValue({}),
  deleteCarrierReply: vi.fn().mockResolvedValue({}),
  carrierBlast: (...args: unknown[]) => carrierBlast(...args),
  downloadCarrierContactsCsv: vi.fn(),
  isValidEmail: (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' } }),
}))

import { CarriersPage } from './CarriersPage'
import { ListsTab } from './ListsTab'
import { CampaignsTab } from './CampaignsTab'
import { RepliesTab } from './RepliesTab'

function renderPage() {
  return render(<MemoryRouter><CarriersPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  listCarrierContacts.mockResolvedValue([])
  listCarrierCampaigns.mockResolvedValue([])
  listCarrierReplies.mockResolvedValue([])
})

describe('CarriersPage', () => {
  it('renders the lists tab by default', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Carriers' })).toBeTruthy()
    expect(screen.getByTestId('carriers-tab-lists')).toBeTruthy()
  })
})

describe('ListsTab', () => {
  it('shows import preview counts and imports contacts', async () => {
    listCarrierContacts.mockResolvedValue([])
    render(<ListsTab />)

    const pasteBtns = screen.getAllByRole('button', { name: /Paste emails/i })
    fireEvent.click(pasteBtns[0])

    const textarea = screen.getAllByPlaceholderText(/one@carrier\.com/i)[0]
    act(() => {
      fireEvent.change(textarea, { target: { value: 'alice@carrier.com, bob@carrier.com; invalid' } })
    })

    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview/i })[0])
    })

    await waitFor(() => {
      expect(screen.getByText((_, el) => el?.textContent === '2 new')).toBeTruthy()
      expect(screen.getByText((_, el) => el?.textContent === '0 duplicate')).toBeTruthy()
      expect(screen.getByText((_, el) => el?.textContent === '1 invalid')).toBeTruthy()
    })

    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /Import 2 contacts/i })[0])
    })

    await waitFor(() => {
      expect(batchCreateCarrierContacts).toHaveBeenCalledTimes(1)
      expect(batchCreateCarrierContacts).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ email: 'alice@carrier.com', status: 'active' }),
          expect.objectContaining({ email: 'bob@carrier.com', status: 'active' }),
        ])
      )
    })
  })
})

describe('CampaignsTab', () => {
  it('computes days estimate from selected accounts', async () => {
    carrierBlast.mockResolvedValue({
      ok: true,
      accounts: [
        { email: 'warm@jobsdone.com', status: '1', warmupStatus: 'active', dailyLimit: 40, warmupScore: 95, provider: 'google', ok: true },
      ],
      totalDailyCapacity: 15,
      defaultPerMailbox: 12,
      reservePerMailbox: 25,
      maxPerMailbox: 15,
    })
    const activeContacts = Array.from({ length: 600 }, (_, i) => ({
      id: `c-${i}`,
      lane: 'IL_IA' as const,
      email: `carrier${i}@x.com`,
      firstName: null,
      lastName: null,
      company: null,
      status: 'active' as const,
      source: null,
      addedBy: null,
      addedAt: '2025-01-01T00:00:00.000Z',
      lastCampaignId: null,
      lastSentAt: null,
      notes: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }))
    listCarrierContacts.mockResolvedValue(activeContacts)
    render(<MemoryRouter><CampaignsTab /></MemoryRouter>)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /New campaign/i }))
    })

    await waitFor(() => {
      expect(screen.getByText(/warm@jobsdone\.com/i)).toBeTruthy()
    })

    act(() => {
      fireEvent.change(screen.getByPlaceholderText(/IL→IA June outreach/i), { target: { value: 'Test Campaign' } })
      fireEvent.change(screen.getByPlaceholderText(/Your subject line/i), { target: { value: 'Hello' } })
      fireEvent.change(screen.getByPlaceholderText(/Plain text/i), { target: { value: 'Body text' } })
    })

    const warmCheckbox = screen.getByRole('checkbox', { name: /warm@jobsdone\.com/i })
    act(() => {
      fireEvent.click(warmCheckbox)
    })

    await waitFor(() => {
      const estimate = screen.getByTestId('campaign-estimate')
      expect(estimate.textContent).toContain('1 mailbox × 12/day = 12/day')
      expect(estimate.textContent).toContain('~50 days for 600 contacts')
    })
  })

  it('clamps per-mailbox to maxPerMailbox and excludes non-jobsdone accounts', async () => {
    carrierBlast.mockResolvedValue({
      ok: true,
      accounts: [
        { email: 'a@jobsdone.com', status: '1', warmupStatus: 'active', dailyLimit: 40, warmupScore: 95, provider: 'google', ok: true },
        { email: 'b@jobsdone.com', status: '1', warmupStatus: 'active', dailyLimit: 40, warmupScore: 92, provider: 'google', ok: true },
        { email: 'bad@cowtown.com', status: '1', warmupStatus: 'active', dailyLimit: 40, warmupScore: 95, provider: 'google', ok: false },
      ],
      totalDailyCapacity: 30,
      defaultPerMailbox: 12,
      reservePerMailbox: 25,
      maxPerMailbox: 15,
    })
    const activeContacts = Array.from({ length: 3000 }, (_, i) => ({
      id: `c-${i}`,
      lane: 'IL_IA' as const,
      email: `carrier${i}@x.com`,
      firstName: null,
      lastName: null,
      company: null,
      status: 'active' as const,
      source: null,
      addedBy: null,
      addedAt: '2025-01-01T00:00:00.000Z',
      lastCampaignId: null,
      lastSentAt: null,
      notes: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }))
    listCarrierContacts.mockResolvedValue(activeContacts)
    render(<MemoryRouter><CampaignsTab /></MemoryRouter>)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /New campaign/i }))
    })

    await waitFor(() => {
      expect(screen.getByText(/a@jobsdone\.com/i)).toBeTruthy()
      expect(screen.getByText(/b@jobsdone\.com/i)).toBeTruthy()
    })

    expect(screen.queryByRole('checkbox', { name: /bad@cowtown\.com/i })).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: /a@jobsdone\.com/i }))
      fireEvent.click(screen.getByRole('checkbox', { name: /b@jobsdone\.com/i }))
    })

    const limitInput = screen.getByTestId('per-mailbox-limit')
    act(() => {
      fireEvent.change(limitInput, { target: { value: '20' } })
    })

    await waitFor(() => {
      expect((limitInput as HTMLInputElement).value).toBe('15')
    })

    await waitFor(() => {
      const estimate = screen.getByTestId('campaign-estimate')
      expect(estimate.textContent).toContain('2 mailboxes × 15/day = 30/day')
      expect(estimate.textContent).toContain('~100 days for 3000 contacts')
    })
  })
})

describe('RepliesTab', () => {
  it('mark handled calls updateCarrierReply', async () => {
    const reply = {
      id: 'reply-1',
      instantlyEmailId: 'em-1',
      fromEmail: 'carrier@x.com',
      fromName: 'Carrier One',
      toAccount: 'warm@instantly.ai',
      subject: 'Re: Rate',
      textBody: 'I am interested',
      snippet: 'I am interested',
      receivedAt: '2025-06-01T12:00:00.000Z',
      isAutoReply: false,
      status: 'open' as const,
      assignedTo: null,
      handledBy: null,
      handledAt: null,
      uniboxUrl: null,
      lastOutboundAt: null,
      campaignId: null,
      contactId: null,
      lane: 'IL_IA' as const,
      instantlyCampaignId: null,
      createdAt: '2025-06-01T12:00:00.000Z',
      updatedAt: '2025-06-01T12:00:00.000Z',
    }
    listCarrierReplies.mockResolvedValue([reply])
    listCarrierCampaigns.mockResolvedValue([])

    render(<RepliesTab />)

    await waitFor(() => {
      expect(screen.getByText('Carrier One')).toBeTruthy()
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Mark handled/i }))
    })

    await waitFor(() => {
      expect(updateCarrierReply).toHaveBeenCalledTimes(1)
      expect(updateCarrierReply).toHaveBeenCalledWith(
        'reply-1',
        expect.objectContaining({ status: 'handled', handledBy: 'ryne@bcatcorp.com' })
      )
    })
  })
})
