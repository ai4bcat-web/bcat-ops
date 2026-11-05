import { describe, expect, it, vi } from 'vitest'
import { REVIEW_MARKER, enterCarrierCharge, findActiveRepId, pickActiveRep, releaseForReview, reviewGaps } from './releaseFixture.mjs'

describe('pickActiveRep', () => {
  it('takes an ACTIVE person, never a throwaway ZZ identity or an inactive one, customer reps first', () => {
    const profiles = [
      { id: 'b-admin', email: 'b@x.com', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'zz1', email: 'zz-temp@x.com', role: 'CUSTOMER_REP', status: 'ACTIVE' },
      { id: 'tmp', email: 'ai4bcat+zzemail1@gmail.com', role: 'CUSTOMER_REP', status: 'ACTIVE' },
      { id: 'gone', email: 'g@x.com', role: 'CUSTOMER_REP', status: 'INACTIVE' },
      { id: 'pending', email: 'p@x.com', role: 'CUSTOMER_REP', status: 'PENDING' },
      { id: 'z-rep', email: 'pizza@x.com', role: 'CUSTOMER_REP', status: 'ACTIVE' },
      { id: 'a-rep', email: 'a@x.com', role: 'CUSTOMER_REP', status: 'ACTIVE' },
    ]
    expect(pickActiveRep(profiles)).toBe('a-rep')
    expect(pickActiveRep(profiles.filter((p) => p.role === 'ADMIN'))).toBe('b-admin')
    expect(pickActiveRep([profiles[3], profiles[4]])).toBeNull()
  })

  it('refuses to invent a rep when the stack has none', async () => {
    await expect(findActiveRepId(async () => ({ listUserProfiles: { items: [] } }))).rejects.toThrow(/no ACTIVE UserProfile/)
  })
})

describe('reviewGaps', () => {
  it('lists gate refusals then the review extras, as the sentences the server uses', () => {
    expect(reviewGaps({
      releaseGate: { missing: [{ code: 'DOC_MISSING', message: 'Missing document: POD' }] },
      extras: [{ code: 'SALES_REP_MISSING', message: 'Missing sales rep' }],
    })).toEqual(['Missing document: POD', 'Missing sales rep'])
    expect(reviewGaps({ releaseGate: { missing: [] }, extras: [] })).toEqual([])
  })
})

describe('releaseForReview', () => {
  const ready = { orderId: 'o1', orderUpdatedAt: 't1', releaseGate: { missing: [] }, extras: [] }
  const harness = (before, after = ready) => {
    const reads = [before, after]
    const calls = []
    const ship = vi.fn(async (action, input) => {
      calls.push([action, input])
      if (action === 'REVIEW_LOAD') return reads.length > 1 ? reads.shift() : reads[0]
      return { ok: true }
    })
    return { ship, calls }
  }

  it('sets the missing rep and division, then releases with the Load Review marker on the fresh order', async () => {
    const { ship, calls } = harness({ ...ready, salesRepId: null, revDivision: null })
    await releaseForReview({ ship, shipmentId: 's1', repId: 'rep-1' })
    expect(calls.map(([a]) => a)).toEqual(['REVIEW_LOAD', 'SET_SALES_REP', 'SET_REV_TAG', 'REVIEW_LOAD', 'READY_TO_INVOICE'])
    expect(calls[1][1]).toEqual({ shipmentId: 's1', repId: 'rep-1' })
    expect(calls[2][1]).toEqual({ shipmentId: 's1', divisionCode: 'BROKERAGE' })
    expect(calls[4][1]).toEqual({ orderId: 'o1', expectedUpdatedAt: 't1', review: REVIEW_MARKER })
  })

  it('leaves an already-tagged shipment alone, even when it names a different rep', async () => {
    const { ship, calls } = harness({ ...ready, salesRepId: 'demo-rep', revDivision: 'ASSETS' })
    await releaseForReview({ ship, shipmentId: 's1', repId: 'rep-1' })
    expect(calls.map(([a]) => a)).toEqual(['REVIEW_LOAD', 'REVIEW_LOAD', 'READY_TO_INVOICE'])
  })

  it('never sends the release for a fixture the server says is not ready', async () => {
    const gappy = { ...ready, salesRepId: 'rep-1', revDivision: 'BROKERAGE', extras: [{ code: 'EXPENSE_MISSING', message: 'No expense entered' }] }
    const { ship, calls } = harness(gappy, gappy)
    await expect(releaseForReview({ ship, shipmentId: 's1', repId: 'rep-1' })).rejects.toThrow('fixture not review-ready: No expense entered')
    expect(calls.map(([a]) => a)).not.toContain('READY_TO_INVOICE')
  })
})

describe('enterCarrierCharge', () => {
  const bundle = { shipment: { version: 4 }, loadCarriers: [{ id: 'own', status: 'ACTIVE', kind: 'OWN_ASSET' }, { id: 'lc1', status: 'ACTIVE', kind: 'CARRIER' }] }

  it('charges the active outside leg at the shipment version it just read', async () => {
    const ship = vi.fn(async (action) => (action === 'GET_SHIPMENT_BUNDLE' ? bundle : { ok: true }))
    await enterCarrierCharge({ ship, shipmentId: 's1', rateCents: 180000 })
    expect(ship).toHaveBeenLastCalledWith('UPDATE_CARRIER_CHARGES', {
      loadCarrierId: 'lc1', expectedVersion: 4, charges: [{ side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 }],
    })
  })

  it('refuses a shipment with no outside carrier rather than charging nothing', async () => {
    const ship = vi.fn(async () => ({ shipment: { version: 1 }, loadCarriers: [bundle.loadCarriers[0]] }))
    await expect(enterCarrierCharge({ ship, shipmentId: 's1', rateCents: 1 })).rejects.toThrow(/no active outside carrier leg/)
  })
})
