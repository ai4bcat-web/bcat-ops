/**
 * Who earns a shipment — resolved from data, not from code.
 *
 * Ryne, 2026-10-28: BCAT runs three businesses (BCAT Logistics, Ivan Cartage with
 * its three driver subsidiaries, Best Care Auto Transport) and must be able to add
 * a fourth — or hand the TMS to a company with entirely different parties —
 * without a deploy. So the division tree and the ordered rules that tag a shipment
 * are rows an admin edits, and this file is the one place that reads them.
 *
 * The rules are tried in `sortOrder`; the FIRST active rule whose condition matches
 * and whose division is active wins. A shipment tagged by hand carries
 * `revTagSource: 'HAND'` and is never passed through here again until the tag is
 * cleared — that decision lives in the router, not in this file.
 *
 * A record stores division CODES, never ids-of-the-day: `revDivision` is the
 * matched division's top-level ancestor and `revSubdivision` is the matched node
 * itself when it is deeper, so "any depth" costs no third column.
 *
 * Imports are relative and type-only where possible: the tmsShipmentActions and
 * tmsDirectoryActions Lambdas bundle this file by path, so a `@/` alias would
 * break the function build.
 */
import { driverProgramOf } from './driverProgram'
import type { DriverProgram, ProgramInputs } from './driverProgram'
import type {
  OwnershipCondition,
  OwnershipDivisionRecord,
  OwnershipFlows,
  OwnershipOwners,
  OwnershipRuleRecord,
  OrderReference,
} from '../types/tms'

/**
 * The reserved `CARRIER_IS` value for our own trucks.
 *
 * There is no Carrier row for the own fleet — it is `LoadCarrier.kind === 'OWN_ASSET'`
 * with no `carrierId` — so the rule editor offers this constant alongside the real
 * carriers and `shipmentContextFor` maps an own-asset leg onto it.
 */
export const OWN_FLEET_CARRIER_CODE = 'OWN_FLEET'

/** Everything a rule may ask about one shipment. */
export interface ResolveContext {
  /** A Carrier id, or `OWN_FLEET` for an own-asset leg. */
  carrierId: string | null
  driverFleetGroup: string | null
  driverType: string | null
  driverProgram: DriverProgram | null
  customerId: string | null
  equipment: string | null
  mode: string | null
  loadSource: string | null
  /** Every order reference VALUE, for `REFERENCE_MATCHES`. */
  references: string[]
}

export interface Resolution {
  revDivision: string | null
  revSubdivision: string | null
  ruleId: string | null
}

/**
 * The columns the tree walk needs. Deliberately structural: the seed rows and a
 * half-written draft in the Settings editor both have to walk the same tree as
 * the rows that came back from the API.
 */
export type DivisionShape = Pick<OwnershipDivisionRecord, 'id' | 'code' | 'parentId'>
export type DivisionTreeShape = DivisionShape & Pick<OwnershipDivisionRecord, 'sortOrder'>

/** One node of the division tree, children sorted by `sortOrder`. */
export interface DivisionNode<T extends DivisionTreeShape = OwnershipDivisionRecord> {
  division: T
  children: DivisionNode<T>[]
}

/** Division rows as the seed carries them: no audit columns, the server adds those. */
export type OwnershipDivisionSeed = Omit<
  OwnershipDivisionRecord,
  'createdBy' | 'updatedBy' | 'version' | 'createdAt' | 'updatedAt'
>

/** Rule rows as the seed carries them. */
export type OwnershipRuleSeed = Omit<
  OwnershipRuleRecord,
  'createdBy' | 'updatedBy' | 'version' | 'createdAt' | 'updatedAt'
>

const text = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')
const sameText = (a: string | null, b: string | null): boolean =>
  text(a) !== '' && text(a).toLowerCase() === text(b).toLowerCase()

