/**
 * Step AI §5.1 — `DashboardSpec` v1: strict validation, identical on client and server.
 * Hand-rolled (no schema library) so the Lambda bundle stays small; every object is closed
 * (unknown keys are an error), every list and string is bounded, and nothing in the shape
 * can carry SQL, a table name or an expression. Issues are plain English.
 * Relative imports only (Lambda-bundled).
 */
import { QUERY_CATALOG, isQueryId, parseParams } from './catalog'
import type {
  DashboardFilters,
  DashboardScope,
  DashboardSpec,
  DashboardWindow,
  Widget,
  WidgetSize,
  WidgetType,
} from './types'
import { MAX_CUSTOM_DAYS, daySpan, parseDay, resolveWindow } from './windows'

export const SPEC_LIMITS = {
  maxWidgets: 12,
  maxSpecBytes: 32_000,
  maxTitle: 80,
  maxDescription: 200,
  maxUsers: 25,
  maxTeams: 10,
  maxDivisions: 8,
  maxCustomers: 25,
  maxReps: 25,
  maxIdLength: 200,
} as const

export const WIDGET_TYPES: readonly WidgetType[] = ['KPI', 'BAR', 'LINE', 'PIE', 'TABLE', 'LIST']
export const WIDGET_SIZES: readonly WidgetSize[] = ['S', 'M', 'L', 'F']
export const WINDOW_PRESETS = [
  'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'LAST_30_DAYS', 'LAST_90_DAYS', 'YEAR_TO_DATE',
] as const
export const SCOPE_KINDS = ['ME', 'COMPANY', 'USERS', 'TEAM'] as const
export const SHIPMENT_MODES = [
  'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
] as const

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
const WIDGET_ID = /^w([1-9]|1[0-2])$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v)

function closed(o: Obj, allowed: readonly string[], where: string, issues: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) issues.push(`${where}: unexpected field "${k}"`)
}

function text(v: unknown, where: string, min: number, max: number, issues: string[]): string | null {
  if (typeof v !== 'string') {
    issues.push(`${where} must be text`)
    return null
  }
  const s = v.trim()
  if (s.length < min || s.length > max) {
    issues.push(`${where} must be ${min === 0 ? `at most ${max}` : `${min}-${max}`} characters`)
    return null
  }
  if (CONTROL.test(s)) {
    issues.push(`${where} contains control characters`)
    return null
  }
  return s
}

function strList(v: unknown, where: string, min: number, max: number, issues: string[], maxLen: number = SPEC_LIMITS.maxIdLength): string[] | null {
  if (!Array.isArray(v)) {
    issues.push(`${where} must be a list`)
    return null
  }
  if (v.length < min || v.length > max) {
    issues.push(`${where} must have ${min === max ? max : `${min}-${max}`} entries`)
    return null
  }
  const out: string[] = []
  for (const item of v) {
    const s = text(item, `${where} entry`, 1, maxLen, issues)
    if (s == null) return null
    out.push(s)
  }
  return out
}

/** Validates a scope. Used by the spec and by the chat's scope picker input. */
export function parseScope(raw: unknown, where = 'scope'): { ok: true; scope: DashboardScope } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (!isObj(raw)) return { ok: false, issues: [`${where} must be an object`] }
  const kind = raw.kind
  if (kind === 'ME' || kind === 'COMPANY') {
    closed(raw, ['kind'], where, issues)
    return issues.length ? { ok: false, issues } : { ok: true, scope: { kind } }
  }
  if (kind === 'USERS') {
    closed(raw, ['kind', 'userIds'], where, issues)
    const userIds = strList(raw.userIds, `${where}.userIds`, 1, SPEC_LIMITS.maxUsers, issues)
    return userIds && !issues.length ? { ok: true, scope: { kind, userIds } } : { ok: false, issues }
  }
  if (kind === 'TEAM') {
    closed(raw, ['kind', 'teamKeys'], where, issues)
    const teamKeys = strList(raw.teamKeys, `${where}.teamKeys`, 1, SPEC_LIMITS.maxTeams, issues, 60)
    return teamKeys && !issues.length ? { ok: true, scope: { kind, teamKeys } } : { ok: false, issues }
  }
  return { ok: false, issues: [`${where}.kind must be one of ${SCOPE_KINDS.join(', ')}`] }
}

