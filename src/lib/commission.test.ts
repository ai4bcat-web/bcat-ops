import { describe, it, expect } from 'vitest'
import {
  CANCELLED_BY_RERUN,
  allocateCents,
  commissionBasis,
  commissionId,
  commissionState,
  computeCommissions,
  netCentsOf,
  payPeriodTotals,
  pctOfCents,
  periodWindow,
  reconcileCommissions,
  resolvePlan,
  reverseFor,
  roleAmountCents,
  rolePeople,
  roundHalfAwayFromZero,
  tierRate,
  validateCommissionPlans,
  validatePaySchedule,
} from './commission'
import type {
  CommissionPlan,
  CommissionPlanRole,
  CommissionRecord,
  CommissionStatus,
} from '../types/tms'
import type { ComputeContext } from './commission'

const NOW = '2026-10-28T12:00:00.000Z'

const percentPlan = (over: Partial<CommissionPlan> = {}): CommissionPlan => ({
  id: 'plan-house',
  name: 'House plan',
  active: true,
  roles: [{ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 1000 }],
  ...over,
})

const ctx = (over: Partial<ComputeContext> = {}): ComputeContext => ({
  order: {
    id: 'ord-1',
    shipmentId: 'shp-1',
    customerId: 'cus-1',
    customerName: 'Acme',
    customerRepId: 'rep@bcatcorp.com',
    createdBy: 'creator@bcatcorp.com',
    invoicedAt: '2026-10-20T00:00:00.000Z',
    divisionKey: 'BCAT',
  },
  invoice: { id: 'inv-1', number: 'INV-1', totalCents: 250_000, writtenOffCents: 0 },
  customer: { accountOwnerIds: ['owner@bcatcorp.com'], teamKey: 'EAST' },
  shipment: { number: 'S000001' },
  loads: [{ id: 'load-1', carrierRepId: 'carrier.rep@bcatcorp.com' }],
  assignments: [
    { kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Fast Freight', chargesFinalizedAt: NOW },
  ],
  financials: [{ costCents: 180_000 }],
  profiles: {},
  plans: [percentPlan()],
  trigger: 'GENERATE_INVOICE',
  triggerAt: '2026-10-20T00:00:00.000Z',
  caller: 'biller@bcatcorp.com',
  nowIso: NOW,
  ...over,
})

const row = (over: Partial<CommissionRecord> = {}): CommissionRecord => ({
  id: 'cm:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com',
  kind: 'EARNED',
  orderId: 'ord-1',
  invoiceId: 'inv-1',
  repId: 'owner@bcatcorp.com',
  roleName: 'PRIMARY_ACCOUNT_OWNER',
  basisCents: 70_000,
  revenueCents: 250_000,
  costCents: 180_000,
  profitCents: 70_000,
  amountCents: 7_000,
  netCents: 7_000,
  status: 'UN_APPROVED',
  triggerAt: '2026-10-20T00:00:00.000Z',
  commissionMonth: '2026-10',
  computedAt: NOW,
  createdBy: 'biller@bcatcorp.com',
  updatedBy: 'biller@bcatcorp.com',
  version: 1,
  ...over,
})

describe('rounding', () => {
  it('rounds a half away from zero in both directions', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3)
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3)
    expect(roundHalfAwayFromZero(2.4)).toBe(2)
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2)
  })

  it('reverses exactly: a negated amount is the negation of the amount', () => {
    // Math.round would give 2 for -2.5 and 3 for 2.5, leaking a cent on reversal.
    const forward = pctOfCents(50_005, 500)
    const back = pctOfCents(-50_005, 500)
    expect(forward).toBe(2500)
    expect(back).toBe(-2500)
    expect(forward + back).toBe(0)
  })

  it('takes a percentage once, not twice', () => {
    expect(pctOfCents(333_333, 333)).toBe(roundHalfAwayFromZero((333_333 * 333) / 10000))
  })
})

describe('allocateCents', () => {
  it('hands out the exact total however the weights fall', () => {
    expect(allocateCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100)
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocateCents(1, [5000, 5000])).toEqual([1, 0])
  })

  it('keeps the sum exact for negative totals too', () => {
    const shares = allocateCents(-100, [1, 1, 1])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-100)
  })

  it('splits evenly when every weight is zero', () => {
    expect(allocateCents(10, [0, 0])).toEqual([5, 5])
  })

  it('never loses or invents a cent across many splits', () => {
    for (let total = -500; total <= 500; total += 7) {
      for (const weights of [[1], [1, 1], [1, 2], [7000, 2000, 1000], [1, 1, 1, 1, 1, 1, 1]]) {
        const shares = allocateCents(total, weights)
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })
})

