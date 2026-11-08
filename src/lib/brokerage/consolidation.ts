/**
 * Consolidation rules (Step L).
 *
 * Advisory only: this file evaluates a group of shipments against stored rules and
 * returns reasons to BLOCK or WARN. It never touches AR status and has no AR input.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */

export type ConsolidationSeverity = 'BLOCK' | 'WARN' | 'OFF'

export interface ConsolidationCategory {
  key: string
  label: string
  unit?: string
}

export interface ConsolidationRule {
  category: string
  severity: ConsolidationSeverity
  threshold?: number | null
  unit?: string | null
}

export interface ConsolidationRules {
  rules: ConsolidationRule[]
  hazmatMode: 'NEVER' | 'SAME_CLASS' | 'ALLOW'
  onHold: 'BLOCK' | 'WARN'
}

export interface ConsolidationReason {
  category: string
  severity: ConsolidationSeverity
  message: string
}

export interface ConsolidationEvaluation {
  blocks: ConsolidationReason[]
  warns: ConsolidationReason[]
}

/** The eight categories a rule can govern. */
export const CONSOLIDATION_CATEGORIES: readonly ConsolidationCategory[] = [
  { key: 'CUSTOMER_MISMATCH', label: 'Shipments belong to different customers' },
  { key: 'TEMPERATURE', label: 'Temperature requirements differ' },
  { key: 'WEIGHT_TOTAL', label: 'Total weight exceeds threshold', unit: 'pounds' },
  { key: 'STOP_COUNT', label: 'Total stop count exceeds threshold', unit: 'stops' },
  { key: 'PICKUP_WINDOW_DAYS', label: 'Pickup window spans more than threshold days', unit: 'days' },
  { key: 'EQUIPMENT_MISMATCH', label: 'Equipment types differ' },
  { key: 'HAZMAT', label: 'Hazmat handling conflict' },
  { key: 'ON_HOLD', label: 'One or more shipments are on hold' },
]

