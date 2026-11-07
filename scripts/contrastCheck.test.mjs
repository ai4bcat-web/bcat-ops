import { describe, expect, it } from 'vitest'
import { evaluate, ratio } from './contrastCheck.mjs'

describe('accent contrast', () => {
  it('computes the WCAG ratio', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })

  it('every accent pair in both themes meets WCAG AA', () => {
    const failing = evaluate().filter((r) => !r.pass).map((r) => `${r.theme}: ${r.label} ${r.ratio.toFixed(2)}`)
    expect(failing).toEqual([])
  })
})
