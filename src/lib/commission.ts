/*
 * Commissions (Step I) — the arithmetic and the state machine, with no clock,
 * no store and no network. Both the Lambda (`tms-finance-actions/commissions.ts`)
 * and the Commissions page read these functions, so a number shown on screen and
 * a number written to the ledger come from the same code.
 *
 * Three rules hold everything together:
 *
 *  1. Money is integer cents and rates are integer basis points. A percentage is
 *     taken once, with half-away-from-zero rounding, because `Math.round(-2.5)`
 *     is -2 and a reversal that rounds the other way leaks a cent.
 *  2. A split never loses or invents a cent: `allocateCents` hands out the exact
 *     total by largest remainder.
 *  3. A row before approval is a proposal and is recomputed in place; from
 *     MANAGER_APPROVED on it is a liability, and every later change arrives as
 *     an ADJUSTMENT or a REVERSAL. Nothing approved is ever rewritten.
 */

import type {
  CommissionBasisKind,
  CommissionEvent,
  CommissionPaySchedule,
  CommissionPlan,
  CommissionPlanRole,
  CommissionRateType,
  CommissionRecord,
  CommissionRoleName,
  CommissionStatus,
  CommissionTier,
  CommissionTierType,
  CommissionTrigger,
  PayScheduleFrequency,
} from '../types/tms'

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const COMMISSION_ROLE_NAMES: readonly CommissionRoleName[] = [
  'PRIMARY_ACCOUNT_OWNER',
  'SECONDARY_ACCOUNT_OWNER',
  'PRIMARY_CARRIER_REP',
  'SECONDARY_CARRIER_REP',
  'PRIMARY_OPERATED_BY',
  'SECONDARY_OPERATED_BY',
  'CARRIER_BOOKING_REP',
  'CREATED_BY',
  'MANAGER',
  'SPECIFIC_USER',
] as const

export const COMMISSION_ROLE_LABELS: Record<CommissionRoleName, string> = {
  PRIMARY_ACCOUNT_OWNER: 'Primary account owner',
  SECONDARY_ACCOUNT_OWNER: 'Secondary account owner',
  PRIMARY_CARRIER_REP: 'Primary carrier rep',
  SECONDARY_CARRIER_REP: 'Secondary carrier rep',
  PRIMARY_OPERATED_BY: 'Primary operated by',
  SECONDARY_OPERATED_BY: 'Secondary operated by',
  CARRIER_BOOKING_REP: 'Carrier booking rep',
  CREATED_BY: 'Created by',
  MANAGER: 'Manager',
  SPECIFIC_USER: 'Specific user',
}

export const COMMISSION_RATE_TYPES: readonly CommissionRateType[] = [
  'FIXED',
  'PERCENT_PROFIT',
  'PERCENT_REVENUE',
] as const

export const COMMISSION_TIER_TYPES: readonly CommissionTierType[] = [
  'PER_LOAD_MARGIN_BPS',
  'PER_LOAD_PROFIT_CENTS',
] as const

export const COMMISSION_TRIGGERS: readonly CommissionTrigger[] = [
  'GENERATE_INVOICE',
  'INVOICE_PAID',
] as const

export const PAY_SCHEDULE_FREQUENCIES: readonly PayScheduleFrequency[] = [
  'WEEKLY',
  'BIWEEKLY',
  'SEMI_MONTHLY',
  'MONTHLY',
] as const

/** Statuses at or past which a row is a liability and may never be rewritten. */
const LOCKED_STATUSES: readonly CommissionStatus[] = [
  'MANAGER_APPROVED',
  'FULLY_APPROVED',
  'PAID',
] as const

/** Statuses a rerun may rewrite in place: the number is still a proposal. */
const OPEN_STATUSES: readonly CommissionStatus[] = [
  'UN_APPROVED',
  'REP_COUNTERED',
  'MANAGER_COUNTERED',
] as const

export const CANCELLED_BY_RERUN = 'REMOVED_BY_RERUN'

export function isLocked(status: CommissionStatus | null | undefined): boolean {
  return LOCKED_STATUSES.includes((status ?? 'UN_APPROVED') as CommissionStatus)
}

export function isOpen(status: CommissionStatus | null | undefined): boolean {
  return OPEN_STATUSES.includes((status ?? 'UN_APPROVED') as CommissionStatus)
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

/**
 * Round to the nearest integer, ties away from zero.
 *
 * `Math.round` rounds -2.5 to -2, so a reversal of a half-cent amount would not
 * cancel the row it reverses. Every commission number goes through here.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** `cents × bps / 10000`, rounded once, half away from zero. */
export function pctOfCents(cents: number, bps: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(bps)) return 0
  return roundHalfAwayFromZero((cents * bps) / 10000)
}

/**
 * Hand out `totalCents` across `weightsBps` by largest remainder, so the shares
 * always add up to exactly the total — no cent is lost or invented by rounding.
 * Equal weights and a zero total are both well defined; all-zero weights split
 * evenly.
 */
export function allocateCents(totalCents: number, weightsBps: number[]): number[] {
  const n = weightsBps.length
  if (n === 0) return []
  const weights = weightsBps.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const sum = weights.reduce((a, b) => a + b, 0)
  const even = sum <= 0
  const effective = even ? weights.map(() => 1) : weights
  const effectiveSum = even ? n : sum

  const exact = effective.map((w) => (totalCents * w) / effectiveSum)
  const floors = exact.map((v) => (totalCents < 0 ? Math.ceil(v) : Math.floor(v)))
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0)

  // Largest fractional part first; ties go to the earlier share so the result is
  // deterministic for the same inputs.
  const order = exact
    .map((v, i) => ({ i, frac: Math.abs(v - floors[i]) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i))

  const step = totalCents < 0 ? -1 : 1
  const out = [...floors]
  let k = 0
  while (remainder !== 0 && k < order.length * 2) {
    out[order[k % order.length].i] += step
    remainder -= step
    k += 1
  }
  return out
}

// ── Plans ────────────────────────────────────────────────────────────────────

export interface PlanMatch {
  repId?: string | null
  customerId?: string | null
  teamKey?: string | null
  /** The date the plan window is judged against, `'YYYY-MM-DD'`. */
  asOf: string
}

