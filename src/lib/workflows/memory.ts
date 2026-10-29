/**
 * Step K — the human-written memory the agents read.
 *
 * Every block here is authored by a person and read by the agent; nothing in this file
 * is ever written from model output. A revision counter moves only when the words
 * actually change, so a run can record exactly which text shaped it and a reviewer can
 * tell a re-read from a re-write.
 *
 * `redactForPrompt` is the single credential filter for everything this stack sends to
 * a model or stores on a run row. It lives here because memory, prompts and error
 * strings all need the same answer to "could this be a secret".
 */
import { AGENTS } from './agents'
import type {
  AgentMemory,
  AgentSettings,
  AiAgentKey,
  AiAgentsSettings,
  PartyAiMemory,
  WorkflowAgentKey,
  WorkflowMemoryRevisions,
} from '../../types/tms'

/** A memory block big enough to hold real instructions and small enough to prompt with. */
export const MEMORY_MAX = 20_000

export const DEFAULT_DAILY_RUN_CAP = 200

/** The agents a person can configure. WEBHOOK has no inbox and no instructions. */
const AI_AGENT_KEYS: readonly AiAgentKey[] = ['QUOTE', 'TENDER', 'AP', 'CAPACITY']

/**
 * Credential shapes, most specific first. Each replacement is a non-empty literal, so
 * redaction can never splice two fragments of the surrounding text together.
 *
 * The floor lengths are what keeps this from shredding ordinary prose: a 24-character
 * run of base64 alphabet is longer than any English word and longer than every PRO,
 * shipment number and reference this desk uses, and the 13-digit card floor sits above
 * a 10-digit phone number. Anything shorter is left alone on purpose — a prompt full
 * of `[redacted]` where the load numbers used to be is worse than useless.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer <token>` in a forwarded header block.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // OpenAI/Anthropic-style keys.
  /\bsk-[A-Za-z0-9_-]{12,}/gi,
  // Slack tokens.
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
  // An AWS access key id is exactly this shape and nothing else is.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  // `password: hunter2`, `api_key=...`, `secret: "..."` — the assignment is the signal,
  // so the value is redacted whatever shape it has. Quotes are consumed with it.
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|credentials?)\b\s*[:=]\s*"?'?[^\s"';,]{4,}"?'?/gi,
  // 13-19 digit card-shaped runs, with or without space/dash separators. A 10-digit
  // phone number is deliberately below the floor.
  /\b\d(?:[ -]?\d){12,18}\b/g,
  // Anything else long enough to be a secret, in either base64 alphabet. Standard
  // base64 (`/`, `+`, `=`) is what an AWS secret access key is written in; base64url
  // (`-`, `_`) is what most bearer tokens are. Last, so the named shapes win.
  /[A-Za-z0-9+/]{24,}={0,2}/g,
  /\b[A-Za-z0-9_-]{24,}\b/g,
]

export function redactForPrompt(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/**
 * The one place this directory turns an unvalidated payload into something indexable.
 * The assertion is justified by the three checks immediately above it; every field read
 * downstream is still `unknown` and still has to prove its own type.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Accepts either a bare markdown string or a `{ markdown }` block from the editor. */
function markdownOf(value: unknown, where: string): string {
  const row = asRecord(value)
  const raw =
    typeof value === 'string' ? value : typeof row?.markdown === 'string' ? row.markdown : null
  if (raw === null) throw new Error(`${where} must be markdown text`)
  if (raw.trim().length > MEMORY_MAX) throw new Error(`${where} is over ${MEMORY_MAX} characters`)
  return raw
}

/**
 * The stored block under one key, or null. Used to carry an untouched block forward
 * verbatim: a partial save must never silently drop somebody else's instructions.
 */
function priorMemory(prev: unknown, key: string): AgentMemory | null {
  const row = asRecord(prev)
  return row ? validateMemory(row[key]) : null
}

