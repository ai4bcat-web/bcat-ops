// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ApInboxConfig } from '@/lib/apInbox/types'
import type { ApInboxStatusView } from '@/features/ap/inbox/apInboxClient'

const client = vi.hoisted(() => ({
  apInboxStatus: vi.fn(), apInboxSaveSettings: vi.fn(), apInboxOauthStart: vi.fn(), apInboxDisconnect: vi.fn(),
  apInboxConnectSimulated: vi.fn(), apInboxSyncNow: vi.fn(),
}))
vi.mock('@/features/ap/inbox/apInboxClient', () => client)
vi.mock('@/lib/apiClient', () => ({ graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)), listApInboxItems: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ApInboxSettingsCard } from './ApInboxSettingsCard'

const CONFIG: ApInboxConfig = {
  enabled: false, mode: 'GOOGLE', mailbox: 'ai4bcat@gmail.com', runHourChicago: 6, lookbackHours: 24, autoApply: true,
  autoApplyMinScore: 0.9, reviewMinScore: 0.5, maxMessagesPerRun: 200, maxModelCallsPerRun: 80, maxAutoAppliesPerRun: 50,
  dismissedRetentionDays: 30, resolvedRetentionDays: 180, ignoreSenders: [], version: 4,
}
const status = (patch: Partial<ApInboxStatusView> = {}): ApInboxStatusView => ({
  config: CONFIG,
  connection: { status: 'NOT_CONNECTED', googleEmail: null, connectedAt: null, lastError: null },
  runs: [], openCount: 0, devStack: false, providerReady: true, ...patch,
})
const draw = () => render(<MemoryRouter><ApInboxSettingsCard /></MemoryRouter>)

beforeEach(() => vi.clearAllMocks())

describe('ApInboxSettingsCard', () => {
  it('connects through Google: the redirect URI is the one shared callback page', async () => {
    client.apInboxStatus.mockResolvedValue(status())
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, origin: 'http://localhost', assign }, writable: true })
    client.apInboxOauthStart.mockResolvedValue({ url: 'https://accounts.google.com/x' })
    draw()
    fireEvent.click(await screen.findByTestId('ap-inbox-connect'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/x'))
    expect(client.apInboxOauthStart).toHaveBeenCalledWith('http://localhost/tms/rates/spot/callback')
  })

  it('cannot connect until the Google client is entered, and says where', async () => {
    client.apInboxStatus.mockResolvedValue(status({ providerReady: false }))
    draw()
    expect(await screen.findByTestId('ap-inbox-connect')).toBeDisabled()
    expect(screen.getByText(/Settings › Integrations › Google/)).toBeTruthy()
  })

  it('offers the simulated mailbox only on the dev stack', async () => {
    client.apInboxStatus.mockResolvedValue(status())
    const { unmount } = draw()
    await screen.findByTestId('ap-inbox-connect')
    expect(screen.queryByTestId('ap-inbox-sim')).toBeNull()
    unmount()
    client.apInboxStatus.mockResolvedValue(status({ devStack: true }))
    draw()
    expect(await screen.findByTestId('ap-inbox-sim')).toBeTruthy()
  })

  it('refuses a score under the floor locally and sends nothing; a valid save carries the config version', async () => {
    client.apInboxStatus.mockResolvedValue(status({ connection: { status: 'CONNECTED', googleEmail: 'ai4bcat@gmail.com', connectedAt: null, lastError: null } }))
    client.apInboxSaveSettings.mockResolvedValue({ config: CONFIG })
    draw()
    fireEvent.change(await screen.findByLabelText('Auto-update score'), { target: { value: '0.8' } })
    fireEvent.click(screen.getByTestId('ap-inbox-save'))
    expect(await screen.findByText(/between 0.85 and 0.99/)).toBeTruthy()
    expect(client.apInboxSaveSettings).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Auto-update score'), { target: { value: '0.92' } })
    fireEvent.click(screen.getByTestId('ap-inbox-save'))
    await waitFor(() => expect(client.apInboxSaveSettings).toHaveBeenCalled())
    expect(client.apInboxSaveSettings.mock.calls[0][0]).toMatchObject({ autoApplyMinScore: 0.92, mailbox: 'ai4bcat@gmail.com' })
    expect(client.apInboxSaveSettings.mock.calls[0][1]).toBe(4)
  })

  it('names the mailbox in every state: the Google account when connected, the configured address on the simulated mailbox', async () => {
    client.apInboxStatus.mockResolvedValue(status({ connection: { status: 'SIMULATED', googleEmail: null, connectedAt: null, lastError: null } }))
    draw()
    expect(await screen.findByTestId('ap-inbox-status-pill')).toBeTruthy()
    const card = screen.getByTestId('ap-inbox-settings-card')
    expect(card).toHaveTextContent('Simulated mailbox · ai4bcat@gmail.com')
  })
})
