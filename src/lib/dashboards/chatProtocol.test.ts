import { describe, expect, it } from 'vitest'
import {
  CHAT_LIMITS,
  SCOPE_QUESTION_TEXT,
  chatAccessError,
  finalizeChatTurn,
  parseChatInput,
} from './chatProtocol'
import type { ModelOut } from './modelSchema'
import { parseSpec } from './spec'
import type { DashboardSpec } from './types'

const spec = (): DashboardSpec => {
  const r = parseSpec({
    v: 1, title: 'T', scope: { kind: 'ME' },
    filters: { window: { preset: 'THIS_MONTH' } },
    widgets: [{ id: 'w1', type: 'LIST', title: 'x', size: 'F', query: { id: 'ship.recent', params: {} } }],
  })
  if (!r.ok) throw new Error(r.issues.join())
  return r.spec
}

const model = (over: Partial<ModelOut> = {}): ModelOut => ({
  reply: 'Here you go', ready: true, questions: [], title: 'T', description: '', window: '', from: '', to: '',
  divisionNames: [], customerNames: [], repNames: [], modes: [], widgets: [], ...over,
})

describe('scope gate', () => {
  it('asks the scope question and withholds the spec while scope is null, even with a full spec', () => {
    const r = finalizeChatTurn({ scope: null, draft: null, model: model(), spec: spec(), issues: [] })
    expect(r.spec).toBeNull()
    expect(r.questions.filter((q) => q.kind === 'SCOPE')).toEqual([
      expect.objectContaining({ id: 'scope', text: SCOPE_QUESTION_TEXT }),
    ])
    expect(r.reply).toMatch(/Pick one of the options/)
  })

  it('still asks it when the model is unavailable, and carries the provider error trimmed', () => {
    const r = finalizeChatTurn({ scope: null, draft: null, model: null, spec: null, issues: [], modelError: 'x'.repeat(500) })
    expect(r.questions.map((q) => q.kind)).toEqual(['SCOPE'])
    expect(r.spec).toBeNull()
    expect(r.modelError).toHaveLength(CHAT_LIMITS.maxModelErrorChars)
  })

  it('never lets the model add its own SCOPE-looking question, and asks it exactly once', () => {
    const r = finalizeChatTurn({
      scope: null, draft: null, spec: null, issues: [],
      model: model({ ready: false, questions: [{ id: 'scope', text: 'company?', choices: ['yes'] }, { id: 'q1', text: 'AR as table?', choices: ['Table', 'Chart'] }] }),
    })
    expect(r.questions.map((q) => `${q.kind}:${q.id}`)).toEqual(['CLARIFY:q1', 'SCOPE:scope'])
  })

  it('returns the spec once a scope is set', () => {
    const r = finalizeChatTurn({ scope: { kind: 'ME' }, draft: null, model: model(), spec: spec(), issues: [] })
    expect(r.spec).not.toBeNull()
    expect(r.questions).toEqual([])
  })

  it('withholds the spec while a clarifying question is open or the first build is not ready', () => {
    const open = finalizeChatTurn({
      scope: { kind: 'ME' }, draft: null, spec: spec(), issues: [],
      model: model({ questions: [{ id: 'q1', text: 'Which?', choices: ['a'] }] }),
    })
    expect(open.spec).toBeNull()
    expect(open.questions).toHaveLength(1)
    expect(finalizeChatTurn({ scope: { kind: 'ME' }, draft: null, model: model({ ready: false }), spec: spec(), issues: [] }).spec).toBeNull()
    // an iteration on an existing draft counts as ready
    expect(finalizeChatTurn({ scope: { kind: 'ME' }, draft: spec(), model: model({ ready: false }), spec: spec(), issues: [] }).spec).not.toBeNull()
  })

  it('explains validation failures instead of drawing', () => {
    const r = finalizeChatTurn({ scope: { kind: 'ME' }, draft: null, model: model({ reply: '' }), spec: null, issues: ['Widget 1: unknown query "x"'] })
    expect(r.spec).toBeNull()
    expect(r.reply).toMatch(/couldn't build that one: Widget 1/)
  })

  it('caps clarifying questions at two with at most six choices', () => {
    const qs = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, text: `Q${i}`, choices: Array(10).fill('c') }))
    const r = finalizeChatTurn({ scope: { kind: 'ME' }, draft: null, model: model({ questions: qs }), spec: null, issues: [] })
    expect(r.questions).toHaveLength(2)
    expect(r.questions[0].choices).toHaveLength(6)
  })
})

describe('chatAccessError', () => {
  const none = { create: false, publishCompany: false, viewAll: false }
  it('needs create for any chat and publishCompany for a COMPANY scope', () => {
    expect(chatAccessError(none, null)).toMatch(/^Forbidden:/)
    expect(chatAccessError({ ...none, create: true }, { kind: 'ME' })).toBeNull()
    expect(chatAccessError({ ...none, create: true }, { kind: 'COMPANY' })).toMatch(/^Forbidden:/)
    expect(chatAccessError({ create: true, publishCompany: true, viewAll: false }, { kind: 'COMPANY' })).toBeNull()
  })
})

describe('parseChatInput', () => {
  const msg = (text: string, role = 'user') => ({ role, text })
  it('accepts a transcript with an optional scope and draft', () => {
    const r = parseChatInput({ messages: [msg('hi')], scope: { kind: 'TEAM', teamKeys: ['EAST'] }, draft: spec() })
    expect(r.ok).toBe(true)
    expect(parseChatInput({ messages: [msg('hi')], scope: null, draft: null }).ok).toBe(true)
  })

  it('rejects oversize, empty, wrong-order, unknown-field and invalid-scope input', () => {
    const bad = (raw: unknown) => {
      const r = parseChatInput(raw)
      return r.ok ? '' : r.issues.join('|')
    }
    expect(bad({ messages: [] })).toMatch(/at least one/)
    expect(bad({ messages: Array(21).fill(msg('x')) })).toMatch(/at most 20/)
    expect(bad({ messages: [msg('x'.repeat(2001))] })).toMatch(/2000/)
    expect(bad({ messages: Array(7).fill(msg('x'.repeat(1900))) })).toMatch(/too long/)
    expect(bad({ messages: [msg('hi'), msg('yo', 'assistant')] })).toMatch(/last message/)
    expect(bad({ messages: [msg('hi')], scope: { kind: 'COMPANY' }, viewAll: true })).toMatch(/Unexpected field "viewAll"/)
    expect(bad({ messages: [msg('hi')], scope: 'COMPANY' })).toMatch(/scope must be an object/)
    expect(bad({ messages: [msg('hi')], draft: { v: 2 } })).toMatch(/Current draft/)
  })
})