export function bumpMemory(
  prev: AgentMemory | null | undefined,
  markdown: string,
  by: string,
  nowIso: string,
): AgentMemory {
  const next = markdown.trim()
  if (next.length > MEMORY_MAX) throw new Error(`Memory is over ${MEMORY_MAX} characters`)
  // Unchanged text keeps the whole block, revision included: a save that changed
  // nothing must not look like a new version to a run that cites it.
  if (prev && prev.markdown.trim() === next) return prev
  return { markdown: next, revision: (prev?.revision ?? 0) + 1, updatedAt: nowIso, updatedBy: by }
}

export function validateMemory(value: unknown): AgentMemory | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('Memory must be an object')
  if (typeof row.markdown !== 'string') throw new Error('Memory needs markdown text')
  if (row.markdown.length > MEMORY_MAX) throw new Error(`Memory is over ${MEMORY_MAX} characters`)
  const revision = typeof row.revision === 'number' && Number.isFinite(row.revision) ? Math.trunc(row.revision) : 0
  return {
    markdown: row.markdown,
    revision: revision < 0 ? 0 : revision,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : '',
  }
}

/** The stored settings for one agent, re-read through the validators. */
function priorSettingsOf(prev: Record<string, unknown>, agent: AiAgentKey): AgentSettings | null {
  const row = asRecord(prev[agent])
  if (!row) return null
  return {
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    inbox: typeof row.inbox === 'string' ? row.inbox : null,
    instructions: priorMemory(row, 'instructions'),
    memory: priorMemory(row, 'memory'),
  }
}

function validateAgentSettings(
  value: unknown,
  prev: AgentSettings | null,
  agent: AiAgentKey,
  by: string,
  nowIso: string,
): AgentSettings {
  if (value === null || value === undefined) return prev ?? {}
  const row = asRecord(value)
  if (!row) throw new Error(`${agent} settings must be an object`)
  const out: AgentSettings = { ...(prev ?? {}) }

  if ('enabled' in row) {
    if (typeof row.enabled !== 'boolean') throw new Error(`${agent} enabled must be true or false`)
    out.enabled = row.enabled
  }
  if ('inbox' in row) {
    if (typeof row.inbox !== 'string') throw new Error(`${agent} inbox must be an address`)
    const inbox = row.inbox.trim()
    if (inbox.length > 200) throw new Error(`${agent} inbox is too long`)
    if (inbox && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inbox)) throw new Error(`${agent} inbox is not an address`)
    out.inbox = inbox
  }
  /*
   * Two revisioned blocks per agent, deliberately. `instructions` is how the agent is
   * told to behave; `memory` is what the desk has learnt about this kind of mail —
   * the spec's Memory card. Folding them into one field would make an edit to a
   * standing instruction bump the revision of the learnt notes and vice versa, and the
   * run stamps those revisions so a trace can say which text it actually read.
   */
  if ('instructions' in row) {
    out.instructions = bumpMemory(
      prev?.instructions ?? null,
      markdownOf(row.instructions, `${agent} instructions`),
      by,
      nowIso,
    )
  }
  if ('memory' in row) {
    out.memory = bumpMemory(
      prev?.memory ?? null,
      markdownOf(row.memory, `${agent} memory`),
      by,
      nowIso,
    )
  }
  return out
}

export function validateAiAgents(value: unknown, prev: unknown, by: string, nowIso: string): AiAgentsSettings {
  const row = asRecord(value)
  if (!row) throw new Error('aiAgents must be an object')
  const priorRow = asRecord(prev) ?? {}
  const out: AiAgentsSettings = {}

  const priorGeneral = priorMemory(priorRow, 'general')
  out.general =
    'general' in row ? bumpMemory(priorGeneral, markdownOf(row.general, 'General memory'), by, nowIso) : priorGeneral

  if ('dailyRunCap' in row) {
    const cap = row.dailyRunCap
    if (cap === null) out.dailyRunCap = null
    else if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 10_000) {
      throw new Error('dailyRunCap must be between 1 and 10000')
    } else out.dailyRunCap = Math.trunc(cap)
  } else if (typeof priorRow.dailyRunCap === 'number') {
    out.dailyRunCap = priorRow.dailyRunCap
  }

  for (const agent of AI_AGENT_KEYS) {
    const priorSettings = priorSettingsOf(priorRow, agent)
    if (agent in row) out[agent] = validateAgentSettings(row[agent], priorSettings, agent, by, nowIso)
    else if (priorSettings) out[agent] = priorSettings
  }
  return out
}