describe('commissionBasis', () => {
  it('subtracts write-offs from revenue and ignores credit memos', () => {
    const basis = commissionBasis({
      invoice: { totalCents: 250_000, writtenOffCents: 50_000 },
      financials: [{ costCents: 100_000 }],
    })
    expect(basis.revenueCents).toBe(200_000)
    expect(basis.profitCents).toBe(100_000)
    expect(basis.marginBps).toBe(5000)
  })

  it('says nothing rather than Infinity about a zero-revenue invoice', () => {
    const basis = commissionBasis({ invoice: { totalCents: 0 }, financials: [{ costCents: 0 }] })
    expect(basis.marginBps).toBeNull()
  })

  it('flags own fleet and reports whether the cost can still move', () => {
    const own = commissionBasis({
      invoice: { totalCents: 100_000 },
      financials: [{ costCents: 0 }],
      assignments: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }],
    })
    expect(own.ownFleet).toBe(true)
    expect(own.costFinal).toBe(true)

    const pending = commissionBasis({
      invoice: { totalCents: 100_000 },
      financials: [{ costCents: 70_000 }],
      assignments: [{ kind: 'CARRIER', status: 'ACTIVE', chargesFinalizedAt: null }],
    })
    expect(pending.ownFleet).toBe(false)
    expect(pending.costFinal).toBe(false)
  })
})

describe('resolvePlan', () => {
  const user = percentPlan({ id: 'by-user', scope: { userIds: ['rep@bcatcorp.com'] } })
  const customer = percentPlan({ id: 'by-customer', scope: { customerIds: ['cus-1'] } })
  const team = percentPlan({ id: 'by-team', scope: { teamKeys: ['EAST'] } })
  const house = percentPlan({ id: 'house' })
  const all = [house, team, customer, user]

  it('prefers user over customer over team over the house plan', () => {
    expect(resolvePlan(all, { repId: 'rep@bcatcorp.com', customerId: 'cus-1', teamKey: 'EAST', asOf: '2026-10-20' })?.id).toBe('by-user')
    expect(resolvePlan(all, { customerId: 'cus-1', teamKey: 'EAST', asOf: '2026-10-20' })?.id).toBe('by-customer')
    expect(resolvePlan(all, { teamKey: 'EAST', asOf: '2026-10-20' })?.id).toBe('by-team')
    expect(resolvePlan(all, { asOf: '2026-10-20' })?.id).toBe('house')
  })

  it('skips an inactive plan and one outside its window', () => {
    const dormant = percentPlan({ id: 'dormant', active: false })
    const future = percentPlan({ id: 'future', effectiveFrom: '2027-01-01' })
    const past = percentPlan({ id: 'past', effectiveTo: '2026-01-01' })
    expect(resolvePlan([dormant, future, past], { asOf: '2026-10-20' })).toBeNull()
    expect(resolvePlan([future], { asOf: '2027-02-01' })?.id).toBe('future')
  })

  it('returns nothing rather than guessing when no plan applies', () => {
    expect(resolvePlan([], { asOf: '2026-10-20' })).toBeNull()
    expect(resolvePlan(null, { asOf: '2026-10-20' })).toBeNull()
  })
})