function parseWindow(raw: unknown, issues: string[]): DashboardWindow | null {
  if (!isObj(raw)) {
    issues.push('filters.window must be an object')
    return null
  }
  const preset = raw.preset
  if (typeof preset === 'string' && (WINDOW_PRESETS as readonly string[]).includes(preset)) {
    closed(raw, ['preset'], 'filters.window', issues)
    return { preset: preset as (typeof WINDOW_PRESETS)[number] }
  }
  if (preset === 'CUSTOM') {
    closed(raw, ['preset', 'from', 'to'], 'filters.window', issues)
    const from = typeof raw.from === 'string' ? raw.from : ''
    const to = typeof raw.to === 'string' ? raw.to : ''
    if (parseDay(from) == null || parseDay(to) == null) {
      issues.push('filters.window: from and to must be real dates written YYYY-MM-DD')
      return null
    }
    if (from > to) {
      issues.push('filters.window: the start date must not be after the end date')
      return null
    }
    if (daySpan(from, to) > MAX_CUSTOM_DAYS) {
      issues.push(`filters.window: a custom window can cover at most ${MAX_CUSTOM_DAYS} days`)
      return null
    }
    return { preset, from, to }
  }
  issues.push(`filters.window.preset must be one of ${[...WINDOW_PRESETS, 'CUSTOM'].join(', ')}`)
  return null
}

function parseFilters(raw: unknown, issues: string[]): DashboardFilters | null {
  if (!isObj(raw)) {
    issues.push('filters must be an object')
    return null
  }
  closed(raw, ['window', 'divisions', 'customerIds', 'repIds', 'modes'], 'filters', issues)
  const window = parseWindow(raw.window, issues)
  const list = (key: string, max: number, maxLen: number = SPEC_LIMITS.maxIdLength): string[] =>
    raw[key] === undefined ? [] : (strList(raw[key], `filters.${key}`, 0, max, issues, maxLen) ?? [])
  const divisions = list('divisions', SPEC_LIMITS.maxDivisions, 60)
  const customerIds = list('customerIds', SPEC_LIMITS.maxCustomers)
  const repIds = list('repIds', SPEC_LIMITS.maxReps)
  const modes = list('modes', SHIPMENT_MODES.length, 20)
  for (const m of modes) {
    if (!(SHIPMENT_MODES as readonly string[]).includes(m)) issues.push(`filters.modes: "${m}" is not a shipment mode`)
  }
  return window ? { window, divisions, customerIds, repIds, modes } : null
}

function parseWidget(raw: unknown, index: number, issues: string[]): Widget | null {
  const where = `Widget ${index + 1}`
  if (!isObj(raw)) {
    issues.push(`${where} must be an object`)
    return null
  }
  const before = issues.length
  closed(raw, ['id', 'type', 'title', 'size', 'query'], where, issues)
  const id = typeof raw.id === 'string' && WIDGET_ID.test(raw.id) ? raw.id : null
  if (!id) issues.push(`${where}: id must be w1 to w${SPEC_LIMITS.maxWidgets}`)
  const type = (WIDGET_TYPES as readonly unknown[]).includes(raw.type) ? (raw.type as WidgetType) : null
  if (!type) issues.push(`${where}: type must be one of ${WIDGET_TYPES.join(', ')}`)
  const title = text(raw.title, `${where} title`, 1, SPEC_LIMITS.maxTitle, issues)
  const size = (WIDGET_SIZES as readonly unknown[]).includes(raw.size) ? (raw.size as WidgetSize) : null
  if (!size) issues.push(`${where}: size must be one of ${WIDGET_SIZES.join(', ')}`)
  const q = raw.query
  if (!isObj(q)) {
    issues.push(`${where}: query must be an object`)
    return null
  }
  closed(q, ['id', 'params'], `${where} query`, issues)
  if (!isQueryId(q.id)) {
    issues.push(`${where}: unknown query "${typeof q.id === 'string' ? q.id.slice(0, 40) : '?'}"`)
    return null
  }
  const params = parseParams(q.id, q.params === undefined ? {} : q.params)
  if (!params.ok) issues.push(...params.issues.map((i) => `${where}: ${i}`))
  if (type && !QUERY_CATALOG[q.id].types.includes(type)) {
    issues.push(`${where}: ${q.id} cannot be drawn as ${type} (allowed: ${QUERY_CATALOG[q.id].types.join(', ')})`)
  }
  if (issues.length > before || !id || !type || title == null || !size || !params.ok) return null
  return { id, type, title, size, query: { id: q.id, params: params.params } }
}

