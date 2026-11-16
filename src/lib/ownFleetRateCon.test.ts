import { describe, expect, it } from 'vitest'
import { evaluateDocGate, isOutsideRateConKey, isOwnFleetLoad } from './shipmentDocuments'
import { evaluateReleaseGate } from './releaseGate'

const doc = (type: string, over: Record<string, unknown> = {}) => ({
  id: `d-${type}`, shipmentId: 's1', orderId: 'o1', type, status: 'ACTIVE', audience: 'ALL', name: `${type}.pdf`, s3Key: 'k', ...over,
}) as never
const ownLeg = { id: 'lc1', status: 'ACTIVE', kind: 'OWN_ASSET', rateConStatus: 'SIGNED' } as never

describe('own fleet needs an outside rate confirmation (Ryne 2026-11-16)', () => {
  it('tells an uploaded tender from a confirmation BCAT generated for a carrier', () => {
    expect(isOutsideRateConKey('rate-confirms/068ce47c/rate-confirm.pdf')).toBe(true)
    expect(isOutsideRateConKey('rate-confirms/carrier/load1/lc1-v1.pdf')).toBe(false)
    expect(isOutsideRateConKey('')).toBe(false)
    expect(isOutsideRateConKey(null)).toBe(false)
  })
  it('own fleet is the ASSETS division or only our own trucks', () => {
    expect(isOwnFleetLoad({ revDivision: 'ASSETS' })).toBe(true)
    expect(isOwnFleetLoad({ revDivision: 'BROKERAGE' }, [{ status: 'ACTIVE', kind: 'OWN_ASSET' }])).toBe(true)
    expect(isOwnFleetLoad({ revDivision: 'BROKERAGE' }, [{ status: 'ACTIVE', kind: 'CARRIER' }])).toBe(false)
  })
  it('our own truck "signing" our own rate con never satisfies the gate', () => {
    const gate = evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [doc('POD')], scope: 'CUSTOMER', ownFleet: true })
    expect(gate.missing).toContain('RATE_CON')
  })
  it('a generated carrier rate con on the load does not count; the customer tender does', () => {
    const base = { order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [doc('POD')], scope: 'CUSTOMER' as const, ownFleet: true }
    expect(evaluateDocGate({ ...base, loadRateConKeys: ['rate-confirms/carrier/l1/lc1-v1.pdf'] }).missing).toContain('RATE_CON')
    expect(evaluateDocGate({ ...base, loadRateConKeys: ['rate-confirms/l1/rate-confirm.pdf'] }).missing).not.toContain('RATE_CON')
  })
  it('a filed customer rate confirmation counts on own fleet, not on a brokerage load', () => {
    const docs = [doc('POD'), doc('CUSTOMER_RATE_CON', { audience: 'INTERNAL' })]
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: docs, scope: 'CUSTOMER', ownFleet: true }).missing).not.toContain('RATE_CON')
    // A factored brokerage customer still needs the carrier-side rate con for OTR; a customer tender is not it.
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [], documents: docs, scope: 'CUSTOMER', ownFleet: false, customer: { billingMethod: 'FACTOR' } as never }).missing).toContain('RATE_CON')
    // A brokered load for a customer that does not factor owes none (Ryne 2026-11-16).
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [], documents: [doc('POD')], scope: 'CUSTOMER', ownFleet: false, customer: { billingMethod: 'MANUAL' } as never }).required).not.toContain('RATE_CON')
  })
  it('the release gate agrees', () => {
    const input = {
      shipment: { status: 'DELIVERED', revDivision: 'ASSETS' },
      order: { arStatus: 'DOCS_NEEDED', references: [], invoiceId: null },
      requiredDocTypes: [], requiredReferenceCodes: [], openIncidentCount: 0,
      documents: [{ type: 'POD', status: 'ACTIVE' }],
      legs: [{ kind: 'OWN_ASSET', status: 'ACTIVE', rateConStatus: 'SIGNED', loadId: 'l1', driverId: 'd', deliveryDriverId: 'd' }],
      ownFleet: true,
    } as never
    const codes = (r: ReturnType<typeof evaluateReleaseGate>) => r.missing.map((m) => `${m.code}:${m.detail ?? ''}`)
    expect(codes(evaluateReleaseGate(input))).toContain('DOC_MISSING:RATE_CON')
    expect(codes(evaluateReleaseGate({ ...(input as object), ownFleetTenderOnLoad: true } as never))).not.toContain('DOC_MISSING:RATE_CON')
  })
})

describe('assetRateConTenders: the tender on the load, as the Documents box and the gate both read it', () => {
  it('lists outside tenders on live loads only', async () => {
    const { assetRateConTenders } = await import('./shipmentDocuments')
    expect(assetRateConTenders([
      { id: 'l1', rateConfirmKey: 'rate-confirms/l1/rate-confirm.pdf' },
      { id: 'l2', rateConfirmKey: 'rate-confirms/carrier/l2/lc-v1.pdf' },
      { id: 'l3', rateConfirmKey: 'rate-confirms/l3/rate-confirm.pdf', voidedAt: '2026-11-01' },
      { id: 'l4', rateConfirmKey: null },
    ])).toEqual([{ loadId: 'l1', key: 'rate-confirms/l1/rate-confirm.pdf' }])
  })
})
