// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  getLaneIntelligence: vi.fn(),
  priceFromMarket: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)

import { RateIntelligencePanel } from './RateIntelligencePanel'

const LANE = { originCity: 'Chicago', originState: 'IL', originZip: '60601', destinationCity: 'Dallas', destinationState: 'TX', destinationZip: '75201' }
const STUB = { answer: { averageCents: 200000, lowCents: 180000, highCents: 220000, fuelCents: 0, perMileCents: 200, miles: 1000, reports: 0, days: 0, stub: true, source: 'DAT_RATEVIEW', message: 'stub' } }
const LIVE = { answer: { ...STUB.answer, stub: false } }

const INTEL = {
  laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', equipmentType: 'VAN', fromDate: '2024-11-04', months: 24, generatedAt: 'x', truncated: false,
  runs: {
    stats: { count: 2, customer: { count: 2, avgCents: 330000, lowCents: 300000, highCents: 360000 }, carrier: { count: 2, avgCents: 260000, lowCents: 250000, highCents: 270000 }, marginAvgBps: 2100, lastDate: '2026-10-01' },
    rows: [
      { id: 'a', date: '2026-10-01', customerName: 'ZZ Acme', carrierName: null, carrierCostCents: 250000, customerRateCents: 300000, marginCents: 50000, marginBps: 1667, equipmentType: 'VAN', shipmentNumber: null, source: 'BACKFILL', match: 'CITY' },
      { id: 'b', date: '2026-09-01', customerName: 'ZZ Beta', carrierName: null, carrierCostCents: 270000, customerRateCents: 360000, marginCents: 90000, marginBps: 2500, equipmentType: 'VAN', shipmentNumber: null, source: 'LOAD', match: 'ZIP3' },
    ],
  },
  quotes: {
    stats: { count: 3, won: 1, lost: 1, expired: 0, pending: 1, winRate: 0.5, avgQuotedCents: 330000, avgWonCents: 310000 },
    rows: [
      { id: 'Q1', date: '2026-10-02', customerName: 'ZZ Acme', quotedCents: 310000, outcome: 'WON', lostReason: null, status: 'WON', equipmentType: 'VAN', match: 'CITY' },
      { id: 'Q2', date: '2026-10-05', customerName: 'ZZ Beta', quotedCents: 390000, outcome: 'LOST', lostReason: 'TOO_HIGH', status: 'LOST', equipmentType: 'VAN', match: 'CITY' },
      { id: 'Q3', date: '2026-10-06', customerName: 'ZZ Gamma', quotedCents: 300000, outcome: 'PENDING', lostReason: null, status: 'QUOTED', equipmentType: 'VAN', match: 'CITY' },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getLaneIntelligence.mockResolvedValue(INTEL)
  api.priceFromMarket.mockResolvedValue(STUB)
})

describe('RateIntelligencePanel', () => {
  it('shows market (labelled STUB), what we ran, and what we quoted with its win rate', async () => {
    render(<RateIntelligencePanel lane={LANE} equipmentType="VAN" customerId="c1" />)

    expect(await screen.findByTestId('rate-intel-stub')).toHaveTextContent('STUB')
    expect(screen.getByTestId('rate-intel-dat')).toHaveTextContent('no DAT call was made')

    const ran = await screen.findByTestId('rate-intel-ran-summary')
    expect(ran).toHaveTextContent('2 loads')
    expect(ran).toHaveTextContent('$3,300.00')
    expect(within(screen.getByTestId('rate-intel-ran-table')).getAllByRole('row')).toHaveLength(3)

    expect(screen.getByTestId('rate-intel-winrate')).toHaveTextContent('50 %')
    const quoted = screen.getByTestId('rate-intel-quoted-table')
    expect(within(quoted).getByText('WON')).toBeInTheDocument()
    expect(within(quoted).getByText('LOST')).toBeInTheDocument()
    expect(within(quoted).getByText('PENDING')).toBeInTheDocument()
    expect(api.getLaneIntelligence).toHaveBeenCalledWith(expect.objectContaining({ originCity: 'Chicago', equipmentType: 'VAN' }))
  })

  it('labels a live DAT answer LIVE and does not ask DAT again when the page already has it', async () => {
    render(<RateIntelligencePanel lane={LANE} equipmentType="VAN" market={LIVE as never} />)
    expect(await screen.findByTestId('rate-intel-live')).toHaveTextContent('LIVE')
    expect(screen.queryByTestId('rate-intel-stub')).toBeNull()
    await screen.findByTestId('rate-intel-ran-summary')
    expect(api.priceFromMarket).not.toHaveBeenCalled()
  })

  it('says so, and reads nothing, when the lane is not known yet', () => {
    render(<RateIntelligencePanel lane={null} equipmentType={null} />)
    expect(screen.getByTestId('rate-intel-nolane')).toBeInTheDocument()
    expect(screen.queryByTestId('rate-intel-ran')).toBeNull()
    expect(api.getLaneIntelligence).not.toHaveBeenCalled()
  })

  it('reports an empty lane as empty, not as free freight', async () => {
    api.getLaneIntelligence.mockResolvedValue({
      ...INTEL,
      runs: { stats: { count: 0, customer: { count: 0, avgCents: null, lowCents: null, highCents: null }, carrier: { count: 0, avgCents: null, lowCents: null, highCents: null }, marginAvgBps: null, lastDate: null }, rows: [] },
      quotes: { stats: { count: 0, won: 0, lost: 0, expired: 0, pending: 0, winRate: null, avgQuotedCents: null, avgWonCents: null }, rows: [] },
    })
    render(<RateIntelligencePanel lane={LANE} equipmentType="VAN" />)
    expect(await screen.findByTestId('rate-intel-ran-empty')).toBeInTheDocument()
    expect(screen.getByTestId('rate-intel-quoted-empty')).toBeInTheDocument()
  })

  it('shows a failed history read without hiding the market', async () => {
    api.getLaneIntelligence.mockRejectedValue(new Error('boom'))
    render(<RateIntelligencePanel lane={LANE} equipmentType="VAN" />)
    expect(await screen.findByText(/Lane history failed to load: boom/)).toBeInTheDocument()
    expect(screen.getByTestId('rate-intel-stub')).toBeInTheDocument()
  })
})
