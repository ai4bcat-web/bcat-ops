import { beforeEach, describe, expect, it } from 'vitest'
import { CrmFakeDb } from '../_shared/crmFakeDb'
import type { Db, Row } from '../_shared/crmStore'
import { dispatch, type AppSyncIdentity } from './actions'
import type { DashDeps } from './dashboardActions'
import type { CustomerNameRow, DashSource } from './dashSources'
import { CONFLICT_ERROR, summaryOf, type DashStore, type StoredDashboard } from './dashStore'
import { ASSISTANT_LIMITS, assistantTurn, parseAssistantInput, type AssistantTools } from './assistant'
import type { AssistantBlock, AssistantModel, StepRequest } from './assistantModel'

const ident = (username: string, groups: string[]): AppSyncIdentity => ({
  username, sub: username, claims: { email: `${username}@bcatcorp.com`, 'cognito:groups': groups },
})
const admin = ident('boss', ['ADMIN', 'page-tms'])
const repa = ident('repa', ['page-tms'])
const nopage = ident('nopage', ['page-customers'])

const customers: CustomerNameRow[] = [
  { id: 'c1', name: 'Alpha Freight', accountOwnerIds: ['repa'] },
  { id: 'c3', name: 'ZZSENTINEL Hidden Co', accountOwnerIds: ['other'] },
]
const AMOUNT: Record<string, number> = { c1: 1_000, c3: 777_777_777 }

const source: DashSource = {
  customers: async () => customers,
  teams: async () => [],
  staff: async () => [{ id: 'repa', name: 'Rep A', email: 'repa@bcatcorp.com' }, { id: 'boss', name: 'Boss', email: 'boss@bcatcorp.com' }],
  divisions: async () => [{ code: 'BCAT', name: 'BCAT Logistics', brand: null, parentId: null }],
  samples: async () =>
    customers.map((c, i) => ({
      shipmentId: `s${i}`, date: '2026-11-10', revenueCents: AMOUNT[c.id]!, costCents: 0, profitCents: AMOUNT[c.id]!,
      customerId: c.id, customerName: c.name, revDivision: 'BCAT', mode: 'FTL',
    })),
  shipments: async () => [],
  openInvoices: async () => [],
  quotes: async () => [],
}

const store: DashStore = {
  index: async () => [] as ReturnType<typeof summaryOf>[],
  get: async () => null as StoredDashboard | null,
  async commit() { throw new Error(CONFLICT_ERROR) },
}

/** A model that runs the scripted steps in order and records what it was shown. */
function scripted(steps: AssistantBlock[][], seen: StepRequest[] = []): AssistantModel {
  let i = 0
  return { async step(req) { seen.push({ ...req, messages: structuredClone(req.messages) }); return { content: steps[i++] ?? [{ type: 'text', text: 'done' }] } } }
}
const toolUse = (name: string, input: unknown, id = 't1'): AssistantBlock => ({ type: 'tool_use', id, name, input })
const text = (t: string): AssistantBlock => ({ type: 'text', text: t })

describe('parseAssistantInput', () => {
  it('accepts a transcript that ends on the user', () => {
    const r = parseAssistantInput({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'revenue?' }] })
    expect(r.ok).toBe(true)
  })
  it.each([
    [{}], [{ messages: [] }], [{ messages: [{ role: 'assistant', text: 'x' }] }],
    [{ messages: [{ role: 'user', text: '' }] }], [{ messages: [{ role: 'system', text: 'x' }] }],
    [{ messages: [{ role: 'user', text: 'x'.repeat(ASSISTANT_LIMITS.maxChars + 1) }] }],
    [{ messages: Array.from({ length: ASSISTANT_LIMITS.maxMessages + 1 }, () => ({ role: 'user', text: 'x' })) }],
  ])('rejects %j', (raw) => {
    expect(parseAssistantInput(raw).ok).toBe(false)
  })
})

