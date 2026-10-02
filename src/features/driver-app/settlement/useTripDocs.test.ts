// @vitest-environment jsdom
/**
 * A settlement row can say "POD in" and still have nothing to show the driver, which is
 * the gap this index closes: the server computes presence from two stores, but only the
 * driver's own submissions carry a document they are allowed to open.
 *
 * The matching rule has to be the same one the office uses, or a POD visible on a load in
 * the Loads page would be invisible on the driver's own row for the same shipment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { SubmissionSummary } from '../driverApi'

const fetchSubmissions = vi.hoisted(() => vi.fn())
vi.mock('../driverApi', () => ({ fetchSubmissions }))

const { useTripDocs } = await import('./useTripDocs')

function sub(over: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 'sub-1',
    status: 'NEW',
    loadId: null,
    referenceNumber: null,
    createdAt: '2026-10-01T12:00:00Z',
    docs: [],
    documents: [
      { kind: 'POD', docId: 'combined-POD', pageCount: 3, enhanced: true, contentType: 'application/pdf', combined: true },
    ],
    ...over,
  } as SubmissionSummary
}

async function index(rows: SubmissionSummary[]) {
  fetchSubmissions.mockResolvedValue(rows)
  const { result } = renderHook(() => useTripDocs())
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result
}

beforeEach(() => vi.clearAllMocks())

describe('useTripDocs', () => {
  it('finds the document by load id', async () => {
    const r = await index([sub({ loadId: 'load-1' })])
    expect(r.current.find('POD', 'load-1', null)?.document.docId).toBe('combined-POD')
  })

  it('finds it by the PRO the driver typed, label and whitespace and all', async () => {
    // The common case: a driver sends a POD before anyone links it to a load. They type
    // "PRO #14538" or "14538 " and both have to reach the same shipment.
    const r = await index([sub({ referenceNumber: 'PRO #14538' })])
    expect(r.current.find('POD', null, ' 14538 ')).not.toBeNull()
  })

  it('does not treat a differently padded PRO as the same shipment', async () => {
    // Leading zeros are kept on purpose: this matcher is shared with the office, and a
    // PRO is an identifier, not a number to normalise. Loosening it here would silently
    // attach paperwork to the wrong load on both sides.
    const r = await index([sub({ referenceNumber: '014538' })])
    expect(r.current.find('POD', null, '14538')).toBeNull()
  })

  it('never hands back another shipment’s paperwork', async () => {
    const r = await index([sub({ loadId: 'load-2', referenceNumber: '99999' })])
    expect(r.current.find('POD', 'load-1', '14538')).toBeNull()
  })

  it('returns nothing for a kind that was never submitted', async () => {
    // The office may hold a rate con this driver never sent. The row still reads green
    // from the server; it just has nothing here for the driver to open or remove.
    const r = await index([sub({ loadId: 'load-1' })])
    expect(r.current.find('RATECON', 'load-1', null)).toBeNull()
  })

  it('survives the listing failing, because it only costs the preview button', async () => {
    fetchSubmissions.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useTripDocs())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.find('POD', 'load-1', '14538')).toBeNull()
  })

  it('ignores a blank reference rather than matching every loose submission to it', async () => {
    const r = await index([sub({ referenceNumber: '  ' })])
    expect(r.current.find('POD', null, '  ')).toBeNull()
  })
})
