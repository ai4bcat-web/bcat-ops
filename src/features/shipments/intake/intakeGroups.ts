/**
 * Intake page grouping (Step AV feedback 3): the page opens on All loads; "By rev division" and "By customer" section
 * the same table into one group per division or customer (Ryne 2026-11-16: grouped rows, no second row of filter chips).
 * Pure, so the counts are derived from the queue with no extra reads.
 */
import type { IntakeLoadRecord } from '@/types/intake'

export type IntakeView = 'all' | 'division' | 'customer'
export const ALL_GROUP = 'all'
export const UNASSIGNED = 'unassigned'
export const NOT_MATCHED = 'not-matched'

export interface IntakeGroup { id: string; label: string; count: number }
export interface IntakeDivisionRef { code: string; name: string }

export function parseView(raw: string | null): IntakeView {
  return raw === 'division' || raw === 'customer' ? raw : 'all'
}

/** One group per division in the given (display) order, then Unassigned for rows with no active division. */
export function groupByDivision(rows: IntakeLoadRecord[], divisions: IntakeDivisionRef[]): IntakeGroup[] {
  const counts = new Map<string, number>(divisions.map((d) => [d.code, 0]))
  let unassigned = 0
  for (const row of rows) {
    if (row.divisionCode != null && counts.has(row.divisionCode)) counts.set(row.divisionCode, (counts.get(row.divisionCode) ?? 0) + 1)
    else unassigned += 1
  }
  return [
    ...divisions.map((d) => ({ id: d.code, label: d.name, count: counts.get(d.code) ?? 0 })),
    { id: UNASSIGNED, label: 'Unassigned', count: unassigned },
  ]
}

/** One group per matched customer that has rows, most rows first (ties by name), then Not matched when any. */
export function groupByCustomer(rows: IntakeLoadRecord[]): IntakeGroup[] {
  const byId = new Map<string, IntakeGroup>()
  let notMatched = 0
  for (const row of rows) {
    const id = row.fields.customerId
    if (!id) { notMatched += 1; continue }
    const group = byId.get(id)
    if (group) group.count += 1
    else byId.set(id, { id, label: row.fields.customerName || id, count: 1 })
  }
  const groups = [...byId.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  return notMatched > 0 ? [...groups, { id: NOT_MATCHED, label: 'Not matched', count: notMatched }] : groups
}

/** The group a row sits in for this view: its active division (else Unassigned), or its matched customer (else Not matched). */
export function groupKeyOfRow(row: IntakeLoadRecord, view: IntakeView, divisionCodes: ReadonlySet<string>): string {
  if (view === 'division') return row.divisionCode != null && divisionCodes.has(row.divisionCode) ? row.divisionCode : UNASSIGNED
  if (view === 'customer') return row.fields.customerId || NOT_MATCHED
  return ALL_GROUP
}

/**
 * Rows reordered so each group's rows sit together, groups in the given order; within a group the incoming order (the table's
 * sort, newest received first by default) is kept. A row whose group is not listed goes last.
 */
export function orderByGroup<T>(rows: readonly T[], groups: readonly IntakeGroup[], keyOf: (row: T) => string): T[] {
  const rank = new Map(groups.map((g, i) => [g.id, i]))
  return rows
    .map((row, i) => ({ row, i, g: rank.get(keyOf(row)) ?? groups.length }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.row)
}

/**
 * Rev division joined the defaults on 2026-11-14. A layout saved before then never had it: add it once, right after Customer, and remember
 * that it was added so someone who later hides it keeps it hidden.
 */
export function withDivisionColumn(columns: readonly string[]): string[] {
  if (columns.includes('division')) return [...columns]
  const at = columns.indexOf('customer')
  const out = [...columns]
  out.splice(at >= 0 ? at + 1 : Math.min(out.length, 3), 0, 'division')
  return out
}
