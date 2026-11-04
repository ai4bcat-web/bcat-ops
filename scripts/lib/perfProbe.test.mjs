import { describe, it, expect } from 'vitest'
import { parseOperations, requestShape, topLevelFields } from './perfProbe.mjs'

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