describe('assistantTurn', () => {
  const tools = (calls: string[]): AssistantTools => ({
    runQuery: async (i) => { calls.push(`q:${String(i.queryId)}`); return '{"rows":1}' },
    findShipment: async (i) => { calls.push(`s:${String(i.number)}`); return '{"status":"IN_TRANSIT"}' },
  })
  const input = { messages: [{ role: 'user' as const, text: 'where is 20018?' }] }

  it('runs the requested tool, feeds the result back and returns the final text', async () => {
    const calls: string[] = []
    const seen: StepRequest[] = []
    const res = await assistantTurn(input, {
      model: scripted([[toolUse('find_shipment', { number: '20018' })], [text('It is in transit.')]], seen),
      tools: tools(calls), today: '2026-11-11', nowMs: Date.now,
    })
    expect(res).toMatchObject({ reply: 'It is in transit.', toolsUsed: ['find_shipment'], modelError: null })
    expect(calls).toEqual(['s:20018'])
    const second = seen[1]!.messages
    expect(second[second.length - 1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"status":"IN_TRANSIT"}' }] })
    expect((seen[0]!.messages[0]!.content as string)).toContain('Today (UTC): 2026-11-11')
  })

  it('turns a throwing tool into text the model can read, not a crash', async () => {
    const seen: StepRequest[] = []
    const res = await assistantTurn(input, {
      model: scripted([[toolUse('run_query', { queryId: 'fin.summary' })], [text('Could not look that up.')]], seen),
      tools: { runQuery: async () => { throw new Error('boom') }, findShipment: async () => '' }, today: '2026-11-11', nowMs: Date.now,
    })
    expect(res.reply).toBe('Could not look that up.')
    expect(JSON.stringify(seen[1]!.messages)).toContain('The lookup failed: boom')
  })

  it('cuts an oversized tool result', async () => {
    const seen: StepRequest[] = []
    await assistantTurn(input, {
      model: scripted([[toolUse('run_query', { queryId: 'x' })], [text('ok')]], seen),
      tools: { runQuery: async () => 'x'.repeat(50_000), findShipment: async () => '' }, today: '2026-11-11', nowMs: Date.now,
    })
    const content = (seen[1]!.messages[2]!.content as AssistantBlock[])[0] as { content: string }
    expect(content.content.length).toBeLessThan(ASSISTANT_LIMITS.toolResultChars + 200)
  })

  it('stops after the round cap and says so', async () => {
    const res = await assistantTurn(input, {
      model: { step: async () => ({ content: [toolUse('run_query', { queryId: 'fin.summary' })] }) },
      tools: tools([]), today: '2026-11-11', nowMs: Date.now,
    })
    expect(res.reply).toMatch(/too many lookups/)
    expect(res.toolsUsed).toHaveLength(ASSISTANT_LIMITS.maxRounds)
  })

  it('reports a provider failure as modelError and never throws', async () => {
    const res = await assistantTurn(input, {
      model: { step: async () => { throw new Error('overloaded sk-ant-abc123') } },
      tools: tools([]), today: '2026-11-11', nowMs: Date.now,
    })
    expect(res.modelError).toBe('overloaded [key]')
    expect(res.reply).toBe('')
  })
})

describe('PREVIEW_ASSISTANT_CHAT through the router', () => {
  let db: Db
  const row: Row = { id: 's9', number: '20018', status: 'IN_TRANSIT', customerId: 'c3', customerName: 'ZZSENTINEL Hidden Co', salesRepId: 'other' }
  const mine: Row = { id: 's8', number: '20019', status: 'DELIVERED', customerId: 'c1', customerName: 'Alpha Freight', salesRepId: 'repa', trackerId: 'boss' }
  let deps: DashDeps
  const ask = (who: AppSyncIdentity, steps: AssistantBlock[][], seen: StepRequest[] = []) => {
    deps = { ...deps, assistantModel: scripted(steps, seen) }
    return dispatch('PREVIEW_ASSISTANT_CHAT', { messages: [{ role: 'user', text: 'q' }] }, who, db, deps) as Promise<{ reply: string; toolsUsed: string[] }>
  }
  const toolResultText = (seen: StepRequest[]) => JSON.stringify(seen[1]!.messages)

  beforeEach(() => {
    db = new CrmFakeDb()
    deps = {
      source, store, model: { complete: async () => '' }, nowMs: () => Date.parse('2026-11-15T12:00:00Z'), newId: () => 'id',
      shipmentByNumber: async (n) => (n === '20018' ? row : n === '20019' ? mine : null),
    }
  })

  it('refuses a caller without the dashboard door', async () => {
    await expect(ask(nopage, [])).rejects.toThrow(/Forbidden/)
  })

  it('a run_query tool answers with the caller\'s own rows only', async () => {
    const adminSeen: StepRequest[] = []
    await ask(admin, [[toolUse('run_query', { queryId: 'fin.summary', metrics: ['revenue'], window: 'THIS_MONTH' })], [text('x')]], adminSeen)
    expect(toolResultText(adminSeen)).toContain('777778777')
    const repSeen: StepRequest[] = []
    await ask(repa, [[toolUse('run_query', { queryId: 'fin.summary', metrics: ['revenue'], window: 'THIS_MONTH' })], [text('x')]], repSeen)
    expect(toolResultText(repSeen)).not.toMatch(/77777|ZZSENTINEL/i)
    expect(toolResultText(repSeen)).toContain('value\\":1000')
  })

  it('find_shipment hides a shipment the caller cannot see exactly like a missing one', async () => {
    const hidden: StepRequest[] = []
    await ask(repa, [[toolUse('find_shipment', { number: '20018' })], [text('x')]], hidden)
    expect(toolResultText(hidden)).toContain('No shipment 20018 that you can see.')
    expect(toolResultText(hidden)).not.toContain('ZZSENTINEL')
    const missing: StepRequest[] = []
    await ask(repa, [[toolUse('find_shipment', { number: '99999' })], [text('x')]], missing)
    expect(toolResultText(missing)).toContain('No shipment 99999 that you can see.')
  })

  it('find_shipment returns the facts and names for a visible shipment', async () => {
    const seen: StepRequest[] = []
    await ask(repa, [[toolUse('find_shipment', { number: '20019' })], [text('x')]], seen)
    const out = toolResultText(seen)
    expect(out).toContain('DELIVERED')
    expect(out).toContain('Alpha Freight')
    expect(out).toContain('Rep A')
    expect(out).toContain('Boss')
  })

  it('an unknown name comes back as text for the model, not as a widened query', async () => {
    const seen: StepRequest[] = []
    await ask(admin, [[toolUse('run_query', { queryId: 'fin.summary', customerNames: ['Nobody Inc'] })], [text('x')]], seen)
    expect(toolResultText(seen)).toMatch(/No customer you can see matches/)
  })
})
