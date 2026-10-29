// @vitest-environment jsdom
/**
 * The trace is the only screen that explains an agent, so these assertions are about the
 * claims it makes: the right door for each kind of proposal, a failed run that says where
 * it stopped, and the Live badge, which must never say a settled run is still working.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { WorkflowProposal, WorkflowRunRecord } from '@/types/tms'

const api = vi.hoisted(() => ({
  getWorkflowRun: vi.fn(async () => null as WorkflowRunRecord | null),
  getIntakePdfUrl: vi.fn(async () => 'https://example.test/signed'),
  dismissWorkflowRun: vi.fn(),
  saveWorkflowFeedback: vi.fn(),
  linkWorkflowRun: vi.fn(),
  setWorkflowRunParty: vi.fn(),
  listShipments: vi.fn(async () => [] as unknown[]),
  getShipmentBundle: vi.fn(async () => ({ shipment: { id: 'shp-1', number: 'S000123', status: 'OPEN', customerName: 'Acme' }, orders: [], loads: [], loadCarriers: [], charges: [] })),
}))
vi.mock('@/lib/apiClient', () => api)

// The create door is the board's own dialog, tested where it lives; the trace only has
// to hand it a prefill, so it is a stub here rather than a second copy of that suite.
vi.mock('@/features/shipments/components/NewShipmentDialog', () => ({
  NewShipmentDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="new-shipment-dialog" /> : null),
}))

import { RunTrace } from './RunTrace'

function run(patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'wf:TENDER:abc',
    agent: 'TENDER',
    inboxRole: 'TENDER',
    status: 'COMPLETED',
    outcome: 'PROPOSED',
    sourceId: 'intake-1',
    subject: 'Tender 4411 Chicago to Dallas',
    fromEmail: 'ops@acme.example',
    fromName: 'Acme Ops',
    receivedAt: '2026-10-28T11:00:00.000Z',
    attempts: 1,
    durationMs: 4200,
    model: 'claude-sonnet',
    modelCalls: 2,
    inputTokens: 1200,
    outputTokens: 300,
    partyName: 'Acme Logistics',
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    version: 2,
    updatedAt: '2026-10-28T11:00:05.000Z',
    ...patch,
  }
}

function withProposal(kind: WorkflowProposal['kind'], proposal: WorkflowProposal, patch: Partial<WorkflowRunRecord> = {}) {
  return run({ proposalKind: kind, proposal, ...patch })
}

const draw = () => render(<MemoryRouter><RunTrace runId="wf:TENDER:abc" /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  api.getIntakePdfUrl.mockResolvedValue('https://example.test/signed')
})

describe('RunTrace', () => {
  it('renders the header, the model cost and the whole step rail for a tender proposal', async () => {
    api.getWorkflowRun.mockResolvedValue(withProposal('TENDER', {
      kind: 'TENDER',
      customerName: 'Acme Logistics',
      tender: {
        format: 'SUBJECT',
        reference: 'TMS-4411',
        weightLb: 42000,
        stops: [
          { type: 'pickup', name: 'Acme Dock', city: 'Chicago', state: 'IL', dateStr: '2026-11-02' },
          { type: 'delivery', name: 'Buyer DC', city: 'Dallas', state: 'TX', dateStr: '2026-11-04' },
        ],
      },
    }))
    draw()

    expect(await screen.findByText('Tender 4411 Chicago to Dallas')).toBeInTheDocument()
    expect(screen.getByTestId('model-cost')).toHaveTextContent('claude-sonnet')
    expect(screen.getByTestId('model-cost')).toHaveTextContent('1200 in / 300 out')
    expect(screen.getByRole('button', { name: 'Create shipment' })).toBeInTheDocument()
    expect(screen.getByText('TMS-4411')).toBeInTheDocument()

    // Every step the agent could have taken is on the rail, reached or not.
    const rail = screen.getByTestId('steps-rail')
    for (const label of ['receive email', 'classify email', 'parse tender', 'match stop', 'propose tender']) {
      expect(rail).toHaveTextContent(label)
    }
  })

  it('sends a quote proposal to the quote board and a carrier bill to Carrier Pay', async () => {
    api.getWorkflowRun.mockResolvedValue(withProposal('QUOTE', {
      kind: 'QUOTE',
      customerName: 'Acme Logistics',
      origin: { city: 'Chicago', state: 'IL' },
      destination: { city: 'Dallas', state: 'TX' },
      targetRateCents: 185000,
    }, { agent: 'QUOTE' }))
    const quote = draw()

    expect(await screen.findByRole('button', { name: 'Create quote' })).toBeInTheDocument()
    expect(screen.getByText('$1,850.00')).toBeInTheDocument()
    quote.unmount()

    api.getWorkflowRun.mockResolvedValue(withProposal('CARRIER_BILL', {
      kind: 'CARRIER_BILL',
      invoiceNumber: 'INV-77',
      amountCents: 95000,
      carrierName: 'Road Dogs LLC',
      shipmentId: 'shp-1',
      shipmentNumber: 'S000123',
    }, { agent: 'AP', shipmentId: 'shp-1' }))
    draw()

    const link = await screen.findByRole('link', { name: 'Open Carrier Pay' })
    expect(link).toHaveAttribute('href', '/tms/shipments/shp-1?tab=carrierPay')
    expect(screen.getByText('INV-77')).toBeInTheDocument()
  })

  it('sends a vendor bill to Vendors and offers nothing to press on a capacity note', async () => {
    api.getWorkflowRun.mockResolvedValue(withProposal('VENDOR_BILL', {
      kind: 'VENDOR_BILL',
      vendorName: 'Pilot Travel Centers',
      invoiceNumber: 'V-9',
      amountCents: 12345,
    }, { agent: 'AP' }))
    const vendor = draw()
    expect(await screen.findByRole('link', { name: 'Open in Vendors' })).toHaveAttribute('href', '/tms/vendors')
    vendor.unmount()

    api.getWorkflowRun.mockResolvedValue(withProposal('CAPACITY', {
      kind: 'CAPACITY',
      carrierName: 'Road Dogs LLC',
      equipment: 'REEFER',
      originCity: 'Laredo',
      originState: 'TX',
      trucks: 3,
    }, { agent: 'CAPACITY', outcome: 'NOTED' }))
    draw()

    expect(await screen.findByText('Capacity noted')).toBeInTheDocument()
    expect(screen.getByText('REEFER')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull()
  })

  it('asks who the sender is when the match failed, and never answers it itself', async () => {
    api.getWorkflowRun.mockResolvedValue(run({
      outcome: 'UNKNOWN_PARTY',
      exceptionOpen: 'OPEN',
      partyName: null,
      partyCandidates: [
        { kind: 'CUSTOMER', id: 'cus-1', name: 'Acme Logistics', how: 'DOMAIN' },
        { kind: 'CARRIER', id: 'car-9', name: 'Acme Trucking', how: 'NAME' },
      ],
    }))
    draw()

    expect(await screen.findByText('Who sent this?')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Pick party' })).toHaveLength(2)
    expect(api.setWorkflowRunParty).not.toHaveBeenCalled()
  })

  it('says where a failed run stopped', async () => {
    api.getWorkflowRun.mockResolvedValue(run({
      status: 'FAILED',
      outcome: null,
      error: 'Anthropic call timed out',
      errorCode: 'MODEL_TIMEOUT',
      exceptionOpen: 'OPEN',
      currentStep: 'PARSE_TENDER',
      steps: [
        { key: 'RECEIVE_EMAIL', status: 'DONE', ms: 120 },
        { key: 'CLASSIFY_EMAIL', status: 'DONE', ms: 900 },
        { key: 'PARSE_TENDER', status: 'FAILED', ms: 30000, detail: 'Anthropic call timed out after 30s' },
      ],
    }))
    draw()

    expect(await screen.findByTestId('failed-step-detail')).toHaveTextContent('PARSE_TENDER: Anthropic call timed out after 30s')
    expect(screen.getByTestId('steps-rail')).toHaveTextContent('pending')
  })

  it('shows Live only while the run is in progress', async () => {
    api.getWorkflowRun.mockResolvedValue(run({ status: 'IN_PROGRESS', outcome: null, currentStep: 'PARSE_TENDER' }))
    const live = draw()
    expect(await screen.findByText('Live')).toBeInTheDocument()
    live.unmount()

    api.getWorkflowRun.mockResolvedValue(run())
    draw()
    await waitFor(() => expect(screen.getByText('Acme Logistics')).toBeInTheDocument())
    expect(screen.queryByText('Live')).toBeNull()
  })
})
