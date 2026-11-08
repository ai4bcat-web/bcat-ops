/**
 * Step AI §7.3 — the model-facing structured-output schema and its mapping to a spec.
 *
 * Union-free by construction (the AB lesson: Anthropic structured output rejected a schema with
 * 21 union params): every property is required, "unset" is a sentinel ("" / 0 / []), and queryId,
 * widget type, size and window are plain enums. The model never sets scope: code does.
 * `buildSpecFromModel` maps sentinels to absent keys, drops unknown query ids, assigns widget
 * ids and returns an UNVALIDATED raw spec for `parseSpec`.
 * Relative imports only (Lambda-bundled).
 */
import { QUERY_CATALOG, QUERY_IDS, isQueryId } from './catalog'
import { SHIPMENT_MODES, SPEC_LIMITS, WIDGET_SIZES, WIDGET_TYPES, WINDOW_PRESETS } from './spec'
import type { DashboardScope, QueryParams, QueryId } from './types'

export interface ModelQuestion {
  id: string
  text: string
  choices: string[]
}

export interface ModelWidget {
  type: string
  title: string
  queryId: string
  /** Sentinel "" = unset. */
  metric: string
  metrics: string[]
  groupBy: string
  grain: string
  sort: string
  /** Sentinel 0 = unset. */
  limit: number
  size: string
}

export interface ModelOut {
  reply: string
  ready: boolean
  questions: ModelQuestion[]
  title: string
  description: string
  /** A preset, or "" (then from/to, if both set, make a CUSTOM window). */
  window: string
  from: string
  to: string
  divisionNames: string[]
  customerNames: string[]
  repNames: string[]
  modes: string[]
  widgets: ModelWidget[]
}

const str = { type: 'string' } as const
const strList = { type: 'array', items: str } as const

export const MODEL_OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reply', 'ready', 'questions', 'title', 'description', 'window', 'from', 'to',
    'divisionNames', 'customerNames', 'repNames', 'modes', 'widgets',
  ],
  properties: {
    reply: str,
    ready: { type: 'boolean' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'choices'],
        properties: { id: str, text: str, choices: strList },
      },
    },
    title: str,
    description: str,
    window: { type: 'string', enum: ['', ...WINDOW_PRESETS] },
    from: str,
    to: str,
    divisionNames: strList,
    customerNames: strList,
    repNames: strList,
    modes: strList,
    widgets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'queryId', 'metric', 'metrics', 'groupBy', 'grain', 'sort', 'limit', 'size'],
        properties: {
          type: { type: 'string', enum: [...WIDGET_TYPES] },
          title: str,
          queryId: { type: 'string', enum: [...QUERY_IDS] },
          metric: str,
          metrics: strList,
          groupBy: str,
          grain: str,
          sort: str,
          limit: { type: 'integer' },
          size: { type: 'string', enum: [...WIDGET_SIZES] },
        },
      },
    },
  },
} as const

/** What the server resolved from the model's names, plus the scope the picker set. */
export interface BuildContext {
  scope: DashboardScope
  divisionCodes: string[]
  customerIds: string[]
  repIds: string[]
}

/** Sentinel -> catalog param mapping for one widget; keys the query does not declare are dropped. */
function paramsFor(queryId: QueryId, w: ModelWidget): QueryParams {
  const declared = QUERY_CATALOG[queryId].params
  const params: QueryParams = {}
  const scalar: Record<string, string> = { metric: w.metric, groupBy: w.groupBy, grain: w.grain, sort: w.sort }
  for (const key of Object.keys(declared)) {
    if (key === 'metrics') {
      if (Array.isArray(w.metrics) && w.metrics.length) params.metrics = w.metrics
    } else if (key === 'limit') {
      if (typeof w.limit === 'number' && w.limit > 0) params.limit = w.limit
    } else if (typeof scalar[key] === 'string' && scalar[key] !== '') {
      params[key] = scalar[key]
    }
  }
  return params
}

/**
 * Maps the model output to a raw (unvalidated) spec. Widgets with an unknown query id are
 * dropped and reported; everything else invalid is left for `parseSpec` to name precisely.
 */
export function buildSpecFromModel(
  out: ModelOut,
  ctx: BuildContext,
): { raw: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = []
  const widgets: Record<string, unknown>[] = []
  for (const w of out.widgets ?? []) {
    if (!isQueryId(w.queryId)) {
      dropped.push(String(w.title || w.queryId).slice(0, 80))
      continue
    }
    if (widgets.length >= SPEC_LIMITS.maxWidgets + 1) break // parseSpec reports the overflow
    widgets.push({
      id: `w${widgets.length + 1}`,
      type: w.type,
      title: w.title,
      size: w.size,
      query: { id: w.queryId, params: paramsFor(w.queryId, w) },
    })
  }
  const window =
    out.window !== ''
      ? { preset: out.window }
      : out.from !== '' && out.to !== ''
        ? { preset: 'CUSTOM', from: out.from, to: out.to }
        : { preset: 'THIS_MONTH' }
  const modes = (out.modes ?? []).filter((m) => (SHIPMENT_MODES as readonly string[]).includes(m))
  const raw: Record<string, unknown> = {
    v: 1,
    title: out.title,
    ...(out.description !== '' ? { description: out.description } : {}),
    scope: ctx.scope,
    filters: {
      window,
      divisions: ctx.divisionCodes,
      customerIds: ctx.customerIds,
      repIds: ctx.repIds,
      modes,
    },
    widgets,
  }
  return { raw, dropped }
}

/** Defensive shape check of the model's JSON before it is mapped (the provider enforces it, but never trust it). */
export function isModelOut(v: unknown): v is ModelOut {
  if (v == null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string')
  return (
    typeof o.reply === 'string' &&
    typeof o.ready === 'boolean' &&
    Array.isArray(o.questions) &&
    o.questions.every(
      (q) => q != null && typeof q.id === 'string' && typeof q.text === 'string' && strs(q.choices),
    ) &&
    typeof o.title === 'string' &&
    typeof o.description === 'string' &&
    typeof o.window === 'string' &&
    typeof o.from === 'string' &&
    typeof o.to === 'string' &&
    strs(o.divisionNames) &&
    strs(o.customerNames) &&
    strs(o.repNames) &&
    strs(o.modes) &&
    Array.isArray(o.widgets) &&
    o.widgets.every((w) => w != null && typeof w.queryId === 'string' && typeof w.title === 'string')
  )
}
