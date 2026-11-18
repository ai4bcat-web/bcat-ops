// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'
import { chargeSignature, draftsOf } from '@/features/tms/loadReview/chargesEdit'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), recalc: vi.fn(), revise: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ getShipmentBundle: mocks.bundle, recalcCharges: mocks.recalc, reviseInvoice: mocks.revise }))
import { adjustmentsCentsOf, InvoiceNotRegeneratedError, rateEditBlock, saveInvoiceRates, validateCustomerLines } from './invoiceRateEdit'

const line = (over: Record<string, unknown>) => ({
  orderId: 'o-1', loadId: 'load-1', loadCarrierId: null, label: null, calculatedBy: 'FLAT', count: 1, release: null, note: null,
  createdBy: 'x', createdAt: 't', updatedAt: 't', ...over,
})
const bundle = {
  shipment: { id: 'shp-1', version: 4 },
  orders: [{ id: 'o-1' }],
  loads: [{ id: 'load-1', miles: 300, weight: 20000 }],
  loadCarriers: [{ id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', kind: 'CARRIER', sequence: 0, carrierId: 'car-1', carrierName: 'SHERIFAJ TRUCKING INC' }],
  charges: [
    line({ id: 'c1', side: 'CUSTOMER', code: 'LINEHAUL', label: 'Line Haul', rateCents: 110000, amountCents: 110000, isRate: true, sortOrder: 0 }),
    line({ id: 'k1', side: 'CARRIER', orderId: null, loadCarrierId: 'lc-1', code: 'LINEHAUL', label: 'Line Haul', rateCents: 90000, amountCents: 90000, isRate: true, sortOrder: 1 }),
  ],
  financials: [{ id: 'load-1', frozenAt: '2026-11-18T00:00:00Z' }],
  documents: [],
} as unknown as ShipmentBundle

const invoice = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: 'inv-1', number: '20073', orderId: 'o-1', shipmentId: 'shp-1', shipmentNumber: '20073', customerId: 'c', customerName: 'INTEGRITY',
  status: 'ISSUED', invoiceDate: '2026-11-18', issuedAt: '2026-11-18T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-18', termsDays: 30,
  invoiceMonth: '2026-11', subtotalCents: 110000, totalCents: 110000, paidCents: 0, writtenOffCents: 0, balanceCents: 110000,
  createdBy: 'x', updatedBy: 'x', version: 1, ...over,
} as InvoiceRecord)

beforeEach(() => { vi.clearAllMocks(); mocks.bundle.mockResolvedValue(bundle); mocks.recalc.mockResolvedValue(bundle) })

describe('rateEditBlock', () => {
  it('lets an unsent draft be edited', () => {
    expect(rateEditBlock(invoice(), null)).toBeNull()
  })
  it('refuses once sent, paid, void or with OTR, and says what to do instead', () => {
    expect(rateEditBlock(invoice({ sentAt: '2026-11-18T13:00:00Z' }), null)).toMatch(/already sent.*credit or debit/)
    expect(rateEditBlock(invoice({ markedSentAt: '2026-11-18T13:00:00Z' }), null)).toMatch(/already sent/)
    expect(rateEditBlock(invoice({ sentCount: 1 }), null)).toMatch(/already sent/)
    expect(rateEditBlock(invoice({ paidCents: 100 }), null)).toMatch(/credit memo/)
    expect(rateEditBlock(invoice({ status: 'PARTIAL' }), null)).toMatch(/credit memo/)
    expect(rateEditBlock(invoice({ status: 'VOID' }), null)).toMatch(/void/)
    expect(rateEditBlock(invoice(), { otrInvoiceId: '26192712' })).toMatch(/with OTR/)
  })
})

describe('validateCustomerLines', () => {
  it('needs positive customer amounts and a positive total', () => {
    const drafts = draftsOf(bundle)
    expect(validateCustomerLines(bundle, drafts, 0)).toBeNull()
    expect(validateCustomerLines(bundle, drafts.map((d) => (d.side === 'CUSTOMER' ? { ...d, rateCents: 0 } : d)), 0)).toMatch(/more than zero/)
    expect(validateCustomerLines(bundle, drafts.filter((d) => d.side !== 'CUSTOMER'), 0)).toMatch(/at least one charge/)
    expect(validateCustomerLines(bundle, drafts, -110000)).toMatch(/total must be more than zero/)
  })
  it('adds the hand credits and debits already on the invoice', () => {
    expect(adjustmentsCentsOf(invoice({ adjustments: [{ kind: 'CREDIT', description: 'a', amountCents: 500, reason: 'r' }, { kind: 'DEBIT', description: 'b', amountCents: 200, reason: 'r' }] }))).toBe(-300)
  })
})

describe('saveInvoiceRates', () => {
  it('saves the full charge set (carrier lines untouched) with the reason, then revises the invoice keeping its adjustments', async () => {
    const adjustments = [{ kind: 'CREDIT' as const, description: 'Late', amountCents: 500, reason: 'r' }]
    mocks.revise.mockResolvedValue({ invoice: invoice({ totalCents: 140000, adjustments }), revision: 1 })
    const drafts = draftsOf(bundle).map((d) => (d.code === 'LINEHAUL' && d.side === 'CUSTOMER' ? { ...d, rateCents: 140500 } : d))
    const out = await saveInvoiceRates({ invoice: invoice({ adjustments }), drafts, signature: chargeSignature(bundle), reason: 'Customer agreed to 1,405' })
    expect(mocks.recalc).toHaveBeenCalledTimes(1)
    const call = mocks.recalc.mock.calls[0][0]
    expect(call).toMatchObject({ shipmentId: 'shp-1', expectedVersion: 4, changeReason: 'Customer agreed to 1,405' })
    expect(call.charges.map((c: { side: string; code: string; rateCents: number }) => [c.side, c.code, c.rateCents])).toEqual([['CUSTOMER', 'LINEHAUL', 140500], ['CARRIER', 'LINEHAUL', 90000]])
    expect(mocks.revise).toHaveBeenCalledWith({ invoiceId: 'inv-1', adjustments, reason: 'Customer agreed to 1,405' })
    expect(mocks.recalc.mock.invocationCallOrder[0]).toBeLessThan(mocks.revise.mock.invocationCallOrder[0])
    expect(out).toMatchObject({ beforeCents: 110000, afterCents: 140000 })
  })

  it('refuses a reason that is too short and writes nothing', async () => {
    await expect(saveInvoiceRates({ invoice: invoice(), drafts: draftsOf(bundle), signature: chargeSignature(bundle), reason: 'ok' })).rejects.toThrow(/at least 5/)
    expect(mocks.recalc).not.toHaveBeenCalled()
  })

  it('refuses when the charge lines changed since they were opened', async () => {
    const moved = { ...bundle, charges: bundle.charges.map((c) => (c.id === 'c1' ? { ...c, rateCents: 120000 } : c)) } as unknown as ShipmentBundle
    mocks.bundle.mockResolvedValue(moved)
    await expect(saveInvoiceRates({ invoice: invoice(), drafts: draftsOf(bundle), signature: chargeSignature(bundle), reason: 'Rate corrected' })).rejects.toThrow(/changed somewhere else/)
    expect(mocks.recalc).not.toHaveBeenCalled()
  })

  it('says so when the charges saved but the invoice could not be regenerated', async () => {
    mocks.revise.mockRejectedValue(new Error('PDF failed'))
    await expect(saveInvoiceRates({ invoice: invoice(), drafts: draftsOf(bundle), signature: chargeSignature(bundle), reason: 'Rate corrected' })).rejects.toBeInstanceOf(InvoiceNotRegeneratedError)
  })
})
