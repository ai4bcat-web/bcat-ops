import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getById: vi.fn(),
  transact: vi.fn(async () => {}),
  writeAudit: vi.fn(async () => {}),
}))
vi.mock('./store', () => ({
  SHIPMENT_TABLE_NAME: 'Shipment-test',
  getById: store.getById,
  transact: store.transact,
  writeAudit: store.writeAudit,
  nowIso: () => '2026-11-13T00:00:00.000Z',
  updateTx: (table: string, id: string, patch: unknown, options: unknown) => ({ table, id, patch, options }),
}))

import { clearFinanceReview } from './financeReview'

const caller = { email: 'ar@bcatcorp.com', sub: 's', groups: [], isAdmin: false }

describe('clearFinanceReview', () => {
  beforeEach(() => { store.getById.mockReset(); store.transact.mockClear(); store.writeAudit.mockClear() })

  it('removes the three flag fields and audits the old reason', async () => {
    store.getById.mockResolvedValue({ id: 'shp-1', financeReviewAt: '2026-11-13T00:00:00Z', financeReviewReason: 'No customer rate' })
    await expect(clearFinanceReview({ shipmentId: 'shp-1' }, caller)).resolves.toEqual({ shipmentId: 'shp-1', cleared: true })
    const [[writes]] = store.transact.mock.calls as unknown as [[{ options: { remove: string[] } }[]]]
    expect(writes[0].options.remove).toEqual(['financeReviewAt', 'financeReviewReason', 'financeReviewApNote'])
    expect(store.writeAudit).toHaveBeenCalledWith('SHIPMENT', 'shp-1', 'CLEAR_FINANCE_REVIEW', caller, { reason: 'No customer rate', note: null })
  })

  it('is a no-op on a shipment with no flag', async () => {
    store.getById.mockResolvedValue({ id: 'shp-2' })
    await expect(clearFinanceReview({ shipmentId: 'shp-2' }, caller)).resolves.toEqual({ shipmentId: 'shp-2', cleared: false })
    expect(store.transact).not.toHaveBeenCalled()
  })

  it('refuses an unknown shipment', async () => {
    store.getById.mockResolvedValue(null)
    await expect(clearFinanceReview({ shipmentId: 'nope' }, caller)).rejects.toThrow('Shipment not found')
  })
})
