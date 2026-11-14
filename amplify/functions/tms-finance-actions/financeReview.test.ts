import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getById: vi.fn(),
  queryIndex: vi.fn(async (_table: string, _index: string, _key: string, _value: string): Promise<unknown[]> => []),
  transact: vi.fn(async () => {}),
  writeAudit: vi.fn(async () => {}),
}))
vi.mock('./store', () => ({
  SHIPMENT_TABLE_NAME: 'Shipment-test',
  CARRIER_BILL_TABLE_NAME: 'CarrierBill-test',
  LOAD_TABLE_NAME: 'Load-test',
  LOAD_CARRIER_TABLE_NAME: 'LoadCarrier-test',
  IDX_BILLS_BY_CARRIER: 'bills',
  IDX_CARRIERS_BY_SHIPMENT: 'carriers',
  IDX_LOADS_BY_SHIPMENT: 'loads',
  getById: store.getById,
  queryIndex: store.queryIndex,
  transact: store.transact,
  writeAudit: store.writeAudit,
  nowIso: () => '2026-11-13T00:00:00.000Z',
  updateTx: (table: string, id: string, patch: unknown, options: unknown) => ({ table, id, patch, options }),
}))

import { clearFinanceReview, reasonWithoutDelivered, setDeliveredDate } from './financeReview'

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

describe('reasonWithoutDelivered', () => {
  it('drops only the delivered-date part', () => {
    expect(reasonWithoutDelivered('Missing delivered date')).toBe('')
    expect(reasonWithoutDelivered('No customer rate; Missing delivered date')).toBe('No customer rate')
    expect(reasonWithoutDelivered('No carrier')).toBe('No carrier')
  })
})

describe('setDeliveredDate', () => {
  type Write = { table: string; id: string; patch: Record<string, unknown>; options: { remove?: string[] } }
  const writes = () => (store.transact.mock.calls as unknown as [[Write[]]])[0][0]
  beforeEach(() => { store.getById.mockReset(); store.queryIndex.mockReset(); store.queryIndex.mockResolvedValue([]); store.transact.mockClear(); store.writeAudit.mockClear() })

  it('stamps noon Chicago, clears a delivered-only flag and re-dates a car bill in review', async () => {
    store.getById.mockResolvedValue({ id: 'shp-1', revDivision: 'CAR_SHIPPING', financeReviewAt: 'x', financeReviewReason: 'Missing delivered date' })
    store.queryIndex.mockImplementation(async (_t: string, index: string) => (
      index === 'carriers' ? [{ id: 'lc-1', carrierId: 'car-1' }]
        : index === 'bills' ? [
          { id: 'cb:lc-1:1', shipmentId: 'shp-1', loadId: 'lod-1', status: 'IN_REVIEW', datesPending: true, billDate: '2026-11-13', dueAt: '2026-12-13', version: 3 },
          { id: 'cb:other:1', shipmentId: 'shp-9', status: 'IN_REVIEW', version: 1 },
        ]
          : []))
    const out = await setDeliveredDate({ shipmentId: 'shp-1', deliveredDate: '2026-10-13' }, caller)
    expect(out).toMatchObject({ deliveredAt: '2026-10-13T17:00:00.000Z', reviewCleared: true, redatedBills: 1 })
    const [ship, bill] = writes()
    expect(ship.patch.deliveredAt).toBe('2026-10-13T17:00:00.000Z')
    expect(ship.options.remove).toEqual(['financeReviewAt', 'financeReviewReason', 'financeReviewApNote'])
    expect(bill).toMatchObject({ id: 'cb:lc-1:1', patch: { billDate: '2026-10-13', dueAt: '2026-10-15', datesPending: false, version: 4 } })
    expect(writes()).toHaveLength(2)
    expect(store.writeAudit).toHaveBeenCalledWith('SHIPMENT', 'shp-1', 'SET_DELIVERED_DATE', caller, expect.anything())
  })

  it('keeps the rest of the reason and leaves non-car bills alone', async () => {
    store.getById.mockResolvedValue({ id: 'shp-2', revDivision: 'BROKERAGE', financeReviewAt: 'x', financeReviewReason: 'No customer rate; Missing delivered date' })
    store.queryIndex.mockImplementation(async (_t: string, index: string) => (
      index === 'carriers' ? [{ id: 'lc-2', carrierId: 'car-2' }]
        : index === 'bills' ? [{ id: 'cb:lc-2:1', shipmentId: 'shp-2', status: 'IN_REVIEW', version: 1 }] : []))
    const out = await setDeliveredDate({ shipmentId: 'shp-2', deliveredDate: '2026-10-13' }, caller)
    expect(out).toMatchObject({ reviewCleared: false, reviewReason: 'No customer rate', redatedBills: 0 })
    expect(writes()).toHaveLength(1)
    expect(writes()[0].patch.financeReviewReason).toBe('No customer rate')
  })

  it('refuses a malformed or future date', async () => {
    store.getById.mockResolvedValue({ id: 'shp-3' })
    await expect(setDeliveredDate({ shipmentId: 'shp-3', deliveredDate: '10/13/2026' }, caller)).rejects.toThrow('YYYY-MM-DD')
    await expect(setDeliveredDate({ shipmentId: 'shp-3', deliveredDate: '2099-01-01' }, caller)).rejects.toThrow('future')
  })
})
