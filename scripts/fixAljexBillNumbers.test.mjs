import { describe, it, expect } from 'vitest'
import { planBillNumberRepairs, isAljexImportBill, assertWritableSuffix, PROD_SUFFIX, DEV_SUFFIX } from './fixAljexBillNumbers.mjs'

const bill = (o) => ({ id: 'cb:lcr-aa:1', carrierId: 'c1', billNumber: 'Jordan', loadId: 'l1', loadNumber: '900001', createdBy: 'aljex-import', approvalWarnings: ['LEGACY_IMPORT'], version: 1, ...o })
const loads = [{ id: 'l1', aljexId: '900001' }, { id: 'l2', aljexId: '900002' }, { id: 'l3', aljexId: '900003' }]

describe('planBillNumberRepairs', () => {
  it('repairs the driver-name collision and is idempotent once applied', () => {
    const bills = [bill({}), bill({ id: 'cb:lcr-bb:1', loadId: 'l2', loadNumber: '900002' })]
    const plan = planBillNumberRepairs({ bills, loads })
    expect(plan.updates.map((u) => [u.id, u.from, u.to])).toEqual([['cb:lcr-aa:1', 'Jordan', '900001'], ['cb:lcr-bb:1', 'Jordan', '900002']])
    const after = bills.map((b, i) => ({ ...b, billNumber: plan.updates[i].to }))
    expect(planBillNumberRepairs({ bills: after, loads })).toMatchObject({ updates: [], counts: { alreadyCorrect: 2, planned: 0 } })
  })

  it('never touches bills the import did not create', () => {
    const others = [
      bill({ id: 'cb:lcr-zz:1', createdBy: 'zz-test' }),
      bill({ id: 'cb:other-1:1', createdBy: 'aljex-import' }),
      bill({ id: 'cb:lcr-app:1', approvalWarnings: [] }),
      bill({ id: 'cb:lcr-app2:1', approvalWarnings: undefined }),
    ]
    expect(planBillNumberRepairs({ bills: others, loads })).toMatchObject({ updates: [], counts: { importBills: 0 } })
    expect(isAljexImportBill(others[0])).toBe(false)
  })

  it('skips a missing load PRO, a disagreeing loadNumber, and a new number that would collide with another bill of the carrier', () => {
    const bills = [
      bill({ id: 'cb:lcr-1:1', loadId: 'gone' }),
      bill({ id: 'cb:lcr-2:1', loadId: 'l2', loadNumber: '777' }),
      bill({ id: 'cb:lcr-3:1', loadId: 'l3', loadNumber: '900003' }),
      { id: 'manual', carrierId: 'c1', billNumber: '900003', createdBy: 'someone' },
    ]
    const { updates, counts } = planBillNumberRepairs({ bills, loads })
    expect(updates).toEqual([])
    expect(counts).toMatchObject({ skippedNoLoadPro: 1, skippedLoadNumberMismatch: 1, skippedCollision: 1, planned: 0 })
  })

  it('compares PROs the way the app does for the loadNumber check but writes the load PRO verbatim', () => {
    const { updates } = planBillNumberRepairs({ bills: [bill({ loadNumber: 'PRO 900001' })], loads })
    expect(updates[0].to).toBe('900001')
  })
})

describe('assertWritableSuffix', () => {
  it('accepts only the dev suffix', () => {
    expect(() => assertWritableSuffix(DEV_SUFFIX)).not.toThrow()
    expect(() => assertWritableSuffix(PROD_SUFFIX)).toThrow(/production/)
    expect(() => assertWritableSuffix('abc-NONE')).toThrow()
  })
})