function byCode<T extends DivisionShape>(divisions: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const d of divisions) {
    // `id` and `code` are the same value by construction; index both so a row
    // written by an older client (id-only parentId) still resolves.
    if (text(d.code) !== '') map.set(d.code, d)
    if (text(d.id) !== '' && !map.has(d.id)) map.set(d.id, d)
  }
  return map
}

/**
 * Does this condition hold for this shipment?
 *
 * Ids and enum values compare exactly; the free-text fields an operator types
 * (equipment, mode, load source) compare case-insensitively, and
 * `REFERENCE_MATCHES` is a case-insensitive regex over every reference value.
 * A condition with no value never matches — a half-written rule must not swallow
 * every shipment.
 */
export function matchesCondition(condition: OwnershipCondition | null | undefined, ctx: ResolveContext): boolean {
  if (!condition) return false
  const value = condition.value == null ? null : String(condition.value)
  switch (condition.kind) {
    case 'ALWAYS':
      return true
    case 'CARRIER_IS':
      return text(value) !== '' && ctx.carrierId === value
    case 'DRIVER_FLEET_GROUP_IS':
      return text(value) !== '' && ctx.driverFleetGroup === value
    case 'DRIVER_TYPE_IS':
      return text(value) !== '' && ctx.driverType === value
    case 'DRIVER_PROGRAM_IS':
      return text(value) !== '' && ctx.driverProgram === value
    case 'CUSTOMER_IS':
      return text(value) !== '' && ctx.customerId === value
    case 'EQUIPMENT_IS':
      return sameText(value, ctx.equipment)
    case 'MODE_IS':
      return sameText(value, ctx.mode)
    case 'LOAD_SOURCE_IS':
      return sameText(value, ctx.loadSource)
    case 'REFERENCE_MATCHES': {
      if (text(value) === '') return false
      let re: RegExp
      try {
        re = new RegExp(value as string, 'i')
      } catch {
        // A rule an admin broke must not throw inside a booking transaction.
        return false
      }
      return ctx.references.some((r) => typeof r === 'string' && re.test(r))
    }
    default:
      return false
  }
}

/**
 * The top-level ancestor of `code`, or null when the code is unknown or its parent
 * chain loops. Cycle-safe: a tree an admin broke must not hang a Lambda.
 */
export function topLevelOf(divisions: DivisionShape[], code: string): string | null {
  const index = byCode(divisions)
  let node = index.get(code)
  if (!node) return null
  const seen = new Set<string>()
  while (node && text(node.parentId) !== '') {
    if (seen.has(node.code)) return null
    seen.add(node.code)
    const parent = index.get(node.parentId as string)
    if (!parent) return null
    node = parent
  }
  return node ? node.code : null
}

