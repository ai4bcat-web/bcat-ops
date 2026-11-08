import { describe, it, expect } from 'vitest'
import { parseSchemaAuth, isDenied, countText, renderMarkdown } from './auditDataExposure.mjs'

const SOURCE = `
  Shipment: a
    .model({
      number: a.string().required(),
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  Dashboard: a
    .model({
      title: a.string().required(),
    })
    .disableOperations(['queries', 'mutations'])
    .authorization((allow) => [allow.groups(['ADMIN']).to(['read'])]),

  Note: a
    .model({
      body: a.string(),
    })
    .authorization((allow) => [allow.authenticated()]),
`

describe('parseSchemaAuth', () => {
  it('tells a read-only authenticated model from a group-only one and from an unrestricted one', () => {
    const auth = parseSchemaAuth(SOURCE)
    expect(auth.Shipment).toMatchObject({ authenticatedRead: true, authenticatedWrite: false })
    expect(auth.Dashboard).toMatchObject({ authenticatedRead: false, groups: ['ADMIN'], operations: ['queries', 'mutations'] })
    expect(auth.Note).toMatchObject({ authenticatedRead: true, authenticatedWrite: true })
  })
})

describe('probe results', () => {
  it('separates an authorization refusal from an operational error', () => {
    expect(isDenied('Not Authorized to access listCustomers on type Query')).toBe(true)
    expect(isDenied('Rate exceeded')).toBe(false)
  })
  it('prints a capped count as a lower bound', () => {
    expect(countText(25000, true)).toBe('≥ 25,000')
    expect(countText(705, false)).toBe('705')
  })
})

describe('renderMarkdown', () => {
  const rows = [
    { model: 'Shipment', readable: 'yes', count: 2509, capped: false, auth: 'authenticated: read' },
    { model: 'Dashboard', readable: 'no', count: 0, auth: 'groups: ADMIN' },
  ]
  it('states the exposure in aggregates and carries no row values', () => {
    const md = renderMarkdown({ rows, generatedAt: '2026-11-04T00:00:00Z', pages: 25 })
    expect(md).toContain('1 of 2 models are readable by any signed-in user')
    expect(md).toContain('| Shipment | **yes** | 2,509 |')
    expect(md).toContain('| Dashboard | no | — |')
    expect(md).toMatch(/not\*\* an access boundary/)
  })
})
