/**
 * The two promises `/reports` rests on: a month is read once, and a month that fails
 * costs its own rows and nothing else.
 *
 * Both are about trust. Re-reading a month per tab switch would turn a six-panel page
 * into dozens of index queries; throwing the window away because one month refused would
 * leave the office staring at a blank page when five sixths of the answer was in hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LaneRateSampleRecord } from '@/types/tms'
import { clearReportCache, loadReportBundle, loadSamples } from './reportsClient'

const samplesMock = vi.hoisted(() => vi.fn<(ym: string) => Promise<LaneRateSampleRecord[]>>())

vi.mock('@/lib/apiClient', () => ({
  listLaneSamplesByMonth: samplesMock,
  listQuotesByMonth: vi.fn(),
  listCommissionsByMonth: vi.fn(),
  listInvoicesByMonth: vi.fn(),
}))

function sample(id: string, month: string): LaneRateSampleRecord {
  return {
    id,
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: `${month}-10`,
    loadId: `l-${id}`,
    shipmentId: `s-${id}`,
    sampleMonth: month,
    revenueCents: 250_000,
    costCents: 200_000,
    source: 'LOAD',
    sampledAt: `${month}-10T12:00:00.000Z`,
    version: 1,
  }
}

beforeEach(() => {
  clearReportCache()
  samplesMock.mockReset()
})

describe('loadSamples', () => {
  it('reads every month of the window once, however many times it is asked', async () => {
    samplesMock.mockImplementation((ym: string) => Promise.resolve([sample(`a-${ym}`, ym)]))

    const first = await loadSamples('2026-08', '2026-10')
    expect(first.months).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(first.rows.map((r) => r.id)).toEqual(['a-2026-08', 'a-2026-09', 'a-2026-10'])
    expect(samplesMock).toHaveBeenCalledTimes(3)

    // The same window again, and a window that overlaps it: only the month nobody has
    // read yet costs a call.
    const second = await loadSamples('2026-08', '2026-10')
    expect(second.rows).toHaveLength(3)
    expect(samplesMock).toHaveBeenCalledTimes(3)

    await loadSamples('2026-09', '2026-11')
    expect(samplesMock).toHaveBeenCalledTimes(4)
    expect(samplesMock).toHaveBeenLastCalledWith('2026-11')
  })

  it('answers two overlapping asks for one month with a single read', async () => {
    let resolveMonth: (rows: LaneRateSampleRecord[]) => void = () => {}
    samplesMock.mockImplementation(() => new Promise<LaneRateSampleRecord[]>((resolve) => { resolveMonth = resolve }))

    const a = loadSamples('2026-10', '2026-10')
    const b = loadSamples('2026-10', '2026-10')
    resolveMonth([sample('a', '2026-10')])

    expect((await a).rows).toHaveLength(1)
    expect((await b).rows).toHaveLength(1)
    expect(samplesMock).toHaveBeenCalledTimes(1)
  })

  it('reports the month that failed and still returns the rest', async () => {
    samplesMock.mockImplementation((ym: string) =>
      ym === '2026-09'
        ? Promise.reject(new Error('Not authorized to read lane samples'))
        : Promise.resolve([sample(`a-${ym}`, ym)]))

    const read = await loadSamples('2026-08', '2026-10')

    expect(read.failedMonths).toEqual([{ month: '2026-09', message: 'Not authorized to read lane samples' }])
    expect(read.rows.map((r) => r.id)).toEqual(['a-2026-08', 'a-2026-10'])
    expect(read.months).toEqual(['2026-08', '2026-09', '2026-10'])
  })

  it('retries a month that failed rather than memoising the failure', async () => {
    samplesMock.mockRejectedValueOnce(new Error('Throttled'))
    samplesMock.mockResolvedValueOnce([sample('a', '2026-10')])

    const failed = await loadSamples('2026-10', '2026-10')
    expect(failed.rows).toHaveLength(0)
    expect(failed.failedMonths).toHaveLength(1)

    const retried = await loadSamples('2026-10', '2026-10')
    expect(retried.rows.map((r) => r.id)).toEqual(['a'])
    expect(retried.failedMonths).toEqual([])
  })
})

describe('loadReportBundle', () => {
  it('returns the window samples with the months they came from', async () => {
    samplesMock.mockImplementation((ym: string) => Promise.resolve([sample(`a-${ym}`, ym)]))

    const bundle = await loadReportBundle({ from: '2026-09', to: '2026-10' })

    expect(bundle.months).toEqual(['2026-09', '2026-10'])
    expect(bundle.samples).toHaveLength(2)
    expect(bundle.failedMonths).toEqual([])
  })
})
