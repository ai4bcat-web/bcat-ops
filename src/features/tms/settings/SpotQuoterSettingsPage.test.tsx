// @vitest-environment jsdom
/**
 * The org page decides whether reps can auto-send at all and how long mail is kept, so a
 * save must carry exactly what was typed, a nonsense number must never reach the server,
 * and the Reps table must show states and counters only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'

const api = vi.hoisted(() => ({ spotAction: vi.fn(), listGmailConnections: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

import SpotQuoterSettingsPage from './SpotQuoterSettingsPage'

const STATUS = {
  devStack: false,
  gmailProvider: { mode: 'STUB', health: null },
  datProvider: { mode: 'LIVE' },
  connection: null,
  settings: { id: 'default', enabled: true, allowAutoSend: false, retentionDays: 90, version: 7 },
}
const REPS = [
  {
    id: 'u1', userEmail: 'jane.rep@bcatcorp.com', mode: 'GOOGLE', status: 'CONNECTED', lastPollAt: '2026-11-04T10:00:00Z', lastPollOk: true,
    lastPollStats: { listed: 12, stage1Rejected: 6, stage2Rejected: 3, modelCalls: 3, stored: 2, attached: 0, errors: 0 },
    settings: { autoSend: true }, version: 1,
  },
]

const draw = () => render(<MemoryRouter><SpotQuoterSettingsPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  api.spotAction.mockImplementation(async (action: string) => (action === 'SPOT_STATUS' ? STATUS : {}))
  api.listGmailConnections.mockResolvedValue(REPS)
})

describe('SpotQuoterSettingsPage', () => {
  it('shows the provider modes', async () => {
    draw()
    expect(await screen.findByTestId('spot-gmail-mode')).toHaveTextContent('STUB')
    expect(screen.getByTestId('spot-dat-mode')).toHaveTextContent('LIVE')
  })

  it('saves what was typed against the version it loaded', async () => {
    draw()
    const retention = await screen.findByTestId('spot-policy-retentionDays')
    fireEvent.change(retention, { target: { value: '30' } })
    fireEvent.click(screen.getByLabelText('Allow auto-send'))
    fireEvent.click(screen.getByTestId('spot-policy-save'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_SAVE_SETTINGS', expect.anything()))
    const call = api.spotAction.mock.calls.find((c) => c[0] === 'SPOT_SAVE_SETTINGS')![1]
    expect(call.expectedVersion).toBe(7)
    expect(call.settings).toMatchObject({ retentionDays: 30, allowAutoSend: true, enabled: true })
  })

  it('refuses a nonsense number without calling the server', async () => {
    draw()
    fireEvent.change(await screen.findByTestId('spot-policy-retentionDays'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('spot-policy-save'))
    expect(await screen.findByText(/retention/i, { selector: 'p' })).toBeInTheDocument()
    expect(api.spotAction.mock.calls.some((c) => c[0] === 'SPOT_SAVE_SETTINGS')).toBe(false)
  })

  it('lists reps with counters only and disconnects one', async () => {
    draw()
    expect(await screen.findByText('jane.rep@bcatcorp.com')).toBeInTheDocument()
    expect(screen.getByText('12/9/3/2')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('spot-admin-disconnect-u1'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_ADMIN_DISCONNECT', { userId: 'u1', purge: false }))
  })
})
