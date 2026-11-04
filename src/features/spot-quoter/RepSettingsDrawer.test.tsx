// @vitest-environment jsdom
/**
 * The mailbox is read-only, so the drawer must carry no way to send, draft or auto-send.
 * Disconnecting must offer both outcomes for the stored requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { SpotStatusView } from '@/lib/spot/types'

const api = vi.hoisted(() => ({ spotAction: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

import { RepSettingsDrawer } from './RepSettingsDrawer'

function status(allowAutoSend: boolean, autoSend = false): SpotStatusView {
  return {
    devStack: false,
    gmailProvider: { mode: 'LIVE', health: null },
    datProvider: { mode: 'STUB' },
    settings: { id: 'default', enabled: true, allowAutoSend, retentionDays: 45, dismissedRetentionDays: 7 },
    connection: {
      id: 'u1', userEmail: 'jane.rep@bcatcorp.com', mode: 'GOOGLE', status: 'CONNECTED', googleEmail: 'jane.rep@bcatcorp.com',
      version: 4, settings: { autoSend, watchLabel: null, lookbackDays: 2, signature: 'Jane', replyTemplateId: 'DEFAULT', notifyNew: true },
    },
  } as unknown as SpotStatusView
}

const draw = (s: SpotStatusView) =>
  render(<RepSettingsDrawer open onOpenChange={() => {}} status={s} onChanged={() => {}} />)

beforeEach(() => {
  vi.clearAllMocks()
  api.spotAction.mockResolvedValue({})
})

describe('RepSettingsDrawer', () => {
  it('says the mailbox is read-only and has no auto-send control', () => {
    draw(status(true))
    expect(screen.getByTestId('spot-readonly-copy')).toHaveTextContent(/never sends or drafts mail/)
    expect(screen.queryByTestId('spot-autosend-toggle')).toBeNull()
  })

  it('saves the signature, label and look-back against the loaded version', async () => {
    draw(status(false))
    fireEvent.change(screen.getByTestId('spot-signature'), { target: { value: 'Thanks, Jane' } })
    fireEvent.click(screen.getByTestId('spot-settings-save'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_SAVE_MY_SETTINGS', {
      settings: { watchLabel: null, lookbackDays: 2, signature: 'Thanks, Jane' }, expectedVersion: 4,
    }))
  })

  it('states retention from the live org settings', () => {
    draw(status(false))
    expect(screen.getByTestId('spot-storage-note')).toHaveTextContent('45 days')
  })

  it('offers to keep or delete stored requests when disconnecting', async () => {
    draw(status(false))
    fireEvent.click(screen.getByTestId('spot-disconnect'))
    fireEvent.click(await screen.findByTestId('spot-disconnect-purge'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_DISCONNECT', { purge: true }))
  })

  it('can disconnect and keep the stored requests', async () => {
    draw(status(false))
    fireEvent.click(screen.getByTestId('spot-disconnect'))
    fireEvent.click(await screen.findByTestId('spot-disconnect-keep'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_DISCONNECT', { purge: false }))
  })

  it('pauses watching', async () => {
    draw(status(false))
    fireEvent.click(screen.getByTestId('spot-pause'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_SET_PAUSED', { paused: true }))
  })
})
