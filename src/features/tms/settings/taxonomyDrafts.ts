/**
 * The half-written state behind Divisions & ownership.
 *
 * The editor has to walk, label and re-order a tree an admin is in the middle of
 * breaking, so every helper here works on drafts — rows that may have no code yet,
 * a parent that does not exist, or a regex that does not compile — and leaves the
 * judging to `validateDivisions` / `validateRules` in `src/lib/ownership.ts`.
 */
import { divisionTree } from '@/lib/ownership'
import type { DivisionNode } from '@/lib/ownership'
import type {
  OwnershipConditionKind,
  OwnershipDivisionRecord,
  OwnershipFlows,
  OwnershipOwners,
  OwnershipRuleRecord,
} from '@/types/tms'
import type { OwnershipDivisionInput, OwnershipRuleInput } from '@/lib/apiClient'

// ── Labels ───────────────────────────────────────────────────────────────────

/** Every condition a rule can ask about, in words an admin reads out loud. */
export const CONDITION_KINDS: readonly OwnershipConditionKind[] = [
  'CARRIER_IS',
  'DRIVER_FLEET_GROUP_IS',
  'DRIVER_TYPE_IS',
  'DRIVER_PROGRAM_IS',
  'CUSTOMER_IS',
  'EQUIPMENT_IS',
  'MODE_IS',
  'LOAD_SOURCE_IS',
  'REFERENCE_MATCHES',
  'ALWAYS',
]

export const CONDITION_KIND_LABELS: Record<OwnershipConditionKind, string> = {
  CARRIER_IS: 'Carrier is',
  DRIVER_FLEET_GROUP_IS: 'Driver fleet group is',
  DRIVER_TYPE_IS: 'Driver type is',
  DRIVER_PROGRAM_IS: 'Driver program is',
  CUSTOMER_IS: 'Customer is',
  EQUIPMENT_IS: 'Equipment is',
  MODE_IS: 'Mode is',
  LOAD_SOURCE_IS: 'Load source is',
  REFERENCE_MATCHES: 'Reference matches',
  ALWAYS: 'Always (catch-all)',
}

/** The fixed vocabularies the driver conditions choose from. */
export const DRIVER_FLEET_GROUPS: readonly string[] = ['LOCAL', 'AMAZON', 'BOX_TRUCK', 'OWNER_OPERATOR']
export const DRIVER_TYPES: readonly string[] = ['COMPANY', 'OWNER_OPERATOR']
export const DRIVER_PROGRAMS: readonly string[] = ['SETTLEMENT', 'PAPERWORK']

/** The six questions a division answers about who does the work. */
export const OWNER_SLOTS: ReadonlyArray<{ key: keyof OwnershipOwners; label: string }> = [
  { key: 'building', label: 'Who owns building' },
  { key: 'booking', label: 'Who owns booking' },
  { key: 'tracking', label: 'Who owns tracking' },
  { key: 'invoicing', label: 'Who owns invoicing (AR)' },
  { key: 'carrierPay', label: 'Who owns carrier pay (AP)' },
  { key: 'settlements', label: 'Who owns settlements' },
]

/** The six existing surfaces a division's shipments flow into. */
export const FLOW_SLOTS: ReadonlyArray<{ key: keyof OwnershipFlows; label: string }> = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'driverApp', label: 'Driver app' },
  { key: 'driverPay', label: 'Driver pay' },
  { key: 'fleetDashboards', label: 'Fleet dashboards' },
  { key: 'carShipping', label: 'Car-shipping pages' },
]

// ── Tree walking ─────────────────────────────────────────────────────────────

export interface DivisionTreeRow {
  division: OwnershipDivisionRecord
  depth: number
}

function walk(nodes: DivisionNode<OwnershipDivisionRecord>[], depth: number, out: DivisionTreeRow[]): void {
  for (const node of nodes) {
    out.push({ division: node.division, depth })
    walk(node.children, depth + 1, out)
  }
}

/** The tree as an indented list: parents immediately before their children. */
export function flattenDivisions(divisions: OwnershipDivisionRecord[]): DivisionTreeRow[] {
  const rows: DivisionTreeRow[] = []
  walk(divisionTree(divisions), 0, rows)
  return rows
}

/** `code` and everything under it — the parents a division may never be given. */
export function descendantCodes(divisions: OwnershipDivisionRecord[], code: string): Set<string> {
  const rows = flattenDivisions(divisions)
  const start = rows.findIndex((r) => r.division.code === code)
  const out = new Set<string>()
  if (start < 0) return out
  out.add(code)
  const base = rows[start].depth
  for (let i = start + 1; i < rows.length && rows[i].depth > base; i += 1) out.add(rows[i].division.code)
  return out
}

