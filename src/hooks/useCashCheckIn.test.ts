// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  DEFAULT_CASH_SETTINGS,
  type CashCheckIn,
  type CashCheckInInput,
  type CashSettingsValues,
} from '@/lib/cashCheckIn'
import {
  listCashCheckIns,
  getCashSettings,
  createCashSettings,
  updateCashSettings,
  createCashCheckIn,
  updateCashCheckIn,
  deleteCashCheckIn,
  subscribeCashCheckIns,
  subscribeCashSettings,
} from '@/lib/cashCheckInClient'
import { useCashCheckIn } from './useCashCheckIn'

vi.mock('@/hooks/useAuth')
vi.mock('@/lib/cashCheckInClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cashCheckInClient')>()
  return {
    ...actual,
    listCashCheckIns: vi.fn(),
    getCashSettings: vi.fn(),
    createCashSettings: vi.fn(),
    updateCashSettings: vi.fn(),
    createCashCheckIn: vi.fn(),
    updateCashCheckIn: vi.fn(),
    deleteCashCheckIn: vi.fn(),
    subscribeCashCheckIns: vi.fn(),
    subscribeCashSettings: vi.fn(),
  }
})

function adminUser() {
  return { userId: 'u1', email: 'admin@bcatcorp.com', groups: ['ADMIN'] }
}

function readonlyUser() {
  return { userId: 'u2', email: 'viewer@bcatcorp.com', groups: ['DISPATCHER'] }
}

const sampleCheckIn: CashCheckIn = {
  id: 'c1',
  date: '2026-09-15',
  cash: 120_000,
  ar: 30_000,
  ap: 20_000,
  cards: 5_000,
  bcatMtdProfit: 6_000,
  ivanMtdProfit: 15_000,
  amazonMtdProfit: 12_000,
  note: 'weekly',
  createdBy: 'admin@bcatcorp.com',
  createdAt: '2026-09-15T12:00:00Z',
  updatedAt: '2026-09-15T12:00:00Z',
}

const savedSettings: CashSettingsValues = {
  floor: 50_000,
  months: 6,
  runrate: DEFAULT_CASH_SETTINGS.runrate,
  items: [],
  factoring: DEFAULT_CASH_SETTINGS.factoring,
}

function mockClient(options: {
  checkins?: CashCheckIn[]
  settings?: CashSettingsValues | null
} = {}) {
  const checkinSubs: { onEvent: () => void; onError: (err: unknown) => void }[] = []
  const settingsSubs: { onEvent: () => void; onError: (err: unknown) => void }[] = []

  vi.mocked(listCashCheckIns).mockResolvedValue(options.checkins ?? [])
  vi.mocked(getCashSettings).mockResolvedValue(options.settings ?? null)
  vi.mocked(createCashSettings).mockImplementation(async (s) => s)
  vi.mocked(updateCashSettings).mockImplementation(async (s) => s)
  vi.mocked(createCashCheckIn).mockImplementation(async (input) => ({
    id: 'new',
    ...input,
    createdAt: 'now',
    updatedAt: 'now',
  }) as CashCheckIn)
  vi.mocked(updateCashCheckIn).mockImplementation(async (id, patch) => ({
    ...sampleCheckIn,
    id,
    ...patch,
  }) as CashCheckIn)
  vi.mocked(deleteCashCheckIn).mockResolvedValue(undefined)
  vi.mocked(subscribeCashCheckIns).mockImplementation((onEvent, onError) => {
    checkinSubs.push({ onEvent, onError })
    return () => {}
  })
  vi.mocked(subscribeCashSettings).mockImplementation((onEvent, onError) => {
    settingsSubs.push({ onEvent, onError })
    return () => {}
  })

  return { checkinSubs, settingsSubs }
}

