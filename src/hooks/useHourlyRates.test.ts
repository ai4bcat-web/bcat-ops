// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listDriverPaySettings: vi.fn(),
  createDriverPaySetting: vi.fn(),
  updateDriverPaySetting: vi.fn(),
  createAuditLog: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

const { useHourlyRates } = await import('./useHourlyRates')

const setting = (over: Record<string, unknown> = {}) =>
  ({ id: 'ps-1', driverId: 'd1', payGroup: 'LOCAL', payPercent: 0, expensesBeforePercent: false, hourlyRate: null, hourlyRateHistory: [], updatedAt: '2026-11-01T00:00:00Z', createdAt: '', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  api.listDriverPaySettings.mockResolvedValue([])
  api.createAuditLog.mockResolvedValue(undefined)
  api.createDriverPaySetting.mockImplementation(async (i) => ({ ...i, id: 'new', updatedAt: 't', createdAt: '' }))
  api.updateDriverPaySetting.mockImplementation(async (id, patch) => ({ id, driverId: 'd1', ...patch, updatedAt: 't2', createdAt: '' }))
})

describe('useHourlyRates first save', () => {
  it('reuses a row that appeared after the page loaded instead of creating a duplicate', async () => {
    const { result } = renderHook(() => useHourlyRates(true, 'ryne@bcatcorp.com'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // Another tab made d1's row since this page loaded.
    api.listDriverPaySettings.mockResolvedValue([setting()])
    await act(async () => { await result.current.saveRate('d1', 21, '2026-10-12') })
    expect(api.createDriverPaySetting).not.toHaveBeenCalled()
    expect(api.updateDriverPaySetting).toHaveBeenCalledWith('ps-1', expect.objectContaining({ hourlyRate: 21 }), '2026-11-01T00:00:00Z')
  })

  it('creates the row only when the fresh look finds none', async () => {
    const { result } = renderHook(() => useHourlyRates(true, 'ryne@bcatcorp.com'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => { await result.current.saveRate('d1', 21, '2026-10-12') })
    expect(api.createDriverPaySetting).toHaveBeenCalledTimes(1)
    expect(api.updateDriverPaySetting).not.toHaveBeenCalled()
  })

  it('a second save for the same driver while one is in flight is refused, so only one row is written', async () => {
    let release: (v: unknown) => void = () => {}
    api.createDriverPaySetting.mockImplementation(() => new Promise((r) => { release = r }))
    const { result } = renderHook(() => useHourlyRates(true, 'ryne@bcatcorp.com'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let first: Promise<unknown> = Promise.resolve()
    let second: unknown
    await act(async () => {
      first = result.current.saveRate('d1', 21, '2026-10-12')
      second = await result.current.saveRate('d1', 21, '2026-10-12').catch((e: Error) => e.message)
    })
    expect(second).toMatch(/already being saved/)
    await act(async () => { release({ id: 'new', driverId: 'd1', hourlyRate: 21, hourlyRateHistory: [], updatedAt: 't', createdAt: '' }); await first })
    expect(api.createDriverPaySetting).toHaveBeenCalledTimes(1)
  })

  it('refuses to save while the rates failed to load, and not at all without pay access', async () => {
    api.listDriverPaySettings.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useHourlyRates(true, 'r'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/boom/)
    await expect(result.current.saveRate('d1', 21, '2026-10-12')).rejects.toThrow(/not loaded yet/)
    const off = renderHook(() => useHourlyRates(false, 'r'))
    expect(off.result.current.status).toBe('off')
    expect(api.listDriverPaySettings).toHaveBeenCalledTimes(1)
    await expect(off.result.current.saveRate('d1', 21, '2026-10-12')).rejects.toThrow(/access/)
  })
})
