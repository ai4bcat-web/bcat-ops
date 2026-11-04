// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSalesSettingsPage } from './CarrierSalesSettingsPage'

const mocks = vi.hoisted(() => ({ csAction: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ csAction: mocks.csAction }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function status(over: Record<string, unknown> = {}, devStack = false) {
  return {
    config: {
      enabled: true, lookbackHours: 24, maxMessagesPerRun: 100, modelCallsPerDay: 300, autoFileMinScore: 0.85, suggestMinScore: 0.5,
      unmatchedRetentionDays: 30, ignoreSenders: [], boardSenderDomains: ['dat.com'], version: 4,
      mailboxes: [{ id: 'm1', label: 'Loads', account: 'desk@example.invalid', addresses: ['loads@example.invalid'], gmailLabel: null, mode: 'GOOGLE', paused: false }],
      voice: { enabled: false, hasSecret: false, rotatedAt: null, maxTranscriptChars: 20000 },
      ...over,
    },
    state: {
      mailboxes: { m1: { status: 'NEEDS_RECONNECT', googleEmail: null, lastPollAt: '2026-11-04T12:00:00Z', lastPollOk: false, lastError: 'token expired', lastStats: null } },
      voice: { lastCallAt: null, calls24h: 0, lastError: null, urlSeenAt: null, url: null }, runs: [],
    },
    devStack, gmailProvider: { mode: 'LIVE' },
  }
}

const draw = () => render(<MemoryRouter><CarrierSalesSettingsPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.csAction.mockImplementation(async (action: string) => (action === 'CS_STATUS' ? status() : action === 'CS_VOICE_ROTATE_SECRET' ? { secret: 's3cret-value' } : action === 'CS_OAUTH_START' ? { url: 'https://accounts.example.invalid/auth' } : {}))
})

describe('CarrierSalesSettingsPage', () => {
  it('shows each mailbox with its status chip and last error', async () => {
    draw()
    const row = await screen.findByTestId('cs-settings-mailbox-m1')
    expect(row.textContent).toContain('desk@example.invalid')
    expect(screen.getByText('NEEDS RECONNECT')).toBeTruthy()
    expect(screen.getByText('token expired')).toBeTruthy()
    expect(screen.getByTestId('cs-settings-connect-m1').textContent).toBe('Connect')
  })

  it('Connect starts OAuth for that mailbox with the shared callback path', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { origin: 'https://app.example.invalid', assign }, writable: true })
    draw()
    fireEvent.click(await screen.findByTestId('cs-settings-connect-m1'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.example.invalid/auth'))
    expect(mocks.csAction).toHaveBeenCalledWith('CS_OAUTH_START', { mailboxId: 'm1', redirectUri: 'https://app.example.invalid/tms/rates/spot/callback' })
  })

  it('rotating the voice secret shows it once, and it is gone after Done', async () => {
    draw()
    fireEvent.click(await screen.findByTestId('cs-settings-voice-rotate'))
    const shown = await screen.findByTestId('cs-settings-voice-secret')
    expect(shown.textContent).toContain('s3cret-value')
    fireEvent.click(screen.getByText('Done'))
    expect(screen.queryByText('s3cret-value')).toBeNull()
  })

  it('save sends the whole config with the version it was loaded at', async () => {
    draw()
    fireEvent.change(await screen.findByTestId('cs-settings-modelCallsPerDay'), { target: { value: '50' } })
    fireEvent.click(screen.getByTestId('cs-settings-save'))
    await waitFor(() => expect(mocks.csAction).toHaveBeenCalledWith('CS_SAVE_SETTINGS', expect.objectContaining({ expectedVersion: 4 })))
    const call = mocks.csAction.mock.calls.find((c) => c[0] === 'CS_SAVE_SETTINGS')![1] as { config: { modelCallsPerDay: number; mailboxes: Array<{ addresses: string[] }> } }
    expect(call.config.modelCallsPerDay).toBe(50)
    expect(call.config.mailboxes[0]!.addresses).toEqual(['loads@example.invalid'])
  })

  it('the dev panel and the SIMULATED badge exist only on the dev stack', async () => {
    const view = draw()
    await screen.findByTestId('cs-settings-page')
    expect(screen.queryByTestId('cs-settings-dev-panel')).toBeNull()
    expect(screen.queryByTestId('cs-settings-simulated-badge')).toBeNull()
    view.unmount()
    mocks.csAction.mockImplementation(async () => status({}, true))
    draw()
    expect(await screen.findByTestId('cs-settings-dev-panel')).toBeTruthy()
    expect(screen.getByTestId('cs-settings-simulated-badge')).toBeTruthy()
  })
})
