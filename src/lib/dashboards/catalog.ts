/**
 * Step AI §5.2 — the whitelist. `QUERY_CATALOG` is the single source for the validator
 * (spec.ts), the executor, the model prompt/schema and the UI labels. A query is chosen by
 * id; there is no SQL, table name or expression anywhere, so there is nothing to inject.
 * Relative imports only (Lambda-bundled).
 */
import type { QueryId, QueryParams, WidgetType } from './types'

/** Declarative, strict param schema. Unknown keys are always rejected; defaults fill missing keys. */
export type ParamSpec =
  | { kind: 'enum'; values: readonly string[]; default: string }
  | { kind: 'enumList'; values: readonly string[]; min: number; max: number; default: readonly string[] }
  | { kind: 'int'; min: number; max: number; default: number }

export type QuerySource = 'SAMPLE' | 'SHIPMENT' | 'INVOICE' | 'QUOTE'

export interface QueryMeta {
  id: QueryId
  label: string
  /** One line; goes into the model prompt. */
  description: string
  types: readonly WidgetType[]
  params: Record<string, ParamSpec>
  /** Strictest window span in months; null = open set with no window (AR). */
  maxMonths: number | null
  source: QuerySource
  supports: { divisions: boolean; customers: boolean; reps: boolean; modes: boolean }
}

const FIN_METRICS = ['revenue', 'cost', 'profit', 'margin', 'count'] as const
const SHIP_METRICS = ['count', 'delivered', 'inTransit', 'open'] as const
const AR_METRICS = ['open', 'overdue', 'count', 'avgDaysOpen'] as const
const QUOTE_METRICS = ['count', 'won', 'lost', 'winRate', 'openValue'] as const
const GRAINS = ['MONTH', 'WEEK'] as const

const limit = (def = 12): ParamSpec => ({ kind: 'int', min: 1, max: 25, default: def })
const metrics = (values: readonly string[], def: readonly string[]): ParamSpec => ({
  kind: 'enumList',
  values,
  min: 1,
  max: values.length,
  default: def,
})
const grain: ParamSpec = { kind: 'enum', values: GRAINS, default: 'MONTH' }

const FIN = { divisions: true, customers: true, reps: true, modes: true } as const
const SHIP = { divisions: true, customers: true, reps: true, modes: true } as const
const AR = { divisions: true, customers: true, reps: true, modes: false } as const
const QUOTE = { divisions: false, customers: true, reps: true, modes: true } as const

export const QUERY_CATALOG: Record<QueryId, QueryMeta> = {
  'fin.summary': {
    id: 'fin.summary', label: 'Financial summary', source: 'SAMPLE', maxMonths: 13, supports: FIN,
    description: 'Revenue, cost, profit, margin and priced-shipment count for the window.',
    types: ['KPI'],
    params: { metrics: metrics(FIN_METRICS, ['revenue', 'profit', 'margin']) },
  },
  'fin.byGroup': {
    id: 'fin.byGroup', label: 'Financials by group', source: 'SAMPLE', maxMonths: 13, supports: FIN,
    description: 'One financial metric grouped by customer, rep, carrier, division or mode, top N descending.',
    types: ['BAR', 'PIE', 'TABLE'],
    params: {
      metric: { kind: 'enum', values: FIN_METRICS, default: 'revenue' },
      groupBy: { kind: 'enum', values: ['CUSTOMER', 'REP', 'CARRIER', 'DIVISION', 'MODE'], default: 'CUSTOMER' },
      limit: limit(),
    },
  },
  'fin.byTime': {
    id: 'fin.byTime', label: 'Financials over time', source: 'SAMPLE', maxMonths: 13, supports: FIN,
    description: 'One financial metric per month or week across the window.',
    types: ['LINE', 'BAR', 'TABLE'],
    params: { metric: { kind: 'enum', values: FIN_METRICS, default: 'revenue' }, grain },
  },
  'ship.summary': {
    id: 'ship.summary', label: 'Shipment summary', source: 'SHIPMENT', maxMonths: 4, supports: SHIP,
    description: 'Shipment counts: total, delivered, in transit, open. Voided shipments excluded.',
    types: ['KPI'],
    params: { metrics: metrics(SHIP_METRICS, ['count', 'delivered', 'inTransit']) },
  },
  'ship.byStatus': {
    id: 'ship.byStatus', label: 'Shipments by status', source: 'SHIPMENT', maxMonths: 4, supports: SHIP,
    description: 'Shipment count per status.',
    types: ['PIE', 'BAR', 'TABLE'],
    params: {},
  },
  'ship.byTime': {
    id: 'ship.byTime', label: 'Shipments over time', source: 'SHIPMENT', maxMonths: 4, supports: SHIP,
    description: 'Shipment count per month or week by pickup date.',
    types: ['LINE', 'BAR', 'TABLE'],
    params: { grain },
  },
  'ship.byGroup': {
    id: 'ship.byGroup', label: 'Shipments by group', source: 'SHIPMENT', maxMonths: 4, supports: SHIP,
    description: 'Shipment count grouped by customer, rep, division or mode, top N.',
    types: ['BAR', 'TABLE'],
    params: {
      groupBy: { kind: 'enum', values: ['CUSTOMER', 'REP', 'DIVISION', 'MODE'], default: 'CUSTOMER' },
      limit: limit(),
    },
  },
  'ship.recent': {
    id: 'ship.recent', label: 'Recent shipments', source: 'SHIPMENT', maxMonths: 4, supports: SHIP,
    description: 'The latest shipments by pickup date, newest first.',
    types: ['LIST', 'TABLE'],
    params: { limit: limit(10) },
  },
  'ar.summary': {
    id: 'ar.summary', label: 'Open AR summary', source: 'INVOICE', maxMonths: null, supports: AR,
    description: 'Open receivables: total open, overdue, invoice count, average days open. No window.',
    types: ['KPI'],
    params: { metrics: metrics(AR_METRICS, ['open', 'overdue', 'count']) },
  },
  'ar.aging': {
    id: 'ar.aging', label: 'AR aging', source: 'INVOICE', maxMonths: null, supports: AR,
    description: 'Open AR in fixed buckets of days past due: 0-30, 31-60, 61-90, 90+. No window.',
    types: ['BAR', 'PIE', 'TABLE'],
    params: {},
  },
  'ar.byCustomer': {
    id: 'ar.byCustomer', label: 'Open AR by customer', source: 'INVOICE', maxMonths: null, supports: AR,
    description: 'Open receivable balance per customer, top N descending. No window.',
    types: ['BAR', 'TABLE'],
    params: { limit: limit() },
  },
  'ar.list': {
    id: 'ar.list', label: 'Open invoices', source: 'INVOICE', maxMonths: null, supports: AR,
    description: 'Open invoices sorted by due date or balance. No window.',
    types: ['LIST', 'TABLE'],
    params: {
      limit: limit(10),
      sort: { kind: 'enum', values: ['dueAt', 'balance'], default: 'dueAt' },
    },
  },
  'quote.summary': {
    id: 'quote.summary', label: 'Quote summary', source: 'QUOTE', maxMonths: 6, supports: QUOTE,
    description: 'Quote count, won, lost, win rate and open value. Quotes are not split by division.',
    types: ['KPI'],
    params: { metrics: metrics(QUOTE_METRICS, ['count', 'won', 'winRate']) },
  },
  'quote.byStatus': {
    id: 'quote.byStatus', label: 'Quotes by status', source: 'QUOTE', maxMonths: 6, supports: QUOTE,
    description: 'Quote count per status.',
    types: ['PIE', 'BAR', 'TABLE'],
    params: {},
  },
  'quote.byCustomer': {
    id: 'quote.byCustomer', label: 'Quotes by customer', source: 'QUOTE', maxMonths: 6, supports: QUOTE,
    description: 'Quote count or value per customer, top N.',
    types: ['BAR', 'TABLE'],
    params: { metric: { kind: 'enum', values: ['count', 'value'], default: 'count' }, limit: limit() },
  },
  'quote.recent': {
    id: 'quote.recent', label: 'Recent quotes', source: 'QUOTE', maxMonths: 6, supports: QUOTE,
    description: 'The latest quotes, newest first.',
    types: ['LIST', 'TABLE'],
    params: { limit: limit(10) },
  },
}

