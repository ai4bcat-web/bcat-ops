/**
 * Step AI §7 — the deterministic half of the chat: input validation, the scope gate and the
 * assembly of a turn's result. The model (server) only supplies a draft; code decides what
 * the client gets, so these invariants hold even when the provider is down:
 *
 *  R1  scope === null  => the SCOPE question is ALWAYS in `questions`, appended by code.
 *  R2  scope === null  => `spec` is ALWAYS null, whatever the model produced.
 *  R3  COMPANY scope without publishCompany => Forbidden (fail early).
 *  R4  open questions, or not ready (first build only) => `spec` is null.
 *
 * Relative imports only (Lambda-bundled).
 */
import { parseSpec, parseScope } from './spec'
import type { ModelOut } from './modelSchema'
import type {
  DashChatInput,
  DashChatMessage,
  DashChatResult,
  DashQuestion,
  DashboardAccess,
  DashboardScope,
  DashboardSpec,
} from './types'

export const CHAT_LIMITS = {
  maxMessages: 20,
  maxMessageChars: 2_000,
  maxTotalChars: 12_000,
  maxQuestions: 2,
  maxChoices: 6,
  maxQuestionChars: 300,
  maxModelErrorChars: 200,
} as const

export const SCOPE_QUESTION_ID = 'scope'
export const SCOPE_QUESTION_TEXT = 'Is this dashboard for the whole company, or for specific users/teams?'
export const SCOPE_PENDING_REPLY = "I'll build it as soon as you tell me who it is for. Pick one of the options below."

export const SCOPE_QUESTION: DashQuestion = {
  id: SCOPE_QUESTION_ID,
  kind: 'SCOPE',
  text: SCOPE_QUESTION_TEXT,
  choices: [],
}

export const EMPTY_RESOLVED: DashChatResult['resolved'] = {
  divisions: [],
  customers: [],
  reps: [],
  unresolved: [],
}

/** Strict validation of one chat call's input. */
export function parseChatInput(raw: unknown): { ok: true; input: DashChatInput } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: ['The chat request must be an object'] }
  }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!['messages', 'scope', 'draft'].includes(k)) issues.push(`Unexpected field "${k}"`)
  }
  const messages: DashChatMessage[] = []
  if (!Array.isArray(o.messages) || o.messages.length < 1) issues.push('Send at least one message')
  else if (o.messages.length > CHAT_LIMITS.maxMessages) {
    issues.push(`A chat can hold at most ${CHAT_LIMITS.maxMessages} messages; start a new one`)
  } else {
    let total = 0
    for (const m of o.messages) {
      const mm = m as Record<string, unknown> | null
      if (
        mm == null || typeof mm !== 'object' ||
        (mm.role !== 'user' && mm.role !== 'assistant') ||
        typeof mm.text !== 'string'
      ) {
        issues.push('Every message needs a role (user or assistant) and text')
        break
      }
      if (mm.text.length > CHAT_LIMITS.maxMessageChars) {
        issues.push(`A message can be at most ${CHAT_LIMITS.maxMessageChars} characters`)
        break
      }
      total += mm.text.length
      messages.push({ role: mm.role, text: mm.text })
    }
    if (total > CHAT_LIMITS.maxTotalChars) {
      issues.push(`The chat is too long (limit ${CHAT_LIMITS.maxTotalChars} characters); start a new one`)
    }
    if (messages.length && messages[messages.length - 1].role !== 'user') issues.push('The last message must be from the user')
  }
  let scope: DashboardScope | null = null
  if (o.scope != null) {
    const s = parseScope(o.scope)
    if (s.ok) scope = s.scope
    else issues.push(...s.issues)
  }
  let draft: DashboardSpec | null = null
  if (o.draft != null) {
    const d = parseSpec(o.draft)
    if (d.ok) draft = d.spec
    else issues.push(...d.issues.map((i) => `Current draft: ${i}`))
  }
  return issues.length ? { ok: false, issues } : { ok: true, input: { messages, scope, draft } }
}

/** R3. `Forbidden:` text like every other router, or null. `create` is always required. */
export function chatAccessError(access: DashboardAccess, scope: DashboardScope | null): string | null {
  if (!access.create) return 'Forbidden: creating dashboards needs the Create dashboards permission'
  if (scope?.kind === 'COMPANY' && !access.publishCompany) {
    return 'Forbidden: company dashboards need the Publish company dashboards permission'
  }
  return null
}

function cleanQuestions(
  fromModel: readonly { id: string; text: string; choices: readonly string[] }[],
  extra: readonly DashQuestion[],
): DashQuestion[] {
  const out: DashQuestion[] = []
  const seen = new Set<string>([SCOPE_QUESTION_ID])
  const candidates: DashQuestion[] = [
    ...extra.map((q) => ({ ...q, kind: 'CLARIFY' as const })),
    ...fromModel.map((q) => ({ id: q.id, kind: 'CLARIFY' as const, text: q.text, choices: [...q.choices] })),
  ]
  for (const q of candidates) {
    const text = q.text.trim().slice(0, CHAT_LIMITS.maxQuestionChars)
    const id = q.id.trim() || `q${out.length + 1}`
    if (!text || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      kind: 'CLARIFY',
      text,
      choices: q.choices.map((c) => c.trim()).filter(Boolean).slice(0, CHAT_LIMITS.maxChoices),
    })
    if (out.length >= CHAT_LIMITS.maxQuestions) break
  }
  return out
}

export interface TurnInput {
  scope: DashboardScope | null
  draft: DashboardSpec | null
  /** Null when the model was unavailable. */
  model: ModelOut | null
  /** A validated spec built from the model output, if any. */
  spec: DashboardSpec | null
  /** Validation / resolution problems (plain English). */
  issues: string[]
  /** Server-generated clarifications (e.g. ambiguous division names). */
  clarify?: readonly DashQuestion[]
  resolved?: DashChatResult['resolved']
  modelMs?: number
  modelError?: string | null
}

/** Assembles the result of one turn; this is where R1, R2 and R4 are enforced. */
export function finalizeChatTurn(t: TurnInput): DashChatResult {
  const modelError = t.modelError ? t.modelError.trim().slice(0, CHAT_LIMITS.maxModelErrorChars) : null
  const clarifying = cleanQuestions(t.model?.questions ?? [], t.clarify ?? [])
  const ready = t.model ? t.model.ready || t.draft !== null : false
  const questions: DashQuestion[] = [...clarifying]
  if (t.scope === null) questions.push(SCOPE_QUESTION)

  const buildable = t.spec != null && clarifying.length === 0 && ready
  const spec = t.scope === null || !buildable ? null : t.spec

  let reply = (t.model?.reply ?? '').trim()
  if (t.scope === null) {
    reply = t.spec != null && buildable ? SCOPE_PENDING_REPLY : reply || SCOPE_PENDING_REPLY
  } else if (modelError) {
    reply = reply || 'The assistant is unavailable right now. Try again in a moment.'
  } else if (spec == null && clarifying.length === 0 && t.issues.length) {
    reply = `I couldn't build that one: ${t.issues.slice(0, 3).join('; ')}`
  }

  return {
    reply,
    questions,
    spec,
    issues: t.issues,
    resolved: t.resolved ?? EMPTY_RESOLVED,
    modelMs: t.modelMs ?? 0,
    modelError,
  }
}