/** Plain-English validation. Returns a normalised spec (defaults filled, strings trimmed) or issues. */
export function parseSpec(raw: unknown): { ok: true; spec: DashboardSpec } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (!isObj(raw)) return { ok: false, issues: ['The dashboard must be an object'] }
  closed(raw, ['v', 'title', 'description', 'scope', 'filters', 'widgets'], 'Dashboard', issues)
  if (raw.v !== 1) issues.push('Dashboard: v must be 1')
  const title = text(raw.title, 'Title', 1, SPEC_LIMITS.maxTitle, issues)
  const description =
    raw.description === undefined ? undefined : (text(raw.description, 'Description', 0, SPEC_LIMITS.maxDescription, issues) ?? undefined)
  const scope = parseScope(raw.scope)
  if (!scope.ok) issues.push(...scope.issues)
  const filters = parseFilters(raw.filters, issues)

  const widgets: Widget[] = []
  if (!Array.isArray(raw.widgets)) issues.push('widgets must be a list')
  else if (raw.widgets.length < 1 || raw.widgets.length > SPEC_LIMITS.maxWidgets) {
    issues.push(`A dashboard needs 1-${SPEC_LIMITS.maxWidgets} widgets (this one has ${raw.widgets.length})`)
  } else {
    raw.widgets.forEach((w, i) => {
      const parsed = parseWidget(w, i, issues)
      if (parsed) widgets.push(parsed)
    })
    const seen = new Set<string>()
    for (const w of widgets) {
      if (seen.has(w.id)) issues.push(`Widget id ${w.id} is used twice`)
      seen.add(w.id)
    }
  }

  if (filters && widgets.length && !issues.length) {
    const count = windowMonthCount(filters.window)
    for (const w of widgets) {
      const max = QUERY_CATALOG[w.query.id].maxMonths
      if (max != null && count > max) {
        issues.push(
          `${w.title}: ${QUERY_CATALOG[w.query.id].label} can cover at most ${max} months, this window spans up to ${count}. Shorten the window.`,
        )
      }
    }
  }

  if (issues.length || !title || !scope.ok || !filters) return { ok: false, issues }
  const spec: DashboardSpec = {
    v: 1,
    title,
    ...(description ? { description } : {}),
    scope: scope.scope,
    filters,
    widgets,
  }
  if (new TextEncoder().encode(JSON.stringify(spec)).length > SPEC_LIMITS.maxSpecBytes) {
    return { ok: false, issues: [`The dashboard is too large (limit ${SPEC_LIMITS.maxSpecBytes} bytes)`] }
  }
  return { ok: true, spec }
}

/**
 * Worst-case month count of a window, independent of today's date: CUSTOM is exact, presets
 * are the largest span the preset can touch (a 30/90-day window can touch 2/4 calendar months).
 */
export function windowMonthCount(window: DashboardWindow): number {
  switch (window.preset) {
    case 'THIS_MONTH':
    case 'LAST_MONTH':
      return 1
    case 'THIS_QUARTER':
    case 'LAST_QUARTER':
      return 3
    case 'LAST_30_DAYS':
      return 2
    case 'LAST_90_DAYS':
      return 4
    case 'YEAR_TO_DATE':
      return 12
    case 'CUSTOM':
      return resolveWindow(window, window.to + 'T00:00:00Z').months.length
  }
}

export interface LayoutItem {
  id: string
  row: number
  /** 0-based start column of 12. */
  col: number
  span: number
}

export const SIZE_SPAN: Record<WidgetSize, number> = { S: 3, M: 6, L: 9, F: 12 }

/**
 * Deterministic placement: KPI widgets first (in order) so tiles pack the first rows, then
 * the rest in order; items flow left to right and wrap when the 12 columns are full.
 */
export function autoLayout(widgets: readonly Pick<Widget, 'id' | 'type' | 'size'>[]): LayoutItem[] {
  const ordered = [...widgets.filter((w) => w.type === 'KPI'), ...widgets.filter((w) => w.type !== 'KPI')]
  const out: LayoutItem[] = []
  let row = 0
  let col = 0
  for (const w of ordered) {
    const span = SIZE_SPAN[w.size]
    if (col + span > 12) {
      row += 1
      col = 0
    }
    out.push({ id: w.id, row, col, span })
    col += span
  }
  return out
}
