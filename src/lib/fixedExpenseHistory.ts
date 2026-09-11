import type { FixedExpenseInput } from './driverPay'

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function parseISODateUTC(value: string, name = 'date'): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be a YYYY-MM-DD ISO date string, got ${JSON.stringify(value)}`)
  }
  const [y, m, d] = value.split('-').map(Number)
  const ts = Date.UTC(y, m - 1, d)
  const dt = new Date(ts)
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`${name} is not a valid calendar date: ${value}`)
  }
  return dt
}

function assertFinitePositive2Decimals(amount: number, name = 'amount'): void {
  if (!Number.isFinite(amount)) throw new Error(`${name} must be finite, got ${amount}`)
  if (amount <= 0) throw new Error(`${name} must be positive, got ${amount}`)
  const scaled = amount * 100
  if (Math.abs(Math.round(scaled) - scaled) > 1e-9) {
    throw new Error(`${name} must have at most 2 decimal places, got ${amount}`)
  }
}

function assertNonBlankLabel(label: string): void {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error(`label must be a non-blank string, got ${JSON.stringify(label)}`)
  }
}

function assertAudit(audit: FixedExpenseAudit): void {
  if (!audit || typeof audit !== 'object') throw new Error('audit is required')
  if (typeof audit.at !== 'string' || Number.isNaN(Date.parse(audit.at))) {
    throw new Error(`audit.at must be a real ISO date/time string, got ${JSON.stringify(audit.at)}`)
  }
  if (!('by' in audit) || (audit.by !== null && typeof audit.by !== 'string')) {
    throw new Error('audit.by must be a string or null')
  }
  if (audit.makeId != null && typeof audit.makeId !== 'function') {
    throw new Error('audit.makeId must be a function when provided')
  }
}

function assertNoAmbiguousWindows(entries: FixedExpenseInput[]): void {
  const byExpense = new Map<string, FixedExpenseInput[]>()
  const seenRevisionIds = new Set<string>()
  for (const e of entries) {
    if (!e.revisionId) throw new Error('every entry must have a revisionId')
    if (seenRevisionIds.has(e.revisionId)) {
      throw new Error(`duplicate revisionId ${e.revisionId}`)
    }
    seenRevisionIds.add(e.revisionId)
    if (!e.expenseId) throw new Error(`revision ${e.revisionId} must have an expenseId`)
    const arr = byExpense.get(e.expenseId) ?? []
    arr.push(e)
    byExpense.set(e.expenseId, arr)
  }

  for (const group of byExpense.values()) {
    const dated = group
      .filter((e) => e.from != null)
      .map((e) => ({
        entry: e,
        from: parseISODateUTC(e.from!, `${e.label} from`),
        until: e.until ? parseISODateUTC(e.until, `${e.label} until`) : null,
      }))
      .sort((a, b) => a.from.getTime() - b.from.getTime())

    // unbounded-from rows (no from) must be alone and cannot coexist with dated rows
    const unboundedFrom = group.filter((e) => e.from == null)
    if (unboundedFrom.length > 0 && dated.length > 0) {
      throw new Error(`expenseId ${group[0].expenseId} has unbounded-from and dated revisions`)
    }
    if (unboundedFrom.length > 1) {
      throw new Error(`expenseId ${group[0].expenseId} has multiple unbounded-from revisions`)
    }

    for (let i = 0; i < dated.length; i++) {
      const cur = dated[i]
      if (cur.until && cur.until < cur.from) {
        throw new Error(`invalid window for ${cur.entry.label}: ${cur.entry.from} > ${cur.entry.until}`)
      }
      if (i > 0) {
        const prev = dated[i - 1]
        if (prev.until == null) {
          throw new Error(`unbounded revision ${prev.entry.revisionId} precedes another revision`)
        }
        if (prev.until > cur.from) {
          throw new Error(
            `overlapping revisions for expenseId ${cur.entry.expenseId}: ${prev.entry.from}/${prev.entry.until} and ${cur.entry.from}/${cur.entry.until}`
          )
        }
      }
    }
  }
}

export interface FixedExpenseChangeAdd {
  kind: 'add'
  label: string
  amount: number
  effectiveFrom: string
}

export interface FixedExpenseChangeChange {
  kind: 'change'
  revisionId: string
  label: string
  amount: number
  effectiveFrom: string
}

export interface FixedExpenseChangeEnd {
  kind: 'end'
  revisionId: string
  effectiveFrom: string
}

export type FixedExpenseChange =
  | FixedExpenseChangeAdd
  | FixedExpenseChangeChange
  | FixedExpenseChangeEnd

export interface FixedExpenseAudit {
  at: string
  by: string | null
  makeId?: () => string
}

/**
 * Ensure every legacy fixed-expense row carries a stable revisionId and expenseId.
 * Missing ids are assigned once; existing ids and all other fields are preserved.
 */
export function prepareFixedExpenses(
  entries: readonly FixedExpenseInput[],
  makeId: () => string = globalThis.crypto.randomUUID.bind(globalThis.crypto),
): FixedExpenseInput[] {
  return entries.map((e) => ({
    ...e,
    revisionId: e.revisionId ?? makeId(),
    expenseId: e.expenseId ?? makeId(),
  }))
}

/**
 * Apply a historical change to a prepared fixed-expense history.
 *
 * - `add` appends a new unbounded expense revision.
 * - `change` ends the selected revision at `effectiveFrom` and appends a replacement
 *   from that date, preserving the original `until` and `expenseId`.
 * - `end` closes the selected revision at `effectiveFrom` and keeps the row in history.
 *
 * All changes are immutable: the input array/objects are not mutated.
 */
export function applyFixedExpenseChange(
  entries: readonly FixedExpenseInput[],
  change: FixedExpenseChange,
  audit: FixedExpenseAudit,
): FixedExpenseInput[] {
  assertAudit(audit)
  const makeId = audit.makeId ?? globalThis.crypto.randomUUID.bind(globalThis.crypto)

  if (change.kind === 'add') {
    assertNonBlankLabel(change.label)
    assertFinitePositive2Decimals(change.amount)
    parseISODateUTC(change.effectiveFrom, 'effectiveFrom')

    const added: FixedExpenseInput = {
      label: change.label.trim(),
      amount: round2(change.amount),
      from: change.effectiveFrom,
      until: null,
      revisionId: makeId(),
      expenseId: makeId(),
      recordedAt: audit.at,
      recordedBy: audit.by,
      endedAt: null,
      endedBy: null,
    }
    const next = [...entries, added]
    assertNoAmbiguousWindows(next)
    return next
  }

  const index = entries.findIndex((e) => e.revisionId === change.revisionId)
  if (index === -1) throw new Error(`revision ${change.revisionId} not found`)
  const old = entries[index]
  if (!old.expenseId) throw new Error(`revision ${old.revisionId} has no expenseId`)
  if (old.endedAt != null) throw new Error(`revision ${old.revisionId} is already ended`)

  const effectiveFrom = parseISODateUTC(change.effectiveFrom, 'effectiveFrom')
  const oldFrom = old.from ? parseISODateUTC(old.from, `${old.label} from`) : null
  const oldUntil = old.until ? parseISODateUTC(old.until, `${old.label} until`) : null

  if (oldFrom && effectiveFrom < oldFrom) {
    throw new Error(
      `effectiveFrom ${change.effectiveFrom} is before revision start ${old.from}`
    )
  }
  if (oldUntil && effectiveFrom >= oldUntil) {
    throw new Error(
      `effectiveFrom ${change.effectiveFrom} must be before revision end ${old.until}`
    )
  }

  if (change.kind === 'end') {
    const ended: FixedExpenseInput = {
      ...old,
      until: change.effectiveFrom,
      endedAt: audit.at,
      endedBy: audit.by,
    }
    const next = entries.map((e, i) => (i === index ? ended : e))
    assertNoAmbiguousWindows(next)
    return next
  }

  // change.kind === 'change'
  assertNonBlankLabel(change.label)
  assertFinitePositive2Decimals(change.amount)
  const newAmount = round2(change.amount)
  const newLabel = change.label.trim()
  if (newLabel === old.label && newAmount === old.amount) {
    throw new Error('no-op change: label and amount are unchanged')
  }

  const updatedOld: FixedExpenseInput = {
    ...old,
    until: change.effectiveFrom,
    endedAt: audit.at,
    endedBy: audit.by,
  }
  const replacement: FixedExpenseInput = {
    label: newLabel,
    amount: newAmount,
    from: change.effectiveFrom,
    until: old.until ?? null,
    revisionId: makeId(),
    expenseId: old.expenseId,
    recordedAt: audit.at,
    recordedBy: audit.by,
    endedAt: null,
    endedBy: null,
  }
  const next = entries.map((e, i) => (i === index ? updatedOld : e)).concat(replacement)
  assertNoAmbiguousWindows(next)
  return next
}