function inWindow(plan: CommissionPlan, asOf: string): boolean {
  const day = (asOf ?? '').slice(0, 10)
  if (!day) return false
  if (plan.effectiveFrom && day < plan.effectiveFrom.slice(0, 10)) return false
  if (plan.effectiveTo && day > plan.effectiveTo.slice(0, 10)) return false
  return true
}

const sameId = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

const hasId = (list: string[] | null | undefined, id: string | null | undefined): boolean =>
  !!id && (list ?? []).some((v) => sameId(v, id))

/**
 * The spec's assignment priority: user → customer → team → the single plan with
 * no scope at all. An inactive plan, or one outside its effective window, is
 * never picked. Ties inside a tier go to the first plan in the list, so an admin
 * can order them.
 */
export function resolvePlan(
  plans: CommissionPlan[] | null | undefined,
  match: PlanMatch,
): CommissionPlan | null {
  const live = (plans ?? []).filter((p) => p && p.active !== false && inWindow(p, match.asOf))
  const byUser = live.find((p) => hasId(p.scope?.userIds, match.repId))
  if (byUser) return byUser
  const byCustomer = live.find((p) => hasId(p.scope?.customerIds, match.customerId))
  if (byCustomer) return byCustomer
  const byTeam = live.find((p) => hasId(p.scope?.teamKeys, match.teamKey))
  if (byTeam) return byTeam
  const unscoped = live.find(
    (p) =>
      !(p.scope?.userIds ?? []).length &&
      !(p.scope?.customerIds ?? []).length &&
      !(p.scope?.teamKeys ?? []).length,
  )
  return unscoped ?? null
}

// ── Basis ────────────────────────────────────────────────────────────────────

export interface BasisInvoice {
  totalCents?: number | null
  writtenOffCents?: number | null
}

export interface BasisFinancials {
  costCents?: number | null
  revenueCents?: number | null
}

export interface BasisAssignment {
  kind?: string | null
  status?: string | null
  chargesFinalizedAt?: string | null
}

export interface CommissionBasis {
  revenueCents: number
  costCents: number
  profitCents: number
  marginBps: number | null
  /** At least one leg ran on our own trucks, whose cost lives in settlements. */
  ownFleet: boolean
  /** Every live assignment is finalized (or own-asset): the cost cannot move. */
  costFinal: boolean
}

const cents = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0

/**
 * What the commission is a percentage of.
 *
 * Revenue is the invoice total less anything written off — money we decided not
 * to collect is not revenue a rep earns on. A credit memo is kept cash (step F's
 * model) and does not reduce the basis. Cost is the sum of the order's loads.
 */
