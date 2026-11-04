/**
 * Step AI §7 — one stateless chat turn: model call (aborted at 22 s, never throws), server-side
 * name resolution against what the VIEWER may see, spec build + strict validation (one repair
 * call at most), then `finalizeChatTurn` (src/lib/dashboards/chatProtocol.ts), which is where
 * the scope gate (R1/R2) and the open-question rule (R4) are enforced by code.
 * Logs ids/counts only: no message text, no spec body.
 */
import { catalogPromptText } from '../../../src/lib/dashboards/catalog'
import { finalizeChatTurn } from '../../../src/lib/dashboards/chatProtocol'
import { buildSpecFromModel, isModelOut, type ModelOut } from '../../../src/lib/dashboards/modelSchema'
import { parseSpec } from '../../../src/lib/dashboards/spec'
import type { DashChatInput, DashChatResult, DashQuestion, DashboardScope, DashboardSpec } from '../../../src/lib/dashboards/types'
import { canSeeCustomer, type DataViewer } from '../../../src/lib/dataVisibility'
import { normalizeName } from '../_shared/directoryKeys'
import type { CustomerNameRow, DivisionRow, StaffRow } from './dashSources'
import { MODEL_ABORT_MS, type ModelPort } from './dashModel'

/** A repair call needs at least this long before the abort mark. */
const REPAIR_MIN_REMAINING_MS = 10_000
const MAX_CANDIDATES = 6

export const SYSTEM_PROMPT = `You design dashboards for BCAT Ops, a freight brokerage and trucking TMS. You never see any data: you only choose WHICH of the whitelisted queries below to show and with which filters. Reply with the JSON object the schema describes.

How to answer:
- If the request is clear enough, set ready=true and fill the dashboard. If one thing is genuinely ambiguous, set ready=false and ask at most 2 short clarifying questions (give 2-6 choices when the answer is a pick). Do not ask for anything that has a sensible default.
- NEVER ask who the dashboard is for or whether it is company-wide: the app asks that itself.
- Use ONLY these queries (queryId) and respect each widget type allowed for it:
${catalogPromptText()}
- A dashboard has 1-12 widgets. KPI tiles first (size S or M); charts M or L; tables and lists L or F. Use window presets (THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, LAST_30_DAYS, LAST_90_DAYS, YEAR_TO_DATE) or from/to as YYYY-MM-DD with window "".
- Fields a widget does not use are "" / [] / 0 (never invent a parameter the query does not list).
- Put every business, division, customer or sales-rep name the dashboard is filtered to in divisionNames / customerNames / repNames, copied as the user wrote it. A business name such as "Ivan Cartage" is usually a division. Never invent ids.
- When a current draft is supplied, revise it and return the COMPLETE dashboard (keep its filter names unless asked to change them).
- Keep reply to one or two plain sentences describing what you built or what you need.`

export interface ChatEnv {
  model: ModelPort
  viewer: DataViewer
  customers: readonly CustomerNameRow[]
  divisions: readonly DivisionRow[]
  staff: readonly StaffRow[]
  /** ISO date `YYYY-MM-DD` (UTC). */
  today: string
  nowMs: () => number
}

const norm = (s: string): string => normalizeName(s)

/** Alternating user/assistant starting with user (the model API requires it). */
function toModelMessages(input: DashChatInput, extraUser: string): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of input.messages) {
    const last = out[out.length - 1]
    if (!last && m.role === 'assistant') continue
    if (last && last.role === m.role) last.content += `\n${m.text}`
    else out.push({ role: m.role, content: m.text })
  }
  const last = out[out.length - 1]
  if (last) last.content += extraUser
  return out
}

