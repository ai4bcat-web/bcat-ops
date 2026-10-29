// @vitest-environment jsdom
/**
 * The AI Agents desk is where a person writes what the model reads, so the things worth
 * defending are the ones a mistake here would hand straight to a run: a memory block
 * longer than the prompt budget, a revision number invented by the browser, an inbox
 * address edited in a page that cannot create the Google Group behind it, and "Try it"
 * — which is a real run against the real model — firing with anything but what was typed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { MEMORY_MAX } from '@/lib/workflows/memory'
import type { TmsSettings, WorkflowRunRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({
  getTmsSettings: vi.fn(),
  saveTmsSettings: vi.fn(),
  listWorkflowRuns: vi.fn(),
  runWorkflowSample: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => mocks)

const auth = vi.hoisted(() => ({ isOwner: true, isAdmin: false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

import AiAgentsPage from './AiAgentsPage'

const SETTINGS = {
  id: 'default',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  aiAgents: {
    general: { markdown: 'Never quote reefer.', revision: 3, updatedAt: '2026-10-20T10:00:00Z', updatedBy: 'ryne@bcatcorp.com' },
    dailyRunCap: 50,
    QUOTE: {
      enabled: true,
      instructions: { markdown: 'Quote in cents.', revision: 2, updatedAt: '2026-10-19T09:00:00Z', updatedBy: 'ryne@bcatcorp.com' },
      memory: { markdown: 'Acme ships Tuesdays.', revision: 5, updatedAt: '2026-10-18T08:00:00Z', updatedBy: 'dana@bcatcorp.com' },
    },
  },
} as unknown as TmsSettings

const SAMPLE_RUN = {
  id: 'wf:QUOTE:abc123',
  agent: 'QUOTE',
  status: 'COMPLETED',
  outcome: 'PROPOSED',
  sourceId: 'sample-1',
  createdBy: 'ryne@bcatcorp.com',
  updatedBy: 'ryne@bcatcorp.com',
} as unknown as WorkflowRunRecord

const draw = () => render(<MemoryRouter><AiAgentsPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  auth.isOwner = true
  auth.isAdmin = false
  mocks.getTmsSettings.mockResolvedValue(SETTINGS)
  mocks.saveTmsSettings.mockResolvedValue(SETTINGS)
  mocks.listWorkflowRuns.mockResolvedValue([])
  mocks.runWorkflowSample.mockResolvedValue(SAMPLE_RUN)
})

describe('AiAgentsPage', () => {
  it('opens on General with one tab per configurable agent', async () => {
    draw()

    await waitFor(() => expect(screen.getByLabelText('Organization memory')).toHaveValue('Never quote reefer.'))
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'General', 'Quote', 'Tender', 'AP', 'Capacity',
    ])
    expect(screen.getByLabelText('Daily run cap')).toHaveValue('50')
    expect(screen.getByText(/Revision 3 · edited by ryne@bcatcorp.com/)).toBeInTheDocument()
  })

  it('refuses memory text longer than the prompt budget rather than letting the server lose it', async () => {
    draw()
    const box = await screen.findByLabelText('Organization memory')

    fireEvent.change(box, { target: { value: 'x'.repeat(MEMORY_MAX + 1) } })

    expect(box).toHaveValue('Never quote reefer.')
    expect(screen.getByText(/was not applied/)).toBeInTheDocument()

    fireEvent.change(box, { target: { value: 'y'.repeat(MEMORY_MAX) } })
    expect(box).toHaveValue('y'.repeat(MEMORY_MAX))
  })

  it('shows the agent inbox read-only, defaulting to the address the bridge polls', async () => {
    draw()
    await screen.findByLabelText('Organization memory')

    fireEvent.click(screen.getByRole('tab', { name: 'Tender' }))

    const inbox = screen.getByLabelText('Tender inbox address')
    expect(inbox).toHaveValue('tenders@bcatcorp.com')
    expect(inbox).toHaveAttribute('readonly')
  })

  it('saves the typed markdown against the settings row it read, leaving the revision to the server', async () => {
    draw()
    const box = await screen.findByLabelText('Organization memory')

    fireEvent.change(box, { target: { value: 'Reefer is fine now.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.saveTmsSettings).toHaveBeenCalledTimes(1))
    const [patch, expectedUpdatedAt] = mocks.saveTmsSettings.mock.calls[0]
    expect(expectedUpdatedAt).toBe('2026-10-20T10:00:00Z')
    expect(patch.aiAgents.general).toMatchObject({ markdown: 'Reefer is fine now.', revision: 3 })
    expect(patch.aiAgents.dailyRunCap).toBe(50)
    expect(patch.aiAgents.QUOTE.enabled).toBe(true)
    // No `inbox` key: leaving it out is what makes the validator keep the stored address.
    expect(patch.aiAgents.QUOTE.inbox).toBeUndefined()
    // The page re-reads, so the revision on screen is the one the server stamped.
    await waitFor(() => expect(mocks.getTmsSettings).toHaveBeenCalledTimes(2))
  })

  it('runs a sample once with exactly what was typed and links the run it made', async () => {
    draw()
    await screen.findByLabelText('Organization memory')
    fireEvent.click(screen.getByRole('tab', { name: 'Quote' }))

    fireEvent.change(screen.getByLabelText('Sample from address'), { target: { value: 'dispatch@acme.test' } })
    fireEvent.change(screen.getByLabelText('Sample subject'), { target: { value: 'Rate for Chicago to Dallas' } })
    fireEvent.change(screen.getByLabelText('Sample body'), { target: { value: '45000 lb dry van, Tuesday.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run sample' }))

    await waitFor(() => expect(mocks.runWorkflowSample).toHaveBeenCalledTimes(1))
    expect(mocks.runWorkflowSample).toHaveBeenCalledWith({
      agent: 'QUOTE',
      subject: 'Rate for Chicago to Dallas',
      body: '45000 lb dry van, Tuesday.',
      fromEmail: 'dispatch@acme.test',
    })

    const link = await screen.findByRole('link', { name: 'wf:QUOTE:abc123' })
    expect(link).toHaveAttribute('href', '/tms/workflows/runs/wf:QUOTE:abc123')
    expect(screen.getByText(/COMPLETED · PROPOSED/)).toBeInTheDocument()
  })

  it('refuses a daily cap outside the range the server accepts before spending the trip', async () => {
    draw()
    await screen.findByLabelText('Organization memory')

    fireEvent.change(screen.getByLabelText('Daily run cap'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/between 1 and 10,000/)).toBeInTheDocument()
    expect(mocks.saveTmsSettings).not.toHaveBeenCalled()
  })

  it('gives an agent two cards, each with its own revision line and its own budget', async () => {
    draw()
    await screen.findByLabelText('Organization memory')

    fireEvent.click(screen.getByRole('tab', { name: 'Quote' }))

    expect(screen.getByLabelText('Quote instructions')).toHaveValue('Quote in cents.')
    expect(screen.getByLabelText('Quote memory')).toHaveValue('Acme ships Tuesdays.')
    expect(screen.getByText(/Revision 2 · edited by ryne@bcatcorp.com/)).toBeInTheDocument()
    expect(screen.getByText(/Revision 5 · edited by dana@bcatcorp.com/)).toBeInTheDocument()
    // Each card counts its own text, so neither budget can be spent by the other block.
    expect(screen.getByText('15 / 20,000 characters')).toBeInTheDocument()
    expect(screen.getByText('20 / 20,000 characters')).toBeInTheDocument()
  })

  it('sends only the block that was edited, so the untouched revision cannot move', async () => {
    draw()
    await screen.findByLabelText('Organization memory')
    fireEvent.click(screen.getByRole('tab', { name: 'Quote' }))

    fireEvent.change(screen.getByLabelText('Quote memory'), {
      target: { value: 'Acme ships Tuesdays and pays net 15.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.saveTmsSettings).toHaveBeenCalledTimes(1))
    const sent = mocks.saveTmsSettings.mock.calls[0][0].aiAgents
    // The whole shape, because "which keys are present" is the contract the server reads.
    expect(Object.keys(sent).sort()).toEqual(['AP', 'CAPACITY', 'QUOTE', 'TENDER', 'dailyRunCap', 'general'])
    expect(Object.keys(sent.TENDER)).toEqual(['enabled'])
    const quote = sent.QUOTE
    expect(Object.keys(quote).sort()).toEqual(['enabled', 'memory'])
    expect(quote.memory).toMatchObject({ markdown: 'Acme ships Tuesdays and pays net 15.', revision: 5 })
    // Absent, not null: a key the validator never sees is the only way its revision stays put.
    expect('instructions' in quote).toBe(false)
    expect(quote.enabled).toBe(true)
  })

  it('sends the instructions alone when the instructions alone changed', async () => {
    draw()
    await screen.findByLabelText('Organization memory')
    fireEvent.click(screen.getByRole('tab', { name: 'Quote' }))

    fireEvent.change(screen.getByLabelText('Quote instructions'), { target: { value: 'Quote in dollars.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.saveTmsSettings).toHaveBeenCalledTimes(1))
    const quote = mocks.saveTmsSettings.mock.calls[0][0].aiAgents.QUOTE
    expect(quote.instructions).toMatchObject({ markdown: 'Quote in dollars.', revision: 2 })
    expect('memory' in quote).toBe(false)
  })
})
