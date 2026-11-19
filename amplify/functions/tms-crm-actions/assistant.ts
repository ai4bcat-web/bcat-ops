/**
 * Ops assistant — one stateless chat turn with read-only tools. The model never touches a table:
 * it asks for a whitelisted dashboard query or one shipment by number, and the Lambda runs that
 * under the CALLER's visibility (the same reader the dashboards use), so the assistant can never
 * show a person more than their own screens would. Logs counts only: no message text, no rows.
 */
import type { ToolDef, AssistantBlock, AssistantModel, AssistantMessage } from './assistantModel'
import { QUERY_IDS } from '../../../src/lib/dashboards/catalog'
import { DATASET_IDS } from './askData'

export const ASSISTANT_LIMITS = { maxMessages: 20, maxChars: 2000, maxRounds: 6, toolResultChars: 9000 } as const
/** AppSync cuts a resolver at 30 s; the loop stops asking the model for more at this mark. */
export const ASSISTANT_BUDGET_MS = 24_000
/** A further model round needs at least this long left. */
const ROUND_MIN_REMAINING_MS = 5_000

export interface AssistantInput {
  messages: { role: 'user' | 'assistant'; text: string }[]
}
export interface AssistantResult {
  reply: string
  /** Which tools ran, in order (names only). */
  toolsUsed: string[]
  modelError: string | null
  ms: number
}

export type ParsedInput = { ok: true; input: AssistantInput } | { ok: false; issues: string[] }

export function parseAssistantInput(raw: unknown): ParsedInput {
  const issues: string[] = []
  const list = (raw as { messages?: unknown } | null)?.messages
  if (!Array.isArray(list) || list.length === 0) return { ok: false, issues: ['messages is required'] }
  if (list.length > ASSISTANT_LIMITS.maxMessages) issues.push(`at most ${ASSISTANT_LIMITS.maxMessages} messages`)
  const messages: AssistantInput['messages'] = []
  for (const m of list.slice(0, ASSISTANT_LIMITS.maxMessages)) {
    const role = (m as { role?: unknown })?.role
    const text = (m as { text?: unknown })?.text
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) {
      issues.push('each message needs a role and text')
      continue
    }
    if (text.length > ASSISTANT_LIMITS.maxChars) issues.push(`a message is over ${ASSISTANT_LIMITS.maxChars} characters`)
    messages.push({ role, text: text.slice(0, ASSISTANT_LIMITS.maxChars) })
  }
  if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') issues.push('the last message must come from the user')
  return issues.length ? { ok: false, issues } : { ok: true, input: { messages } }
}

/** What each tool does. Both resolve to the text the model reads; a refusal is a normal text result. */
export interface AssistantTools {
  runQuery(input: Record<string, unknown>): Promise<string>
  findShipment(input: Record<string, unknown>): Promise<string>
  /** The governed data layer (askData.ts). Optional so a caller without it still gets the first two tools. */
  describeData?(input: Record<string, unknown>): Promise<string> | string
  queryData?(input: Record<string, unknown>): Promise<string>
  fleetPnl?(input: Record<string, unknown>): Promise<string>
}

