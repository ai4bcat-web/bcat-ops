import { describe, expect, it } from 'vitest'
import { HOURS_HIDDEN_KEY, defaultHiddenDriverIds, isHiddenByDefault, loadHiddenDriverIds, readSavedHiddenIds, saveHiddenDriverIds, toggleHidden } from './hoursDriverFilter'

const drivers = [
  { id: 'a', name: 'Charles Best' },
  { id: 'b', name: 'Daniel Palmer' },
  { id: 'c', name: 'Ryne Test' },
  { id: 'd', name: 'John Brittich' },
]

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

describe('hours driver filter', () => {
  it('hides Dan Palmer and Ryne Test by default, nobody else', () => {
    expect(isHiddenByDefault('Ryne Test')).toBe(true)
    expect(isHiddenByDefault('  daniel   palmer ')).toBe(true)
    expect(isHiddenByDefault('Dan Palmer')).toBe(true)
    expect(isHiddenByDefault('Charles Best')).toBe(false)
    expect(defaultHiddenDriverIds(drivers)).toEqual(['b', 'c'])
  })
  it('uses the default when nothing is saved or storage is unusable', () => {
    expect(loadHiddenDriverIds(drivers, mem())).toEqual(['b', 'c'])
    expect(loadHiddenDriverIds(drivers, null)).toEqual(['b', 'c'])
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(loadHiddenDriverIds(drivers, broken)).toEqual(['b', 'c'])
  })
  it('remembers the viewer choice, including showing everyone', () => {
    const s = mem()
    expect(readSavedHiddenIds(s)).toBeNull()
    saveHiddenDriverIds([], s)
    expect(s.getItem(HOURS_HIDDEN_KEY)).toBe('[]')
    expect(loadHiddenDriverIds(drivers, s)).toEqual([])
    saveHiddenDriverIds(['a'], s)
    expect(loadHiddenDriverIds(drivers, s)).toEqual(['a'])
  })
  it('toggles one driver at a time', () => {
    expect(toggleHidden(['b'], 'c')).toEqual(['b', 'c'])
    expect(toggleHidden(['b', 'c'], 'b')).toEqual(['c'])
  })
})
