// @vitest-environment jsdom
/**
 * Auto-send lets a reply leave a rep's Gmail with nobody pressing Send, so the switch has
 * to be impossible to flip by accident: off unless the org allows it, and turning it on
 * takes a typed confirmation after the gates are listed. Disconnecting must offer both
 * outcomes for the stored requests.
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
  it('keeps auto-send switched off, with the reason, while the org has not allowed it', () => {
    draw(status(false))
    expect(screen.getByTestId('spot-autosend-toggle')).toBeDisabled()
    expect(screen.getByTestId('spot-autosend-reason')).toBeInTheDocument()
  })

  it('turns auto-send on only after the rep types their first name', async () => {
    draw(status(true))
    fireEvent.click(screen.getByTestId('spot-autosend-toggle'))
    const confirm = await screen.findByTestId('spot-autosend-confirm')
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId('spot-autosend-name'), { target: { value: 'bob' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId('spot-autosend-name'), { target: { value: 'Jane' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_SAVE_MY_SETTINGS', { settings: { autoSend: true }, expectedVersion: 4 }))
  })

  it('turns auto-send off in one click', async () => {
    draw(status(true, true))
    fireEvent.click(screen.getByTestId('spot-autosend-toggle'))
    await waitFor(() => expect(api.spotAction).toHaveBeenCalledWith('SPOT_SAVE_MY_SETTINGS', { settings: { autoSend: false }, expectedVersion: 4 }))
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
