import { describe, it, expect } from 'vitest'
import { normalizePro, buildPodIndex, podPageCount, loadHasPod, loadHasRatecon, type PodSubmissionLike } from './podPresence'

const sub = (over: Partial<PodSubmissionLike> = {}): PodSubmissionLike =>
  ({ hasPodDoc: true, ...over })

const index = (over: Parameters<typeof buildPodIndex>[0]) => buildPodIndex(over)
const empty = { jobsdoneLoadIds: [], submissions: [] }

describe('normalizePro', () => {
  it('strips the padding the live table stores', () => {
    expect(normalizePro('14452  ')).toBe('14452')
  })

  it('reads a PRO a driver typed with a label', () => {
    expect(normalizePro('PRO #13364')).toBe('13364')
    expect(normalizePro('pro 13364')).toBe('13364')
  })

  it('ignores punctuation and case so one load has one key', () => {
    expect(normalizePro('a-2847391')).toBe(normalizePro('A 2847391'))
  })

  it('treats the N/A sentinel as no PRO at all', () => {
    expect(normalizePro('N/A')).toBeNull()
    expect(normalizePro('n/a')).toBeNull()
  })

  it('refuses anything too short to be a real PRO', () => {
    // A stray "12" in a note must never match a load.
    expect(normalizePro('12')).toBeNull()
    expect(normalizePro('')).toBeNull()
    expect(normalizePro(null)).toBeNull()
  })
})

describe('loadHasPod', () => {
  it('finds a POD that JobsDone linked to the load', () => {
    const i = index({ jobsdoneLoadIds: ['load-1'], submissions: [] })
    expect(loadHasPod(i, { id: 'load-1' })).toBe(true)
    expect(loadHasPod(i, { id: 'load-2' })).toBe(false)
  })

  it('finds a POD a driver scanned, matched by the PRO they typed', () => {
    // This is the case that used to show amber on a settlement while the POD sat in
    // Slack: the driver's submission names the PRO, not the internal load id.
    const i = index({ jobsdoneLoadIds: [], submissions: [sub({ referenceNumber: 'PRO 13364' })] })
    expect(loadHasPod(i, { id: 'load-9', aljexId: '13364  ' })).toBe(true)
  })

  it('finds a POD staff uploaded against the load directly', () => {
    const i = index({ jobsdoneLoadIds: [], submissions: [sub({ loadId: 'load-4' })] })
    expect(loadHasPod(i, { id: 'load-4' })).toBe(true)
  })

  it('ignores a submission that carries only a rate confirmation', () => {
    const i = index({
      jobsdoneLoadIds: [],
      submissions: [sub({ hasPodDoc: false, loadId: 'load-5', referenceNumber: '13364' })],
    })
    expect(loadHasPod(i, { id: 'load-5', aljexId: '13364' })).toBe(false)
  })

  it('does not match a load whose PRO is missing or a sentinel', () => {
    const i = index({ jobsdoneLoadIds: [], submissions: [sub({ referenceNumber: 'N/A' })] })
    expect(loadHasPod(i, { id: 'load-6', aljexId: 'N/A' })).toBe(false)
    expect(loadHasPod(i, { id: 'load-7', aljexId: '' })).toBe(false)
    expect(loadHasPod(i, { id: 'load-8' })).toBe(false)
  })

  it('does not attach a POD to a different load that shares no PRO', () => {
    const i = index({ jobsdoneLoadIds: [], submissions: [sub({ referenceNumber: '13364' })] })
    expect(loadHasPod(i, { id: 'load-9', aljexId: '13365' })).toBe(false)
  })

  it('reports no POD for anything when nothing is on file', () => {
    expect(loadHasPod(index(empty), { id: 'load-1', aljexId: '13364' })).toBe(false)
  })
})

describe('loadHasRatecon', () => {
  it('counts a rate confirmation already on the load row', () => {
    const i = buildPodIndex({ jobsdoneLoadIds: [], submissions: [], rateconLoadIds: ['load-1'] })
    expect(loadHasRatecon(i, { id: 'load-1' })).toBe(true)
    expect(loadHasPod(i, { id: 'load-1' })).toBe(false)
  })

  it('counts a rate confirmation a driver scanned, by PRO', () => {
    const i = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ hasPodDoc: false, hasRateconDoc: true, referenceNumber: '13364' }],
    })
    expect(loadHasRatecon(i, { id: 'load-2', aljexId: '13364' })).toBe(true)
  })

  it('keeps the two kinds apart on one submission', () => {
    // A submission with only a rate con must not make the POD check pass — that is the
    // exact confusion that would pay a load with no proof of delivery.
    const i = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ hasPodDoc: false, hasRateconDoc: true, loadId: 'load-3' }],
    })
    expect(loadHasRatecon(i, { id: 'load-3' })).toBe(true)
    expect(loadHasPod(i, { id: 'load-3' })).toBe(false)
  })

  it('records both when one submission carries both kinds', () => {
    const i = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ hasPodDoc: true, hasRateconDoc: true, loadId: 'load-4' }],
    })
    expect(loadHasPod(i, { id: 'load-4' })).toBe(true)
    expect(loadHasRatecon(i, { id: 'load-4' })).toBe(true)
  })
})

/**
 * How many pages of the POD are on file — said beside the tick, because "POD on file" and
 * "all three pages of the POD on file" are different answers.
 */
describe('podPageCount', () => {
  it('counts the pages a submission carries, by load id', () => {
    const i = buildPodIndex({ jobsdoneLoadIds: [], submissions: [
      { loadId: 'l1', hasPodDoc: true, podPageCount: 3 },
    ] })
    expect(podPageCount(i, { id: 'l1' })).toBe(3)
  })

  it('finds it by the PRO the driver typed, padded or labelled', () => {
    const i = buildPodIndex({ jobsdoneLoadIds: [], submissions: [
      { loadId: null, referenceNumber: 'PRO 14565', hasPodDoc: true, podPageCount: 2 },
    ] })
    expect(podPageCount(i, { id: 'x', aljexId: '14565  ' })).toBe(2)
  })

  it('reports the FULLER document when two submissions claim one load', () => {
    // The fuller one is what the queue sends; under-reporting sends somebody looking for a
    // page that is already there.
    const i = buildPodIndex({ jobsdoneLoadIds: [], submissions: [
      { loadId: 'l1', hasPodDoc: true, podPageCount: 1 },
      { loadId: 'l1', hasPodDoc: true, podPageCount: 4 },
    ] })
    expect(podPageCount(i, { id: 'l1' })).toBe(4)
  })

  it('is null when nothing could count — never 0, which would read as an empty POD', () => {
    const i = buildPodIndex({ jobsdoneLoadIds: ['l1'], submissions: [] })
    expect(podPageCount(i, { id: 'l1' })).toBeNull()
    expect(podPageCount(i, { id: 'nothing' })).toBeNull()
  })
})