/** The draft as the model needs it: names instead of ids, only what the viewer can see. */
function draftSummary(draft: DashboardSpec | null, env: ChatEnv): string {
  if (!draft) return ''
  const visibleCustomers = new Map(env.customers.filter((c) => canSeeCustomer(env.viewer, c)).map((c) => [c.id, c.name ?? c.id]))
  const f = draft.filters
  const body = {
    title: draft.title,
    description: draft.description ?? '',
    window: f.window,
    divisionNames: f.divisions.map((code) => env.divisions.find((d) => d.code === code)?.name ?? code),
    customerNames: f.customerIds.map((id) => visibleCustomers.get(id)).filter((n): n is string => !!n),
    repNames: f.repIds.map((id) => env.staff.find((s) => s.id === id)?.name ?? id),
    modes: f.modes,
    widgets: draft.widgets.map((w) => ({ type: w.type, title: w.title, size: w.size, queryId: w.query.id, params: w.query.params })),
  }
  return `\n\n[Current draft]\n${JSON.stringify(body)}`
}

interface Resolution {
  divisionCodes: string[]
  customerIds: string[]
  repIds: string[]
  resolved: DashChatResult['resolved']
  clarify: DashQuestion[]
  issues: string[]
}

function pick<T>(items: readonly T[], keys: (t: T) => string[], name: string): T[] {
  const n = norm(name)
  if (!n) return []
  const exact = items.filter((t) => keys(t).some((k) => norm(k) === n))
  if (exact.length) return exact
  return n.length >= 3 ? items.filter((t) => keys(t).some((k) => norm(k).includes(n))) : []
}

/** Resolves names server-side. Customers only among those the viewer may see: not-found and not-visible are the same text. */
export function resolveNames(out: ModelOut, env: ChatEnv): Resolution {
  const r: Resolution = {
    divisionCodes: [],
    customerIds: [],
    repIds: [],
    resolved: { divisions: [], customers: [], reps: [], unresolved: [] },
    clarify: [],
    issues: [],
  }

  const parentOf = new Map(env.divisions.map((d) => [d.code, d.parentId]))
  const hasAncestorIn = (code: string, set: ReadonlySet<string>): boolean => {
    for (let p = parentOf.get(code) ?? null, hops = 0; p && hops < 10; p = parentOf.get(p) ?? null, hops++) if (set.has(p)) return true
    return false
  }
  for (const name of out.divisionNames) {
    let found = pick(env.divisions, (d) => [d.name, d.code, d.brand ?? ''], name)
    const codes = new Set(found.map((d) => d.code))
    found = found.filter((d) => !hasAncestorIn(d.code, codes)) // a parent already covers its descendants
    if (found.length === 1) {
      r.divisionCodes.push(found[0]!.code)
      r.resolved.divisions.push({ code: found[0]!.code, name: found[0]!.name })
    } else if (found.length > 1) {
      r.clarify.push({ id: `division:${norm(name)}`, kind: 'CLARIFY', text: `Which business or division do you mean by "${name}"?`, choices: found.slice(0, MAX_CANDIDATES).map((d) => d.name) })
    } else {
      r.resolved.unresolved.push(name)
      r.issues.push(`I couldn't find a business or division called "${name}"`)
    }
  }

  const visible = env.customers.filter((c) => canSeeCustomer(env.viewer, c))
  for (const name of out.customerNames) {
    const found = pick(visible, (c) => [c.name ?? '', ...(c.aliases ?? [])], name)
    if (found.length === 1) {
      r.customerIds.push(found[0]!.id)
      r.resolved.customers.push({ id: found[0]!.id, name: found[0]!.name ?? found[0]!.id })
    } else if (found.length > 1) {
      r.clarify.push({ id: `customer:${norm(name)}`, kind: 'CLARIFY', text: `Which customer do you mean by "${name}"?`, choices: found.slice(0, MAX_CANDIDATES).map((c) => c.name ?? c.id) })
    } else {
      r.resolved.unresolved.push(name)
      r.issues.push(`No customer you can see matches "${name}"`)
    }
  }

  for (const name of out.repNames) {
    const found = pick(env.staff, (s) => [s.name, s.email, s.email.split('@')[0] ?? ''], name)
    if (found.length === 1) {
      r.repIds.push(found[0]!.id)
      r.resolved.reps.push({ id: found[0]!.id, name: found[0]!.name })
    } else if (found.length > 1) {
      r.clarify.push({ id: `rep:${norm(name)}`, kind: 'CLARIFY', text: `Which team member do you mean by "${name}"?`, choices: found.slice(0, MAX_CANDIDATES).map((s) => s.name) })
    } else {
      r.resolved.unresolved.push(name)
      r.issues.push(`No team member matches "${name}"`)
    }
  }
  return r
}