export function commissionBasis(input: {
  invoice: BasisInvoice
  financials: BasisFinancials[]
  assignments?: BasisAssignment[]
}): CommissionBasis {
  const revenueCents = cents(input.invoice.totalCents) - cents(input.invoice.writtenOffCents)
  const costCents = input.financials.reduce((sum, f) => sum + cents(f.costCents), 0)
  const profitCents = revenueCents - costCents
  const marginBps =
    revenueCents === 0 ? null : roundHalfAwayFromZero((profitCents * 10000) / revenueCents)

  const live = (input.assignments ?? []).filter(
    (a) => a.status === 'ACTIVE' || a.status === 'TONU',
  )
  const ownFleet = live.some((a) => a.kind === 'OWN_ASSET')
  const costFinal =
    live.length > 0 && live.every((a) => a.kind === 'OWN_ASSET' || !!a.chargesFinalizedAt)

  return { revenueCents, costCents, profitCents, marginBps, ownFleet, costFinal }
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export interface ResolvedRate {
  rateBps: number | null
  rateCents: number | null
  tierLabel: string | null
}

const tierFloor = (tier: CommissionTier, type: CommissionTierType): number =>
  type === 'PER_LOAD_MARGIN_BPS' ? cents(tier.fromBps) : cents(tier.fromCents)

function sortedTiers(role: CommissionPlanRole): CommissionTier[] {
  const type = role.tierType
  if (!type) return []
  return [...(role.tiers ?? [])].sort((a, b) => tierFloor(a, type) - tierFloor(b, type))
}

function tierLabelOf(tier: CommissionTier, type: CommissionTierType): string {
  if (tier.label) return tier.label
  return type === 'PER_LOAD_MARGIN_BPS'
    ? `from ${(tierFloor(tier, type) / 100).toFixed(2)}%`
    : `from $${(tierFloor(tier, type) / 100).toFixed(2)}`
}

/**
 * The rate a role pays on this load's numbers.
 *
 * A straight ladder pays the band the load lands in, on the whole basis. A
 * graduated ladder pays each band its own rate on its own slice of the profit —
 * which only means anything when the bands are amounts, so a graduated ladder
 * over margin bands is refused when the plan is saved, not guessed at here.
 */
export function tierRate(role: CommissionPlanRole, basis: CommissionBasis): ResolvedRate {
  const base: ResolvedRate = {
    rateBps: role.rateType === 'FIXED' ? null : cents(role.rateBps),
    rateCents: role.rateType === 'FIXED' ? cents(role.rateCents) : null,
    tierLabel: null,
  }
  const type = role.tierType
  const tiers = sortedTiers(role)
  if (!type || tiers.length === 0 || role.rateType === 'FIXED') return base

  const measure = type === 'PER_LOAD_MARGIN_BPS' ? (basis.marginBps ?? 0) : basis.profitCents
  let picked: CommissionTier | null = null
  for (const tier of tiers) {
    if (measure >= tierFloor(tier, type)) picked = tier
  }
  if (!picked) return base
  return {
    rateBps: picked.rateBps != null ? cents(picked.rateBps) : base.rateBps,
    rateCents: base.rateCents,
    tierLabel: tierLabelOf(picked, type),
  }
}

/** The role's whole pot, before it is split between the people on the role. */
export function roleAmountCents(role: CommissionPlanRole, basis: CommissionBasis): {
  amountCents: number
  basisKind: CommissionBasisKind
  basisCents: number
  rate: ResolvedRate
} {
  const rate = tierRate(role, basis)
  if (role.rateType === 'FIXED') {
    return {
      amountCents: cents(rate.rateCents ?? role.rateCents),
      basisKind: 'FIXED',
      basisCents: 0,
      rate,
    }
  }
  const basisKind: CommissionBasisKind = role.rateType === 'PERCENT_PROFIT' ? 'PROFIT' : 'REVENUE'
  const basisCents = basisKind === 'PROFIT' ? basis.profitCents : basis.revenueCents

  const type = role.tierType
  const tiers = sortedTiers(role)
  if (role.graduated === true && type === 'PER_LOAD_PROFIT_CENTS' && tiers.length > 0) {
    // Each band pays its own rate on its own slice of the profit.
    let amount = 0
    for (let i = 0; i < tiers.length; i += 1) {
      const from = tierFloor(tiers[i], type)
      const to = i + 1 < tiers.length ? tierFloor(tiers[i + 1], type) : Number.POSITIVE_INFINITY
      if (basisCents <= from) break
      const slice = Math.min(basisCents, to) - from
      if (slice <= 0) continue
      amount += pctOfCents(slice, cents(tiers[i].rateBps ?? role.rateBps))
    }
    return { amountCents: amount, basisKind, basisCents, rate }
  }

  return {
    amountCents: pctOfCents(basisCents, cents(rate.rateBps)),
    basisKind,
    basisCents,
    rate,
  }
}

// ── Who earns it ─────────────────────────────────────────────────────────────

export interface RolePerson {
  repId: string
  /** Share of the role's pot this person takes, or null for "an equal share". */
  splitBps: number | null
}

export interface RolePeopleContext {
  order: { createdBy?: string | null; customerRepId?: string | null }
  customer?: {
    accountOwnerIds?: string[] | null
    operatedById?: string | null
    operatedByIds?: string[] | null
    gpSplitBps?: number | null
    teamKey?: string | null
  } | null
  loads?: { carrierRepId?: string | null }[]
  assignments?: { carrierRepId?: string | null; status?: string | null }[]
  /** `id` (the Cognito username) → the profile, for the MANAGER role. */
  profiles?: Record<string, { managerId?: string | null }>
}

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

function uniqueIds(ids: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = clean(raw)
    if (!id) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

/**
 * Resolve a commission role to the people already named on the records. Nothing
 * is invented: a role that names nobody returns an empty list, and the caller
 * writes a needs-review row rather than paying a guess.
 */
export function rolePeople(role: CommissionPlanRole, ctx: RolePeopleContext): RolePerson[] {
  const owners = uniqueIds(ctx.customer?.accountOwnerIds ?? [])
  const operated = uniqueIds([
    ctx.customer?.operatedById,
    ...(ctx.customer?.operatedByIds ?? []),
  ])
  const loadReps = uniqueIds((ctx.loads ?? []).map((l) => l.carrierRepId))
  const bookingReps = uniqueIds(
    (ctx.assignments ?? [])
      .filter((a) => a.status === 'ACTIVE' || a.status === 'TONU')
      .map((a) => a.carrierRepId),
  )
  const split = (ids: string[], bps: number | null): RolePerson[] =>
    ids.map((repId) => ({ repId, splitBps: bps }))

  const roleSplit = role.splitBps != null ? cents(role.splitBps) : null

  switch (role.roleName) {
    case 'PRIMARY_ACCOUNT_OWNER': {
      // The order's own customer rep stands in when the customer names nobody.
      const primary = owners[0] ?? clean(ctx.order.customerRepId)
      return primary ? split([primary], roleSplit) : []
    }
    case 'SECONDARY_ACCOUNT_OWNER': {
      const secondaries = owners.slice(1)
      // The customer's GP split is the house default for a second owner.
      const bps = roleSplit ?? (ctx.customer?.gpSplitBps != null ? cents(ctx.customer.gpSplitBps) : null)
      return split(secondaries, bps)
    }
    case 'PRIMARY_OPERATED_BY':
      return operated[0] ? split([operated[0]], roleSplit) : []
    case 'SECONDARY_OPERATED_BY':
      return split(operated.slice(1), roleSplit)
    case 'PRIMARY_CARRIER_REP':
      return loadReps[0] ? split([loadReps[0]], roleSplit) : []
    case 'SECONDARY_CARRIER_REP':
      return split(loadReps.slice(1), roleSplit)
    case 'CARRIER_BOOKING_REP':
      return split(bookingReps, roleSplit)
    case 'CREATED_BY': {
      const creator = clean(ctx.order.createdBy)
      return creator ? split([creator], roleSplit) : []
    }
    case 'MANAGER': {
      const rep = owners[0] ?? clean(ctx.order.customerRepId)
      const managerId = rep ? clean(ctx.profiles?.[rep]?.managerId) : ''
      return managerId ? split([managerId], roleSplit) : []
    }
    case 'SPECIFIC_USER':
      return split(uniqueIds(role.userIds ?? []), roleSplit)
    default:
      return []
  }
}

// ── The desired row set for one invoice ──────────────────────────────────────

export interface ComputeContext {
  order: {
    id: string
    shipmentId?: string | null
    customerId?: string | null
    customerName?: string | null
    customerRepId?: string | null
    createdBy?: string | null
    invoicedAt?: string | null
    divisionKey?: string | null
  }
  invoice: BasisInvoice & {
    id: string
    number?: string | null
    invoiceDate?: string | null
  }
  customer?: (RolePeopleContext['customer'] & { teamKey?: string | null }) | null
  shipment?: { number?: string | null; divisionKey?: string | null; deliveredAt?: string | null } | null
  loads?: { id: string; carrierRepId?: string | null; divisionKey?: string | null }[]
  assignments?: (BasisAssignment & {
    carrierRepId?: string | null
    carrierId?: string | null
    carrierName?: string | null
  })[]
  financials: BasisFinancials[]
  profiles?: Record<string, { managerId?: string | null; name?: string | null; email?: string | null }>
  plans?: CommissionPlan[] | null
  trigger: CommissionTrigger
  /** When the trigger fired — the row's `triggerAt` and the month it counts in. */
  triggerAt: string
  caller: string
  nowIso: string
}

/** A row the invoice should have, as the reconciler wants to see it. */
export interface DesiredCommission {
  id: string
  repId: string
  roleName: CommissionRoleName
  amountCents: number
  row: Omit<CommissionRecord, 'createdAt' | 'updatedAt'>
}

export function commissionId(orderId: string, roleName: string, repId: string): string {
  return `cm:${orderId}:${roleName}:${repId.toLowerCase()}`
}

export function adjustmentId(
  orderId: string,
  roleName: string,
  repId: string,
  n: number,
): string {
  return `cma:${orderId}:${roleName}:${repId.toLowerCase()}:${n}`
}

export function reversalId(sourceId: string, n: number): string {
  return `cmr:${sourceId}:${n}`
}

/**
 * Every row this invoice should carry today, under the plan that applies to it.
 *
 * An own-fleet order has no carrier cost (its drivers are paid through
 * settlements), so a percent-of-profit role would pay on a 100 % margin: the row
 * is written at zero, flagged `needsReview` with `OWN_FLEET_NO_COST`, and a cost
 * is never invented.
 */
export function computeCommissions(ctx: ComputeContext): DesiredCommission[] {
  const basis = commissionBasis({
    invoice: ctx.invoice,
    financials: ctx.financials,
    assignments: ctx.assignments,
  })
  const asOf = (ctx.order.invoicedAt ?? ctx.invoice.invoiceDate ?? ctx.triggerAt).slice(0, 10)
  const teamKey = ctx.customer?.teamKey ?? null

  const plan = resolvePlan(ctx.plans, {
    repId: ctx.order.customerRepId,
    customerId: ctx.order.customerId,
    teamKey,
    asOf,
  })
  if (!plan) return []

  const activeAssignment = (ctx.assignments ?? []).find((a) => a.status === 'ACTIVE') ?? null
  const month = ctx.triggerAt.slice(0, 7)
  const out: DesiredCommission[] = []

  for (const role of plan.roles ?? []) {
    const people = rolePeople(role, {
      order: ctx.order,
      customer: ctx.customer,
      loads: ctx.loads,
      assignments: ctx.assignments,
      profiles: ctx.profiles,
    })
    if (people.length === 0) continue

    const pot = roleAmountCents(role, basis)
    /*
     * A split is a WEIGHT, not an independent percentage: two owners at 50 %
     * each share the role's pot between them rather than being paid half of it
     * apiece, and the largest-remainder allocation means the shares always add
     * back up to the pot exactly — no cent invented, none lost.
     */
    const shares = allocateCents(
      pot.amountCents,
      people.map((p) => (p.splitBps != null ? p.splitBps : 10000)),
    )

    for (let i = 0; i < people.length; i += 1) {
      const person = people[i]
      const ownFleetOnProfit = basis.ownFleet && role.rateType === 'PERCENT_PROFIT'
      const amountCents = ownFleetOnProfit ? 0 : shares[i]
      const profile = ctx.profiles?.[person.repId]
      const row: Omit<CommissionRecord, 'createdAt' | 'updatedAt'> = {
        id: commissionId(ctx.order.id, role.roleName, person.repId),
        kind: 'EARNED',
        orderId: ctx.order.id,
        shipmentId: ctx.order.shipmentId ?? null,
        shipmentNumber: ctx.shipment?.number ?? null,
        invoiceId: ctx.invoice.id,
        invoiceNumber: ctx.invoice.number ?? null,
        customerId: ctx.order.customerId ?? null,
        customerName: ctx.order.customerName ?? null,
        carrierId: activeAssignment?.carrierId ?? null,
        carrierName: activeAssignment?.carrierName ?? null,
        divisionKey: ctx.order.divisionKey ?? ctx.shipment?.divisionKey ?? null,
        teamKey,
        repId: person.repId,
        repName: profile?.name ?? profile?.email ?? null,
        managerId: profile?.managerId ?? null,
        roleName: role.roleName,
        planId: plan.id,
        planName: plan.name,
        rateType: role.rateType,
        rateBps: pot.rate.rateBps,
        rateCents: pot.rate.rateCents,
        tierLabel: pot.rate.tierLabel,
        splitBps: person.splitBps,
        basis: pot.basisKind,
        basisCents: pot.basisCents,
        revenueCents: basis.revenueCents,
        costCents: basis.costCents,
        profitCents: basis.profitCents,
        marginBps: basis.marginBps,
        amountCents,
        overrideCents: null,
        netCents: amountCents,
        basisNote: ownFleetOnProfit ? 'OWN_FLEET_NO_COST' : null,
        needsReview: ownFleetOnProfit,
        costFinal: basis.costFinal,
        status: 'UN_APPROVED',
        trigger: ctx.trigger,
        triggerAt: ctx.triggerAt,
        commissionMonth: month,
        source: 'RUN',
        computedAt: ctx.nowIso,
        events: [],
        createdBy: ctx.caller,
        updatedBy: ctx.caller,
        version: 1,
      }
      out.push({ id: row.id, repId: person.repId, roleName: role.roleName, amountCents, row })
    }
  }
  return out
}

// ── Reconciliation: run, rerun, adjust ───────────────────────────────────────

export interface ReconcilePlan {
  /** Rows that do not exist yet. */
  puts: DesiredCommission[]
  /** Unapproved rows whose numbers moved: rewritten in place under CAS. */
  updates: { existing: CommissionRecord; desired: DesiredCommission; patch: Partial<CommissionRecord> }[]
  /** Approved rows whose numbers moved: the difference, as its own row. */
  adjustments: Omit<CommissionRecord, 'createdAt' | 'updatedAt'>[]
  /** Rows for people no longer on the record, unapproved: cancelled. */
  cancels: { existing: CommissionRecord; reason: string }[]
  /** Rows for people no longer on the record, approved: reversed. */
  reversals: Omit<CommissionRecord, 'createdAt' | 'updatedAt'>[]
  untouched: CommissionRecord[]
}

const familyKey = (orderId: string, roleName: string, repId: string): string =>
  `${orderId}::${roleName}::${repId.toLowerCase()}`

/**
 * What the ledger has against what it should have.
 *
 * The whole recomputation rule lives here: a missing row is written; an
 * unapproved row that disagrees is rewritten; an approved row is never touched
 * and the difference becomes an ADJUSTMENT carrying the exact delta; a person
 * who has left the record is cancelled while unapproved and reversed once
 * approved. Running it twice over the same facts produces nothing the second
 * time.
 */
export function reconcileCommissions(
  existing: CommissionRecord[],
  desired: DesiredCommission[],
  opts: { nowIso: string; caller: string; source?: CommissionRecord['source'] },
): ReconcilePlan {
  const plan: ReconcilePlan = {
    puts: [],
    updates: [],
    adjustments: [],
    cancels: [],
    reversals: [],
    untouched: [],
  }
  const source = opts.source ?? 'RERUN'

  const byId = new Map<string, CommissionRecord>()
  const families = new Map<string, CommissionRecord[]>()
  for (const row of existing) {
    byId.set(row.id, row)
    const key = familyKey(row.orderId, row.roleName, row.repId)
    const list = families.get(key) ?? []
    list.push(row)
    families.set(key, list)
  }

  const seen = new Set<string>()

  for (const want of desired) {
    const key = familyKey(want.row.orderId, want.roleName, want.repId)
    seen.add(key)
    const earned = byId.get(want.id)

    if (!earned) {
      plan.puts.push(want)
      continue
    }

    // A row cancelled by an earlier rerun comes back when the person does.
    if (earned.status === 'CANCELLED') {
      if (earned.cancelReason === CANCELLED_BY_RERUN) {
        plan.updates.push({
          existing: earned,
          desired: want,
          patch: rerunPatch(earned, want, opts.nowIso, opts.caller, source),
        })
      } else {
        plan.untouched.push(earned)
      }
      continue
    }

    if (isLocked(earned.status)) {
      // The liability stands. Only the difference moves, as its own row.
      // A CANCELLED adjustment counts towards what is booked — a manager who
      // cancelled a difference meant "do not pay this", and a rerun must not
      // quietly book it again — and towards the numbering, so its id is never
      // minted twice.
      const family = families.get(key) ?? []
      const live = family.filter((r) => r.status !== 'CANCELLED')
      const booked = live.reduce((sum, r) => sum + cents(r.amountCents), 0)
      const cancelledAdjustments = family
        .filter((r) => r.kind === 'ADJUSTMENT' && r.status === 'CANCELLED')
        .reduce((sum, r) => sum + cents(r.amountCents), 0)
      const delta = want.amountCents - booked - cancelledAdjustments
      if (delta !== 0) {
        const n = family.filter((r) => r.kind === 'ADJUSTMENT').length + 1
        plan.adjustments.push(
          adjustmentRow(earned, want, delta, n, opts.nowIso, opts.caller, source),
        )
      } else {
        plan.untouched.push(earned)
      }
      continue
    }

    const patch = rerunPatch(earned, want, opts.nowIso, opts.caller, source)
    if (Object.keys(patch).length === 0) {
      plan.untouched.push(earned)
    } else {
      plan.updates.push({ existing: earned, desired: want, patch })
    }
  }

  // Anybody the records no longer name.
  for (const [key, rows] of families) {
    if (seen.has(key)) continue
    for (const row of rows) {
      if (row.status === 'CANCELLED' || row.kind === 'REVERSAL') {
        plan.untouched.push(row)
        continue
      }
      if (isLocked(row.status)) {
        // Once a locked row has been reversed, it stays reversed: reversing it
        // again would mint the same id and fail every later run of the invoice.
        if (rows.some((r) => r.kind === 'REVERSAL' && r.adjustsId === row.id && r.status !== 'CANCELLED')) {
          plan.untouched.push(row)
          continue
        }
        plan.reversals.push(reversalRow(row, opts.nowIso, opts.caller, 'RERUN_REMOVED_PERSON'))
      } else {
        plan.cancels.push({ existing: row, reason: CANCELLED_BY_RERUN })
      }
    }
  }

  return plan
}

/** The fields a rerun may move on an unapproved row. Empty means "nothing changed". */
function rerunPatch(
  existing: CommissionRecord,
  want: DesiredCommission,
  nowIso: string,
  caller: string,
  source: CommissionRecord['source'],
): Partial<CommissionRecord> {
  const next = want.row
  const fields: (keyof Omit<CommissionRecord, 'createdAt' | 'updatedAt'>)[] = [
    'amountCents',
    'basisCents',
    'revenueCents',
    'costCents',
    'profitCents',
    'marginBps',
    'rateBps',
    'rateCents',
    'rateType',
    'basis',
    'tierLabel',
    'splitBps',
    'planId',
    'planName',
    'needsReview',
    'costFinal',
    'basisNote',
    'carrierId',
    'carrierName',
    'teamKey',
    'invoiceNumber',
    'repName',
    'managerId',
    'divisionKey',
  ]
  const patch: Partial<CommissionRecord> = {}
  for (const field of fields) {
    const before = existing[field] ?? null
    const after = next[field] ?? null
    if (before !== after) Object.assign(patch, { [field]: after })
  }
  const revived = existing.status === 'CANCELLED'
  if (Object.keys(patch).length === 0 && !revived) return {}

  const net = existing.overrideCents != null ? cents(existing.overrideCents) : cents(next.amountCents)
  patch.netCents = net
  patch.computedAt = nowIso
  patch.updatedBy = caller
  patch.source = source
  patch.version = cents(existing.version) + 1
  if (revived) {
    patch.status = 'UN_APPROVED'
    patch.cancelledAt = null
    patch.cancelReason = null
  }
  return patch
}

function adjustmentRow(
  earned: CommissionRecord,
  want: DesiredCommission,
  deltaCents: number,
  n: number,
  nowIso: string,
  caller: string,
  source: CommissionRecord['source'],
): Omit<CommissionRecord, 'createdAt' | 'updatedAt'> {
  const next = want.row
  return {
    ...next,
    id: adjustmentId(earned.orderId, earned.roleName, earned.repId, n),
    kind: 'ADJUSTMENT',
    adjustsId: earned.id,
    amountCents: deltaCents,
    netCents: deltaCents,
    overrideCents: undefined,
    status: 'UN_APPROVED',
    approvedAt: undefined,
    approvedBy: undefined,
    // An adjustment is earned WHEN IT IS COMPUTED, not when the invoice was
    // raised: the original period may already be paid, and a row stamped into a
    // closed window would never be claimed by any pay period again.
    triggerAt: nowIso,
    commissionMonth: nowIso.slice(0, 7),
    payPeriodId: undefined,
    paidAt: undefined,
    paymentRef: undefined,
    source,
    computedAt: nowIso,
    createdBy: caller,
    updatedBy: caller,
    version: 1,
    events: [
      {
        at: nowIso,
        by: caller,
        action: 'ADJUSTMENT',
        note: `The approved row is $${(cents(earned.amountCents) / 100).toFixed(2)}; the plan now says $${(want.amountCents / 100).toFixed(2)}.`,
        amountCents: deltaCents,
      },
    ],
  }
}

function reversalRow(
  row: CommissionRecord,
  nowIso: string,
  caller: string,
  reason: string,
  n = 1,
): Omit<CommissionRecord, 'createdAt' | 'updatedAt'> {
  const amount = -cents(row.netCents ?? row.amountCents)
  return {
    ...row,
    id: reversalId(row.id, n),
    kind: 'REVERSAL',
    adjustsId: row.id,
    amountCents: amount,
    netCents: amount,
    /*
     * Every one of these is `undefined`, never `null`: `payPeriodId` is the hash
     * key of the pay-period index, and DynamoDB answers a NULL on an index key
     * with `Type mismatch … Actual: NULL` and refuses the write — which would
     * take the whole void transaction down with it.
     */
    overrideCents: undefined,
    overrideBy: undefined,
    overrideNote: undefined,
    counterCents: undefined,
    counterBy: undefined,
    counterNote: undefined,
    status: 'UN_APPROVED',
    approvedAt: undefined,
    approvedBy: undefined,
    cancelledAt: undefined,
    cancelReason: undefined,
    payPeriodId: undefined,
    paidAt: undefined,
    paymentRef: undefined,
    // Reversed now, so the period that is open now can net it off.
    triggerAt: nowIso,
    commissionMonth: nowIso.slice(0, 7),
    basisNote: reason,
    needsReview: true,
    source: 'VOID',
    computedAt: nowIso,
    createdBy: caller,
    updatedBy: caller,
    version: 1,
    events: [{ at: nowIso, by: caller, action: 'REVERSAL', note: reason, amountCents: amount }],
  }
}

/**
 * What voiding an invoice does to its commissions: an unapproved row is
 * cancelled, an approved or paid one is reversed with the negated amount. The
 * ledger rule AR and AP already keep — a posted row is never rewritten.
 */
export function reverseFor(
  rows: CommissionRecord[],
  opts: { nowIso: string; caller: string; reason: string },
): {
  cancels: { existing: CommissionRecord; reason: string }[]
  reversals: Omit<CommissionRecord, 'createdAt' | 'updatedAt'>[]
} {
  const cancels: { existing: CommissionRecord; reason: string }[] = []
  const reversals: Omit<CommissionRecord, 'createdAt' | 'updatedAt'>[] = []
  for (const row of rows) {
    if (row.status === 'CANCELLED' || row.kind === 'REVERSAL') continue
    if (isLocked(row.status)) {
      reversals.push(reversalRow(row, opts.nowIso, opts.caller, opts.reason))
    } else {
      cancels.push({ existing: row, reason: opts.reason })
    }
  }
  return { cancels, reversals }
}

// ── Approval ladder ──────────────────────────────────────────────────────────

export interface CommissionCaller {
  /**
   * The Cognito username — the pool names people by a generated id and signs them in
   * by e-mail, and `UserProfile.id` and every rep picked from a profile hold the id.
   */
  id?: string | null
  email: string
  isAdmin: boolean
  isManager: boolean
  /** False when `commissionApprovalAdminOnly` is on and the caller is not admin. */
  mayApprove?: boolean
}

export interface CommissionAbilities {
  canApprove: boolean
  canCounter: boolean
  canAcceptCounter: boolean
  canOverride: boolean
  canCancel: boolean
  isOwnRow: boolean
}

/**
 * One answer for the page and the Lambda.
 *
 * A rep may counter their own row; a manager counters and approves anybody
 * else's; whoever did not counter last accepts; and an admin closes a row a
 * manager has approved, which is the rung that makes it payable.
 *
 * **Nobody approves, overrides or accepts their own number.** A manager is a rep
 * too, and a commission a person signs off for themselves is not an approval.
 */
export function commissionState(
  row: Pick<CommissionRecord, 'repId' | 'status' | 'counterBy' | 'payPeriodId'>,
  caller: CommissionCaller,
): CommissionAbilities {
  const status = row.status ?? 'UN_APPROVED'
  // A rep field names the caller by username, or by the e-mail somebody typed.
  const isOwnRow = sameId(row.repId, caller.id) || sameId(row.repId, caller.email)
  const approver =
    !isOwnRow && (caller.isAdmin || (caller.isManager && caller.mayApprove !== false))
  const settled = status === 'PAID' || status === 'CANCELLED'

  const canApprove =
    !settled &&
    ((approver && (status === 'UN_APPROVED' || status === 'REP_COUNTERED')) ||
      // A manager's approval is the first rung; the owner or an admin closes it.
      (caller.isAdmin && !isOwnRow && status === 'MANAGER_APPROVED'))
  const canCounter =
    !settled &&
    ((isOwnRow && (status === 'UN_APPROVED' || status === 'MANAGER_COUNTERED')) ||
      (approver && (status === 'UN_APPROVED' || status === 'REP_COUNTERED')))
  const canAcceptCounter =
    !settled &&
    ((status === 'MANAGER_COUNTERED' && isOwnRow) || (status === 'REP_COUNTERED' && approver))
  // An override rewrites what is owed, so it stops where the liability starts.
  const canOverride = !settled && approver && isOpen(status)
  const canCancel = !settled && approver

  return { canApprove, canCounter, canAcceptCounter, canOverride, canCancel, isOwnRow }
}

/** The amount actually owed on a row: an override beats a counter beats the plan. */
export function netCentsOf(
  row: Pick<CommissionRecord, 'amountCents' | 'overrideCents' | 'counterCents' | 'status'>,
): number {
  if (row.overrideCents != null) return cents(row.overrideCents)
  if (row.counterCents != null && (row.status === 'FULLY_APPROVED' || row.status === 'PAID')) {
    return cents(row.counterCents)
  }
  return cents(row.amountCents)
}

export function appendEvent(
  events: CommissionEvent[] | null | undefined,
  event: CommissionEvent,
): CommissionEvent[] {
  return [...(events ?? []), event].slice(-50)
}

// ── Pay periods ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

function dayNumber(day: string): number {
  return Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  )
}

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDaysTo(day: string, n: number): string {
  return dayString(dayNumber(day) + n * DAY_MS)
}

export interface PeriodWindow {
  periodStart: string
  periodEnd: string
  payDate: string
}

/**
 * The window a date falls in, and when that window gets paid. Weeks run Monday
 * to Sunday; a fortnight is counted from the schedule's anchor Monday; a
 * semi-monthly period is the 1st–15th and the 16th–end; a month is a month.
 */
export function periodWindow(
  schedule: CommissionPaySchedule | null | undefined,
  dateIso: string,
): PeriodWindow {
  const day = (dateIso ?? '').slice(0, 10)
  const frequency = schedule?.frequency ?? 'SEMI_MONTHLY'
  const daysUntilPay = schedule?.daysUntilPay != null ? Math.max(0, Math.trunc(schedule.daysUntilPay)) : 7

  const ms = dayNumber(day)
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const dom = date.getUTCDate()
  // Monday = 0 … Sunday = 6
  const weekday = (date.getUTCDay() + 6) % 7

  let periodStart: string
  let periodEnd: string

  if (frequency === 'WEEKLY') {
    periodStart = dayString(ms - weekday * DAY_MS)
    periodEnd = addDaysTo(periodStart, 6)
  } else if (frequency === 'BIWEEKLY') {
    const anchor = (schedule?.anchorDate ?? '2026-01-05').slice(0, 10)
    const anchorMs = dayNumber(anchor)
    const elapsed = Math.floor((ms - anchorMs) / DAY_MS)
    const offset = ((elapsed % 14) + 14) % 14
    periodStart = dayString(ms - offset * DAY_MS)
    periodEnd = addDaysTo(periodStart, 13)
  } else if (frequency === 'MONTHLY') {
    periodStart = dayString(Date.UTC(year, month, 1))
    periodEnd = dayString(Date.UTC(year, month + 1, 0))
  } else {
    // SEMI_MONTHLY
    if (dom <= 15) {
      periodStart = dayString(Date.UTC(year, month, 1))
      periodEnd = dayString(Date.UTC(year, month, 15))
    } else {
      periodStart = dayString(Date.UTC(year, month, 16))
      periodEnd = dayString(Date.UTC(year, month + 1, 0))
    }
  }

  let payDate = addDaysTo(periodEnd, daysUntilPay)
  if (frequency === 'MONTHLY' && schedule?.payDay != null) {
    const payDom = Math.min(28, Math.max(1, Math.trunc(schedule.payDay)))
    const endDate = new Date(dayNumber(periodEnd))
    payDate = dayString(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, payDom))
  }
  return { periodStart, periodEnd, payDate }
}

