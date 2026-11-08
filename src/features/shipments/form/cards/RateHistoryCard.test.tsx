// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { RateHistoryCard } from './RateHistoryCard'
import { clearRateHistoryCache } from './rateHistoryCache'
import { renderCard } from './cardTestKit'
import type { ShipmentFormValues } from '../model'
import type { LaneIntelligence, LaneRunStats } from '@/lib/laneIntel'

const api = vi.hoisted(() => ({
  getLaneIntelligence: vi.fn(),
  priceFromMarket: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)

const spread = (avg: number | null, count = avg == null ? 0 : 3) => ({ count, avgCents: avg, lowCents: avg, highCents: avg })
const stats = (count: number, cust: number | null, carrier: number | null, bps: number | null): LaneRunStats => ({
  count, customer: spread(cust, count), carrier: spread(carrier, count), marginAvgBps: bps, lastDate: count ? '2026-10-01' : null,
})
const EMPTY = stats(0, null, null, null)

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `r${n}`, date: `2026-10-0${n}`, customerName: `Cust ${n}`, carrierName: null, carrierCostCents: 250000 + n,
  customerRateCents: 300000 + n, marginCents: 50000, marginBps: 1667, equipmentType: 'VAN', shipmentNumber: `PRO${n}`,
  source: null, match: 'CITY', ...over,
})

function intel(over: Partial<LaneIntelligence['runs']> = {}): LaneIntelligence {
  return {
    laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', equipmentType: 'VAN', fromDate: '2024-11-05', months: 24,
    generatedAt: 'x', truncated: false,
    runs: {
      stats: stats(7, 310000, 255000, 1700),
      rows: [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)),
      windows: { d30: stats(2, 320000, 260000, 1800), d90: stats(5, 310000, 255000, 1700), d365: stats(7, 300000, 250000, 1600) },
      ...over,
    },
    quotes: { stats: { count: 0, won: 0, lost: 0, expired: 0, pending: 0, winRate: null, avgQuotedCents: null, avgWonCents: null }, rows: [] },
  } as unknown as LaneIntelligence
}

const market = (stub: boolean) => ({
  answer: {
    averageCents: 270000, lowCents: 250000, highCents: 300000, fuelCents: 20000, perMileCents: 250, miles: 900,
    reports: 40, days: 15, stub, source: 'DAT_RATEVIEW', message: 'm',
  },
  targetBps: 2000, floorBps: 1200, suggestedSellCents: 330000, belowFloor: false, floorSellCents: 300000, marginAtSuggested: 2000,
})

const seed = (v: ShipmentFormValues): ShipmentFormValues => {
  v.ship.equipmentType = 'VAN'
  v.stops[0] = { ...v.stops[0], city: 'Chicago', state: 'IL' }
  v.stops[1] = { ...v.stops[1], city: 'Dallas', state: 'TX' }
  return v
}
const blank = (v: ShipmentFormValues) => v

