import { describe, it, expect, vi } from 'vitest'

import { estimateMiles, liveRateView, stubRateView } from './rateView'

const lane = {
  originCity: 'Chicago', originState: 'IL',
  destinationCity: 'Dallas', destinationState: 'TX',
  equipmentType: 'VAN',
  pickupDate: '2026-11-02T00:00:00Z',
}

describe('the stub RateView answer', () => {
  it('says it is a stub, in the number and in the words', () => {
    const answer = stubRateView(lane)
    expect(answer.stub).toBe(true)
    expect(answer.message.startsWith('STUB — no DAT call was made.')).toBe(true)
  })

  it('gives the same lane the same number twice — a demo that moves is not a demo', () => {
    expect(stubRateView(lane)).toEqual(stubRateView(lane))
  })

  it('prices two different lanes differently', () => {
    const other = stubRateView({ ...lane, destinationCity: 'Atlanta', destinationState: 'GA' })
    expect(other.averageCents).not.toBe(stubRateView(lane).averageCents)
  })

  it('pays more per mile on a short lane than on a long one', () => {
    const short = stubRateView({ ...lane, miles: 180 })
    const long = stubRateView({ ...lane, miles: 1400 })
    expect(short.perMileCents).toBeGreaterThan(long.perMileCents)
  })

  it('charges a reefer more than a van on the same lane', () => {
    expect(stubRateView({ ...lane, equipmentType: 'REEFER' }).averageCents)
      .toBeGreaterThan(stubRateView(lane).averageCents)
  })

  it('brackets the average and keeps fuel out of the line-haul', () => {
    const a = stubRateView(lane)
    expect(a.lowCents).toBeLessThan(a.averageCents)
    expect(a.highCents).toBeGreaterThan(a.averageCents)
    expect(a.fuelCents).toBeGreaterThan(0)
    expect(a.averageCents).toBeGreaterThan(a.fuelCents)
  })

  it('never answers zero miles, even for an in-state run', () => {
    expect(estimateMiles('IL', 'IL')).toBeGreaterThanOrEqual(75)
    expect(estimateMiles('XX', 'ZZ')).toBe(600)
  })
})

describe('the live RateView lookup', () => {
  it('does nothing at all without a complete credential set', async () => {
    const fetchImpl = vi.fn()
    expect(await liveRateView(lane, {}, fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads DAT\'s own answer and marks it not-a-stub', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          rateResponses: [{ response: { rate: {
            averageFuelSurchargePerTripUsd: 310.5,
            perTrip: { lowUsd: 1800, highUsd: 2400, rateUsd: 2100 },
            mileage: 925,
            reports: 143,
          } } }],
        }),
      })
    const answer = await liveRateView(lane, { serviceAccountEmail: 'a@b.c', serviceAccountPassword: 'x' }, fetchImpl as unknown as typeof fetch)
    expect(answer).toMatchObject({ stub: false, source: 'DAT_RATEVIEW', miles: 925, reports: 143 })
    expect(answer!.fuelCents).toBe(31050)
    expect(answer!.averageCents).toBe(210000 + 31050)
  })

  it('answers null rather than inventing a price when DAT refuses the credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    expect(await liveRateView(lane, { serviceAccountEmail: 'a@b.c', serviceAccountPassword: 'x' }, fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('answers null rather than throwing when the network fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    expect(await liveRateView(lane, { serviceAccountEmail: 'a@b.c', serviceAccountPassword: 'x' }, fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('answers null when DAT returns a body with no rate in it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rateResponses: [] }) })
    expect(await liveRateView(lane, { serviceAccountEmail: 'a@b.c', serviceAccountPassword: 'x' }, fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