const str = { type: 'string' } as const
const strList = { type: 'array', items: str } as const

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'run_query',
    description:
      'Run one whitelisted business query (financials, shipment counts and recent shipments, open AR, quotes) for a time window and optional filters. Returns rows already limited to what this user may see. Money values are in cents. Use it for any "how many / how much / which / who owes" question.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['queryId'],
      properties: {
        queryId: { type: 'string', enum: [...QUERY_IDS] },
        metric: { ...str, description: 'Single metric for queries that take one (e.g. revenue, profit, margin, count). Omit for the default.' },
        metrics: { ...strList, description: 'Metrics for summary queries. Omit for the default.' },
        groupBy: { ...str, description: 'CUSTOMER, REP, CARRIER, DIVISION or MODE, for the byGroup queries.' },
        grain: { ...str, description: 'MONTH or WEEK, for the byTime queries.' },
        sort: { ...str, description: 'Sort for list queries, when the query accepts one.' },
        limit: { type: 'number', description: 'Top N, 1-25.' },
        window: { ...str, description: 'THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, LAST_30_DAYS, LAST_90_DAYS or YEAR_TO_DATE. Leave empty to use from/to.' },
        from: { ...str, description: 'YYYY-MM-DD, with `to`, when no preset fits.' },
        to: { ...str, description: 'YYYY-MM-DD.' },
        divisionNames: { ...strList, description: 'Business/division names to filter to, as the user wrote them.' },
        customerNames: { ...strList, description: 'Customer names to filter to, as the user wrote them.' },
        repNames: { ...strList, description: 'Sales rep names to filter to, as the user wrote them.' },
        modes: { ...strList, description: 'Shipment modes such as FTL, LTL.' },
      },
    },
  },
  {
    name: 'find_shipment',
    description:
      'Look up one shipment by its PRO / shipment number (for example 20018). Returns its status, customer, route, appointments, delivery and billing milestones, and who is tracking it.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['number'],
      properties: { number: { ...str, description: 'The shipment / PRO number exactly as the user gave it.' } },
    },
  },
  {
    name: 'describe_data',
    description:
      'List the datasets you may query with query_data, with their dimensions (what you can group or filter by), metrics, date fields and notes. Call it first when you are not sure a question can be answered, and again with a dataset name to see its fields. Only datasets this user may use are listed.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { dataset: { ...str, description: 'One dataset id, to see just that one. Omit to list all.' } },
    },
  },
  {
    name: 'query_data',
    description:
      'Ask a governed question of one dataset: choose metrics, group by up to two dimensions (including day, week or month), filter dimensions, and set a window. Use it for any "how many / how much / by customer, carrier, rep, truck, vendor, month..." question about delivered loads, carrier bills, vendor bills, maintenance, fuel or driver pay. Money is in cents. Totals are returned with the groups.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['dataset'],
      properties: {
        dataset: { type: 'string', enum: [...DATASET_IDS] },
        metrics: { ...strList, description: 'Metric names from describe_data. Omit for the dataset default.' },
        groupBy: { ...strList, description: 'Up to 2 dimension names (or day / week / month).' },
        filters: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['dim', 'values'], properties: { dim: str, values: strList } },
          description: 'Each filter keeps rows whose dimension equals or contains any of the values, as the user wrote them.',
        },
        window: { ...str, description: 'THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, LAST_30_DAYS, LAST_90_DAYS or YEAR_TO_DATE. Leave empty to use from/to. Default THIS_MONTH.' },
        from: { ...str, description: 'YYYY-MM-DD, with `to`.' },
        to: { ...str, description: 'YYYY-MM-DD.' },
        dateField: { ...str, description: 'Which date of the dataset the window and day/week/month use (see describe_data).' },
        sort: { ...str, description: 'Metric to sort groups by. Default: the first metric (time groupings sort by date).' },
        order: { ...str, description: 'desc (default) or asc.' },
        limit: { type: 'number', description: 'Groups to return, 1-50. Default 25.' },
      },
    },
  },
  {
    name: 'fleet_pnl',
    description:
      'The fleet profit and loss for LOCAL (the Ivan local drivers, box truck included), BOX_TRUCK or AMAZON: revenue, expenses (driver pay, fuel, insurance, truck loans, maintenance, other), net and profit margin, per truck, for a window. Use it for "monthly expenses for local drivers", "what is the margin on the local fleet", "is the fleet profitable". Owner and admin only. It reports where driver pay has not been entered yet.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fleet: { ...str, description: 'LOCAL (default), BOX_TRUCK or AMAZON.' },
        window: { ...str, description: 'THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, LAST_30_DAYS, LAST_90_DAYS or YEAR_TO_DATE. Default THIS_MONTH (cut at today).' },
        from: { ...str, description: 'YYYY-MM-DD, with `to`, when no preset fits.' },
        to: { ...str, description: 'YYYY-MM-DD.' },
        byTruck: { type: 'boolean', description: 'Include the per-truck rows (default true).' },
      },
    },
  },
]