/** `'— — Box trucks (BOX_TRUCK)'`: the option label that shows where a division sits. */
export function divisionOptions(
  divisions: OwnershipDivisionRecord[],
  opts: { exclude?: Set<string>; includeInactive?: boolean } = {},
): Array<{ value: string; label: string }> {
  return flattenDivisions(divisions)
    .filter((row) => (opts.includeInactive ?? true) || row.division.active)
    .filter((row) => !opts.exclude?.has(row.division.code))
    .map((row) => ({
      value: row.division.code,
      label: `${'— '.repeat(row.depth)}${row.division.name} (${row.division.code})`,
    }))
}

/** The codes that are not top-level: what `revSubdivision` can hold. */
export function subdivisionOptions(divisions: OwnershipDivisionRecord[]): Array<{ value: string; label: string }> {
  return flattenDivisions(divisions)
    .filter((row) => row.depth > 0)
    .map((row) => ({ value: row.division.code, label: `${row.division.name} (${row.division.code})` }))
}

/** The brands of the top-level businesses — the party names an owner field suggests. */
export function partySuggestions(divisions: OwnershipDivisionRecord[]): string[] {
  const seen = new Set<string>()
  for (const row of flattenDivisions(divisions)) {
    if (row.depth !== 0) continue
    const brand = (row.division.brand ?? '').trim() || row.division.name.trim()
    if (brand) seen.add(brand)
  }
  return [...seen]
}

function ancestors(divisions: OwnershipDivisionRecord[], parentId: string | null): OwnershipDivisionRecord[] {
  const byCode = new Map(divisions.map((d) => [d.code, d]))
  const chain: OwnershipDivisionRecord[] = []
  const seen = new Set<string>()
  let current = parentId ? byCode.get(parentId) : undefined
  while (current && !seen.has(current.code)) {
    seen.add(current.code)
    chain.push(current)
    current = current.parentId ? byCode.get(current.parentId) : undefined
  }
  return chain
}

/** What a subsidiary shows greyed when its own owner slot is empty. */
export function inheritedOwner(
  divisions: OwnershipDivisionRecord[],
  parentId: string | null,
  key: keyof OwnershipOwners,
): string | null {
  for (const node of ancestors(divisions, parentId)) {
    const value = (node.owners?.[key] ?? '').trim()
    if (value) return value
  }
  return null
}