const draw = (seeded = seed) => renderCard(RateHistoryCard, { seed: seeded })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T15:00:00Z') })
  clearRateHistoryCache()
  api.getLaneIntelligence.mockReset().mockResolvedValue(intel())
  api.priceFromMarket.mockReset().mockResolvedValue(market(false))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('RateHistoryCard', () => {
  it('asks to complete the lane and reads nothing while an end is missing', () => {
    draw(blank)
    expect(screen.getByTestId('card-rateHistory-nolane')).toHaveTextContent('Add pickup and delivery to see lane history')
    expect(api.getLaneIntelligence).not.toHaveBeenCalled()
    expect(api.priceFromMarket).not.toHaveBeenCalled()
  })

  it('lists the last five loads and the 30 / 90 / year averages from the server windows', async () => {
    draw()
    const table = await screen.findByTestId('card-rateHistory-ran-table')
    const rows = within(table).getAllByTestId('card-rateHistory-ran-row')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveTextContent('PRO1')
    expect(rows[0]).toHaveTextContent('Cust 1')
    expect(rows[0]).toHaveTextContent('$3,000.01')
    expect(rows[0]).toHaveTextContent('$2,500.01')
    expect(rows[0]).toHaveTextContent('$500.00 · 16.7%')
    expect(screen.queryByText('PRO6')).toBeNull()
    expect(screen.getByTestId('card-rateHistory-avg-d30')).toHaveTextContent('30 days2$3,200.00$2,600.0018.0%')
    expect(screen.getByTestId('card-rateHistory-avg-d90')).toHaveTextContent('90 days5$3,100.00$2,550.0017.0%')
    expect(screen.getByTestId('card-rateHistory-avg-d365')).toHaveTextContent('Last year7$3,000.00$2,500.0016.0%')
    expect(screen.getByTestId('card-rateHistory-all')).toHaveAttribute('href', '/tms/rates')
  })

  it('says so when the lane has no history, without showing zeros', async () => {
    api.getLaneIntelligence.mockResolvedValue(intel({ stats: EMPTY, rows: [], windows: { d30: EMPTY, d90: EMPTY, d365: EMPTY } }))
    draw()
    expect(await screen.findByTestId('card-rateHistory-ran-empty')).toHaveTextContent('No shipments on this lane in the last 24 months')
    expect(screen.queryByTestId('card-rateHistory-averages')).toBeNull()
  })

  it('shows live DAT spot low / average / high and when it was read', async () => {
    draw()
    const spot = await screen.findByTestId('card-rateHistory-dat-spot')
    expect(spot).toHaveTextContent('Spot$2,500.00$2,700.00$3,000.00')
    expect(screen.getByTestId('card-rateHistory-dat-refreshed')).toHaveTextContent('Refreshed 2026-11-05')
  })

  it('renders a stub answer as DAT not connected with a Settings link and no numbers', async () => {
    api.priceFromMarket.mockResolvedValue(market(true))
    draw()
    const stub = await screen.findByTestId('card-rateHistory-dat-stub')
    expect(stub).toHaveTextContent('DAT not connected')
    expect(screen.getByTestId('card-rateHistory-dat-settings')).toHaveAttribute('href', '/tms/brokerage/integrations/dat')
    expect(stub.textContent).not.toMatch(/\d/)
    expect(screen.getByTestId('card-rateHistory-dat').textContent).not.toMatch(/\$/)
  })

  it('shows DAT unavailable on error and retries on demand', async () => {
    api.priceFromMarket.mockRejectedValueOnce(new Error('503'))
    draw()
    expect(await screen.findByTestId('card-rateHistory-dat-error')).toHaveTextContent('DAT unavailable')
    fireEvent.click(screen.getByTestId('card-rateHistory-dat-retry'))
    expect(await screen.findByTestId('card-rateHistory-dat-spot')).toBeInTheDocument()
    expect(api.priceFromMarket).toHaveBeenCalledTimes(2)
  })

  it('suggests from live DAT with its basis and writes the carrier rate when none is typed', async () => {
    const host = draw()
    expect(await screen.findByTestId('card-rateHistory-suggested-text')).toHaveTextContent('Customer $3,300.00 · Carrier $2,700.00')
    expect(screen.getByTestId('card-rateHistory-suggested-basis')).toHaveTextContent('DAT live')
    fireEvent.click(screen.getByTestId('card-rateHistory-use'))
    expect(host.current?.getValues().rates.carrier.lhRate).toBe('2700')
    expect(host.current?.getValues().rates.carrier.rateType).toBe('FLAT')
  })

  it('never overwrites a typed carrier rate without confirmation', async () => {
    const host = draw((v) => { seed(v); v.rates.carrier.lhRate = '2000'; return v })
    fireEvent.click(await screen.findByTestId('card-rateHistory-use'))
    expect(host.current?.getValues().rates.carrier.lhRate).toBe('2000')
    expect(screen.getByTestId('card-rateHistory-use-confirm')).toHaveTextContent('Replace $2,000.00 with $2,700.00?')
    fireEvent.click(screen.getByTestId('card-rateHistory-use-no'))
    expect(host.current?.getValues().rates.carrier.lhRate).toBe('2000')
    fireEvent.click(screen.getByTestId('card-rateHistory-use'))
    fireEvent.click(screen.getByTestId('card-rateHistory-use-yes'))
    expect(host.current?.getValues().rates.carrier.lhRate).toBe('2700')
  })

  it('labels a stub suggestion STUB and offers no carrier button for it', async () => {
    api.priceFromMarket.mockResolvedValue(market(true))
    api.getLaneIntelligence.mockResolvedValue(intel({ stats: EMPTY, rows: [], windows: { d30: EMPTY, d90: EMPTY, d365: EMPTY } }))
    draw()
    await screen.findByTestId('card-rateHistory-dat-stub')
    expect(await screen.findByTestId('card-rateHistory-suggested-basis')).toHaveTextContent('STUB')
    expect(screen.queryByTestId('card-rateHistory-use')).toBeNull()
  })

  it('falls back to lane history (3+ loads) when DAT is not live', async () => {
    api.priceFromMarket.mockResolvedValue(market(true))
    draw()
    await waitFor(() => expect(screen.getByTestId('card-rateHistory-suggested-basis')).toHaveTextContent('Lane history'))
    expect(screen.getByTestId('card-rateHistory-suggested-text')).toHaveTextContent('Customer $3,100.00 · Carrier $2,550.00')
  })

  it('reads once per lane and equipment, then again 400 ms after the lane changes', async () => {
    const host = draw()
    await screen.findByTestId('card-rateHistory-dat-spot')
    expect(api.getLaneIntelligence).toHaveBeenCalledTimes(1)
    expect(api.priceFromMarket).toHaveBeenCalledTimes(1)

    // A burst of keystrokes is one read, after the pause.
    for (const city of ['Aust', 'Austi', 'Austin']) {
      act(() => host.current?.form.update((p) => ({ ...p, stops: p.stops.map((s, i) => (i === 1 ? { ...s, city, state: 'TX' } : s)) })))
    }
    expect(api.getLaneIntelligence).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.getLaneIntelligence).toHaveBeenCalledTimes(2))
    expect(api.getLaneIntelligence).toHaveBeenLastCalledWith(expect.objectContaining({ destinationCity: 'Austin', equipmentType: 'VAN' }))
    expect(api.priceFromMarket).toHaveBeenCalledTimes(2)

    act(() => host.current?.form.update((p) => ({ ...p, ship: { ...p.ship, equipmentType: 'REEFER' } })))
    await waitFor(() => expect(api.getLaneIntelligence).toHaveBeenCalledTimes(3))
    expect(api.priceFromMarket).toHaveBeenLastCalledWith(expect.objectContaining({ equipmentType: 'REEFER' }))
  })
})