const CATEGORY_KEYS: readonly string[] = CONSOLIDATION_CATEGORIES.map((c) => c.key)
const CATEGORY_BY_KEY: Record<string, ConsolidationCategory> = Object.fromEntries(
  CONSOLIDATION_CATEGORIES.map((c) => [c.key, c]),
)

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number.`)
  }
  return value
}

/** The shape a caller passes for each shipment in the proposed group. */
export interface ConsolidationShipment {
  customerId?: string | null
  weightPounds?: number | null
  stopCount?: number | null
  pickupDate?: string | null
  equipmentType?: string | null
  hazmatClass?: string | null
  onHold?: boolean | null
}

/**
 * Validate the stored consolidation-rules object. One rule per category, and a
 * threshold is required only for categories that declare a unit.
 */
export function validateConsolidationRules(value: unknown): ConsolidationRules {
  const row = asRecord(value)
  if (!row) throw new Error('Consolidation rules must be an object.')

  const rawRules = Array.isArray(row.rules) ? row.rules : []
  const rules: ConsolidationRule[] = []
  const seen: Record<string, true> = {}

  for (let i = 0; i < rawRules.length; i++) {
    const raw = asRecord(rawRules[i])
    if (!raw) throw new Error(`Rule ${i + 1} must be an object.`)

    const category = typeof raw.category === 'string' ? raw.category.trim() : ''
    if (!category) throw new Error(`Rule ${i + 1} needs a category.`)
    if (!CATEGORY_KEYS.includes(category)) throw new Error(`"${category}" is not a consolidation category.`)
    if (seen[category]) throw new Error(`Only one rule is allowed per category; "${category}" appears twice.`)
    seen[category] = true

    const severity = typeof raw.severity === 'string' ? raw.severity : 'OFF'
    if (severity !== 'BLOCK' && severity !== 'WARN' && severity !== 'OFF') {
      throw new Error(`Rule ${i + 1} severity must be BLOCK, WARN or OFF.`)
    }

    const declaredUnit = CATEGORY_BY_KEY[category]?.unit
    let threshold: number | null = null
    if (declaredUnit) {
      if (raw.threshold === null || raw.threshold === undefined) {
        throw new Error(`Rule ${i + 1} needs a threshold in ${declaredUnit}.`)
      }
      threshold = wholeNumber(raw.threshold, `Rule ${i + 1} threshold`)
      const unit = typeof raw.unit === 'string' ? raw.unit.trim() : ''
      if (unit && unit !== declaredUnit) {
        throw new Error(`Rule ${i + 1} unit must be ${declaredUnit}.`)
      }
    }

    rules.push({ category, severity: severity as ConsolidationSeverity, threshold, unit: declaredUnit ?? null })
  }

  // Fill missing categories with OFF.
  for (const category of CATEGORY_KEYS) {
    if (!seen[category]) {
      rules.push({ category, severity: 'OFF', threshold: null, unit: CATEGORY_BY_KEY[category]?.unit ?? null })
    }
  }

  const hazmatMode = typeof row.hazmatMode === 'string' ? row.hazmatMode : 'NEVER'
  if (hazmatMode !== 'NEVER' && hazmatMode !== 'SAME_CLASS' && hazmatMode !== 'ALLOW') {
    throw new Error('Hazmat mode must be NEVER, SAME_CLASS or ALLOW.')
  }

  const onHold = typeof row.onHold === 'string' ? row.onHold : 'WARN'
  if (onHold !== 'BLOCK' && onHold !== 'WARN') {
    throw new Error('On-hold handling must be BLOCK or WARN.')
  }

  return { rules, hazmatMode: hazmatMode as ConsolidationRules['hazmatMode'], onHold: onHold as ConsolidationRules['onHold'] }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : null
}

function daysBetween(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null
  const ms = b.getTime() - a.getTime()
  return Math.floor(ms / 86_400_000)
}

/**
 * Evaluate a proposed shipment group against the stored rules. Returns BLOCK and
 * WARN reasons; OFF rules return nothing. No AR state is read or written.
 */
export function evaluateConsolidation(
  shipments: ConsolidationShipment[],
  rules: ConsolidationRules,
): ConsolidationEvaluation {
  const blocks: ConsolidationReason[] = []
  const warns: ConsolidationReason[] = []
  const byCategory: Record<string, ConsolidationRule> = {}
  for (const rule of rules.rules) byCategory[rule.category] = rule

  function push(severity: ConsolidationSeverity, category: string, message: string) {
    const reason = { category, severity, message }
    if (severity === 'BLOCK') blocks.push(reason)
    else if (severity === 'WARN') warns.push(reason)
  }

  if (shipments.length < 2) return { blocks, warns }

  const customerIds = new Set(shipments.map((s) => s.customerId ?? ''))
  if (customerIds.size > 1) {
    const rule = byCategory.CUSTOMER_MISMATCH
    if (rule?.severity && rule.severity !== 'OFF') {
      push(rule.severity, 'CUSTOMER_MISMATCH', 'The shipments belong to different customers.')
    }
  }

  const totalWeight = shipments.reduce((sum, s) => sum + (Number.isFinite(s.weightPounds ?? 0) ? (s.weightPounds ?? 0) : 0), 0)
  const weightRule = byCategory.WEIGHT_TOTAL
  if (weightRule?.severity && weightRule.severity !== 'OFF' && weightRule.threshold != null && totalWeight > weightRule.threshold) {
    push(weightRule.severity, 'WEIGHT_TOTAL', `Total weight ${totalWeight} lb exceeds ${weightRule.threshold} lb.`)
  }

  const totalStops = shipments.reduce((sum, s) => sum + (Number.isFinite(s.stopCount ?? 0) ? (s.stopCount ?? 0) : 0), 0)
  const stopRule = byCategory.STOP_COUNT
  if (stopRule?.severity && stopRule.severity !== 'OFF' && stopRule.threshold != null && totalStops > stopRule.threshold) {
    push(stopRule.severity, 'STOP_COUNT', `Total stop count ${totalStops} exceeds ${stopRule.threshold}.`)
  }

  const dates = shipments.map((s) => parseDate(s.pickupDate)).filter((d): d is Date => d != null)
  if (dates.length > 1) {
    const min = new Date(Math.min(...dates.map((d) => d.getTime())))
    const max = new Date(Math.max(...dates.map((d) => d.getTime())))
    const span = daysBetween(min, max)
    const windowRule = byCategory.PICKUP_WINDOW_DAYS
    if (windowRule?.severity && windowRule.severity !== 'OFF' && windowRule.threshold != null && span != null && span > windowRule.threshold) {
      push(windowRule.severity, 'PICKUP_WINDOW_DAYS', `Pickup window spans ${span} days, exceeding ${windowRule.threshold}.`)
    }
  }

  const equipmentTypes = new Set(shipments.map((s) => s.equipmentType ?? ''))
  if (equipmentTypes.size > 1) {
    const rule = byCategory.EQUIPMENT_MISMATCH
    if (rule?.severity && rule.severity !== 'OFF') {
      push(rule.severity, 'EQUIPMENT_MISMATCH', 'The shipments require different equipment.')
    }
  }

  const anyOnHold = shipments.some((s) => s.onHold === true)
  if (anyOnHold) {
    push(rules.onHold, 'ON_HOLD', 'One or more shipments are on hold.')
  }

  // Hazmat is stored for when a hazmat field exists; today it is advisory only.
  const hazmatClasses = new Set(shipments.map((s) => s.hazmatClass ?? ''))
  const hazmatRule = byCategory.HAZMAT
  if (hazmatRule?.severity && hazmatRule.severity !== 'OFF') {
    if (rules.hazmatMode === 'NEVER' && hazmatClasses.size > 0 && ![...hazmatClasses].every((c) => !c)) {
      push(hazmatRule.severity, 'HAZMAT', 'Hazmat is not allowed in consolidation.')
    } else if (rules.hazmatMode === 'SAME_CLASS' && hazmatClasses.size > 1) {
      push(hazmatRule.severity, 'HAZMAT', 'Hazmat classes differ across the group.')
    }
  }

  return { blocks, warns }
}