export function payPeriodId(periodStart: string): string {
  return `cpp:${periodStart}`
}

export interface PayPeriodTotals {
  commissionCount: number
  totalCents: number
  byRep: { repId: string; repName: string | null; count: number; amountCents: number }[]
}

export function payPeriodTotals(rows: CommissionRecord[]): PayPeriodTotals {
  const byRep = new Map<string, { repId: string; repName: string | null; count: number; amountCents: number }>()
  let totalCents = 0
  let commissionCount = 0
  for (const row of rows) {
    if (row.status === 'CANCELLED') continue
    const key = row.repId.toLowerCase()
    const entry = byRep.get(key) ?? { repId: row.repId, repName: row.repName ?? null, count: 0, amountCents: 0 }
    // The row's own `netCents` is what the ledger says is owed; derive it only
    // for a row written before the field existed.
    const amount = row.netCents != null ? Math.trunc(row.netCents) : netCentsOf(row)
    entry.count += 1
    entry.amountCents += amount
    byRep.set(key, entry)
    totalCents += amount
    commissionCount += 1
  }
  return {
    commissionCount,
    totalCents,
    byRep: [...byRep.values()].sort((a, b) => b.amountCents - a.amountCents),
  }
}

// ── Plan validation (the settings save) ──────────────────────────────────────