/** The tree an admin edits and the sidebar renders. Inactive divisions are included. */
export function divisionTree<T extends DivisionTreeShape>(divisions: T[]): DivisionNode<T>[] {
  const index = byCode(divisions)
  const nodes = new Map<string, DivisionNode<T>>()
  for (const d of divisions) nodes.set(d.code, { division: d, children: [] })

  const roots: DivisionNode<T>[] = []
  for (const d of divisions) {
    const node = nodes.get(d.code)
    if (!node) continue
    const parentCode = text(d.parentId) === '' ? null : index.get(d.parentId as string)?.code ?? null
    // A node whose parent is missing, or whose chain loops, is shown at the top
    // rather than dropped: an admin has to be able to see the row to repair it.
    const parent = parentCode && parentCode !== d.code && topLevelOf(divisions, d.code) ? nodes.get(parentCode) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (list: DivisionNode<T>[]): DivisionNode<T>[] => {
    list.sort((a, b) => a.division.sortOrder - b.division.sortOrder || a.division.code.localeCompare(b.division.code))
    for (const n of list) sort(n.children)
    return list
  }
  return sort(roots)
}

/** Everything wrong with a division tree, in plain English. Empty = it is sound. */
export function validateDivisions(divisions: (DivisionShape & Pick<OwnershipDivisionRecord, 'name'>)[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const d of divisions) {
    const code = text(d.code)
    if (code === '') {
      errors.push('A division has no code.')
      continue
    }
    if (seen.has(code)) errors.push(`Duplicate division code "${code}".`)
    seen.add(code)
    if (text(d.name) === '') errors.push(`Division "${code}" has no name.`)
  }

  const index = byCode(divisions)
  for (const d of divisions) {
    const code = text(d.code)
    if (code === '' || text(d.parentId) === '') continue
    if (!index.has(d.parentId as string)) {
      errors.push(`Division "${code}" has an unknown parent "${d.parentId}".`)
      continue
    }
    if (topLevelOf(divisions, code) == null) errors.push(`Division "${code}" is its own ancestor.`)
  }
  return errors
}

// Every kind but ALWAYS is meaningless without a value: a half-written rule must
// never swallow the board.
const CONDITION_KIND_NEEDS_VALUE: Record<string, boolean> = {
  ALWAYS: false,
  CARRIER_IS: true,
  DRIVER_FLEET_GROUP_IS: true,
  DRIVER_TYPE_IS: true,
  DRIVER_PROGRAM_IS: true,
  CUSTOMER_IS: true,
  EQUIPMENT_IS: true,
  MODE_IS: true,
  LOAD_SOURCE_IS: true,
  REFERENCE_MATCHES: true,
}

/** Everything wrong with the rule list against this division tree. */
export function validateRules(
  rules: Pick<OwnershipRuleRecord, 'id' | 'name' | 'condition' | 'divisionCode'>[],
  divisions: DivisionShape[],
): string[] {
  const errors: string[] = []
  const index = byCode(divisions)
  for (const rule of rules) {
    const label = text(rule.name) !== '' ? rule.name : rule.id
    const kind = rule.condition?.kind
    if (!kind || !(kind in CONDITION_KIND_NEEDS_VALUE)) {
      errors.push(`Rule "${label}" has an unknown condition.`)
    } else if (CONDITION_KIND_NEEDS_VALUE[kind] && text(rule.condition.value) === '') {
      errors.push(`Rule "${label}" needs a value for ${kind}.`)
    } else if (kind === 'REFERENCE_MATCHES') {
      try {
        new RegExp(rule.condition.value as string, 'i')
      } catch {
        errors.push(`Rule "${label}" has an invalid reference pattern.`)
      }
    }
    if (text(rule.divisionCode) === '') errors.push(`Rule "${label}" names no division.`)
    else if (!index.has(rule.divisionCode)) errors.push(`Rule "${label}" points at an unknown division "${rule.divisionCode}".`)
  }
  return errors
}

/**
 * Which division earns this shipment. First active rule whose condition matches and
 * whose division is active and reachable wins; no match leaves the shipment untagged
 * rather than guessing.
 */
export function resolveDivision(
  divisions: (DivisionShape & Pick<OwnershipDivisionRecord, 'active'>)[],
  rules: Pick<OwnershipRuleRecord, 'id' | 'active' | 'sortOrder' | 'condition' | 'divisionCode'>[],
  ctx: ResolveContext,
): Resolution {
  const index = byCode(divisions)
  const ordered = rules
    .filter((r) => r.active)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)

  for (const rule of ordered) {
    if (!matchesCondition(rule.condition, ctx)) continue
    const division = index.get(rule.divisionCode)
    // An archived division (or one deleted out from under a rule) is skipped, not
    // written: the next rule — ultimately the catch-all — answers instead.
    if (!division || !division.active) continue
    const top = topLevelOf(divisions, division.code)
    if (top == null) continue
    return {
      revDivision: top,
      revSubdivision: top === division.code ? null : division.code,
      ruleId: rule.id,
    }
  }
  return { revDivision: null, revSubdivision: null, ruleId: null }
}

