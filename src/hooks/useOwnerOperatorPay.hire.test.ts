// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const load = (id: string, driverId: string, day: string) => ({
  id, tmsId: id, customer: 'Broker', miles: 100, rate: 100000,
  deliveryAppt: `${day}T17:00:00Z`, deliveryDriverId: driverId,
  originCity: 'Chicago, IL', destinationCity: 'Detroit, MI',
})
const state = vi.hoisted(() => ({
  drivers: [] as Array<Record<string, unknown>>,
  settings: [] as Array<Record<string, unknown>>,
  loads: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/apiClient', () => ({
  listCustomers: () => Promise.resolve([]),
  listLocations: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve(state.settings),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
  listFactoringItems: () => Promise.resolve([]),
}))
vi.mock('@/lib/driverSubmissionsClient', () => ({ listDriverSubmissions: () => Promise.resolve([]) }))
vi.mock('@/lib/podsClient', () => ({ listPods: () => Promise.resolve({ items: [], nextToken: null }) }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: state.loads }), useEnsureLoadRange: () => true }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: state.drivers, updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useOwnerOperatorPay } = await import('./useOwnerOperatorPay')
const { withOwnerOpFrom, withOwnerOpTo } = await import('@/lib/driverPay')

const setting = (driverId: string) => ({
  id: `s-${driverId}`, driverId, payGroup: 'OWNER_OPERATOR', payPercent: 0.88, expensesBeforePercent: false, active: true,
  fixedExpenses: [{ label: 'INSURANCE', amount: 700, from: '2026-01-01' }],
  createdAt: '2026-06-22T00:00:00Z', updatedAt: '2026-06-22T00:00:00Z',
})
const driver = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, type: 'driver', active: true, fleetGroup: 'OWNER_OPERATOR', driverType: 'OWNER_OPERATOR', createdAt: '2026-06-01T00:00:00Z', ...extra,
})

beforeEach(() => { state.drivers = []; state.settings = []; state.loads = [] })

describe('owner operator settlements start at the hire date', () => {
  it('lists a driver already on the page with no hire date for every week, and says the hire date is missing', async () => {
    state.drivers = [driver('old')]
    state.settings = [setting('old')]
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0]).toMatchObject({ noHireDate: true, startsOn: null, payTermsPending: false })
  })

  it('does not list a driver for weeks before the week of their hire date', async () => {
    state.drivers = [driver('new', { hireDate: '2026-10-08' })]
    state.settings = [setting('new')]
    const early = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(early.result.current.loading).toBe(false))
    expect(early.result.current.rows).toHaveLength(0)
    const hireWeek = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(hireWeek.result.current.rows).toHaveLength(1))
    expect(hireWeek.result.current.rows[0]).toMatchObject({ noHireDate: false, startsOn: '2026-10-08' })
  })

  it('leaves out loads delivered before the hire date in the hire week and prorates the weekly charges from that day', async () => {
    state.drivers = [driver('new', { hireDate: '2026-10-08' })]
    state.settings = [setting('new')]
    state.loads = [load('before', 'new', '2026-10-06'), load('after', 'new', '2026-10-09')]
    const { result } = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const row = result.current.rows[0]
    expect(row.trips.map((t) => t.id)).toEqual(['after'])
    // 10/8 to 10/10 is three of the week's seven days: 700 * 3/7 = 300.
    const insurance = row.deductions.find((d) => d.label.startsWith('INSURANCE'))
    expect(insurance?.amount).toBe(300)
  })

  it('lists an owner operator with no pay setting from their hire date at 0%, until pay terms are set', async () => {
    state.drivers = [driver('fresh', { hireDate: '2026-10-08' })]
    const none = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(none.result.current.loading).toBe(false))
    expect(none.result.current.rows).toHaveLength(0)
    expect(none.result.current.unconfigured.map((d) => d.id)).toEqual(['fresh']) // not yet on payroll: the set-up chip, as before
    const week = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(week.result.current.rows).toHaveLength(1))
    expect(week.result.current.rows[0]).toMatchObject({ payTermsPending: true, noHireDate: false, startsOn: '2026-10-08' })
    expect(week.result.current.rows[0].setting.payPercent).toBe(0)
    expect(week.result.current.unconfigured).toHaveLength(0)
  })

  it('lists an owner operator with no setting and no hire date from the day they were set up', async () => {
    state.drivers = [driver('nodate', { createdAt: '2026-10-08T15:00:00Z' })]
    const week = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(week.result.current.rows).toHaveLength(1))
    expect(week.result.current.rows[0]).toMatchObject({ payTermsPending: true, noHireDate: true, startsOn: '2026-10-08' })
  })

  it('does not list inactive drivers or brokers that happen to be marked owner operator', async () => {
    state.drivers = [driver('gone', { active: false }), driver('BROKER COVERED', { type: 'broker' })]
    const { result } = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(0)
  })

  it('starts a driver switched to owner operator on the date they were asked for, over their hire date', async () => {
    const rate = { payPercent: 0.88, expensesBeforePercent: false }
    state.drivers = [driver('moved', { hireDate: '2025-01-06', fleetGroup: 'OWNER_OPERATOR' })]
    state.settings = [{ ...setting('moved'), payGroup: 'LOCAL', rateHistory: withOwnerOpFrom(null, '2026-10-08', rate) }]
    state.loads = [load('before', 'moved', '2026-10-06'), load('after', 'moved', '2026-10-09')]
    const early = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(early.result.current.loading).toBe(false))
    expect(early.result.current.rows).toHaveLength(0)
    const week = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(week.result.current.rows).toHaveLength(1))
    expect(week.result.current.rows[0]).toMatchObject({ startsOn: '2026-10-08', noHireDate: false, payTermsPending: false })
    expect(week.result.current.rows[0].trips.map((t) => t.id)).toEqual(['after'])
    expect(week.result.current.unconfigured).toHaveLength(0) // not also listed as a driver with no setting
  })

  it('stops a driver switched away from owner operator after the last day they were asked for', async () => {
    const rate = { payPercent: 0.88, expensesBeforePercent: false }
    state.drivers = [driver('left', { fleetGroup: 'LOCAL', hireDate: '2025-01-06' })]
    state.settings = [{ ...setting('left'), rateHistory: withOwnerOpTo(null, '2026-10-08', rate) }]
    state.loads = [load('in', 'left', '2026-10-08'), load('out', 'left', '2026-10-09')]
    const week = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(week.result.current.rows).toHaveLength(1))
    expect(week.result.current.rows[0].endsOn).toBe('2026-10-08')
    expect(week.result.current.rows[0].trips.map((t) => t.id)).toEqual(['in'])
    const later = renderHook(() => useOwnerOperatorPay('2026-10-11'))
    await waitFor(() => expect(later.result.current.loading).toBe(false))
    expect(later.result.current.rows).toHaveLength(0)
  })
})
