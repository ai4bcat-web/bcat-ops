// @vitest-environment jsdom
/**
 * The remembered driver selection.
 *
 * Split from driverFilter.test.ts because the rest of that module is pure and deserves to
 * stay testable without a DOM. These five need a real localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readStoredDriverIds, writeStoredDriverIds, DRIVER_FILTER_KEYS } from './driverFilter'

describe('the remembered selection', () => {
  beforeEach(() => window.localStorage.clear())

  it('round-trips a selection', () => {
    writeStoredDriverIds(DRIVER_FILTER_KEYS.loads, ['ivan-1', 'oo-1'])
    expect(readStoredDriverIds(DRIVER_FILTER_KEYS.loads)).toEqual(['ivan-1', 'oo-1'])
  })

  it('keeps the two pages apart — they answer different questions', () => {
    writeStoredDriverIds(DRIVER_FILTER_KEYS.loads, ['oo-1'])
    expect(readStoredDriverIds(DRIVER_FILTER_KEYS.calendar)).toBeNull()
  })

  it('remembers an empty selection as a real choice, not as nothing chosen', () => {
    // null means "never chose"; [] means "chose nobody". The page defaults on the first
    // and shows an empty grid on the second.
    writeStoredDriverIds(DRIVER_FILTER_KEYS.loads, [])
    expect(readStoredDriverIds(DRIVER_FILTER_KEYS.loads)).toEqual([])
  })

  it('falls back to nothing chosen when the stored value is junk', () => {
    window.localStorage.setItem(DRIVER_FILTER_KEYS.loads, '{not json')
    expect(readStoredDriverIds(DRIVER_FILTER_KEYS.loads)).toBeNull()
  })

  it('drops non-string entries rather than trusting them as ids', () => {
    window.localStorage.setItem(DRIVER_FILTER_KEYS.loads, JSON.stringify(['ivan-1', 7, null]))
    expect(readStoredDriverIds(DRIVER_FILTER_KEYS.loads)).toEqual(['ivan-1'])
  })
})