/** What `shipmentContextFor` needs off each record. Every part is optional. */
export interface ShipmentContextInput {
  shipment?: { customerId?: string | null; mode?: string | null; source?: string | null } | null
  order?: {
    customerId?: string | null
    mode?: string | null
    equipmentType?: string | null
    /** Only the value is read — the router may hand over partial rows. */
    references?: Partial<OrderReference>[] | null
  } | null
  load?: { customerId?: string | null; equipmentType?: string | null } | null
  loadCarrier?: { kind?: string | null; carrierId?: string | null } | null
  driver?: (ProgramInputs & { fleetGroup?: string | null; driverType?: string | null }) | null
}

/**
 * Build the rule context from the records a booking already has in hand.
 *
 * The own-fleet leg is the important case: it carries no `carrierId` at all, so it
 * is mapped onto the reserved `OWN_FLEET` value the seed rule names.
 */
export function shipmentContextFor(input: ShipmentContextInput): ResolveContext {
  const { shipment, order, load, loadCarrier, driver } = input
  const carrierId = loadCarrier
    ? loadCarrier.kind === 'OWN_ASSET'
      ? OWN_FLEET_CARRIER_CODE
      : text(loadCarrier.carrierId) === '' ? null : (loadCarrier.carrierId as string)
    : null

  const references: string[] = []
  for (const ref of order?.references ?? []) {
    if (ref && typeof ref.value === 'string' && ref.value.trim() !== '') references.push(ref.value)
  }

  return {
    carrierId,
    driverFleetGroup: driver?.fleetGroup ?? null,
    driverType: driver?.driverType ?? null,
    driverProgram: driver ? driverProgramOf(driver) : null,
    customerId: shipment?.customerId ?? order?.customerId ?? load?.customerId ?? null,
    equipment: order?.equipmentType ?? load?.equipmentType ?? null,
    mode: shipment?.mode ?? order?.mode ?? null,
    loadSource: shipment?.source ?? null,
    references,
  }
}

// ── Seed rows ────────────────────────────────────────────────────────────────
// The three businesses, Ivan's three driver subsidiaries and the Company group are
// SEED DATA, not constants: ENSURE_OWNERSHIP_SEED writes them once and an admin
// edits, archives or adds to them from Divisions & ownership afterwards.

const owners = (party: string, overrides: Partial<OwnershipOwners> = {}): OwnershipOwners => ({
  building: party,
  booking: party,
  tracking: party,
  invoicing: party,
  carrierPay: party,
  settlements: party,
  ...overrides,
})

const flows = (on: Partial<OwnershipFlows> = {}): OwnershipFlows => ({
  calendar: false,
  dispatch: false,
  driverApp: false,
  driverPay: false,
  fleetDashboards: false,
  carShipping: false,
  ...on,
})

