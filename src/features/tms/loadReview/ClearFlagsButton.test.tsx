// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  setDetentionFlag: vi.fn(async () => ({ shipment: {} })),
  setTonuFlag: vi.fn(async () => ({ shipment: {} })),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ClearFlagsButton } from './ClearFlagsButton'

const stamp = { flaggedAt: '2026-11-16T10:00:00Z', flaggedBy: 'ops@x.com' }

beforeEach(() => { api.setDetentionFlag.mockClear(); api.setTonuFlag.mockClear() })

describe('ClearFlagsButton', () => {
  it('draws nothing for an unflagged load', () => {
    render(<ClearFlagsButton row={{ id: 's1', number: '1' }} />)
    expect(screen.queryByTestId('clear-flags')).toBeNull()
  })

  it('clears a TONU flag with one click and tells the page to reload', async () => {
    const onCleared = vi.fn()
    render(<ClearFlagsButton row={{ id: 's1', number: '14001', tonuFlag: stamp }} onCleared={onCleared} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear flag' }))
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(api.setTonuFlag).toHaveBeenCalledWith({ shipmentId: 's1', flag: null })
    expect(api.setDetentionFlag).not.toHaveBeenCalled()
  })

  it('clears both flags when both are raised', async () => {
    const onCleared = vi.fn()
    render(<ClearFlagsButton row={{ id: 's2', detentionFlag: { stopType: 'pickup', ...stamp }, tonuFlag: stamp }} onCleared={onCleared} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear flags' }))
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(api.setDetentionFlag).toHaveBeenCalledWith({ shipmentId: 's2', flag: null })
    expect(api.setTonuFlag).toHaveBeenCalledWith({ shipmentId: 's2', flag: null })
  })
})