/**
 * `undefined` means the caller did not mention memory at all, which every ordinary
 * carrier and customer edit does — it keeps whatever is stored. `null` is the
 * explicit clear. Anything else that is not an object is a mistake worth refusing.
 */
export function validatePartyMemory(
  value: unknown,
  prev: unknown,
  by: string,
  nowIso: string,
): PartyAiMemory | null | undefined {
  if (value === undefined) return (asRecord(prev) ? (prev as PartyAiMemory) : undefined)
  if (value === null) return null
  const row = asRecord(value)
  if (!row) throw new Error('aiMemory must be an object')
  const priorRow = asRecord(prev) ?? {}
  const out: PartyAiMemory = {}

  const priorGeneral = priorMemory(priorRow, 'general')
  out.general =
    'general' in row ? bumpMemory(priorGeneral, markdownOf(row.general, 'Party notes'), by, nowIso) : priorGeneral

  for (const agent of AI_AGENT_KEYS) {
    const priorAgent = priorMemory(priorRow, agent)
    if (agent in row) out[agent] = bumpMemory(priorAgent, markdownOf(row[agent], `Party ${agent} notes`), by, nowIso)
    else if (priorAgent) out[agent] = priorAgent
  }
  return out
}

/** The configurable slice of an agent, or null for WEBHOOK and for unset agents. */
function settingsFor(org: AiAgentsSettings | null, agent: WorkflowAgentKey): AgentSettings | null {
  if (agent === 'WEBHOOK' || !org) return null
  return org[agent] ?? null
}

export function memoryPromptFor(
  org: AiAgentsSettings | null,
  party: PartyAiMemory | null,
  agent: WorkflowAgentKey,
): string {
  const label = AGENTS[agent].label
  const partyAgent = agent === 'WEBHOOK' ? null : (party?.[agent] ?? null)
  const settings = settingsFor(org, agent)
  const sections: Array<[string, string]> = [
    ['## Organization instructions', (org?.general?.markdown ?? '').trim()],
    [`## ${label} instructions`, (settings?.instructions?.markdown ?? '').trim()],
    [`## ${label} memory`, (settings?.memory?.markdown ?? '').trim()],
    ['## Party notes', (party?.general?.markdown ?? '').trim()],
    [`## Party ${label} notes`, (partyAgent?.markdown ?? '').trim()],
  ]
  return sections
    .filter(([, body]) => body.length > 0)
    .map(([heading, body]) => `${heading}\n${body}`)
    .join('\n\n')
}

export function memoryRevisionsFor(
  org: AiAgentsSettings | null,
  party: PartyAiMemory | null,
  agent: WorkflowAgentKey,
): WorkflowMemoryRevisions {
  const partyAgent = agent === 'WEBHOOK' ? null : (party?.[agent] ?? null)
  const settings = settingsFor(org, agent)
  return {
    org: org?.general?.revision ?? null,
    orgAgent: settings?.instructions?.revision ?? null,
    orgAgentMemory: settings?.memory?.revision ?? null,
    party: party?.general?.revision ?? null,
    partyAgent: partyAgent?.revision ?? null,
  }
}

export function dailyRunCapOf(org: AiAgentsSettings | null): number {
  const cap = org?.dailyRunCap
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 1) return Math.trunc(cap)
  return DEFAULT_DAILY_RUN_CAP
}

export function agentEnabled(org: AiAgentsSettings | null, agent: WorkflowAgentKey): boolean {
  return settingsFor(org, agent)?.enabled !== false
}
