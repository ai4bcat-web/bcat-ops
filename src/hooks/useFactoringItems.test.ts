// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { listFactoringItems, deleteFactoringItem } from '@/lib/apiClient'
import { useFactoringItems } from './useFactoringItems'
import type { FactoringItem } from '@/types'

vi.mock('@/lib/apiClient', () => ({
  listFactoringItems: vi.fn(),
  // Still mocked: the hook must not reach for it, and a missing export would hide that.
  updateFactoringItem: vi.fn(),
  deleteFactoringItem: vi.fn(),
}))

const item = (overrides: Partial<FactoringItem> = {}): FactoringItem => ({
  id: 'PRO-001',
  proNumber: 'PRO-001',
  status: 'NEED_TO_FACTOR',
  subject: 'Invoice for PRO #PRO-001',
  fromEmail: 'billing@example.com',
  receivedAt: '2026-09-23T10:00:00Z',
  messageId: '<msg-1@example.com>',
  createdAt: '2026-09-23T10:00:00Z',
  updatedAt: '2026-09-23T10:00:00Z',
  ...overrides,
})

describe('useFactoringItems', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('loads and polls every 30 seconds', async () => {
    vi.mocked(listFactoringItems).mockResolvedValue([item()])

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.items).toHaveLength(1)
    expect(result.current.error).toBeNull()

    const polled = item({ id: 'PRO-002', proNumber: 'PRO-002', subject: 'Second invoice' })
    vi.mocked(listFactoringItems).mockResolvedValue([item(), polled])

    act(() => vi.advanceTimersByTime(30_000))
    await waitFor(() => expect(result.current.items).toHaveLength(2))
  })

  it('removes a server-deleted row on refresh without reloading the page', async () => {
    vi.mocked(listFactoringItems).mockResolvedValue([item()])
    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.items.map((row) => row.id)).toEqual(['PRO-001']))

    vi.mocked(listFactoringItems).mockResolvedValue([])
    await act(async () => result.current.refresh())
    expect(result.current.items).toEqual([])
  })

  /**
   * There is no status setter, on purpose.
   *
   * A factoring row's status is a fact about the invoice, not a label somebody applies. It
   * has exactly three causes: the intake creates the row as NEED_TO_FACTOR, submitting to
   * OTR sets PENDING_WITH_OTR as part of creating the invoice, and the status sync sets
   * FACTORED when OTR's board says Paid.
   *
   * The optimistic-update machinery that used to live here existed only to make a dropdown
   * feel quick — a dropdown that let a row read "Pending with OTR" having never been
   * submitted, or "Factored" against money nobody had been paid.
   */
  it('offers no way to set a status by hand', async () => {
    vi.mocked(listFactoringItems).mockResolvedValue([item()])
    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect('updateStatus' in result.current).toBe(false)
    expect(Object.keys(result.current)).toEqual(
      expect.arrayContaining(['items', 'loading', 'error', 'pendingIds', 'refresh', 'removeItem']),
    )
  })


  it('surfaces fetch errors without clearing existing items', async () => {
    vi.mocked(listFactoringItems)
      .mockResolvedValueOnce([item()])
      .mockRejectedValueOnce(new Error('AppSync down'))

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.error).toBeTruthy()

    expect(result.current.items).toHaveLength(1)
  })

  it('leaves the row visible when delete fails', async () => {
    const initial = item()
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    vi.mocked(deleteFactoringItem).mockRejectedValue(new Error('AppSync denied'))

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)

    await expect(
      act(async () => result.current.removeItem(initial.id)),
    ).rejects.toThrow('AppSync denied')

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe(initial.id)
    expect(result.current.pendingIds.has(initial.id)).toBe(false)
  })

  it('does not resurrect a deleted row from a stale poll, but allows a later forward with the same PRO', async () => {
    const initial = item({ updatedAt: '2026-09-23T10:00:00Z' })
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    vi.mocked(deleteFactoringItem).mockResolvedValue(undefined)

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)

    await act(async () => {
      await result.current.removeItem(initial.id)
    })

    expect(result.current.items).toHaveLength(0)
    expect(result.current.pendingIds.has(initial.id)).toBe(false)

    // A poll that started before the delete returns the old row.
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.items).toHaveLength(0)

    // A genuinely new forward arrives with the same PRO but a newer updatedAt.
    const recreated = item({
      updatedAt: '2026-09-23T12:00:00Z',
      subject: 'Re-forwarded invoice for PRO #PRO-001',
    })
    vi.mocked(listFactoringItems).mockResolvedValue([recreated])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].subject).toBe('Re-forwarded invoice for PRO #PRO-001')
  })
})