describe('rolePeople', () => {
  const people = (role: CommissionPlanRole, over = {}) =>
    rolePeople(role, {
      order: { createdBy: 'creator@x.com', customerRepId: 'rep@x.com' },
      customer: { accountOwnerIds: ['owner1@x.com', 'owner2@x.com'], operatedById: 'ops@x.com', gpSplitBps: 5000 },
      loads: [{ carrierRepId: 'crep1@x.com' }, { carrierRepId: 'crep2@x.com' }],
      assignments: [
        { carrierRepId: 'booker@x.com', status: 'ACTIVE' },
        { carrierRepId: 'bounced@x.com', status: 'BOUNCED' },
      ],
      profiles: { 'owner1@x.com': { managerId: 'boss@x.com' } },
      ...over,
    })

  it('resolves each role to the people already named on the records', () => {
    expect(people({ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT' })).toEqual([
      { repId: 'owner1@x.com', splitBps: null },
    ])
    expect(people({ roleName: 'SECONDARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT' })).toEqual([
      { repId: 'owner2@x.com', splitBps: 5000 },
    ])
    expect(people({ roleName: 'PRIMARY_OPERATED_BY', rateType: 'PERCENT_PROFIT' })[0].repId).toBe('ops@x.com')
    expect(people({ roleName: 'PRIMARY_CARRIER_REP', rateType: 'PERCENT_PROFIT' })[0].repId).toBe('crep1@x.com')
    expect(people({ roleName: 'SECONDARY_CARRIER_REP', rateType: 'PERCENT_PROFIT' })[0].repId).toBe('crep2@x.com')
    expect(people({ roleName: 'CREATED_BY', rateType: 'PERCENT_PROFIT' })[0].repId).toBe('creator@x.com')
    expect(people({ roleName: 'MANAGER', rateType: 'PERCENT_PROFIT' })[0].repId).toBe('boss@x.com')
    expect(people({ roleName: 'SPECIFIC_USER', rateType: 'FIXED', rateCents: 100, userIds: ['named@x.com'] })[0].repId).toBe('named@x.com')
  })

  it('only pays the booking rep of a live assignment', () => {
    expect(people({ roleName: 'CARRIER_BOOKING_REP', rateType: 'PERCENT_PROFIT' })).toEqual([
      { repId: 'booker@x.com', splitBps: null },
    ])
  })

  it('falls back to the order customer rep when the customer names no owner', () => {
    const resolved = people({ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT' }, { customer: null })
    expect(resolved).toEqual([{ repId: 'rep@x.com', splitBps: null }])
  })

  it('names nobody rather than guessing when the record is empty', () => {
    const none = rolePeople(
      { roleName: 'PRIMARY_CARRIER_REP', rateType: 'PERCENT_PROFIT' },
      { order: {}, loads: [], assignments: [] },
    )
    expect(none).toEqual([])
  })
})

describe('tiers', () => {
  const graduated: CommissionPlanRole = {
    roleName: 'PRIMARY_ACCOUNT_OWNER',
    rateType: 'PERCENT_PROFIT',
    rateBps: 0,
    tierType: 'PER_LOAD_PROFIT_CENTS',
    graduated: true,
    tiers: [
      { fromCents: 0, rateBps: 1000 },
      { fromCents: 50_000, rateBps: 2000 },
    ],
  }
  const straight: CommissionPlanRole = { ...graduated, graduated: false }

  const basisAt = (profitCents: number) =>
    commissionBasis({ invoice: { totalCents: 100_000 }, financials: [{ costCents: 100_000 - profitCents }] })

  it('a straight ladder pays the band the load lands in, on the whole basis', () => {
    expect(roleAmountCents(straight, basisAt(49_999)).amountCents).toBe(pctOfCents(49_999, 1000))
    expect(roleAmountCents(straight, basisAt(50_000)).amountCents).toBe(pctOfCents(50_000, 2000))
  })

  it('a graduated ladder pays each band on its own slice', () => {
    // $600 profit: the first $500 at 10 %, the last $100 at 20 %.
    expect(roleAmountCents(graduated, basisAt(60_000)).amountCents).toBe(5_000 + 2_000)
    expect(roleAmountCents(graduated, basisAt(50_000)).amountCents).toBe(5_000)
  })

  it('labels the band it used', () => {
    expect(tierRate(straight, basisAt(60_000)).tierLabel).toBe('from $500.00')
  })

  it('a margin ladder picks the band by margin, not by amount', () => {
    const marginRole: CommissionPlanRole = {
      roleName: 'PRIMARY_ACCOUNT_OWNER',
      rateType: 'PERCENT_REVENUE',
      rateBps: 100,
      tierType: 'PER_LOAD_MARGIN_BPS',
      tiers: [
        { fromBps: 0, rateBps: 100 },
        { fromBps: 2000, rateBps: 300 },
      ],
    }
    expect(tierRate(marginRole, basisAt(10_000)).rateBps).toBe(100)
    expect(tierRate(marginRole, basisAt(30_000)).rateBps).toBe(300)
  })
})

describe('computeCommissions', () => {
  it('pays the plan rate on the frozen money and stamps a deterministic id', () => {
    const [first, ...rest] = computeCommissions(ctx())
    expect(rest).toHaveLength(0)
    expect(first.id).toBe('cm:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com')
    expect(first.row.revenueCents).toBe(250_000)
    expect(first.row.costCents).toBe(180_000)
    expect(first.row.profitCents).toBe(70_000)
    expect(first.amountCents).toBe(7_000)
    expect(first.row.status).toBe('UN_APPROVED')
    expect(first.row.commissionMonth).toBe('2026-10')
    expect(first.row.teamKey).toBe('EAST')
  })

  it('is deterministic: the same facts give the same rows twice', () => {
    expect(computeCommissions(ctx())).toEqual(computeCommissions(ctx()))
  })

  it('pays an own-fleet order nothing under a profit plan and says why', () => {
    const rows = computeCommissions(
      ctx({
        assignments: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }],
        financials: [{ costCents: 0 }],
      }),
    )
    expect(rows[0].amountCents).toBe(0)
    expect(rows[0].row.basisNote).toBe('OWN_FLEET_NO_COST')
    expect(rows[0].row.needsReview).toBe(true)
  })

  it('still pays an own-fleet order under a revenue plan', () => {
    const rows = computeCommissions(
      ctx({
        plans: [percentPlan({ roles: [{ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_REVENUE', rateBps: 200 }] })],
        assignments: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }],
        financials: [{ costCents: 0 }],
      }),
    )
    expect(rows[0].amountCents).toBe(5_000)
    expect(rows[0].row.needsReview).toBe(false)
  })

  it('splits a role between its people without losing a cent', () => {
    const rows = computeCommissions(
      ctx({
        customer: { accountOwnerIds: ['a@x.com', 'b@x.com', 'c@x.com'], teamKey: 'EAST' },
        plans: [percentPlan({ roles: [{ roleName: 'SECONDARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 1000 }] })],
        invoice: { id: 'inv-1', totalCents: 250_001, writtenOffCents: 0 },
      }),
    )
    // Two secondary owners share the role's pot exactly.
    const pot = pctOfCents(250_001 - 180_000, 1000)
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(pot)
  })

  it('writes nothing at all when no plan applies', () => {
    expect(computeCommissions(ctx({ plans: [] }))).toEqual([])
  })
})

describe('reconcileCommissions', () => {
  const desired = computeCommissions(ctx())

  it('writes the row set once and finds nothing to do the second time', () => {
    const first = reconcileCommissions([], desired, { nowIso: NOW, caller: 'me' })
    expect(first.puts).toHaveLength(1)

    const stored = row({ ...desired[0].row })
    const second = reconcileCommissions([stored], desired, { nowIso: NOW, caller: 'me' })
    expect(second.puts).toHaveLength(0)
    expect(second.updates).toHaveLength(0)
    expect(second.adjustments).toHaveLength(0)
    expect(second.untouched).toHaveLength(1)
  })

  it('rewrites an unapproved row in place when the money moves', () => {
    const stored = row({ ...desired[0].row, amountCents: 5_000, costCents: 200_000, profitCents: 50_000 })
    const plan = reconcileCommissions([stored], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].patch.amountCents).toBe(7_000)
    expect(plan.updates[0].patch.source).toBe('RERUN')
    expect(plan.updates[0].patch.version).toBe(2)
    expect(plan.adjustments).toHaveLength(0)
  })

  it('never touches an approved row and books the exact difference as an adjustment', () => {
    const approved = row({ ...desired[0].row, amountCents: 5_000, status: 'MANAGER_APPROVED' })
    const plan = reconcileCommissions([approved], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.updates).toHaveLength(0)
    expect(plan.adjustments).toHaveLength(1)
    expect(plan.adjustments[0].amountCents).toBe(2_000)
    expect(plan.adjustments[0].kind).toBe('ADJUSTMENT')
    expect(plan.adjustments[0].adjustsId).toBe(approved.id)
    expect(plan.adjustments[0].status).toBe('UN_APPROVED')
  })

  it('counts the adjustments already booked, so a second rerun does not double-pay', () => {
    const approved = row({ ...desired[0].row, amountCents: 5_000, status: 'MANAGER_APPROVED' })
    const adjustment = row({
      id: 'cma:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com:1',
      kind: 'ADJUSTMENT',
      adjustsId: approved.id,
      amountCents: 2_000,
      netCents: 2_000,
    })
    const plan = reconcileCommissions([approved, adjustment], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.adjustments).toHaveLength(0)
  })

  it('cancels an unapproved row for somebody who has left the record', () => {
    const stale = row({ id: commissionId('ord-1', 'CREATED_BY', 'gone@x.com'), repId: 'gone@x.com', roleName: 'CREATED_BY' })
    const plan = reconcileCommissions([stale, row({ ...desired[0].row })], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.cancels).toHaveLength(1)
    expect(plan.cancels[0].reason).toBe(CANCELLED_BY_RERUN)
    expect(plan.reversals).toHaveLength(0)
  })

  it('reverses an approved row for somebody who has left the record', () => {
    const stale = row({
      id: commissionId('ord-1', 'CREATED_BY', 'gone@x.com'),
      repId: 'gone@x.com',
      roleName: 'CREATED_BY',
      status: 'FULLY_APPROVED',
      amountCents: 4_000,
      netCents: 4_000,
    })
    const plan = reconcileCommissions([stale, row({ ...desired[0].row })], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.cancels).toHaveLength(0)
    expect(plan.reversals).toHaveLength(1)
    expect(plan.reversals[0].amountCents).toBe(-4_000)
    expect(plan.reversals[0].kind).toBe('REVERSAL')
  })

  it('brings a row cancelled by an earlier rerun back when the person returns', () => {
    const cancelled = row({ ...desired[0].row, status: 'CANCELLED', cancelReason: CANCELLED_BY_RERUN })
    const plan = reconcileCommissions([cancelled], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].patch.status).toBe('UN_APPROVED')
  })

  it('leaves a row cancelled by a void alone', () => {
    const voided = row({ ...desired[0].row, status: 'CANCELLED', cancelReason: 'INVOICE_VOIDED' })
    const plan = reconcileCommissions([voided], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.updates).toHaveLength(0)
    expect(plan.untouched).toHaveLength(1)
  })

  it('keeps an override when a rerun moves the computed number', () => {
    const overridden = row({ ...desired[0].row, amountCents: 5_000, overrideCents: 9_900, netCents: 9_900 })
    const plan = reconcileCommissions([overridden], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.updates[0].patch.amountCents).toBe(7_000)
    expect(plan.updates[0].patch.netCents).toBe(9_900)
  })
})

describe('reverseFor', () => {
  it('cancels what is unapproved and reverses what is approved', () => {
    const open = row({ id: 'a', status: 'UN_APPROVED' })
    const approved = row({ id: 'b', status: 'FULLY_APPROVED', amountCents: 3_333, netCents: 3_333 })
    const paid = row({ id: 'c', status: 'PAID', amountCents: 1_000, netCents: 1_000 })
    const result = reverseFor([open, approved, paid], { nowIso: NOW, caller: 'me', reason: 'INVOICE_VOIDED' })

    expect(result.cancels.map((c) => c.existing.id)).toEqual(['a'])
    expect(result.reversals.map((r) => r.amountCents)).toEqual([-3_333, -1_000])
    expect(result.reversals.every((r) => r.status === 'UN_APPROVED')).toBe(true)
  })

  it('never reverses a reversal', () => {
    const reversal = row({ id: 'r', kind: 'REVERSAL', status: 'FULLY_APPROVED' })
    const result = reverseFor([reversal], { nowIso: NOW, caller: 'me', reason: 'INVOICE_VOIDED' })
    expect(result.reversals).toHaveLength(0)
    expect(result.cancels).toHaveLength(0)
  })
})

describe('commissionState', () => {
  const rep = { email: 'owner@bcatcorp.com', isAdmin: false, isManager: false }
  const manager = { email: 'boss@bcatcorp.com', isAdmin: false, isManager: true }

  it('lets a rep counter only their own unapproved row', () => {
    expect(commissionState(row(), rep).canCounter).toBe(true)
    expect(commissionState(row({ repId: 'someone@else.com' }), rep).canCounter).toBe(false)
    expect(commissionState(row(), rep).canApprove).toBe(false)
  })

  it('knows a row stored under the username is the signed-in rep\'s own', () => {
    // The picker stores the Cognito username; the pool signs people in by e-mail.
    const signedIn = { id: 'a4786438-50e1-70cd', email: 'owner@bcatcorp.com', isAdmin: false, isManager: true, mayApprove: true }
    const byUsername = row({ repId: 'a4786438-50e1-70cd' })
    expect(commissionState(byUsername, signedIn)).toMatchObject({ isOwnRow: true, canCounter: true, canApprove: false })
    expect(commissionState(row({ repId: 'owner@bcatcorp.com' }), signedIn).isOwnRow).toBe(true)
    expect(commissionState(byUsername, { ...signedIn, id: 'somebody-else' }).canApprove).toBe(true)
  })

  it('lets a manager approve, counter, override and cancel an open row', () => {
    const state = commissionState(row(), manager)
    expect(state).toMatchObject({ canApprove: true, canCounter: true, canOverride: true, canCancel: true })
  })

  it('closes a manager out when approval is admin-only', () => {
    const state = commissionState(row(), { ...manager, mayApprove: false })
    expect(state.canApprove).toBe(false)
    expect(state.canOverride).toBe(false)
  })

  it('hands the counter back to the other side', () => {
    expect(commissionState(row({ status: 'MANAGER_COUNTERED' }), rep).canAcceptCounter).toBe(true)
    expect(commissionState(row({ status: 'REP_COUNTERED' }), manager).canAcceptCounter).toBe(true)
    expect(commissionState(row({ status: 'REP_COUNTERED' }), rep).canAcceptCounter).toBe(false)
  })

  it('allows nothing once a row is paid or cancelled', () => {
    for (const status of ['PAID', 'CANCELLED'] as CommissionStatus[]) {
      const state = commissionState(row({ status }), manager)
      expect(state).toMatchObject({ canApprove: false, canCounter: false, canOverride: false, canCancel: false })
    }
  })
})

describe('netCentsOf', () => {
  it('prefers an override, then an accepted counter, then the plan', () => {
    expect(netCentsOf({ amountCents: 100, overrideCents: 250, counterCents: 180, status: 'FULLY_APPROVED' })).toBe(250)
    expect(netCentsOf({ amountCents: 100, overrideCents: null, counterCents: 180, status: 'FULLY_APPROVED' })).toBe(180)
    expect(netCentsOf({ amountCents: 100, overrideCents: null, counterCents: 180, status: 'REP_COUNTERED' })).toBe(100)
  })
})

describe('periodWindow', () => {
  it('runs a week Monday to Sunday', () => {
    expect(periodWindow({ frequency: 'WEEKLY', daysUntilPay: 5 }, '2026-10-28')).toEqual({
      periodStart: '2026-10-26',
      periodEnd: '2026-11-01',
      payDate: '2026-11-06',
    })
  })

  it('counts a fortnight from the anchor Monday', () => {
    const schedule = { frequency: 'BIWEEKLY' as const, anchorDate: '2026-01-05', daysUntilPay: 7 }
    expect(periodWindow(schedule, '2026-01-05').periodStart).toBe('2026-01-05')
    expect(periodWindow(schedule, '2026-01-18').periodStart).toBe('2026-01-05')
    expect(periodWindow(schedule, '2026-01-19').periodStart).toBe('2026-01-19')
  })

  it('splits a month in two halves', () => {
    expect(periodWindow({ frequency: 'SEMI_MONTHLY', daysUntilPay: 0 }, '2026-02-15')).toMatchObject({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-15',
    })
    expect(periodWindow({ frequency: 'SEMI_MONTHLY', daysUntilPay: 0 }, '2026-02-16')).toMatchObject({
      periodStart: '2026-02-16',
      periodEnd: '2026-02-28',
    })
  })

  it('ends a month on its real last day and pays on the named day of the next', () => {
    expect(periodWindow({ frequency: 'MONTHLY', payDay: 10 }, '2026-12-31')).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      payDate: '2027-01-10',
    })
  })
})

describe('payPeriodTotals', () => {
  it('totals what is owed per rep and ignores cancelled rows', () => {
    const rows = [
      row({ id: '1', repId: 'a@x.com', netCents: 1_000 }),
      row({ id: '2', repId: 'a@x.com', netCents: 700, overrideCents: 700 }),
      row({ id: '3', repId: 'b@x.com', netCents: 2_000 }),
      row({ id: '4', repId: 'b@x.com', netCents: 9_999, status: 'CANCELLED' }),
    ]
    const totals = payPeriodTotals(rows)
    expect(totals.commissionCount).toBe(3)
    expect(totals.totalCents).toBe(1_000 + 700 + 2_000)
    expect(totals.byRep[0]).toMatchObject({ repId: 'b@x.com', amountCents: 2_000 })
  })
})

describe('validateCommissionPlans', () => {
  const plan = (roles: unknown) => [{ id: 'p1', name: 'Plan', roles }]

  it('accepts a plan and normalises it', () => {
    const [saved] = validateCommissionPlans(plan([{ roleName: 'CREATED_BY', rateType: 'PERCENT_REVENUE', rateBps: 150 }])) ?? []
    expect(saved.active).toBe(true)
    expect(saved.roles[0]).toMatchObject({ rateBps: 150, rateCents: null })
  })

  it('refuses a graduated ladder over margin bands', () => {
    expect(() =>
      validateCommissionPlans(
        plan([
          {
            roleName: 'CREATED_BY',
            rateType: 'PERCENT_PROFIT',
            rateBps: 100,
            tierType: 'PER_LOAD_MARGIN_BPS',
            graduated: true,
            tiers: [{ fromBps: 0, rateBps: 100 }],
          },
        ]),
      ),
    ).toThrow(/graduated/)
  })

  it('refuses tiers that do not start at zero or do not ascend', () => {
    const tiered = (tiers: unknown) =>
      plan([{ roleName: 'CREATED_BY', rateType: 'PERCENT_PROFIT', rateBps: 100, tierType: 'PER_LOAD_PROFIT_CENTS', tiers }])
    expect(() => validateCommissionPlans(tiered([{ fromCents: 100, rateBps: 100 }]))).toThrow(/start at 0/)
    expect(() =>
      validateCommissionPlans(tiered([{ fromCents: 0, rateBps: 100 }, { fromCents: 0, rateBps: 200 }])),
    ).toThrow(/above the tier before it/)
  })

  it('refuses an unknown role, a bad rate and a duplicate plan id', () => {
    expect(() => validateCommissionPlans(plan([{ roleName: 'NOBODY', rateType: 'PERCENT_PROFIT', rateBps: 10 }]))).toThrow(/not a commission role/)
    expect(() => validateCommissionPlans(plan([{ roleName: 'CREATED_BY', rateType: 'PERCENT_PROFIT', rateBps: 20_000 }]))).toThrow(/between 0 and 10000/)
    expect(() =>
      validateCommissionPlans([
        { id: 'p1', name: 'A', roles: [{ roleName: 'CREATED_BY', rateType: 'FIXED', rateCents: 100 }] },
        { id: 'p1', name: 'B', roles: [{ roleName: 'CREATED_BY', rateType: 'FIXED', rateCents: 100 }] },
      ]),
    ).toThrow(/used twice/)
  })

  it('refuses a SPECIFIC_USER role with nobody named, and a plan with no roles', () => {
    expect(() => validateCommissionPlans(plan([{ roleName: 'SPECIFIC_USER', rateType: 'FIXED', rateCents: 100 }]))).toThrow(/needs at least one user/)
    expect(() => validateCommissionPlans(plan([]))).toThrow(/at least one role/)
  })

  it('refuses a window that ends before it starts', () => {
    expect(() =>
      validateCommissionPlans([
        { id: 'p', name: 'P', effectiveFrom: '2026-05-01', effectiveTo: '2026-04-01', roles: [{ roleName: 'CREATED_BY', rateType: 'FIXED', rateCents: 1 }] },
      ]),
    ).toThrow(/ends before it starts/)
  })
})

describe('validatePaySchedule', () => {
  it('accepts a schedule and refuses an unknown frequency or an impossible pay day', () => {
    expect(validatePaySchedule({ frequency: 'MONTHLY', payDay: 10, daysUntilPay: 5 })).toEqual({
      frequency: 'MONTHLY',
      payDay: 10,
      daysUntilPay: 5,
      anchorDate: null,
    })
    expect(() => validatePaySchedule({ frequency: 'HOURLY' })).toThrow(/frequency/)
    expect(() => validatePaySchedule({ frequency: 'WEEKLY', payDay: 9 })).toThrow(/between 0 and 6/)
  })
})

describe('splits, reversals and the ladder (review fixes)', () => {
  it('a split never invents or loses a cent, however odd the pot', () => {
    // $1,000.01 revenue, no cost → pot 10001 × 10 % = 1000.1 → 1000¢; two owners
    // at 50 % each must share exactly that, not take half of it apiece.
    const rows = computeCommissions(
      ctx({
        invoice: { id: 'inv-odd', totalCents: 100_001, writtenOffCents: 0 },
        financials: [{ costCents: 0 }],
        customer: { accountOwnerIds: ['a@x.com', 'b@x.com', 'c@x.com'], teamKey: 'EAST' },
        plans: [
          percentPlan({
            roles: [{ roleName: 'SECONDARY_ACCOUNT_OWNER', rateType: 'PERCENT_REVENUE', rateBps: 1000, splitBps: 5000 }],
          }),
        ],
      }),
    )
    const pot = pctOfCents(100_001, 1000)
    expect(rows).toHaveLength(2)
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(pot)
  })

  it('an admin closes a row a manager approved — otherwise nothing is ever payable', () => {
    const manager = { email: 'boss@bcatcorp.com', isAdmin: false, isManager: true }
    const admin = { email: 'ryne@bcatcorp.com', isAdmin: true, isManager: false }
    expect(commissionState(row({ status: 'MANAGER_APPROVED' }), manager).canApprove).toBe(false)
    expect(commissionState(row({ status: 'MANAGER_APPROVED' }), admin).canApprove).toBe(true)
  })

  it('nobody signs off their own number', () => {
    const managerOnOwnRow = { email: 'owner@bcatcorp.com', isAdmin: false, isManager: true }
    const state = commissionState(row(), managerOnOwnRow)
    expect(state).toMatchObject({ canApprove: false, canOverride: false, canCancel: false })
    // They are still the rep, so they may counter.
    expect(state.canCounter).toBe(true)
  })

  it('an override stops where the liability starts', () => {
    const admin = { email: 'ryne@bcatcorp.com', isAdmin: true, isManager: false }
    expect(commissionState(row({ status: 'UN_APPROVED' }), admin).canOverride).toBe(true)
    expect(commissionState(row({ status: 'MANAGER_APPROVED' }), admin).canOverride).toBe(false)
  })

  it('a reversal carries no null on an index key and is earned when it is written', () => {
    const approved = row({ status: 'FULLY_APPROVED', payPeriodId: 'cpp:2026-10-01', paidAt: '2026-10-10' })
    const { reversals } = reverseFor([approved], { nowIso: NOW, caller: 'me', reason: 'INVOICE_VOIDED' })
    const reversal = reversals[0]
    // `payPeriodId` is a GSI hash key: a NULL there is refused by DynamoDB.
    expect(reversal.payPeriodId).toBeUndefined()
    expect(reversal.paidAt).toBeUndefined()
    expect(reversal.triggerAt).toBe(NOW)
    expect(reversal.commissionMonth).toBe(NOW.slice(0, 7))
  })

  it('reverses a removed person once, not on every later run', () => {
    const desired = computeCommissions(ctx())
    const gone = row({
      id: commissionId('ord-1', 'CREATED_BY', 'gone@x.com'),
      repId: 'gone@x.com',
      roleName: 'CREATED_BY',
      status: 'FULLY_APPROVED',
    })
    const first = reconcileCommissions([gone, row({ ...desired[0].row })], desired, { nowIso: NOW, caller: 'me' })
    expect(first.reversals).toHaveLength(1)

    const stored = { ...first.reversals[0], createdAt: NOW, updatedAt: NOW } as CommissionRecord
    const second = reconcileCommissions([gone, stored, row({ ...desired[0].row })], desired, { nowIso: NOW, caller: 'me' })
    expect(second.reversals).toHaveLength(0)
  })

  it('does not re-book a difference a manager deliberately cancelled', () => {
    const desired = computeCommissions(ctx())
    const approved = row({ ...desired[0].row, amountCents: 5_000, status: 'MANAGER_APPROVED' })
    const cancelledAdjustment = row({
      id: 'cma:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com:1',
      kind: 'ADJUSTMENT',
      adjustsId: approved.id,
      amountCents: 2_000,
      netCents: 0,
      status: 'CANCELLED',
    })
    const plan = reconcileCommissions([approved, cancelledAdjustment], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.adjustments).toHaveLength(0)
  })

  it('numbers a second adjustment past a cancelled one so no id is minted twice', () => {
    const desired = computeCommissions(ctx())
    const approved = row({ ...desired[0].row, amountCents: 4_000, status: 'MANAGER_APPROVED' })
    const cancelledAdjustment = row({
      id: 'cma:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com:1',
      kind: 'ADJUSTMENT',
      adjustsId: approved.id,
      amountCents: 500,
      status: 'CANCELLED',
    })
    const plan = reconcileCommissions([approved, cancelledAdjustment], desired, { nowIso: NOW, caller: 'me' })
    expect(plan.adjustments).toHaveLength(1)
    expect(plan.adjustments[0].id).toBe('cma:ord-1:PRIMARY_ACCOUNT_OWNER:owner@bcatcorp.com:2')
  })
})
