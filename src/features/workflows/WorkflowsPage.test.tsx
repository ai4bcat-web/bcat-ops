// @vitest-environment jsdom
/**
 * The Workflows page is a derivation made visible, so the assertions here are about the
 * things that would quietly mislead a dispatcher: a tab that does not survive a link, an
 * empty list that does not say why it is empty, and a default filter that reads as a
 * permission instead of the suggestion it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '@/hooks/useAuth'
import type { AuthUser } from '@/hooks/useAuth'
import type { WorkflowRunRecord } from '@/types/tms'

const api = vi.hoisted(() => ({
  listWorkflowExceptions: vi.fn(async () => [] as unknown[]),
  listWorkflowRuns: vi.fn(async () => [] as unknown[]),
  listShipments: vi.fn(async () => [] as unknown[]),
  listShipmentsByStatus: vi.fn(async () => [] as unknown[]),
  listShipmentsByCustomer: vi.fn(async () => [] as unknown[]),
  listShipmentsByMonth: vi.fn(async () => [] as unknown[]),
  listOrders: vi.fn(async () => [] as unknown[]),
  listLoadSummaries: vi.fn(async () => [] as unknown[]),
  listLoadCarriers: vi.fn(async () => [] as unknown[]),
  listLoadCarriersByLoad: vi.fn(async () => [] as unknown[]),
  listLoadFinancials: vi.fn(async () => [] as unknown[]),
  listQuotes: vi.fn(async () => [] as unknown[]),
  listCheckCallWorklist: vi.fn(async () => [] as unknown[]),
  listCarrierPingLinks: vi.fn(async () => [] as unknown[]),
  listCustomers: vi.fn(async () => [] as unknown[]),
  listLocations: vi.fn(async () => [] as unknown[]),
  listUserProfiles: vi.fn(async () => [] as unknown[]),
  createCustomer: vi.fn(), updateCustomer: vi.fn(), archiveCustomer: vi.fn(), setCustomerStatus: vi.fn(),
  createLocation: vi.fn(), updateLocation: vi.fn(), archiveLocation: vi.fn(),
  listIntegrations: vi.fn(async () => [] as unknown[]),
  getTmsSettings: vi.fn(async (): Promise<unknown> => null),
  retryWorkflowRun: vi.fn(),
  resolveWorkflowException: vi.fn(),
  validateIntegration: vi.fn(),
  setShipmentCustomer: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { WorkflowsPage } from './WorkflowsPage'

function run(patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'wf:TENDER:abc',
    agent: 'TENDER',
    status: 'FAILED',
    outcome: null,
    exceptionOpen: 'OPEN',
    error: 'The model timed out',
    errorCode: 'MODEL_TIMEOUT',
    sourceId: 'intake-1',
    fromEmail: 'ops@acme.example',
    partyName: 'Acme Logistics',
    attempts: 1,
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    version: 3,
    updatedAt: '2026-10-28T12:00:00.000Z',
    ...patch,
  }
}

const UNRESOLVED_SHIPMENT = {
  id: 'shp-1',
  number: 'S000123',
  status: 'OPEN',
  customerId: null,
  customerName: 'Typed Shipper Co',
  updatedAt: '2026-10-28T10:00:00.000Z',
}

function draw(user: Partial<AuthUser> & { groups: string[] }, path = '/tms/workflows') {
  return render(
    <AuthContext.Provider
      value={{
        user: { userId: 'u1', email: 'rep@bcatcorp.com', ...user },
        loading: false,
        needsNewPassword: false,
        login: vi.fn(), completeNewPassword: vi.fn(), logout: vi.fn(),
        isAdmin: false,
        isOwner: false,
        hasPageAccess: () => true,
      }}
    >
      <MemoryRouter initialEntries={[path]}><WorkflowsPage /></MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listWorkflowExceptions.mockResolvedValue([])
  api.listWorkflowRuns.mockResolvedValue([])
  api.listShipments.mockResolvedValue([])
  api.listIntegrations.mockResolvedValue([])
  api.listCheckCallWorklist.mockResolvedValue([])
  api.listCarrierPingLinks.mockResolvedValue([])
  api.listLoadFinancials.mockResolvedValue([])
  api.listUserProfiles.mockResolvedValue([])
  api.getTmsSettings.mockResolvedValue(null)
})

describe('WorkflowsPage', () => {
  it('opens on Errors and keeps the AI Agents tab in the URL', async () => {
    api.listWorkflowExceptions.mockResolvedValue([run()])
    api.listWorkflowRuns.mockResolvedValue([run({ id: 'wf:QUOTE:z', agent: 'QUOTE', status: 'COMPLETED', outcome: 'PROPOSED', exceptionOpen: null, error: null })])
    draw({ groups: ['role-ADMIN'] })

    expect(await screen.findByText('The model timed out')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /AI Agents/ }))
    expect(await screen.findByText('Proposed')).toBeInTheDocument()
    expect(screen.getByText('Acme Logistics')).toBeInTheDocument()
  })

  it('renders the AI Agents tab straight from ?tab=agents', async () => {
    api.listWorkflowRuns.mockResolvedValue([run({ status: 'IN_PROGRESS', exceptionOpen: null, error: null, currentStep: 'PARSE_TENDER' })])
    draw({ groups: ['role-ADMIN'] }, '/tms/workflows?tab=agents')

    expect(await screen.findByText('In progress')).toBeInTheDocument()
    expect(screen.getByText('PARSE_TENDER')).toBeInTheDocument()
  })

  it('says what is empty and why, per quick tab', async () => {
    draw({ groups: ['role-ADMIN'] })

    await waitFor(() => expect(api.listWorkflowExceptions).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: /^Accounting/ }))
    expect(await screen.findByText(/QuickBooks sync is preview-only until it is live/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^EDI/ }))
    expect(await screen.findByText(/fixed at Orderful/)).toBeInTheDocument()
  })

  it('tells a non-admin that the Integrations count is a permission, not a clean bill of health', async () => {
    draw({ groups: ['role-CARRIER_REP'] })

    await waitFor(() => expect(api.listWorkflowExceptions).toHaveBeenCalled())
    // The hook is never mounted for somebody the server would refuse.
    expect(api.listIntegrations).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: /^Integrations/ }))
    expect(await screen.findByText(/LIST_INTEGRATIONS is owner\/ADMIN only/)).toBeInTheDocument()
  })

  it('seeds a carrier rep with their three kinds and their two agents, and widens when the chips are dropped', async () => {
    api.listWorkflowExceptions.mockResolvedValue([
      run({ id: 'wf:AP:1', agent: 'AP', error: 'The invoice would not parse' }),
      run(),
    ])
    api.listShipments.mockResolvedValue([UNRESOLVED_SHIPMENT])
    draw({ groups: ['role-CARRIER_REP'] })

    // The spec matrix for CARRIER_REP: AI, Tracking, Parade — and nothing else.
    expect(await screen.findByText('Kind is AI agents')).toBeInTheDocument()
    expect(screen.getByText('Kind is Tracking')).toBeInTheDocument()
    expect(screen.getByText('Kind is Parade')).toBeInTheDocument()
    expect(screen.queryByText('Kind is Unknown customers')).toBeNull()

    // A4 narrows the AI rows by agent too: a carrier rep opens on AP and capacity, so
    // the tender run is a real row their default hides, like the unresolved shipment.
    await waitFor(() => expect(screen.getByText('The invoice would not parse')).toBeInTheDocument())
    expect(screen.queryByText('The model timed out')).toBeNull()
    expect(screen.queryByText('No customer record is linked to this shipment')).toBeNull()

    fireEvent.click(screen.getByText('Kind is AI agents'))
    fireEvent.click(screen.getByText('Kind is Tracking'))
    fireEvent.click(screen.getByText('Kind is Parade'))

    // A seed is not a gate: with the chips gone the rep sees every row, tender included.
    expect(await screen.findByText('No customer record is linked to this shipment')).toBeInTheDocument()
    expect(screen.getByText('The model timed out')).toBeInTheDocument()
    expect(screen.getByText('The invoice would not parse')).toBeInTheDocument()
  })

  it('offers Identify customer on an unresolved shipment and never a Retry', async () => {
    api.listShipments.mockResolvedValue([UNRESOLVED_SHIPMENT])
    draw({ groups: ['role-ADMIN'] })

    expect(await screen.findByRole('button', { name: 'Identify customer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('greys Retry with the reason when the run may not be retried', async () => {
    api.listWorkflowExceptions.mockResolvedValue([run({ status: 'COMPLETED', outcome: 'APPLIED' })])
    draw({ groups: ['role-ADMIN'] })

    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('title', 'This run was already applied')
  })

  it('raises a silent carrier ping, graded against the saved tracking interval', async () => {
    // 20 minute check-ins, so the rule's patience is 60 minutes — and this link has been
    // quiet since 2020. The number in the message is the proof the setting was read.
    api.getTmsSettings.mockResolvedValue({ trackingIntervalMin: 20 })
    api.listShipments.mockResolvedValue([
      { id: 'shp-9', number: 'S000999', status: 'IN_TRANSIT', customerId: 'cust-1', customerName: 'Acme Logistics' },
    ])
    api.listCarrierPingLinks.mockResolvedValue([
      {
        id: 'tl-9',
        kind: 'CARRIER_PING',
        status: 'ACTIVE',
        shipmentId: 'shp-9',
        loadId: 'load-9',
        expiresAt: '2030-01-01T00:00:00.000Z',
        contactName: 'Driver Dan',
        lastPingAt: '2020-01-01T00:00:00.000Z',
        createdBy: 'u1',
      },
    ])
    draw({ groups: ['role-ADMIN'] })

    expect(await screen.findByText('No position ping in over 60 minutes')).toBeInTheDocument()
    expect(screen.getByText('S000999')).toBeInTheDocument()
    expect(screen.getByText('Driver Dan')).toBeInTheDocument()
  })
})
