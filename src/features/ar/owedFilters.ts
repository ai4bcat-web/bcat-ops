/**
 * Receivable / Payable filters by who owes (customer or carrier) and revenue division, and the
 * "how much is owed and when is it due" summary they open (Ryne 2026-11-12). Pure functions; the
 * pages own the state and keep it in the URL so a filtered view can be shared.
 */

/** Where an open balance falls against its due date. `notDue` is week + month + later. */
export type DueBucket = 'notDue' | 'week' | 'month' | 'later' | 'past' | 'none'

export const DUE_BUCKETS: readonly DueBucket[] = ['notDue', 'week', 'month', 'later', 'past', 'none']

export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  notDue: 'Not yet due',
  week: 'Due this week',
  month: 'Due in 8–30 days',
  later: 'Due in 31+ days',
  past: 'Past due',
  none: 'No due date',
}

export interface OwedFilter {
  /** Customer ids (Receivable) or carrier ids (Payable). */
  parties: string[]
  /** `DIVISION` or `DIVISION/SUB`; a division also matches its sub-divisions. */
  divisions: string[]
  due: DueBucket | null
}

export const EMPTY_OWED_FILTER: OwedFilter = { parties: [], divisions: [], due: null }

/** Parties and divisions narrow who is shown; the due bucket narrows within that. */
export function owedFilterActive(f: OwedFilter): boolean {
  return f.parties.length > 0 || f.divisions.length > 0 || f.due !== null
}

export function owedFilterCount(f: OwedFilter): number {
  return (f.parties.length > 0 ? 1 : 0) + (f.divisions.length > 0 ? 1 : 0) + (f.due ? 1 : 0)
}

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

/** `?customer=a,b&div=BROKERAGE,ASSETS/LOCAL&due=past` (Payable uses `carrier=`). */
export function readOwedFilter(params: URLSearchParams, partyKey: string): OwedFilter {
  const due = params.get('due')
  return {
    parties: list(params.get(partyKey)),
    divisions: list(params.get('div')),
    due: (DUE_BUCKETS as readonly string[]).includes(due ?? '') ? (due as DueBucket) : null,
  }
}

/** A copy of `params` carrying `f`; empty parts are removed so a clear filter leaves a clean URL. */
export function writeOwedFilter(params: URLSearchParams, f: OwedFilter, partyKey: string): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key))
  set(partyKey, f.parties.join(','))
  set('div', f.divisions.join(','))
  set('due', f.due ?? '')
  return next
}

/** A row's division key against the selection: `ASSETS` matches `ASSETS` and `ASSETS/LOCAL`. */
export function divisionMatches(rowKey: string | null | undefined, selected: readonly string[]): boolean {
  if (selected.length === 0) return true
  const key = rowKey ?? ''
  return selected.some((s) => (s.includes('/') ? key === s : key === s || key.startsWith(`${s}/`)))
}

const dayNumber = (iso: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : null
}

/** The bucket a due date falls in, counted in calendar days from `asOf` (YYYY-MM-DD). */
export function dueBucketOf(dueAt: string | null | undefined, asOf: string): Exclude<DueBucket, 'notDue'> {
  const due = dayNumber(dueAt)
  const today = dayNumber(asOf)
  if (due === null || today === null) return 'none'
  const days = due - today
  if (days < 0) return 'past'
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  return 'later'
}

/** True when a due date belongs to `bucket` (`notDue` = any not-yet-due bucket). */
export function inDueBucket(dueAt: string | null | undefined, asOf: string, bucket: DueBucket | null): boolean {
  if (!bucket) return true
  const b = dueBucketOf(dueAt, asOf)
  return bucket === 'notDue' ? b === 'week' || b === 'month' || b === 'later' : b === bucket
}

export interface OwedItem {
  dueAt: string | null | undefined
  balanceCents: number
}

export interface OwedSummary {
  totalCents: number
  count: number
  buckets: Record<DueBucket, { cents: number; count: number }>
  /** The earliest due date today or later; null when nothing upcoming has a date. */
  nextDueAt: string | null
}

/** Totals open balances by due bucket. Items with nothing owed are left out. */
export function summarizeOwed(items: readonly OwedItem[], asOf: string): OwedSummary {
  const buckets = Object.fromEntries(DUE_BUCKETS.map((b) => [b, { cents: 0, count: 0 }])) as OwedSummary['buckets']
  let totalCents = 0
  let count = 0
  let nextDueAt: string | null = null
  for (const item of items) {
    if (!(item.balanceCents > 0)) continue
    totalCents += item.balanceCents
    count += 1
    const b = dueBucketOf(item.dueAt, asOf)
    buckets[b].cents += item.balanceCents
    buckets[b].count += 1
    if (b === 'week' || b === 'month' || b === 'later') {
      buckets.notDue.cents += item.balanceCents
      buckets.notDue.count += 1
      const day = (item.dueAt ?? '').slice(0, 10)
      if (!nextDueAt || day < nextDueAt) nextDueAt = day
    }
  }
  return { totalCents, count, buckets, nextDueAt }
}

export interface OwedOption {
  key: string
  label: string
  /** Sub-divisions sit indented under their division. */
  sub?: boolean
}

/** Distinct parties as options, sorted by name. */
export function partyOptions(items: readonly { id: string | null | undefined; name: string | null | undefined }[]): OwedOption[] {
  const byId = new Map<string, string>()
  for (const it of items) {
    if (!it.id) continue
    if (!byId.has(it.id) || (!byId.get(it.id) && it.name)) byId.set(it.id, it.name || it.id)
  }
  return [...byId.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
}

/** "Owed by Royal Group", "Owed by Royal Group + 2 more · Brokerage". */
export function owedSelectionLabel(f: OwedFilter, partyLabel: (key: string) => string, divisionLabel: (key: string) => string): string {
  const names = (keys: string[], label: (k: string) => string) =>
    keys.length <= 2 ? keys.map(label).join(', ') : `${label(keys[0])} + ${keys.length - 1} more`
  const parts = [
    f.parties.length ? names(f.parties, partyLabel) : '',
    f.divisions.length ? names(f.divisions, divisionLabel) : '',
  ].filter(Boolean)
  return parts.length ? `Owed by ${parts.join(' · ')}` : 'Owed'
}