/** What a subsidiary shows greyed when its own flow switch is unset. */
export function inheritedFlow(
  divisions: OwnershipDivisionRecord[],
  parentId: string | null,
  key: keyof OwnershipFlows,
): boolean | null {
  for (const node of ancestors(divisions, parentId)) {
    const value = node.flows?.[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

// ── Division drafts ──────────────────────────────────────────────────────────

/** `''` in an owner slot and `null` in a flow slot both mean "inherit". */
export interface DivisionDraft {
  code: string
  name: string
  brand: string
  parentId: string
  color: string
  sortOrder: number
  active: boolean
  owners: Record<keyof OwnershipOwners, string>
  flows: Record<keyof OwnershipFlows, boolean | null>
  /** A new row may still choose its code; an existing one never may. */
  isNew: boolean
}

const EMPTY_OWNERS: Record<keyof OwnershipOwners, string> = {
  building: '', booking: '', tracking: '', invoicing: '', carrierPay: '', settlements: '',
}

const EMPTY_FLOWS: Record<keyof OwnershipFlows, boolean | null> = {
  calendar: null, dispatch: null, driverApp: null, driverPay: null, fleetDashboards: null, carShipping: null,
}

export function blankDivisionDraft(parentId = '', sortOrder = 0): DivisionDraft {
  return {
    code: '',
    name: '',
    brand: '',
    parentId,
    color: '',
    sortOrder,
    active: true,
    owners: { ...EMPTY_OWNERS },
    flows: { ...EMPTY_FLOWS },
    isNew: true,
  }
}

export function divisionToDraft(division: OwnershipDivisionRecord): DivisionDraft {
  const owners = { ...EMPTY_OWNERS }
  for (const slot of OWNER_SLOTS) owners[slot.key] = division.owners?.[slot.key] ?? ''
  const flows = { ...EMPTY_FLOWS }
  for (const slot of FLOW_SLOTS) {
    const value = division.flows?.[slot.key]
    flows[slot.key] = typeof value === 'boolean' ? value : null
  }
  return {
    code: division.code,
    name: division.name,
    brand: division.brand ?? '',
    parentId: division.parentId ?? '',
    color: division.color ?? '',
    sortOrder: division.sortOrder,
    active: division.active,
    owners,
    flows,
    isNew: false,
  }
}

/**
 * The tree as it would be once this draft is saved: the draft replaces the row with
 * its code, or joins the list when the code is new. That is the list
 * `validateDivisions` has to judge — a duplicate code or a parent loop only shows up
 * against the other rows.
 */
export function divisionsWithDraft(
  divisions: OwnershipDivisionRecord[],
  draft: DivisionDraft,
): Array<Pick<OwnershipDivisionRecord, 'id' | 'code' | 'name' | 'parentId' | 'sortOrder'>> {
  const code = draft.code.trim()
  const row = {
    id: code,
    code,
    name: draft.name.trim(),
    parentId: draft.parentId.trim() || null,
    sortOrder: draft.sortOrder,
  }
  const rest = divisions
    .filter((d) => d.code !== code)
    .map((d) => ({ id: d.id, code: d.code, name: d.name, parentId: d.parentId, sortOrder: d.sortOrder }))
  return [...rest, row]
}

export function draftToDivisionInput(draft: DivisionDraft): OwnershipDivisionInput {
  const owners: OwnershipOwners = {}
  for (const slot of OWNER_SLOTS) {
    const value = draft.owners[slot.key].trim()
    owners[slot.key] = value === '' ? null : value
  }
  const flows: OwnershipFlows = {}
  for (const slot of FLOW_SLOTS) {
    const value = draft.flows[slot.key]
    if (typeof value === 'boolean') flows[slot.key] = value
  }
  const code = draft.code.trim()
  return {
    id: code,
    code,
    name: draft.name.trim(),
    brand: draft.brand.trim() || null,
    parentId: draft.parentId.trim() || null,
    color: draft.color.trim() || null,
    sortOrder: draft.sortOrder,
    active: draft.active,
    owners,
    flows,
  }
}

// ── Rule drafts ──────────────────────────────────────────────────────────────

export interface RuleDraft {
  /** Stable across a re-order, so React keeps the focused input. */
  key: string
  /** Null until the server has written the row. */
  id: string | null
  name: string
  active: boolean
  kind: OwnershipConditionKind
  value: string
  divisionCode: string
}

let draftSeq = 0

export function blankRuleDraft(divisionCode = ''): RuleDraft {
  draftSeq += 1
  return {
    key: `draft-${draftSeq}`,
    id: null,
    name: '',
    active: true,
    kind: 'CARRIER_IS',
    value: '',
    divisionCode,
  }
}

export function ruleDraftsFrom(rules: OwnershipRuleRecord[]): RuleDraft[] {
  return [...rules]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((rule) => ({
      key: rule.id,
      id: rule.id,
      name: rule.name ?? '',
      active: rule.active,
      kind: rule.condition?.kind ?? 'ALWAYS',
      value: rule.condition?.value ?? '',
      divisionCode: rule.divisionCode,
    }))
}

/** What `validateRules` judges the list by before anything is sent. */
export function draftsAsRuleRows(
  drafts: RuleDraft[],
): Array<Pick<OwnershipRuleRecord, 'id' | 'name' | 'condition' | 'divisionCode'>> {
  return drafts.map((draft) => ({
    id: draft.id ?? draft.key,
    name: draft.name.trim() || null,
    condition: { kind: draft.kind, value: draft.kind === 'ALWAYS' ? null : draft.value.trim() || null },
    divisionCode: draft.divisionCode.trim(),
  }))
}

/** The whole ordered list: position in the array IS the priority. */
export function draftsToRuleInputs(drafts: RuleDraft[]): OwnershipRuleInput[] {
  return drafts.map((draft, index) => ({
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim() || null,
    sortOrder: index * 10,
    active: draft.active,
    condition: { kind: draft.kind, value: draft.kind === 'ALWAYS' ? null : draft.value.trim() || null },
    divisionCode: draft.divisionCode.trim(),
  }))
}

/** Move one rule to a new index. Out-of-range moves leave the list alone. */
export function moveRule(drafts: RuleDraft[], from: number, to: number): RuleDraft[] {
  if (from === to) return drafts
  if (from < 0 || from >= drafts.length || to < 0 || to >= drafts.length) return drafts
  const next = [...drafts]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Does this regex compile? The live check beside a REFERENCE_MATCHES value. */
export function isValidPattern(source: string): boolean {
  if (source.trim() === '') return false
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}