/** Maps provider failures to a short, safe message (the provider's text, trimmed by finalizeChatTurn). */
function modelErrorText(err: unknown, aborted: boolean): string {
  if (aborted) return 'The assistant took too long to answer. Try again.'
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[key]').trim() || 'The assistant is unavailable'
}

type Call = { ok: true; out: ModelOut } | { ok: false; error: string }

export async function chatTurn(input: DashChatInput, env: ChatEnv): Promise<DashChatResult> {
  const start = env.nowMs()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), MODEL_ABORT_MS)
  const scope: DashboardScope | null = input.scope
  const extra = `\n\n[Today (UTC): ${env.today}. Dashboard audience: ${scope ? 'already chosen by the user (do not ask)' : 'not chosen yet (the app will ask)'}.]${draftSummary(input.draft, env)}`
  const messages = toModelMessages(input, extra)

  const call = async (msgs: typeof messages): Promise<Call> => {
    try {
      const text = await env.model.complete({ system: SYSTEM_PROMPT, messages: msgs, signal: abort.signal })
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: 'The assistant returned an unreadable answer. Try again.' }
      }
      return isModelOut(parsed) ? { ok: true, out: parsed } : { ok: false, error: 'The assistant returned an unreadable answer. Try again.' }
    } catch (err) {
      return { ok: false, error: modelErrorText(err, abort.signal.aborted) }
    }
  }

  try {
    const first = await call(messages)
    if (!first.ok) {
      return finalizeChatTurn({ scope, draft: input.draft, model: null, spec: null, issues: [], modelMs: env.nowMs() - start, modelError: first.error })
    }
    let out = first.out
    let resolution = resolveNames(out, env)
    const readyToBuild = (o: ModelOut) => o.ready || input.draft !== null

    let spec: DashboardSpec | null = null
    let issues = [...resolution.issues]
    const build = (o: ModelOut, res: Resolution) => {
      // With no scope yet a placeholder keeps the reply logic uniform; finalizeChatTurn discards the spec (R2).
      const built = buildSpecFromModel(o, { scope: scope ?? { kind: 'ME' }, divisionCodes: res.divisionCodes, customerIds: res.customerIds, repIds: res.repIds })
      return parseSpec(built.raw)
    }

    if (readyToBuild(out) && resolution.clarify.length === 0 && resolution.resolved.unresolved.length === 0) {
      let parsed = build(out, resolution)
      if (!parsed.ok && env.nowMs() - start <= MODEL_ABORT_MS - REPAIR_MIN_REMAINING_MS) {
        const repaired = await call([
          ...messages,
          { role: 'assistant', content: JSON.stringify(out) },
          { role: 'user', content: `That dashboard is not valid: ${parsed.issues.slice(0, 8).join('; ')}. Return the corrected, complete dashboard.` },
        ])
        if (repaired.ok) {
          out = repaired.out
          resolution = resolveNames(out, env)
          if (resolution.clarify.length === 0 && resolution.resolved.unresolved.length === 0) parsed = build(out, resolution)
          else issues = [...resolution.issues]
        }
      }
      if (parsed.ok) spec = parsed.spec
      else issues = [...issues, ...parsed.issues]
    }

    // Never return a spec that silently drops a name the user asked for (that would widen it).
    if (resolution.resolved.unresolved.length > 0) spec = null

    const result = finalizeChatTurn({
      scope,
      draft: input.draft,
      model: out,
      spec,
      issues: resolution.resolved.unresolved.length > 0 ? resolution.issues : issues,
      clarify: resolution.clarify,
      resolved: resolution.resolved,
      modelMs: env.nowMs() - start,
      modelError: null,
    })
    return result
  } finally {
    clearTimeout(timer)
  }
}
