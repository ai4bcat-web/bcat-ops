// @vitest-environment jsdom
/**
 * One component draws every provider, so these assertions are about the four things
 * the page must never get wrong: it asks for a credential only where one can actually
 * be entered, it never offers to edit what the stack owns, a stub says out loud that
 * nothing was called, and a provider BCAT cannot connect to says why instead of
 * showing a form that would go nowhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AdapterResult, IntegrationRecord } from '@/lib/integrations/types'
import type { CustomerRecord, UserProfileRecord } from '@/types/tms'

const api = vi.hoisted(() => ({
  listIntegrations: vi.fn(async (): Promise<IntegrationRecord[]> => []),
  connectIntegration: vi.fn(),
  validateIntegration: vi.fn(),
  saveIntegrationSettings: vi.fn(),
  disconnectIntegration: vi.fn(),
  runIntegrationStub: vi.fn(),
  connectQuickBooks: vi.fn(),
  previewQboSync: vi.fn(),
  issueApiClient: vi.fn(),
  revokeApiClient: vi.fn(),
  listUserProfiles: vi.fn(async (): Promise<UserProfileRecord[]> => []),
  updateUserProfile: vi.fn(),
  listCustomers: vi.fn(async (): Promise<CustomerRecord[]> => []),
  updateCustomer: vi.fn(),
  getTmsSettings: vi.fn(async () => null),
}))
vi.mock('@/lib/apiClient', () => api)

import { IntegrationPage } from './IntegrationPage'

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

function draw(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/tms/brokerage/integrations/${slug}`]}>
      <Routes>
        <Route path="/tms/brokerage/integrations/:provider" element={<IntegrationPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listIntegrations.mockResolvedValue([])
})

describe('IntegrationPage credential sources', () => {
  it('PAGE: hides the values, opens write-only fields on Edit and places the last four in the placeholder', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('DAT', { status: 'CONNECTED', health: 'OK', credentialMask: [{ key: 'serviceAccountEmail', last4: '.com' }] }),
    ])
    draw('dat')

    await waitFor(() => expect(screen.getByText('Credentials')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Edit credentials' }))

    const field = screen.getByLabelText('Service account password')
    expect(field).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Service account e-mail')).toHaveAttribute('placeholder', '•••• .com — leave blank to keep')
    expect(screen.getByText('Save credentials')).toBeInTheDocument()
  })

  it('STACK: names the secrets and the console command, and offers no way to edit them here', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('OTR', { credentialSource: 'STACK', health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV' }),
    ])
    draw('otr')

    await waitFor(() => expect(screen.getByText('Credentials')).toBeInTheDocument())
    expect(screen.getByText('OTR_USERNAME')).toBeInTheDocument()
    expect(screen.getAllByText(/npx ampx secret set/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Edit credentials' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
  })

  it('BRIDGE: names the bridge and says when the last message actually arrived', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('GMAIL', { credentialSource: 'BRIDGE', status: 'CONNECTED', health: 'OK', lastOkAt: '2026-10-28T10:00:00.000Z' }),
    ])
    draw('gmail')

    await waitFor(() => expect(screen.getByText('INTAKE_WEBHOOK_SECRET')).toBeInTheDocument())
    expect(screen.getByText(/Last message received/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit credentials' })).toBeNull()
  })

  it('SCRIPT: names the script that writes the credential and the pool path it writes to', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('TWILIO', { credentialSource: 'SCRIPT', credentialRef: '/bcat/dispatch/us-east-1_dev/' }),
    ])
    draw('twilio')

    await waitFor(() => expect(screen.getByText('scripts/dispatchTwilioSetup.mjs')).toBeInTheDocument())
    expect(screen.getByText('/bcat/dispatch/us-east-1_dev/')).toBeInTheDocument()
  })

  it('NOT_APPLICABLE: prints the reason and draws no credential form at all', async () => {
    draw('convoy')

    await waitFor(() => expect(screen.getAllByText('Not applicable').length).toBeGreaterThan(1))
    expect(screen.getAllByText(/ceased operations in 2023/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull()
    expect(screen.queryByText('Run stub')).toBeNull()
  })

  it('shows the webhook receiver, its signature and its replay window where a provider signs its callbacks', async () => {
    draw('mycarrierpackets')

    await waitFor(() => expect(screen.getByText('Webhook')).toBeInTheDocument())
    expect(screen.getByText(/\/api\/webhooks\/mycarrierpackets$/)).toBeInTheDocument()
    expect(screen.getByText(/five minutes old is refused as a replay/)).toBeInTheDocument()
    expect(screen.getByText('No delivery received yet.')).toBeInTheDocument()
  })

  it('PAGE: disconnecting names what goes and what stays, and only a connected page provider offers it', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT', { status: 'CONNECTED', health: 'OK' })])
    api.disconnectIntegration.mockResolvedValue(rowFor('DAT', { status: 'DISCONNECTED' }))
    draw('dat')

    await waitFor(() => expect(screen.getByText('Disconnect')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Disconnect'))

    await waitFor(() => expect(screen.getByText(/Deleted: the stored credential/)).toBeInTheDocument())
    expect(screen.getByText(/Kept: this provider row, its behaviour settings/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('Disconnect')[screen.getAllByText('Disconnect').length - 1])
    await waitFor(() => expect(api.disconnectIntegration).toHaveBeenCalledWith('DAT'))
  })

  it('never offers Disconnect for a stack secret the deploy owns', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('OTR', { credentialSource: 'STACK', status: 'CONNECTED', health: 'OK' }),
    ])
    draw('otr')

    await waitFor(() => expect(screen.getByText('Credentials')).toBeInTheDocument())
    expect(screen.queryByText('Disconnect')).toBeNull()
  })
})

describe('IntegrationPage state', () => {
  it('badges each state the row can be in', async () => {
    const cases: Array<[Partial<IntegrationRecord>, string]> = [
      [{}, 'Not connected'],
      [{ status: 'CONNECTED', health: 'OK' }, 'Connected'],
      [{ status: 'CONNECTED', health: 'INVALID_CREDENTIALS' }, 'Invalid credentials'],
      [{ status: 'CONNECTED', health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV' }, 'Live on main · neutered on dev'],
      [{ status: 'DISCONNECTED', health: 'OK' }, 'Disconnected'],
    ]
    for (const [patch, label] of cases) {
      api.listIntegrations.mockResolvedValue([rowFor('DAT', patch)])
      const view = draw('dat')
      await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0))
      view.unmount()
    }
  })

  it('a stub run prints its result and says which provider was not called', async () => {
    const result: AdapterResult = {
      mode: 'STUB',
      ok: true,
      message: 'STUB — would post the shipment to DAT',
      externalId: 'stub:abc-123',
    }
    api.runIntegrationStub.mockResolvedValue({ row: rowFor('DAT'), result })
    api.listIntegrations.mockResolvedValue([rowFor('DAT')])
    draw('dat')

    await waitFor(() => expect(screen.getAllByText('Run stub').length).toBeGreaterThan(0))
    const post = screen.getByText('Post a shipment').closest('li')
    expect(post).not.toBeNull()
    fireEvent.click(within(post as HTMLElement).getByText('Run stub'))

    await waitFor(() => expect(screen.getByText(/STUB — would post the shipment to DAT/)).toBeInTheDocument())
    expect(screen.getByText('No call was made to DAT.')).toBeInTheDocument()
    expect(screen.getByText('stub:abc-123')).toBeInTheDocument()
    expect(api.runIntegrationStub).toHaveBeenCalledWith('DAT', 'post')
  })

  it('offers no stub run for a live capability and links to where the real action lives', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('OTR', { credentialSource: 'STACK', mode: 'LIVE', status: 'CONNECTED', health: 'OK' }),
    ])
    draw('otr')

    await waitFor(() => expect(screen.getByText('What this feeds')).toBeInTheDocument())
    expect(screen.queryByText('Run stub')).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Send to Factor' }).length).toBeGreaterThan(0)
  })

  it('says there are no checks yet before the first validate', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT')])
    draw('dat')

    await waitFor(() => expect(screen.getByText('No checks yet')).toBeInTheDocument())
    expect(screen.getByText('Validate runs the first one.')).toBeInTheDocument()
  })

  it('shows the stored events once there are some', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('DAT', {
        events: [{ at: '2026-10-28T10:00:00.000Z', action: 'VALIDATE', by: 'admin@bcatcorp.com', outcome: 'INVALID_CREDENTIALS', detail: 'HTTP 401' }],
      }),
    ])
    draw('dat')

    await waitFor(() => expect(screen.getByText('VALIDATE')).toBeInTheDocument())
    expect(screen.getByText('HTTP 401')).toBeInTheDocument()
    expect(screen.queryByText('No checks yet')).toBeNull()
  })

  it('validates on demand and shows the pending state while it waits', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT')])
    let settle: (row: IntegrationRecord) => void = () => {}
    api.validateIntegration.mockImplementation(() => new Promise<IntegrationRecord>((resolve) => { settle = resolve }))
    draw('dat')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    await waitFor(() => expect(screen.getByText('Checking connection')).toBeInTheDocument())
    settle(rowFor('DAT', { status: 'CONNECTED', health: 'OK' }))
    await waitFor(() => expect(screen.queryByText('Checking connection')).toBeNull())
  })

  it('still offers Run stub for a fully credentialled provider nothing can actually call', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('DAT', {
        status: 'CONNECTED',
        health: 'OK',
        mode: 'LIVE',
        credentialMask: [
          { key: 'serviceAccountEmail', last4: '.com' },
          { key: 'serviceAccountPassword', last4: 'x9f2' },
          { key: 'rateViewTier', last4: 'Pro' },
        ],
      }),
    ])
    draw('dat')

    // Credentials are not an implementation: DAT has no live post in this repo, so the
    // page must keep offering the stub rather than implying a real post exists.
    await waitFor(() => expect(screen.getByText('What this feeds')).toBeInTheDocument())
    expect(screen.getAllByText('Run stub').length).toBeGreaterThan(0)
  })
})

describe('IntegrationPage provider extras', () => {
  it('BCAT API: shows each client by its own id, revokes by that id, and shows a secret once', async () => {
    api.listIntegrations.mockResolvedValue([
      rowFor('OPENAPI', { credentialSource: 'OWN', mode: 'LIVE' }),
      // The provider column of a client row is the API itself; the id is what a caller
      // authenticates with, and the two must never be confused for one another.
      { ...rowFor('OPENAPI'), id: 'api:acme-7f3a', kind: 'API_CLIENT', name: 'Acme portal', scopes: ['READ'] },
    ])
    api.issueApiClient.mockResolvedValue({ row: rowFor('OPENAPI'), clientId: 'new-1b2c', secret: 's3cr3t-value' })
    draw('openapi')

    await waitFor(() => expect(screen.getByText('Acme portal')).toBeInTheDocument())
    expect(screen.getByText('acme-7f3a')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Revoke'))
    await waitFor(() => expect(api.revokeApiClient).toHaveBeenCalledWith('acme-7f3a'))

    fireEvent.click(screen.getByText('Issue client'))
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Second portal' } })
    fireEvent.click(screen.getByText('Issue'))

    await waitFor(() => expect(screen.getByText('s3cr3t-value')).toBeInTheDocument())
    expect(screen.getByText(/only time the secret is shown/)).toBeInTheDocument()
    expect(api.issueApiClient).toHaveBeenCalledWith('Second portal', ['READ'])
  })

  it('QuickBooks: the mapping it saves is a payload the descriptor actually accepts', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('QUICKBOOKS_ONLINE', { version: 2 })])
    api.saveIntegrationSettings.mockResolvedValue(rowFor('QUICKBOOKS_ONLINE', { version: 3 }))
    draw('quickbooks-online')

    await waitFor(() => expect(screen.getByLabelText('Accounts receivable')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Accounts receivable'), { target: { value: '42' } })
    fireEvent.click(screen.getByText('Save mapping'))

    // `validateProviderSettings` is the real one here: a payload carrying an
    // undeclared key would be refused before the call and this would never fire.
    await waitFor(() => expect(api.saveIntegrationSettings).toHaveBeenCalled())
    const [provider, settings, version] = api.saveIntegrationSettings.mock.calls[0]
    expect(provider).toBe('QUICKBOOKS_ONLINE')
    expect(settings).toMatchObject({ mappings: { arAccountRef: '42' } })
    expect(settings).not.toHaveProperty('clientId')
    expect(version).toBe(2)
  })

  it('QuickBooks: a preview shows the payload and says nothing was sent', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('QUICKBOOKS_ONLINE')])
    api.previewQboSync.mockResolvedValue({ payload: { Line: [], TotalAmt: '2500.00' }, mode: 'STUB' })
    draw('quickbooks-online')

    await waitFor(() => expect(screen.getAllByText('Preview sync').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Preview sync' }))

    await waitFor(() => expect(screen.getByText(/2500\.00/)).toBeInTheDocument())
    expect(screen.getByText('Nothing was sent to QuickBooks Online.')).toBeInTheDocument()
  })

  it('ArtisPay: the buyer picker is disabled and says what it is waiting for', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('ARTISPAY')])
    draw('artispay')

    await waitFor(() => expect(screen.getByLabelText('Buyer account')).toBeDisabled())
    expect(screen.getAllByText(/Available after connect/).length).toBeGreaterThan(0)
  })

  it('Highway: says the credential is provisioned by the vendor rather than offering to generate one', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('HIGHWAY')])
    draw('highway')

    await waitFor(() => expect(screen.getByText('Provisioned by the vendor')).toBeInTheDocument())
    expect(screen.getByText(/does not sell self-service API access/)).toBeInTheDocument()
  })

  it('EDI: saves the whole customer, not a patch that would blank it', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('ORDERFUL')])
    api.listCustomers.mockResolvedValue([
      {
        id: 'c1',
        name: 'Acme Co',
        billingEmail: 'ap@acme.test',
        paymentTermsDays: 30,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ])
    draw('orderful')

    await waitFor(() => expect(screen.getByLabelText('Acme Co ISA id')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Acme Co ISA id'), { target: { value: 'ZZ123' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(api.updateCustomer).toHaveBeenCalled())
    const [id, patch, expectedUpdatedAt] = api.updateCustomer.mock.calls[0]
    expect(id).toBe('c1')
    expect(expectedUpdatedAt).toBe('2026-01-02T00:00:00.000Z')
    // UPSERT_CUSTOMER rebuilds the row from the input: the name it asserts on and the
    // unrelated columns have to survive an EDI edit.
    expect(patch).toMatchObject({
      name: 'Acme Co',
      billingEmail: 'ap@acme.test',
      paymentTermsDays: 30,
      ediSettings: { isaId: 'ZZ123' },
    })
    expect(patch).not.toHaveProperty('id')
    expect(patch).not.toHaveProperty('updatedAt')
  })

  it('DAT: saves a rep’s own DAT e-mail through the profile action', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT')])
    api.listUserProfiles.mockResolvedValue([
      { id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', name: 'Rep One', createdBy: 'owner', updatedBy: 'owner', version: 1 },
    ])
    draw('dat')

    await waitFor(() => expect(screen.getByLabelText('DAT e-mail for Rep One')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('DAT e-mail for Rep One'), { target: { value: 'rep@dat.com' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(api.updateUserProfile).toHaveBeenCalledWith('rep@bcatcorp.com', { datEmail: 'rep@dat.com' }))
  })
})

describe('IntegrationPage behaviour card', () => {
  it('saves the behaviour settings on their own button', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT', { version: 4 })])
    api.saveIntegrationSettings.mockResolvedValue(rowFor('DAT', { version: 5 }))
    draw('dat')

    await waitFor(() => expect(screen.getByLabelText('Refresh interval (minutes)')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Refresh interval (minutes)'), { target: { value: '30' } })
    fireEvent.click(screen.getByText('Save behaviour'))

    await waitFor(() => expect(api.saveIntegrationSettings).toHaveBeenCalled())
    const [provider, settings, version] = api.saveIntegrationSettings.mock.calls[0]
    expect(provider).toBe('DAT')
    expect(settings).toMatchObject({ refreshIntervalMin: 30 })
    expect(version).toBe(4)
  })

  it('refuses a setting the provider would refuse, before any call is made', async () => {
    api.listIntegrations.mockResolvedValue([rowFor('DAT')])
    draw('dat')

    await waitFor(() => expect(screen.getByLabelText('Refresh interval (minutes)')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Refresh interval (minutes)'), { target: { value: '17' } })
    fireEvent.click(screen.getByText('Save behaviour'))

    await waitFor(() => expect(screen.getByText(/Refresh interval/i, { selector: '.tms-field-error' })).toBeInTheDocument())
    expect(api.saveIntegrationSettings).not.toHaveBeenCalled()
  })
})
