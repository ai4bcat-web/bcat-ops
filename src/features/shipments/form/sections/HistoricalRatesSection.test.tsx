// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { LaneRateSampleRecord } from '@/types/tms'
import { emptyStop, type FormStop } from '../model'
import { makeCtx } from './sectionTestKit'
import { HistoricalRatesSection } from './HistoricalRatesSection'
import type { FormApi } from '../sectionRegistry'

const exactMock = vi.fn()
const zip3Mock = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  listLaneSamples: (...a: unknown[]) => exactMock(...a),
  listLaneSamplesByZip3: (...a: unknown[]) => zip3Mock(...a),
}))

const form = { getValues: vi.fn(), update: vi.fn(), focusField: vi.fn() } as unknown as FormApi
const stops = (): FormStop[] => [
  { ...emptyStop('pickup'), city: 'Joliet', state: 'IL', zip: '60431' },
  { ...emptyStop('delivery'), city: 'Danville', state: 'IL', zip: '61832' },
]
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const sample = (over: Partial<LaneRateSampleRecord>): LaneRateSampleRecord => ({
  id: 's', laneKey: 'JOLIET|IL>DANVILLE|IL', date: daysAgo(20), loadId: 'l', shipmentId: 'sh',
  customerRateCents: 100000, revenueCents: 110000, equipmentType: 'Dry Van', miles: 100, excluded: false, ...over,
}) as LaneRateSampleRecord

const render_ = (s: FormStop[] = stops(), equipmentType = '') =>
  render(<HistoricalRatesSection stops={s} equipmentType={equipmentType} ctx={makeCtx()} form={form} />)

describe('HistoricalRatesSection', () => {
  beforeEach(() => { exactMock.mockReset(); zip3Mock.mockReset() })

  it('asks for the lane once (debounced) and never shows a zero for an empty period', async () => {
    exactMock.mockResolvedValue([sample({})])
    render_()
    expect(exactMock).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('f-history-row')).toBeTruthy(), { timeout: 3000 })
    expect(exactMock).toHaveBeenCalledTimes(1)
    expect(exactMock.mock.calls[0][0]).toBe('JOLIET|IL>DANVILLE|IL')
    expect(zip3Mock).not.toHaveBeenCalled()
    expect(screen.getByTestId('f-history-row').textContent).toContain('$1,000')
    // Nothing was delivered yesterday: that period says so rather than showing a zero
    fireEvent.click(screen.getByText('Yesterday'))
    expect(screen.queryByTestId('f-history-row')).toBeNull()
    expect(screen.getByTestId('f-history-empty').textContent).toBe('No history')
  })

  it('says "No history" instead of $0 when neither the lane nor ZIP3 has samples', async () => {
    exactMock.mockResolvedValue([])
    zip3Mock.mockResolvedValue([])
    render_()
    await waitFor(() => expect(zip3Mock).toHaveBeenCalled(), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('f-history-empty').textContent).toBe('No history'))
    expect(screen.queryByTestId('f-history-row')).toBeNull()
  })

  it('falls back to the ZIP3 neighbourhood only when the lane is empty, and says so in the badge', async () => {
    exactMock.mockResolvedValue([])
    zip3Mock.mockResolvedValue([sample({ laneKey: 'X', customerRateCents: 80000 })])
    render_()
    await waitFor(() => expect(screen.getByTestId('f-history-badge').textContent).toContain('604→618'), { timeout: 3000 })
    expect(zip3Mock).toHaveBeenCalledTimes(1)
  })

  it('filters by equipment unless "Any equipment" is ticked', async () => {
    exactMock.mockResolvedValue([sample({ equipmentType: 'Reefer' })])
    render_(stops(), 'Dry Van')
    await waitFor(() => expect(exactMock).toHaveBeenCalled(), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('f-history-empty').textContent).toBe('No history'))
    fireEvent.click(screen.getByLabelText('Any equipment'))
    expect(screen.getByTestId('f-history-row')).toBeTruthy()
  })

  it('does not read anything until both ends have a city and state', async () => {
    const s = stops()
    s[1].city = ''
    render_(s)
    await new Promise((r) => setTimeout(r, 700))
    expect(exactMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('f-history-empty').textContent).toMatch(/Enter both stops/)
  })
})
