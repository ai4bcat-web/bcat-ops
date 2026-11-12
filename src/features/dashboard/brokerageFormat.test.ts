import { describe, expect, it } from 'vitest'
import { FIRST_MONTH, clampRange } from './brokerageFormat'

describe('Brokerage range start', () => {
  it('starts at October 2026, the new system data start', () => {
    expect(FIRST_MONTH).toBe('2026-10')
  })

  it('clamps a trailing 12-month range to October', () => {
    expect(clampRange({ from: '2025-11', to: '2026-11' }, '2026-11')).toEqual({ from: '2026-10', to: '2026-11' })
  })

  it('leaves a range inside the data alone and clamps a picked earlier month', () => {
    expect(clampRange({ from: '2026-11', to: '2026-11' }, '2026-11')).toEqual({ from: '2026-11', to: '2026-11' })
    expect(clampRange({ from: '2024-01', to: '2026-10' }, '2026-11')).toEqual({ from: '2026-10', to: '2026-10' })
  })
})
