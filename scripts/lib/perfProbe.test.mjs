import { describe, it, expect } from 'vitest'
import { parseOperations, requestShape, topLevelFields, kpiReadiness, repeatViolations, HOOK_SOURCE } from './perfProbe.mjs'

const body = (query, variables = {}) => ({ body: JSON.stringify({ query, variables }) })

describe('topLevelFields', () => {
  it('reads the real field behind aliases and ignores nested selections', () => {
    const q = 'query Q($k0: String!) { a0: listOrderByShipmentId(shipmentId: $k0, limit: 50) { items { id listOrders } nextToken } a1: getShipment(id: "x") { id } }'
    expect(topLevelFields(q).map((f) => f.name)).toEqual(['listOrderByShipmentId', 'getShipment'])
  })

  it('is not fooled by braces and parentheses inside string arguments', () => {
    const q = 'query { listShipments(filter: { number: { eq: "A}(B" } }) { items { id } } }'
    expect(topLevelFields(q).map((f) => f.name)).toEqual(['listShipments'])
  })
})

describe('requestShape', () => {
  it('flags full-table scans but not the indexed reads that share a prefix', () => {
    const shape = requestShape([
      body('query { listShipments(limit: 1000) { items { id } nextToken } }'),
      body('query { listShipmentByStatusAndPickupAppt(status: OPEN) { items { id } } }'),
      body('query { listLoadByStatus(status: BOOKED) { items { id } } }'),
    ])
    expect(shape.fullTable).toEqual(['listShipments'])
  })

  it('counts listAuditLogs as full-table only when no filter variable is supplied', () => {
    const q = 'query($filter: ModelAuditLogFilterInput, $nextToken: String) { listAuditLogs(filter: $filter, limit: 10000, nextToken: $nextToken) { items { id } nextToken } }'
    expect(requestShape([body(q, { filter: null, nextToken: null })]).fullTable).toEqual(['listAuditLogs'])
    expect(requestShape([body(q, { filter: { or: [{ entityId: { eq: 's1' } }] }, nextToken: null })]).fullTable).toEqual([])
  })

  it('measures nextToken chain depth per operation, not across parallel chains', () => {
    const q = 'query($nextToken: String, $status: String) { listShipmentByStatusAndPickupAppt(status: $status, nextToken: $nextToken) { items { id } nextToken } }'
    const log = [
      body(q, { status: 'OPEN' }), body(q, { status: 'OPEN', nextToken: 't1' }), body(q, { status: 'OPEN', nextToken: 't2' }),
      body(q, { status: 'BOOKED' }), body(q, { status: 'DRAFT' }),
    ]
    expect(requestShape(log).maxDepth).toBe(3)
  })

  it('reports an operation started more than three times (duplicate mounts) but not paging of one chain', () => {
    const q = 'query($nextToken: String) { listCarriers(nextToken: $nextToken) { items { id } nextToken } }'
    const dup = Array.from({ length: 4 }, () => body(q, {}))
    expect(requestShape(dup).repeated).toEqual([{ op: 'listCarriers', times: 4 }])
    const paged = [body(q, {}), ...Array.from({ length: 6 }, (_, i) => body(q, { nextToken: `t${i}` }))]
    expect(requestShape(paged).repeated).toEqual([])
  })

  it('lets read-style router actions through and reports every other mutation', () => {
    const router = 'mutation($action: String!, $input: AWSJSON!) { tmsShipmentActions(action: $action, input: $input) }'
    const shape = requestShape([
      body(router, { action: 'GET_SHIPMENT_BUNDLE', input: '{}' }),
      body(router, { action: 'VOID_SHIPMENT', input: '{}' }),
      body('mutation($input: CreateAuditLogInput!) { createAuditLog(input: $input) { id } }', { input: {} }),
    ])
    expect(shape.mutations).toEqual(['tmsShipmentActions:VOID_SHIPMENT', 'createAuditLog'])
  })

  it('allows only the exact read-only actions of the legacy lowercase routers', () => {
    const pods = 'mutation ManagePods($action: String!, $input: AWSJSON) { managePods(action: $action, input: $input) }'
    const shape = requestShape([body(pods, { action: 'list' }), body(pods, { action: 'status' }), body(pods, { action: 'assign' })])
    expect(shape.mutations).toEqual(['managePods:assign'])
  })

  it('treats a nextToken inside a router call input as the same chain, not a new start', () => {
    const q = 'mutation ManagePods($action: String!, $input: AWSJSON) { managePods(action: $action, input: $input) }'
    const pages = [{}, { nextToken: 'a' }, { nextToken: 'b' }, { nextToken: 'c' }, { nextToken: 'd' }].map((i) => body(q, { action: 'list', input: JSON.stringify(i) }))
    const shape = requestShape(pages)
    expect(shape.repeated).toEqual([])
    expect(shape.maxDepth).toBe(5)
  })

  it('ignores bodies that are not JSON', () => {
    expect(parseOperations('not json')).toEqual([])
  })
})

