import { describe, expect, it } from 'vitest'
import { mapLimit } from './mapLimit'

describe('mapLimit', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, n))
      inFlight -= 1
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70])
    expect(peak).toBe(3)
  })

  it('rejects with the first failure and stops starting new work', async () => {
    const started: number[] = []
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n)
      await new Promise((r) => setTimeout(r, 1))
      if (n === 2) throw new Error('boom')
      return n
    })).rejects.toThrow('boom')
    expect(started.length).toBeLessThan(6)
  })
})
