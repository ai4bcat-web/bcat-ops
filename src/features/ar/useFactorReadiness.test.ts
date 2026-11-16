// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArQueueRow } from './arQueue'

const mocks = vi.hoisted(() => ({ preview: vi.fn(), assemble: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ previewFactorReady: mocks.preview, graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : '') }))
vi.mock('@/lib/otrClient', () => ({ assembleInvoice: mocks.assemble }))

import { useFactorReadiness } from './useFactorReadiness'

const queueRow = (n: string) => ({ key: `factor:${n}`, orderId: `factor:${n}`, factorItem: { id: n, otrInvoiceId: null, otrError: null } }) as unknown as ArQueueRow

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('useFactorReadiness', () => {
  it('lands each queue row as its own check answers, so one slow row does not hold the rest', async () => {
    mocks.assemble.mockImplementation((id: string) => (id === 'slow' ? new Promise(() => {}) : Promise.resolve({ missingFields: [], missingDocuments: [] })))
    const rows = [queueRow('fast'), queueRow('slow')]
    const { result } = renderHook(() => useFactorReadiness(rows, true))
    await waitFor(() => expect(result.current.get('factor:fast')?.ready).toBe(true))
    expect(result.current.has('factor:slow')).toBe(false)
  })

  it('gives up on a check that never answers and says so, instead of staying on "Checking…"', async () => {
    mocks.assemble.mockReturnValue(new Promise(() => {}))
    const rows = [queueRow('stuck')]
    const { result } = renderHook(() => useFactorReadiness(rows, true))
    await act(async () => { await vi.advanceTimersByTimeAsync(26_000) })
    const r = result.current.get('factor:stuck')
    expect(r?.ready).toBe(false)
    expect(r?.missing[0]).toMatch(/Could not check/)
  })

  it('a queue row with its rate con and POD (no ZIPs) is ready', async () => {
    mocks.assemble.mockResolvedValue({ missingFields: [], missingDocuments: [] })
    const rows = [queueRow('ok')]
    const { result } = renderHook(() => useFactorReadiness(rows, true))
    await waitFor(() => expect(result.current.get('factor:ok')).toEqual({ factorBilled: true, ready: true, missing: [] }))
  })
})
