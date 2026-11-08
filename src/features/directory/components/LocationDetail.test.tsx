// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { LocationRecord } from '@/types/tms'

vi.mock('@vis.gl/react-google-maps', () => ({ APIProvider: ({ children }: { children: unknown }) => children, Map: () => null, AdvancedMarker: () => null }))
// LocationDetail windows its visit history through useEnsureLoadRange, which reads these two.
const store = { loads: [], loadedMonths: new Set<string>(), ensureLoadRange: () => Promise.resolve() }
vi.mock('@/store/useAppStore', () => ({ useAppStore: (sel: (s: typeof store) => unknown) => sel(store) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { LocationDetail } = await import('./LocationDetail')

const loc = {
  id: 'l1', name: 'Batory Oakley', createdAt: '', updatedAt: '',
  driverNotes: [
    { at: '2026-10-01T12:00:00Z', driverId: 'd1', by: 'Chuck', text: 'wrong gate' },
    { at: '2026-10-02T12:00:00Z', driverId: 'd2', by: 'Jason', text: 'check in at the shack' },
  ],
} as unknown as LocationRecord

afterEach(() => vi.restoreAllMocks())

describe('LocationDetail driver notes', () => {
  it('staff Remove asks first, then removes exactly that note', async () => {
    const onRemoveNote = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<LocationDetail location={loc} onRemoveNote={onRemoveNote} />)
    // Newest first: Jason's note is listed above Chuck's.
    const buttons = screen.getAllByRole('button', { name: 'Remove' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(onRemoveNote).toHaveBeenCalledWith({ at: '2026-10-01T12:00:00Z', driverId: 'd1' }))
  })

  it('removes nothing when staff decline the confirmation', () => {
    const onRemoveNote = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<LocationDetail location={loc} onRemoveNote={onRemoveNote} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(onRemoveNote).not.toHaveBeenCalled()
  })
})
