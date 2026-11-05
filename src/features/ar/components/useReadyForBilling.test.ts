// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ArWorklistRow } from '@/hooks/useArWorklist'

const previewInvoice = vi.fn()
vi.mock('@/lib/apiClient', () => ({ previewInvoice: (...a: unknown[]) => previewInvoice(...a) }))

const { useReadyForBilling } = await import('./useReadyForBilling')

const row = (orderId: string) => ({ orderId, order: { updatedAt: 'x' } }) as unknown as ArWorklistRow

describe('useReadyForBilling', () => {
  beforeEach(() => { previewInvoice.mockReset(); previewInvoice.mockResolvedValue({ releaseGate: { ok: true, missing: [] } }) })

  it('reads no gate until the tab is open, then once per order, and not again on a re-open', async () => {
    const rows = [row('a'), row('b')]
    const { result, rerender } = renderHook(({ on }) => useReadyForBilling(rows, on), { initialProps: { on: false } })
    expect(previewInvoice).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)

    rerender({ on: true })
    await waitFor(() => expect(result.current.rows.every((r) => r.gate != null)).toBe(true))
    expect(previewInvoice).toHaveBeenCalledTimes(2)

    rerender({ on: false })
    rerender({ on: true })
    expect(previewInvoice).toHaveBeenCalledTimes(2)
    expect(result.current.rows.every((r) => r.gate != null)).toBe(true)
  })

  it('reads again for a changed row set', async () => {
    const { result, rerender } = renderHook(({ rows }) => useReadyForBilling(rows, true), { initialProps: { rows: [row('a')] } })
    await waitFor(() => expect(result.current.rows[0].gate).toBeTruthy())
    rerender({ rows: [row('a'), row('c')] })
    await waitFor(() => expect(result.current.rows.every((r) => r.gate != null)).toBe(true))
    expect(previewInvoice).toHaveBeenCalledTimes(3)
  })
})
