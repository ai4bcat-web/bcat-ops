// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('@/lib/apiClient', () => ({
  listShipmentColumnTemplates: vi.fn().mockResolvedValue([]),
  saveShipmentColumnTemplate: vi.fn().mockResolvedValue({ updatedAt: '2026-11-24T10:00:00.000Z' }),
}))

import { useDenseGridPrefs, withIntroducedColumns, densePrefsKey, type DensePrefs } from './useDenseGridPrefs'
import { __resetOrgGridDefaults } from './orgGridDefault'

const VALID = ['a', 'customer', 'noBuy', 'z']
const opts = (email: string) => ({
  gridId: 'ar-queue-ready', email, defaultColumns: ['a', 'customer', 'noBuy', 'z'], validKeys: VALID, defaultSort: null,
  introduce: [{ key: 'noBuy', after: 'customer' }],
})
const base = (columns: string[], introduced?: string[]): DensePrefs => ({ columns, widths: {}, pinned: [], density: 'compact', sort: null, groupBy: null, kpiOpen: false, introduced })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  window.localStorage.clear()
  __resetOrgGridDefaults()
})

describe('withIntroducedColumns', () => {
  it('puts the new column right after its anchor and keeps every other choice', () => {
    const next = withIntroducedColumns(base(['z', 'customer', 'a']), [{ key: 'noBuy', after: 'customer' }], VALID)
    expect(next.columns).toEqual(['z', 'customer', 'noBuy', 'a'])
    expect(next.introduced).toEqual(['noBuy'])
  })

  it('appends when the anchor is not shown', () => {
    expect(withIntroducedColumns(base(['a']), [{ key: 'noBuy', after: 'customer' }], VALID).columns).toEqual(['a', 'noBuy'])
  })

  it('does nothing for a column already offered (a person who hid it keeps it hidden)', () => {
    const prefs = base(['a', 'customer'], ['noBuy'])
    expect(withIntroducedColumns(prefs, [{ key: 'noBuy', after: 'customer' }], VALID)).toBe(prefs)
  })

  it('does not double a column the layout already holds, and ignores keys the grid cannot draw', () => {
    const next = withIntroducedColumns(base(['noBuy', 'a']), [{ key: 'noBuy' }, { key: 'gone' }], VALID)
    expect(next.columns).toEqual(['noBuy', 'a'])
    expect(next.introduced).toEqual(['noBuy'])
  })
})

describe('a saved layout and a new column', () => {
  it('shows the column once for a saved layout, then leaves it hidden after the person removes it', async () => {
    const key = densePrefsKey('ar-queue-ready', 'jenny@bcatcorp.com')
    window.localStorage.setItem(key, JSON.stringify({ columns: ['a', 'customer', 'z'], widths: {}, pinned: [] }))
    const h = renderHook(() => useDenseGridPrefs(opts('jenny@bcatcorp.com')))
    await flush()
    expect(h.result.current.columns).toEqual(['a', 'customer', 'noBuy', 'z'])

    act(() => h.result.current.setColumns(['a', 'customer', 'z']))
    await flush()
    expect(h.result.current.columns).toEqual(['a', 'customer', 'z'])

    const again = renderHook(() => useDenseGridPrefs(opts('jenny@bcatcorp.com')))
    await flush()
    expect(again.result.current.columns).toEqual(['a', 'customer', 'z'])
  })

  it('a person with no saved layout gets the defaults, which already hold it', async () => {
    const h = renderHook(() => useDenseGridPrefs(opts('new@bcatcorp.com')))
    await flush()
    expect(h.result.current.columns).toEqual(['a', 'customer', 'noBuy', 'z'])
  })
})