describe('kpiReadiness (Step AF)', () => {
  const money = 'Revenue $30,500 214 shipments Profit $10,700 35.1% Open AR $327,968.69 Open AP $154,546.86'
  it('needs data-state ready, four money values and the shipments sub-line', () => {
    expect(kpiReadiness('dash-kpis', { state: 'ready', text: money, skeleton: false })).toBe(true)
    expect(kpiReadiness('dash-kpis', { state: 'loading', text: money, skeleton: false })).toBe(false)
    expect(kpiReadiness('dash-kpis', { state: 'ready', text: money, skeleton: true })).toBe(false)
    expect(kpiReadiness('dash-kpis', { state: 'ready', text: 'Revenue $30,500 214 shipments Profit $10,700', skeleton: false })).toBe(false)
    expect(kpiReadiness('dash-kpis', { state: 'ready', text: money.replace('214 shipments', ''), skeleton: false })).toBe(false)
  })

  it('legacy strip needs a loads count above zero (a placeholder "0 loads" is not visible KPIs)', () => {
    expect(kpiReadiness('legacy-kpis', { state: 'ready', text: 'Loads 197 Revenue $1,200', skeleton: false })).toBe(true)
    expect(kpiReadiness('legacy-kpis', { state: 'ready', text: '171 loads', skeleton: false })).toBe(true)
    expect(kpiReadiness('legacy-kpis', { state: 'ready', text: '0 loads $0', skeleton: false })).toBe(false)
    expect(kpiReadiness('legacy-kpis', { state: 'ready', text: '171 loads', skeleton: true })).toBe(false)
    expect(kpiReadiness('nope', { state: 'ready', text: money, skeleton: false })).toBe(false)
  })

  it('the hook that runs in the page embeds the same function and parses', () => {
    const src = HOOK_SOURCE({ minRows: 0, kpiTestId: 'dash-kpis' })
    expect(src).toContain(kpiReadiness.toString())
    expect(() => new Function(src)).not.toThrow()
  })
})

describe('repeatViolations (G12)', () => {
  const q = 'query($nextToken: String, $s: String) { a0: listShipmentByStatusAndPickupAppt(status: $s, nextToken: $nextToken) { items { id } nextToken } a1: listShipmentByStatusAndPickupAppt(status: "B") { items { id } } }'
  it('counts requests that start a chain: one aliased 15-status request is one, a second identical request is a repeat', () => {
    expect(repeatViolations([body(q, { s: 'A' })], { listShipmentByStatusAndPickupAppt: 1 })).toEqual([])
    expect(repeatViolations([body(q, { s: 'A' }), body(q, { s: 'A' })], { listShipmentByStatusAndPickupAppt: 1 })).toEqual([{ op: 'listShipmentByStatusAndPickupAppt', times: 2, max: 1 }])
  })
  it('paging a chain is not a repeat', () => {
    expect(repeatViolations([body(q, { s: 'A' }), body(q, { s: 'A', nextToken: 't' })], { listShipmentByStatusAndPickupAppt: 1 })).toEqual([])
  })
})

describe('router read classification (G0, mirrors apiClient READ_ROUTER_ACTION)', () => {
  it('SPOT_COUNT / SPOT_STATUS / CRM_LIST_X read; SPOT_ADD_MANUAL still counts as a mutation', () => {
    const router = 'mutation($action: String!, $input: AWSJSON!) { tmsSpotActions(action: $action, input: $input) }'
    const shape = requestShape(['SPOT_COUNT', 'SPOT_STATUS', 'SPOT_LIST_REQUESTS', 'SPOT_ADD_MANUAL'].map((action) => body(router, { action, input: '{}' })))
    expect(shape.mutations).toEqual(['tmsSpotActions:SPOT_ADD_MANUAL'])
  })
})
