// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  rankDetailOptions,
  readRecent,
  pushRecent,
  type DetailOption,
} from './detailSearch'

const OPTIONS: DetailOption[] = [
  { value: 'c1', label: 'Acme Trucking', count: 10 },
  { value: 'c2', label: 'Beta Lines', count: 8 },
  { value: 'c3', label: 'Kansas Carriers', count: 6, codes: ['KS'] },
  { value: 'c4', label: 'Gamma Transport', count: 4 },
  { value: 'c5', label: 'Delta Freight', count: 3 },
  { value: 'c6', label: 'Epsilon Hauling', count: 2 },
  { value: 'c7', label: 'Zeta Logistics', count: 1 },
  { value: 'c8', label: 'Eta Moving', count: 1 },
  { value: 'c9', label: 'Iota Shipping', count: 1 },
]

describe('rankDetailOptions', () => {
  it('returns recently-used values first when the query is empty', () => {
    const result = rankDetailOptions(OPTIONS, '', ['c4', 'c2'], 5)
    expect(result.map((o) => o.value)).toEqual(['c4', 'c2', 'c1', 'c3', 'c5'])
  })

  it('returns nothing on empty query when there are no recents', () => {
    const result = rankDetailOptions(OPTIONS, '', [], 4)
    expect(result).toEqual([])
  })

  it('fills remaining empty-query slots with top-by-count options after recents', () => {
    const result = rankDetailOptions(OPTIONS, '', ['c9'], 4)
    expect(result[0].value).toBe('c9')
    expect(result.slice(1).map((o) => o.value)).toEqual(['c1', 'c2', 'c3'])
  })

  it('caps results at the limit, defaulting to 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      label: `Carrier ${i}`,
      count: 20 - i,
      codes: [] as string[],
    }))
    const result = rankDetailOptions(many, 'carrier', [], undefined)
    expect(result).toHaveLength(8)
  })

  it('ranks exact code matches first', () => {
    const result = rankDetailOptions(OPTIONS, 'KS', [], 4)
    expect(result[0].value).toBe('c3')
  })

  it('matches label prefix before label substring', () => {
    // "ac" matches "Acme" (prefix) and "Gamma" / "Delta" (substring).
    const result = rankDetailOptions(OPTIONS, 'ac', [], 4)
    expect(result[0].value).toBe('c1')
  })

  it('matches a state code option by its code array', () => {
    const result = rankDetailOptions(OPTIONS, 'KS', [], 4)
    expect(result.map((o) => o.value)).toContain('c3')
  })

  it('matches labels case-insensitively', () => {
    const result = rankDetailOptions(OPTIONS, 'BETA', [], 4)
    expect(result[0].value).toBe('c2')
  })

  it('ties are broken by count descending', () => {
    const result = rankDetailOptions(OPTIONS, 'a', [], 8)
    // 'Acme' (10) and 'Gamma' (4) both contain 'a'; Acme should win.
    expect(result[0].value).toBe('c1')
  })

  it('limits a non-empty query to the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      label: `Carrier ${i}`,
      count: 20 - i,
    }))
    const result = rankDetailOptions(many, 'carrier', [], 8)
    expect(result).toHaveLength(8)
  })
})

describe('recent persistence', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.clear()
    }
  })

  it('reads an empty list when nothing is stored', () => {
    expect(readRecent('test-key-empty', 'customer')).toEqual([])
  })

  it('pushes a value to the front and dedups', () => {
    pushRecent('test-key-dedup', 'customer', 'c1')
    pushRecent('test-key-dedup', 'customer', 'c2')
    pushRecent('test-key-dedup', 'customer', 'c1')
    expect(readRecent('test-key-dedup', 'customer')).toEqual(['c1', 'c2'])
  })

  it('caps recents at 8 values', () => {
    for (let i = 1; i <= 10; i++) {
      pushRecent('test-key-cap', 'customer', `c${i}`)
    }
    expect(readRecent('test-key-cap', 'customer')).toHaveLength(8)
    expect(readRecent('test-key-cap', 'customer')[0]).toBe('c10')
  })

  it('returns an empty list on SSR', () => {
    const savedWindow = globalThis.window
    const savedDocument = globalThis.document
    // @ts-expect-error simulate SSR
    delete globalThis.window
    // @ts-expect-error simulate SSR
    delete globalThis.document
    expect(readRecent('test-key-ssr', 'customer')).toEqual([])
    pushRecent('test-key-ssr', 'customer', 'c1')
    expect(readRecent('test-key-ssr', 'customer')).toEqual([])
    globalThis.window = savedWindow
    globalThis.document = savedDocument
  })
})
