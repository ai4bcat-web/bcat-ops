/**
 * Step AI shared contract: the dashboard spec, chat protocol and run result shapes.
 * Pure types: no React, no I/O, relative imports only (the Lambda bundles `src/lib/dashboards/*`).
 */

export type WidgetType = 'KPI' | 'BAR' | 'LINE' | 'PIE' | 'TABLE' | 'LIST'
/** S = 3 of 12 columns, M = 6, L = 9, F = 12. */
export type WidgetSize = 'S' | 'M' | 'L' | 'F'

export type QueryId =
  | 'fin.summary'
  | 'fin.byGroup'
  | 'fin.byTime'
  | 'ship.summary'
  | 'ship.byStatus'
  | 'ship.byTime'
  | 'ship.byGroup'
  | 'ship.recent'
  | 'ar.summary'
  | 'ar.aging'
  | 'ar.byCustomer'
  | 'ar.list'
  | 'quote.summary'
  | 'quote.byStatus'
  | 'quote.byCustomer'
  | 'quote.recent'

/** Who may OPEN a dashboard. Never decides which rows it shows (the viewer's own visibility does). */
export type DashboardScope =
  | { kind: 'ME' }
  | { kind: 'COMPANY' }
  | { kind: 'USERS'; userIds: string[] }
  | { kind: 'TEAM'; teamKeys: string[] }

export type ScopeKind = DashboardScope['kind']

export type WindowPreset =
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'THIS_QUARTER'
  | 'LAST_QUARTER'
  | 'LAST_30_DAYS'
  | 'LAST_90_DAYS'
  | 'YEAR_TO_DATE'

export type DashboardWindow = { preset: WindowPreset } | { preset: 'CUSTOM'; from: string; to: string }

export interface DashboardFilters {
  window: DashboardWindow
  divisions: string[]
  customerIds: string[]
  repIds: string[]
  modes: string[]
}

/** Query params are plain scalars / string lists, validated by the catalog entry's own schema. */
export type QueryParams = Record<string, string | number | string[]>

export interface Widget {
  id: string
  type: WidgetType
  title: string
  size: WidgetSize
  query: { id: QueryId; params: QueryParams }
}

export interface DashboardSpec {
  v: 1
  title: string
  description?: string
  scope: DashboardScope
  filters: DashboardFilters
  widgets: Widget[]
}

export interface DashboardSummary {
  id: string
  title: string
  scope: ScopeKind
  ownerId: string
  ownerName: string | null
  sharedWith: { userIds: string[]; teamKeys: string[] }
  widgetCount: number
  updatedAt: string | null
  version: number
}

export interface DashboardRecord extends DashboardSummary {
  spec: DashboardSpec
  specVersion: 1
  createdBy: string
  updatedBy: string
  archivedAt: string | null
}

export interface DashboardAccess {
  create: boolean
  publishCompany: boolean
  viewAll: boolean
}

// ── Run results (structurally compatible with the dashboard ChartSeries; no UI import here) ──

export type ResultKind = 'kpis' | 'bar' | 'line' | 'pie' | 'table'
export type ResultFormat = 'count' | 'cents' | 'bps' | 'hours' | 'percent'

export interface ResultSeries {
  kpis?: { label: string; value: number | null; format?: ResultFormat }[]
  rows: { label: string; values: (number | null)[]; text?: string[] }[]
  groups: string[]
  columns?: { key: string; label: string; format?: ResultFormat }[]
  valueFormat: ResultFormat
  note?: string
}

export type WidgetResult =
  | { widgetId: string; ok: true; kind: ResultKind; series: ResultSeries }
  | { widgetId: string; ok: false; error: string }

export interface DashVisibility {
  viewAll: boolean
  ownedCustomers: number
  teamKeys: string[]
}

export interface DashRunResult {
  results: WidgetResult[]
  resolved: { from: string; to: string; months: string[] }
  visibility: DashVisibility
  asOf: string
  ms: number
}

export interface DashOptions {
  access: DashboardAccess
  divisions: { code: string; name: string; brand: string | null; parentId: string | null }[]
  staff: { id: string; name: string; teamKeys: string[] }[]
  teams: { key: string; name: string }[]
  catalog: { id: QueryId; label: string; types: WidgetType[] }[]
  limits: { maxWidgets: number; maxSpecBytes: number; maxMessages: number }
  visibility: DashVisibility
}

// ── Chat protocol ──

export interface DashChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface DashChatInput {
  messages: DashChatMessage[]
  scope: DashboardScope | null
  draft: DashboardSpec | null
}

export interface DashQuestion {
  id: string
  kind: 'SCOPE' | 'CLARIFY'
  text: string
  choices: string[]
}

export interface DashChatResult {
  reply: string
  questions: DashQuestion[]
  spec: DashboardSpec | null
  issues: string[]
  resolved: {
    divisions: { code: string; name: string }[]
    customers: { id: string; name: string }[]
    reps: { id: string; name: string }[]
    unresolved: string[]
  }
  modelMs: number
  modelError: string | null
}