export const SEED_DIVISIONS: OwnershipDivisionSeed[] = [
  {
    id: 'BROKERAGE',
    code: 'BROKERAGE',
    name: 'BCAT Logistics',
    brand: 'BCAT Logistics',
    parentId: null,
    color: '#f4c50c',
    sortOrder: 10,
    active: true,
    // Brokerage buys capacity: nothing it books is ever settled as driver pay.
    owners: owners('BCAT Logistics', { settlements: null }),
    flows: flows(),
  },
  {
    id: 'ASSETS',
    code: 'ASSETS',
    name: 'Ivan Cartage',
    brand: 'Ivan Cartage',
    parentId: null,
    color: '#0a81ff',
    sortOrder: 20,
    active: true,
    owners: owners('Ivan Cartage'),
    // An own-fleet shipment IS a load for every existing own-fleet page.
    flows: flows({ calendar: true, dispatch: true, driverApp: true, driverPay: true, fleetDashboards: true }),
  },
  // The three subsidiaries inherit Ivan Cartage's owners and flows: null, not a copy,
  // so changing the parent changes them.
  {
    id: 'OWNER_OPERATOR',
    code: 'OWNER_OPERATOR',
    name: 'Owner Operators',
    brand: null,
    parentId: 'ASSETS',
    color: null,
    sortOrder: 21,
    active: true,
    owners: null,
    flows: null,
  },
  {
    id: 'BOX_TRUCK',
    code: 'BOX_TRUCK',
    name: 'Box Trucks',
    brand: null,
    parentId: 'ASSETS',
    color: null,
    sortOrder: 22,
    active: true,
    owners: null,
    flows: null,
  },
  {
    id: 'LOCAL',
    code: 'LOCAL',
    name: 'Local Drivers',
    brand: null,
    parentId: 'ASSETS',
    color: null,
    sortOrder: 23,
    active: true,
    owners: null,
    flows: null,
  },
  {
    id: 'CAR_SHIPPING',
    code: 'CAR_SHIPPING',
    name: 'Best Care Auto Transport',
    brand: 'Best Care Auto Transport',
    parentId: null,
    color: '#1ba774',
    sortOrder: 30,
    active: true,
    owners: owners('Best Care Auto Transport'),
    flows: flows({ carShipping: true }),
  },
  {
    id: 'COMPANY',
    code: 'COMPANY',
    name: 'Company',
    brand: null,
    parentId: null,
    color: null,
    sortOrder: 40,
    active: true,
    owners: null,
    flows: null,
  },
]

/**
 * The rules Ryne described, in the order he described them.
 *
 * The driver rules come FIRST so an own-fleet load lands in the right subsidiary;
 * the carrier rule behind them catches every other own-fleet load (an Amazon driver,
 * a driver with no fleet group) for Ivan Cartage with no subsidiary. The reference
 * rule is how a vehicle move is recognised today — nothing in the data marks one —
 * and the catch-all keeps every remaining shipment in Brokerage.
 */
export const SEED_RULES: OwnershipRuleSeed[] = [
  {
    id: 'rule-seed-1',
    name: 'Owner operator driver',
    sortOrder: 1,
    active: true,
    condition: { kind: 'DRIVER_FLEET_GROUP_IS', value: 'OWNER_OPERATOR' },
    divisionCode: 'OWNER_OPERATOR',
  },
  {
    id: 'rule-seed-2',
    name: 'Owner operator by driver type',
    sortOrder: 2,
    active: true,
    condition: { kind: 'DRIVER_TYPE_IS', value: 'OWNER_OPERATOR' },
    divisionCode: 'OWNER_OPERATOR',
  },
  {
    id: 'rule-seed-3',
    name: 'Box truck driver',
    sortOrder: 3,
    active: true,
    condition: { kind: 'DRIVER_FLEET_GROUP_IS', value: 'BOX_TRUCK' },
    divisionCode: 'BOX_TRUCK',
  },
  {
    id: 'rule-seed-4',
    name: 'Local driver',
    sortOrder: 4,
    active: true,
    condition: { kind: 'DRIVER_FLEET_GROUP_IS', value: 'LOCAL' },
    divisionCode: 'LOCAL',
  },
  {
    id: 'rule-seed-5',
    name: 'Own fleet',
    sortOrder: 5,
    active: true,
    condition: { kind: 'CARRIER_IS', value: OWN_FLEET_CARRIER_CODE },
    divisionCode: 'ASSETS',
  },
  {
    id: 'rule-seed-6',
    name: 'Vehicle transport',
    sortOrder: 6,
    active: true,
    condition: { kind: 'REFERENCE_MATCHES', value: 'vehicle|auto transport|car shipping' },
    divisionCode: 'CAR_SHIPPING',
  },
  {
    id: 'rule-seed-7',
    name: 'Everything else',
    sortOrder: 7,
    active: true,
    condition: { kind: 'ALWAYS', value: null },
    divisionCode: 'BROKERAGE',
  },
]