export const QUERY_IDS = Object.keys(QUERY_CATALOG) as QueryId[]

export function isQueryId(id: unknown): id is QueryId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(QUERY_CATALOG, id)
}

export function queryMeta(id: QueryId): QueryMeta {
  return QUERY_CATALOG[id]
}

/**
 * Strictly validates `raw` against the entry's params: unknown keys, wrong types,
 * out-of-enum values and out-of-range numbers are issues; missing keys take the default.
 */
export function parseParams(
  id: QueryId,
  raw: unknown,
): { ok: true; params: QueryParams } | { ok: false; issues: string[] } {
  const meta = QUERY_CATALOG[id]
  const issues: string[] = []
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [`${id}: params must be an object`] }
  }
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(meta.params, key)) {
      issues.push(`${id}: "${key}" is not a parameter of this query`)
    }
  }
  const out: QueryParams = {}
  for (const [key, spec] of Object.entries(meta.params)) {
    const value = input[key]
    if (value === undefined) {
      out[key] = spec.kind === 'enumList' ? [...spec.default] : spec.default
      continue
    }
    if (spec.kind === 'enum') {
      if (typeof value === 'string' && spec.values.includes(value)) out[key] = value
      else issues.push(`${id}: ${key} must be one of ${spec.values.join(', ')}`)
    } else if (spec.kind === 'int') {
      if (typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max) {
        out[key] = value
      } else issues.push(`${id}: ${key} must be a whole number from ${spec.min} to ${spec.max}`)
    } else if (
      Array.isArray(value) &&
      value.length >= spec.min &&
      value.length <= spec.max &&
      value.every((x) => typeof x === 'string' && spec.values.includes(x)) &&
      new Set(value).size === value.length
    ) {
      out[key] = value as string[]
    } else issues.push(`${id}: ${key} must be ${spec.min}-${spec.max} distinct values of ${spec.values.join(', ')}`)
  }
  return issues.length ? { ok: false, issues } : { ok: true, params: out }
}

/** Catalog text for the model prompt, generated so prompt, validator and schema cannot drift. */
export function catalogPromptText(): string {
  return QUERY_IDS.map((id) => {
    const m = QUERY_CATALOG[id]
    const params = Object.entries(m.params)
      .map(([k, p]) => (p.kind === 'int' ? `${k}(1-${p.max})` : `${k}(${p.values.join('|')})`))
      .join(', ')
    const months = m.maxMonths == null ? 'no window' : `max ${m.maxMonths} months`
    return `- ${id} [${m.types.join('/')}] ${m.description} Params: ${params || 'none'}. ${months}.`
  }).join('\n')
}
