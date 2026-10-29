// @vitest-environment jsdom
/**
 * The index is the registry made visible, so the assertions here are about the things
 * that would quietly mislead an admin: a heading competing with My Brokerage's own, a
 * provider silently missing from its category, a credential we are waiting for that
 * nobody is told about, and a row that is not a provider at all rendering as one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { IntegrationRecord } from '@/lib/integrations/types'

const api = vi.hoisted(() => ({ listIntegrations: vi.fn(async (): Promise<IntegrationRecord[]> => []) }))
vi.mock('@/lib/apiClient', () => api)

import { PROVIDERS } from '@/lib/integrations/registry'
import { IntegrationsIndex } from './IntegrationsIndex'
import { routeForProvider } from './providerRoute'

function rowFor(provider: string, patch: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    id: provider,
    provider,
    kind: 'PROVIDER',
    mode: 'STUB',
    credentialSource: 'PAGE',
    status: 'NOT_CONNECTED',
    health: 'UNKNOWN',
    ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listIntegrations.mockResolvedValue([])
})

const draw = () => render(<MemoryRouter><IntegrationsIndex /></MemoryRouter>)

describe('IntegrationsIndex', () => {
  it('renders no heading of its own — My Brokerage owns the h1', async () => {
    const { container } = draw()
    await waitFor(() => expect(api.listIntegrations).toHaveBeenCalled())
    expect(container.querySelector('h1')).toBeNull()
  })

  it('lists every registered provider and counts them by category', async () => {
    draw()
    await waitFor(() => expect(api.listIntegrations).toHaveBeenCalled())

    expect(screen.getByRole('tab', { name: /^All/ })).toHaveTextContent(String(PROVIDERS.length))
    for (const label of ['Load boards', 'Factoring', 'Accounting']) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    }
    expect(screen.getAllByText('DAT').length).toBeGreaterThan(0)
    expect(screen.getAllByText('QuickBooks Online').length).toBeGreaterThan(0)
  })

  it('shows the missing-credentials strip with what each provider is waiting for', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('DAT', { missingCredentials: ['Service account e-mail', 'Service account password'] }),
    ])
    draw()

    await waitFor(() => expect(screen.getByText('Missing credentials')).toBeInTheDocument())
    expect(screen.getAllByText(/Service account e-mail, Service account password/).length).toBeGreaterThan(0)
  })

  it('never renders an API client or a webhook receipt as a provider', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('api:abc123', { kind: 'API_CLIENT', name: 'Acme portal' }),
      rowFor('hook:xyz', { kind: 'WEBHOOK_EVENT' }),
    ])
    draw()

    await waitFor(() => expect(api.listIntegrations).toHaveBeenCalled())
    expect(screen.queryByText('Acme portal')).toBeNull()
    expect(screen.queryByText('api:abc123')).toBeNull()
  })

  it('shows a connected provider as connected and an unchecked one as never checked', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('MOTIVE', { credentialSource: 'STACK', status: 'CONNECTED', health: 'OK', mode: 'LIVE', lastCheckAt: '2026-10-29T12:00:00.000Z' }),
    ])
    draw()

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(screen.getAllByText('Never').length).toBeGreaterThan(0)
  })

  it('opens a provider page on a row click', async () => {
    render(
      <MemoryRouter initialEntries={['/tms/brokerage/integrations']}>
        <Routes>
          <Route path="/tms/brokerage/integrations" element={<IntegrationsIndex />} />
          <Route path="/tms/brokerage/integrations/:provider" element={<p>provider page</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(api.listIntegrations).toHaveBeenCalled())
    fireEvent.click(screen.getAllByText('DAT')[screen.getAllByText('DAT').length - 1])

    await waitFor(() => expect(screen.getByText('provider page')).toBeInTheDocument())
  })

  it('sends the two providers that already have a page of their own to that page', () => {
    expect(routeForProvider('JOBSDONE')).toBe('/pods')
    expect(routeForProvider('TWILIO')).toBe('/dispatch')
    expect(routeForProvider('QUICKBOOKS_ONLINE')).toBe('/tms/brokerage/integrations/quickbooks-online')
  })
})
