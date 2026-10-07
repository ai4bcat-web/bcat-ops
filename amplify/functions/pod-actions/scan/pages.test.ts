import { describe, it, expect } from 'vitest'
import { orderPages } from './pages'

/**
 * The staff client once restarted page numbers at 1 for every batch it added, so two
 * batches collided on number alone and the merge interleaved them. Arrival time is the
 * tiebreak that makes "pages added later are later pages" true whatever the numbers say.
 */
describe('orderPages', () => {
  it('orders by page number', () => {
    const out = orderPages([{ pageNumber: 2, uploadedAt: 'b' }, { pageNumber: 1, uploadedAt: 'a' }])
    expect(out.map((d) => d.pageNumber)).toEqual([1, 2])
  })

  it('breaks a page-number tie by arrival, so a second batch follows the first', () => {
    const first = { pageNumber: 1, uploadedAt: '2026-10-02T10:00:00Z', id: 'first-1' }
    const second = { pageNumber: 1, uploadedAt: '2026-10-02T11:00:00Z', id: 'second-1' }
    const out = orderPages([second, first])
    expect(out.map((d) => d.id)).toEqual(['first-1', 'second-1'])
  })

  it('tolerates string page numbers and missing fields rather than throwing', () => {
    const out = orderPages([{ pageNumber: '2' }, { pageNumber: null }, { pageNumber: '1', uploadedAt: null }])
    expect(out.map((d) => d.pageNumber)).toEqual([null, '1', '2'])
  })

  it('does not mutate its input', () => {
    const input = [{ pageNumber: 2 }, { pageNumber: 1 }]
    orderPages(input)
    expect(input.map((d) => d.pageNumber)).toEqual([2, 1])
  })
})
