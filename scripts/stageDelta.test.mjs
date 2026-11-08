import { describe, expect, it } from 'vitest'

import { diffTemplates, gsiAdditions, parseSchema, supersetViolations } from './stageDelta.mjs'

const tpl = (resources) => new Map([['stack.template.json', resources]])
const table = (indexes) => ({ Type: 'Custom::AmplifyDynamoDBTable', Properties: { globalSecondaryIndexes: indexes.map((indexName) => ({ indexName })) } })

describe('diffTemplates', () => {
  it('counts created, updated and deleted resources, and ignores key order', () => {
    const prev = tpl({ A: { Type: 'T', Properties: { x: 1, y: 2 } }, B: { Type: 'T', Properties: { v: 1 } }, C: { Type: 'T' } })
    const next = tpl({ A: { Properties: { y: 2, x: 1 }, Type: 'T' }, B: { Type: 'T', Properties: { v: 2 } }, D: { Type: 'T' } })
    const d = diffTemplates(prev, next)
    expect([d.created, d.updated, d.deleted, d.total]).toEqual([1, 1, 1, 3])
  })

  it('counts every resource of a nested stack that appears or vanishes', () => {
    const d = diffTemplates(new Map(), new Map([['n.template.json', { A: { Type: 'T' }, B: { Type: 'T' } }]]))
    expect(d.created).toBe(2)
    expect(diffTemplates(new Map([['n.template.json', { A: { Type: 'T' } }]]), new Map()).deleted).toBe(1)
  })
})

describe('gsiAdditions', () => {
  it('reports indexes an existing table gains and ignores new tables', () => {
    const prev = tpl({ T: table(['a']) })
    const next = tpl({ T: table(['a', 'b', 'c']), N: table(['x', 'y']) })
    expect(gsiAdditions(prev, next)).toEqual([{ table: 'stack.template.json#T', added: ['b', 'c'] }])
  })
})

describe('supersetViolations', () => {
  const sdl = (body) => `${body}`
  const base = parseSchema(sdl(`
    enum S { A B }
    type M @model { id: ID! name: String @index(queryField: "q") }`))

  it('accepts added fields, models and enum values; auth changes are not a field change', () => {
    const next = parseSchema(sdl(`
      enum S { A B C }
      type M @model { id: ID! name: String @index(queryField: "q") extra: Int @auth(rules: [{allow: private}]) }
      type N @model { id: ID! }`))
    expect(supersetViolations(base, next)).toEqual([])
  })

  it('flags a removed model, a removed or retyped field, a dropped index, a removed enum value', () => {
    expect(supersetViolations(base, parseSchema('enum S { A } type X @model { id: ID! }'))).toHaveLength(2)
    const next = parseSchema(sdl('enum S { A B } type M @model { id: ID! name: Int }'))
    expect(supersetViolations(base, next).join()).toContain('M.name changed')
    expect(supersetViolations(base, parseSchema('enum S { A B } type M @model { id: ID! }')).join()).toContain('M.name removed')
  })
})