export const SYSTEM_PROMPT = `You are the BCAT Ops assistant, built into the dashboard of a freight brokerage and trucking TMS. People ask what is going on in the business and you answer from the data your tools return.

Rules:
- Answer ONLY from tool results. Never guess a number, a status or a name. If the tools cannot answer, say so plainly and say what you can look up instead.
- You are read-only. You cannot change, send, book, invoice or delete anything; if asked, say so and point to where in the app it is done.
- Your tools only return what this user is allowed to see. If something is missing or empty, do not claim it does not exist; say you cannot see it with their access.
- Money in tool results is in cents: show dollars with thousands separators. Show dates as written in the data.
- You can look up: financial totals and breakdowns, shipment counts and the latest shipments, open receivables and aging, quotes, a single shipment by number (run_query, find_shipment), and a governed data layer: describe_data lists the datasets, query_data asks one of them anything it holds (delivered loads with revenue, cost, profit, miles; carrier bills; vendor bills; maintenance; fuel; driver pay), and fleet_pnl gives the fleet profit and loss. You cannot see tracking pings, e-mails, the factoring queue or the intake queue. Say so if asked.
- For a question about margin or expenses of the local drivers or any fleet, call fleet_pnl. For any other "by customer / carrier / rep / truck / vendor / month" question, call query_data; if you are unsure what a dataset holds, call describe_data first.
- State the window and the date basis you used (delivered day, bill date...) in one short clause. When fleet_pnl lists gaps (driver pay not entered, trucks without a fuel card), say so and give the estimate it supplies as an estimate, never as a fact.
- A tool that says your access does not include something is final: tell the user plainly and do not try to answer it another way.
- When a name could match more than one customer, rep or business, ask which one.
- Keep answers short and plain: lead with the answer, then the few numbers that support it. Use a short list or a small table when comparing several rows. No filler, no restating the question.`

type Msg = AssistantMessage

function toModelMessages(input: AssistantInput, today: string): Msg[] {
  const out: Msg[] = []
  for (const m of input.messages) {
    const last = out[out.length - 1]
    if (!last && m.role === 'assistant') continue
    if (last && last.role === m.role && typeof last.content === 'string') last.content += `\n${m.text}`
    else out.push({ role: m.role, content: m.text })
  }
  const last = out[out.length - 1]
  if (last && typeof last.content === 'string') last.content += `\n\n[Today (UTC): ${today}]`
  return out
}

const clip = (s: string): string =>
  s.length <= ASSISTANT_LIMITS.toolResultChars ? s : `${s.slice(0, ASSISTANT_LIMITS.toolResultChars)}\n…(result cut at ${ASSISTANT_LIMITS.toolResultChars} characters; ask for a narrower window or a smaller top N)`

function errorText(err: unknown, aborted: boolean): string {
  if (aborted) return 'The assistant took too long to answer. Try a narrower question.'
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[key]').trim().slice(0, 300) || 'The assistant is unavailable'
}

export interface AssistantEnv {
  model: AssistantModel
  tools: AssistantTools
  today: string
  nowMs: () => number
}

export async function assistantTurn(input: AssistantInput, env: AssistantEnv): Promise<AssistantResult> {
  const start = env.nowMs()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ASSISTANT_BUDGET_MS)
  const toolsUsed: string[] = []
  const messages = toModelMessages(input, env.today)
  const done = (reply: string, modelError: string | null): AssistantResult => ({ reply, toolsUsed, modelError, ms: env.nowMs() - start })

  try {
    for (let round = 0; round < ASSISTANT_LIMITS.maxRounds; round++) {
      const step = await env.model.step({ system: SYSTEM_PROMPT, messages, tools: TOOL_DEFS, signal: abort.signal })
      const text = step.content.filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('').trim()
      const uses = step.content.filter((b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      if (uses.length === 0) return done(text || 'I could not put an answer together. Try rephrasing.', null)

      messages.push({ role: 'assistant', content: step.content })
      const results: AssistantBlock[] = []
      for (const use of uses) {
        toolsUsed.push(use.name)
        let out: string
        try {
          const args = use.input && typeof use.input === 'object' ? (use.input as Record<string, unknown>) : {}
          if (use.name === 'run_query') out = await env.tools.runQuery(args)
          else if (use.name === 'find_shipment') out = await env.tools.findShipment(args)
          else if (use.name === 'describe_data' && env.tools.describeData) out = await env.tools.describeData(args)
          else if (use.name === 'query_data' && env.tools.queryData) out = await env.tools.queryData(args)
          else if (use.name === 'fleet_pnl' && env.tools.fleetPnl) out = await env.tools.fleetPnl(args)
          else out = `Unknown tool ${use.name}`
        } catch (err) {
          out = `The lookup failed: ${errorText(err, false)}`
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: clip(out) })
      }
      messages.push({ role: 'user', content: results })

      if (env.nowMs() - start > ASSISTANT_BUDGET_MS - ROUND_MIN_REMAINING_MS) {
        return done('That took too long to finish. Ask a narrower question, for example one customer or a shorter time window.', null)
      }
    }
    return done('I needed too many lookups for that. Try a narrower question.', null)
  } catch (err) {
    return done('', errorText(err, abort.signal.aborted))
  } finally {
    clearTimeout(timer)
  }
}
