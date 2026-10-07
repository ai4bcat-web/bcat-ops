// @vitest-environment jsdom
/**
 * A failed /me must surface as itself. The old hook silently answered SETTLEMENT, which
 * put an Ivan driver on a page that could only ever 409 — and hid the real refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const fetchMe = vi.fn()
vi.mock('./driverApi', () => ({ fetchMe: () => fetchMe() }))

async function fresh() {
  vi.resetModules()
  vi.doMock('./driverApi', () => ({ fetchMe: () => fetchMe() }))
  return await import('./useDriverProgram')
}

beforeEach(() => { fetchMe.mockReset() })

describe('useDriverProgramStatus', () => {
  it('reports the program /me returns', async () => {
    fetchMe.mockResolvedValue({ program: 'PAPERWORK' })
    const m = await fresh()
    const { result } = renderHook(() => m.useDriverProgramStatus())
    expect(result.current).toMatchObject({ program: null, error: null })
    await waitFor(() => expect(result.current.program).toBe('PAPERWORK'))
    expect(result.current.error).toBeNull()
  })

  it('exposes the server message when /me fails, and does NOT default to SETTLEMENT', async () => {
    fetchMe.mockRejectedValue(new Error('Driver not found'))
    const m = await fresh()
    const { result } = renderHook(() => m.useDriverProgramStatus())
    await waitFor(() => expect(result.current.error).toBe('Driver not found'))
    expect(result.current.program).toBeNull()
    expect(m.useDriverProgram).toBeDefined()
  })

  it('retry re-asks /me and clears the error on success', async () => {
    fetchMe.mockRejectedValueOnce(new Error('Internal error')).mockResolvedValueOnce({ program: 'PAPERWORK' })
    const m = await fresh()
    const { result } = renderHook(() => m.useDriverProgramStatus())
    await waitFor(() => expect(result.current.error).toBe('Internal error'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.program).toBe('PAPERWORK'))
    expect(result.current.error).toBeNull()
    expect(fetchMe).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight call across every subscriber', async () => {
    let resolve!: (v: unknown) => void
    fetchMe.mockReturnValue(new Promise((r) => { resolve = r }))
    const m = await fresh()
    const a = renderHook(() => m.useDriverProgramStatus())
    const b = renderHook(() => m.useDriverProgram())
    expect(fetchMe).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ program: 'SETTLEMENT' }) })
    await waitFor(() => expect(a.result.current.program).toBe('SETTLEMENT'))
    expect(b.result.current).toBe('SETTLEMENT')
  })
})