/**
 * Read one node of the saved JSON, refusing anything that is not an object with
 * the sentence the settings card shows. The house style for every validator on
 * a `TmsSettings` JSON column (`validateChargeCodes`, `validateTeams`): a
 * readable refusal per field, not a schema dump.
 */
const fieldsOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const intIn = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number`)
  }
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return value
}

/**
 * Validate the commission plans an admin saves. Everything a plan can say that
 * the engine cannot act on is refused here, in words, rather than silently
 * producing a wrong number later — including a graduated ladder over margin
 * bands, which has no slice to pay a rate on.
 */
export function validateCommissionPlans(value: unknown): CommissionPlan[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('commissionPlans must be a list')
  if (value.length > 50) throw new Error('commissionPlans takes at most 50 plans')

  const keys = new Set<string>()
  return value.map((rawPlan, i) => {
    const raw = fieldsOf(rawPlan, `commissionPlans[${i}]`)
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id) throw new Error(`commissionPlans[${i}].id is required`)
    if (keys.has(id.toLowerCase())) throw new Error(`commissionPlans[${i}].id "${id}" is used twice`)
    keys.add(id.toLowerCase())
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) throw new Error(`commissionPlans[${i}].name is required`)

    const rolesRaw = raw.roles
    if (!Array.isArray(rolesRaw) || rolesRaw.length === 0) {
      throw new Error(`commissionPlans[${i}] needs at least one role`)
    }
    if (rolesRaw.length > 20) throw new Error(`commissionPlans[${i}] takes at most 20 roles`)

    const roles: CommissionPlanRole[] = rolesRaw.map((rawRole, j) => {
      const label = `commissionPlans[${i}].roles[${j}]`
      const r = fieldsOf(rawRole, label)
      const roleName = r.roleName as CommissionRoleName
      if (!COMMISSION_ROLE_NAMES.includes(roleName)) {
        throw new Error(`${label}.roleName "${String(r.roleName)}" is not a commission role`)
      }
      const rateType = r.rateType as CommissionRateType
      if (!COMMISSION_RATE_TYPES.includes(rateType)) {
        throw new Error(`${label}.rateType must be FIXED, PERCENT_PROFIT or PERCENT_REVENUE`)
      }
      const rateBps = rateType === 'FIXED' ? null : intIn(r.rateBps, `${label}.rateBps`, 0, 10000)
      const rateCents = rateType === 'FIXED' ? intIn(r.rateCents, `${label}.rateCents`, 0, 100_000_000) : null
      const splitBps = r.splitBps == null ? null : intIn(r.splitBps, `${label}.splitBps`, 0, 10000)
      const userIds = Array.isArray(r.userIds)
        ? r.userIds.filter((u): u is string => typeof u === 'string' && u.trim() !== '').map((u) => u.trim())
        : null
      if (roleName === 'SPECIFIC_USER' && (!userIds || userIds.length === 0)) {
        throw new Error(`${label} is SPECIFIC_USER and needs at least one user`)
      }

      const tierType = r.tierType == null ? null : (r.tierType as CommissionTierType)
      if (tierType && !COMMISSION_TIER_TYPES.includes(tierType)) {
        throw new Error(`${label}.tierType must be PER_LOAD_MARGIN_BPS or PER_LOAD_PROFIT_CENTS`)
      }
      const graduated = r.graduated === true
      if (graduated && tierType !== 'PER_LOAD_PROFIT_CENTS') {
        throw new Error(
          `${label} is graduated, which only works on gross-profit bands — a margin ladder has no slice to pay a rate on`,
        )
      }

      let tiers: CommissionTier[] | null = null
      if (r.tiers != null) {
        if (!Array.isArray(r.tiers)) throw new Error(`${label}.tiers must be a list`)
        if (r.tiers.length > 0 && !tierType) throw new Error(`${label} has tiers but no tierType`)
        if (r.tiers.length > 12) throw new Error(`${label} takes at most 12 tiers`)
        let previous = Number.NEGATIVE_INFINITY
        tiers = r.tiers.map((rawTier, k) => {
          const tLabel = `${label}.tiers[${k}]`
          const t = fieldsOf(rawTier, tLabel)
          const from =
            tierType === 'PER_LOAD_MARGIN_BPS'
              ? intIn(t.fromBps, `${tLabel}.fromBps`, -10000, 100000)
              : intIn(t.fromCents, `${tLabel}.fromCents`, -100_000_000, 100_000_000)
          if (from <= previous) throw new Error(`${tLabel} must start above the tier before it`)
          previous = from
          const tierRateBps = intIn(t.rateBps, `${tLabel}.rateBps`, 0, 10000)
          return tierType === 'PER_LOAD_MARGIN_BPS'
            ? { fromBps: from, rateBps: tierRateBps, label: typeof t.label === 'string' ? t.label : null }
            : { fromCents: from, rateBps: tierRateBps, label: typeof t.label === 'string' ? t.label : null }
        })
        if (tiers.length > 0) {
          const first = tierType === 'PER_LOAD_MARGIN_BPS' ? tiers[0].fromBps : tiers[0].fromCents
          if ((first ?? 0) > 0) throw new Error(`${label}.tiers must start at 0 so every load lands in a band`)
        }
      }

      return { roleName, rateType, rateBps, rateCents, splitBps, userIds, tierType, graduated, tiers }
    })

    const scopeRaw =
      raw.scope == null ? null : fieldsOf(raw.scope, `commissionPlans[${i}].scope`)
    const list = (v: unknown): string[] | null =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : null

    const dateField = raw.dateField === 'DELIVERED' ? 'DELIVERED' : raw.dateField === 'INVOICED' ? 'INVOICED' : null
    const day = (v: unknown, label: string): string | null => {
      if (v == null || v === '') return null
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error(`${label} must be a date like 2026-01-31`)
      }
      return v
    }
    const effectiveFrom = day(raw.effectiveFrom, `commissionPlans[${i}].effectiveFrom`)
    const effectiveTo = day(raw.effectiveTo, `commissionPlans[${i}].effectiveTo`)
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      throw new Error(`commissionPlans[${i}] ends before it starts`)
    }

    return {
      id,
      name,
      active: raw.active !== false,
      effectiveFrom,
      effectiveTo,
      dateField,
      scope: scopeRaw
        ? { userIds: list(scopeRaw.userIds), customerIds: list(scopeRaw.customerIds), teamKeys: list(scopeRaw.teamKeys) }
        : null,
      roles,
    }
  })
}

export function validatePaySchedule(value: unknown): CommissionPaySchedule | null {
  if (value == null) return null
  const fields = fieldsOf(value, 'commissionPaySchedule')
  const frequency = fields.frequency as PayScheduleFrequency
  if (!PAY_SCHEDULE_FREQUENCIES.includes(frequency)) {
    throw new Error('commissionPaySchedule.frequency must be WEEKLY, BIWEEKLY, SEMI_MONTHLY or MONTHLY')
  }
  const payDay =
    fields.payDay == null
      ? null
      : intIn(fields.payDay, 'commissionPaySchedule.payDay', 0, frequency === 'MONTHLY' ? 28 : 6)
  const daysUntilPay =
    fields.daysUntilPay == null
      ? null
      : intIn(fields.daysUntilPay, 'commissionPaySchedule.daysUntilPay', 0, 90)
  let anchorDate: string | null = null
  if (fields.anchorDate != null && fields.anchorDate !== '') {
    if (typeof fields.anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fields.anchorDate)) {
      throw new Error('commissionPaySchedule.anchorDate must be a date like 2026-01-05')
    }
    anchorDate = fields.anchorDate
  }
  return { frequency, payDay, daysUntilPay, anchorDate }
}
