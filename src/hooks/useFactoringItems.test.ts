// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { listFactoringItems, updateFactoringItem } from '@/lib/apiClient'
import { useFactoringItems } from './useFactoringItems'
import type { FactoringItem } from '@/types'

vi.mock('@/lib/apiClient', () => ({
  listFactoringItems: vi.fn(),
  updateFactoringItem: vi.fn(),
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

  it('keeps a pending item optimistic and reverts on failure', async () => {
    const initial = item()
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    vi.mocked(updateFactoringItem).mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => result.current.updateStatus(initial.id, 'PENDING_WITH_OTR')),
    ).rejects.toThrow('Network error')

    expect(result.current.items[0].status).toBe('NEED_TO_FACTOR')
    expect(result.current.pendingIds.has(initial.id)).toBe(false)
  })

  it('does not overwrite a pending status during a background poll', async () => {
    const initial = item()
    const serverUpdated = item({ status: 'FACTORED' })
    vi.mocked(listFactoringItems)
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([serverUpdated])

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Start a mutation but don't let it finish before the poll fires.
    let resolveUpdate: (value: FactoringItem) => void
    const updatePromise = new Promise<FactoringItem>((resolve) => {
      resolveUpdate = resolve
    })
    vi.mocked(updateFactoringItem).mockReturnValue(updatePromise)

    act(() => {
      void result.current.updateStatus(initial.id, 'PENDING_WITH_OTR')
    })

    expect(result.current.items[0].status).toBe('PENDING_WITH_OTR')
    expect(result.current.pendingIds.has(initial.id)).toBe(true)

    // Poll returns the old server status while the mutation is still pending.
    act(() => vi.advanceTimersByTime(30_000))
    await waitFor(() => expect(listFactoringItems).toHaveBeenCalledTimes(2))

    // The optimistic value must survive the poll.
    expect(result.current.items[0].status).toBe('PENDING_WITH_OTR')

    // Once the mutation resolves, the server value takes over.
    act(() => resolveUpdate(item({ status: 'PENDING_WITH_OTR' })))
    await waitFor(() => expect(result.current.pendingIds.has(initial.id)).toBe(false))
    expect(result.current.items[0].status).toBe('PENDING_WITH_OTR')
  })

  it('ignores stale poll results after a confirmed status update', async () => {
    const initial = item({ status: 'NEED_TO_FACTOR', updatedAt: '2026-09-23T10:00:00Z' })
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    const updated = item({ status: 'PENDING_WITH_OTR', updatedAt: '2026-09-23T11:00:00Z' })
    vi.mocked(updateFactoringItem).mockResolvedValue(updated)

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateStatus(initial.id, 'PENDING_WITH_OTR')
    })
    await waitFor(() => expect(result.current.items[0].status).toBe('PENDING_WITH_OTR'))
    expect(result.current.items[0].updatedAt).toBe('2026-09-23T11:00:00Z')

    // A later poll returns the pre-mutation snapshot.
    vi.mocked(listFactoringItems).mockResolvedValue([initial])
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.items[0].status).toBe('PENDING_WITH_OTR')
  })

  it('preserves newly arrived rows while another item is pending', async () => {
    const initial = item()
    const newRow = item({
      id: 'PRO-002',
      proNumber: 'PRO-002',
      subject: 'Invoice for PRO #PRO-002',
      status: 'NEED_TO_FACTOR',
    })
    vi.mocked(listFactoringItems)
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([initial, newRow])

    const { result } = renderHook(() => useFactoringItems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let resolveUpdate: (value: FactoringItem) => void
    const updatePromise = new Promise<FactoringItem>((resolve) => {
      resolveUpdate = resolve
    })
    vi.mocked(updateFactoringItem).mockReturnValue(updatePromise)

    act(() => {
      void result.current.updateStatus(initial.id, 'PENDING_WITH_OTR')
    })

    act(() => vi.advanceTimersByTime(30_000))
    await waitFor(() => expect(listFactoringItems).toHaveBeenCalledTimes(2))

    expect(result.current.items).toHaveLength(2)
    expect(result.current.items.find((i) => i.id === initial.id)?.status).toBe('PENDING_WITH_OTR')
    expect(result.current.items.find((i) => i.id === newRow.id)?.proNumber).toBe('PRO-002')

    act(() => resolveUpdate(item({ status: 'PENDING_WITH_OTR' })))
    await waitFor(() => expect(result.current.pendingIds.has(initial.id)).toBe(false))
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
})