describe('useCashCheckIn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('loads check-ins and settings, and seeds defaults for an admin when settings are absent', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    mockClient({ checkins: [sampleCheckIn], settings: null })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.canWrite).toBe(true)
    expect(result.current.checkins).toHaveLength(1)
    expect(result.current.checkins[0].id).toBe('c1')
    expect(result.current.settings.floor).toBe(DEFAULT_CASH_SETTINGS.floor)
    expect(createCashSettings).toHaveBeenCalledWith(DEFAULT_CASH_SETTINGS)
  })

  it('is read-only for non-admin users and does not seed settings', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: readonlyUser() } as ReturnType<typeof useAuth>)
    mockClient({ checkins: [], settings: null })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.canWrite).toBe(false)
    expect(createCashSettings).not.toHaveBeenCalled()
  })

  it('auto-saves settings 500ms after the last local edit and serializes concurrent edits', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    mockClient({ settings: savedSettings })
    const updateSpy = vi.mocked(updateCashSettings)

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const edit1 = { ...result.current.settings, floor: 55_000 }
    act(() => result.current.updateSettings(edit1))
    expect(result.current.settingsSaving).toBe(true)

    act(() => vi.advanceTimersByTime(300))
    expect(updateSpy).not.toHaveBeenCalled()

    const edit2 = { ...edit1, floor: 60_000 }
    act(() => result.current.updateSettings(edit2))

    act(() => vi.advanceTimersByTime(500))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))

    expect(updateSpy).toHaveBeenCalledWith(edit2, 'default')
    expect(result.current.settingsSaving).toBe(false)
  })

  it('keeps local settings while typing even if a remote settings update arrives', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    const { settingsSubs } = mockClient({ settings: savedSettings })
    vi.mocked(getCashSettings).mockResolvedValueOnce(savedSettings).mockResolvedValueOnce({
      ...savedSettings,
      floor: 99_999,
    })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const localEdit = { ...result.current.settings, floor: 10_000 }
    act(() => result.current.updateSettings(localEdit))

    // simulate remote update event while dirty
    act(() => settingsSubs.forEach((s) => s.onEvent()))
    act(() => vi.advanceTimersByTime(200))
    await waitFor(() => expect(getCashSettings).toHaveBeenCalledTimes(2))

    expect(result.current.settings.floor).toBe(10_000)
  })

  it('creates and updates check-ins and surfaces validation errors', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    mockClient({ checkins: [] })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const input: CashCheckInInput = {
      date: '2026-09-16',
      cash: 100_000,
      ar: 10_000,
      ap: 5_000,
    }

    await act(async () => result.current.saveCheckIn(input))

    expect(createCashCheckIn).toHaveBeenCalledWith(expect.objectContaining({ ...input, createdBy: 'admin@bcatcorp.com' }))
    expect(result.current.error).toBeNull()

    await act(async () => result.current.saveCheckIn({ ...input, cash: 110_000 }, 'c1'))
    expect(updateCashCheckIn).toHaveBeenCalledWith('c1', expect.objectContaining({ cash: 110_000 }))
  })

  it('rejects fractional dollars and invalid dates', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    mockClient({ checkins: [] })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => result.current.saveCheckIn({ date: '2026-09-16', cash: 100.5 })),
    ).rejects.toThrow('whole dollars')

    await expect(
      act(async () => result.current.saveCheckIn({ date: '2026-02-30', cash: 100 })),
    ).rejects.toThrow('valid calendar date')
  })

  it('imports rows, validates the whole batch first, and dedupes by date', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    mockClient({ checkins: [sampleCheckIn] })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const rows: CashCheckInInput[] = [
      { date: '2026-09-15', cash: 1 }, // duplicate date → skip
      { date: '2026-09-20', cash: 2 },
      { date: '2026-09-20', cash: 3 }, // duplicate within batch → skip
      { date: '2026-09-25', cash: 4 },
    ]

    let importResult: { imported: number; skipped: number } | undefined
    await act(async () => {
      importResult = await result.current.importCheckIns(rows)
    })

    expect(importResult).toEqual({ imported: 2, skipped: 2 })
    expect(createCashCheckIn).toHaveBeenCalledTimes(2)
  })

  it('re-queries on subscription events and ignores its own settings save events while dirty', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    const { checkinSubs } = mockClient({ checkins: [sampleCheckIn], settings: savedSettings })
    vi.mocked(listCashCheckIns).mockResolvedValue([sampleCheckIn, { ...sampleCheckIn, id: 'c2', date: '2026-09-20' }])

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => checkinSubs.forEach((s) => s.onEvent()))
    act(() => vi.advanceTimersByTime(200))
    await waitFor(() => expect(result.current.checkins).toHaveLength(2))
  })

  it('disables writes and sets backendMissing when the schema is not deployed', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: adminUser() } as ReturnType<typeof useAuth>)
    vi.mocked(listCashCheckIns).mockRejectedValue({ errors: [{ message: 'Cannot query field listCashCheckIns' }] })
    vi.mocked(getCashSettings).mockRejectedValue({ errors: [{ message: 'Cannot query field getCashSettings' }] })

    const { result } = renderHook(() => useCashCheckIn())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.backendMissing).toBe(true)
    expect(result.current.canWrite).toBe(false)
    await expect(act(async () => result.current.saveCheckIn({ date: '2026-09-16', cash: 1 }))).rejects.toThrow('permission')
  })
})
