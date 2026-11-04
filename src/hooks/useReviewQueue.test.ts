// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const client = vi.hoisted(() => ({
  listComplianceDocumentsByStatus: vi.fn(async () => []),
  listApplicationsByStatus: vi.fn(async () => []),
  listOnboardingTasks: vi.fn(),
  updateDriverApplication: vi.fn(),
  setTaskStatus: vi.fn(),
  updateOnboardingTask: vi.fn(),
  writeComplianceAudit: vi.fn(),
  sendOnboardingEmail: vi.fn(),
}))
vi.mock('@/lib/complianceClient', () => client)
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'ops@bcatcorp.com' } }) }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (s: unknown) => unknown) => select({ drivers: [], updateDriver: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { resetReviewQueueForTests, useReviewQueue } from './useReviewQueue'

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
const reads = () => client.listApplicationsByStatus.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetReviewQueueForTests()
  setVisibility('visible')
})
afterEach(() => {
  vi.useRealTimers()
  setVisibility('visible')
})

describe('useReviewQueue', () => {
  it('shares one fetch and one 60 s interval between every mounted copy', async () => {
    const a = renderHook(() => useReviewQueue())
    const b = renderHook(() => useReviewQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(reads()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(reads()).toBe(2)
    // A copy leaving keeps the poll for the one that remains; the last one leaving stops it.
    a.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(reads()).toBe(3)
    b.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(reads()).toBe(3)
  })

  it('does not poll while the tab is hidden and catches up once when it is shown again', async () => {
    renderHook(() => useReviewQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(reads()).toBe(1)
    setVisibility('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(reads()).toBe(1)
    setVisibility('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reads()).toBe(2)
  })
})
