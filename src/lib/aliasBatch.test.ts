import { describe, it, expect, vi } from 'vitest'
import { batchByIndex, batchByIndexPairs, batchGet } from './aliasBatch'
import type { GraphqlRunner } from './aliasBatch'

const Q = { query: 'listOrderByShipmentId', keyArg: 'shipmentId', keyType: 'String!', fields: 'id shipmentId' }

/** A fake AppSync: `rowsFor(id)` rows per key, honouring the alias limit and nextToken. */
function fakeIndex(rowsFor: (id: string) => number, limitSeen: number[] = []) {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const run: GraphqlRunner = async (query, variables) => {
    calls.push({ query, variables })
    const data: Record<string, unknown> = {}
    const aliases = [...query.matchAll(/(\w+): listOrderByShipmentId\(shipmentId: \$(\w+), limit: (\d+)(?:, nextToken: \$t)?\)/g)]
    for (const [, alias, v, limit] of aliases) {
      limitSeen.push(Number(limit))
      const id = variables[v] as string
      const offset = alias === 'a' && variables.t ? Number(variables.t) : 0
      const total = rowsFor(id)
      const end = Math.min(total, offset + Number(limit))
      data[alias] = {
        items: Array.from({ length: end - offset }, (_, i) => ({ id: `${id}-${offset + i}`, shipmentId: id })),
        nextToken: end < total ? String(end) : null,
      }
    }
    return data
  }
  return { run, calls }
}

describe('batchByIndex', () => {
  it('splits at the chunk boundary: 100 ids is one request, 101 is two', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `s${i}`)
    const a = fakeIndex(() => 1)
    await batchByIndex(Q, ids.slice(0, 100), { run: a.run })
    expect(a.calls).toHaveLength(1)
    const b = fakeIndex(() => 1)
    const out = await batchByIndex<{ id: string }>(Q, ids, { run: b.run })
    expect(b.calls).toHaveLength(2)
    expect(out.size).toBe(101)
  })

  it('de-duplicates ids so rows are not doubled', async () => {
    const f = fakeIndex(() => 2)
    const out = await batchByIndex<{ id: string }>(Q, ['x', 'x', 'y'], { run: f.run })
    expect(out.get('x')).toHaveLength(2)
    expect(f.calls[0].query.match(/listOrderByShipmentId\(/g)).toHaveLength(2)
  })

  it('pages a key with more rows than the alias limit to exhaustion instead of truncating', async () => {
    const f = fakeIndex((id) => (id === 'big' ? 120 : 1))
    const out = await batchByIndex<{ id: string }>(Q, ['big', 'small'], { run: f.run, perAliasLimit: 50 })
    expect(out.get('big')).toHaveLength(120)
    expect(new Set(out.get('big')!.map((r) => r.id)).size).toBe(120)
    expect(out.get('small')).toHaveLength(1)
  })

  it('maps a key with no rows to []', async () => {
    const f = fakeIndex(() => 0)
    expect((await batchByIndex(Q, ['none'], { run: f.run })).get('none')).toEqual([])
  })

  it('rejects the whole batch on a partial-error response', async () => {
    const run: GraphqlRunner = async () => { throw { data: { a0: { items: [] } }, errors: [{ message: 'boom' }] } }
    await expect(batchByIndex(Q, ['a', 'b'], { run })).rejects.toBeTruthy()
  })

  it('halves the chunk and retries when AppSync says the response is too large', async () => {
    const sizes: number[] = []
    const run: GraphqlRunner = async (query, variables) => {
      const n = Object.keys(variables).length
      sizes.push(n)
      if (n > 2) throw { errors: [{ message: 'Response size is too large' }] }
      const data: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) data[`a${i}`] = { items: [{ id: String(variables[`k${i}_0`]) }], nextToken: null }
      return data
    }
    const out = await batchByIndex<{ id: string }>(Q, ['a', 'b', 'c', 'd'], { run })
    expect([...out.values()].flat().map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(sizes[0]).toBe(4)
  })

  it('does not fan out on a schema validation error', async () => {
    const run = vi.fn<GraphqlRunner>().mockRejectedValue({ errors: [{ message: "Cannot query field 'listX' on type 'Query'" }] })
    await expect(batchByIndex(Q, Array.from({ length: 10 }, (_, i) => `i${i}`), { run })).rejects.toBeTruthy()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('declares an enum key with the type the caller names', async () => {
    const f = fakeIndex(() => 0)
    await batchByIndex({ ...Q, keyType: 'ShipmentStatus!' }, ['OPEN'], { run: f.run })
    expect(f.calls[0].query).toContain('$k0_0: ShipmentStatus!')
  })

  it('returns results independent of completion order', async () => {
    const run: GraphqlRunner = async (query, variables) => {
      const first = String(variables.k0_0)
      await new Promise((r) => setTimeout(r, first === 'a' ? 20 : 0))
      const data: Record<string, unknown> = {}
      const n = Object.keys(variables).length
      for (let i = 0; i < n; i++) data[`a${i}`] = { items: [{ id: String(variables[`k${i}_0`]) }], nextToken: null }
      return data
    }
    const out = await batchByIndex<{ id: string }>(Q, ['a', 'b', 'c'], { run, chunk: 1 })
    expect([...out.keys()]).toEqual(['a', 'b', 'c'])
    expect(out.get('a')![0].id).toBe('a')
  })
})

describe('batchByIndexPairs', () => {
  it('queries (hash, sort) pairs with an eq condition on the sort key', async () => {
    const run = vi.fn<GraphqlRunner>(async () => ({ a0: { items: [{ id: 'r' }], nextToken: null } }))
    const out = await batchByIndexPairs({ query: 'listAuditLogByEntityTypeAndEntityId', keyArg: 'entityType', keyType: 'String!', sortArg: 'entityId', sortType: 'String!', fields: 'id' },
      [{ key: 'Load', sort: 'l1' }, { key: 'Load', sort: 'l1' }], { run })
    expect(out).toEqual([{ id: 'r' }])
    expect(run.mock.calls[0][0]).toContain('entityType: $k0_0, entityId: { eq: $k0_1 }')
  })
})

describe('batchGet', () => {
  it('omits ids that do not exist', async () => {
    const run: GraphqlRunner = async (_q, v) => {
      const data: Record<string, unknown> = {}
      Object.keys(v).forEach((k, i) => { data[`a${i}`] = v[k] === 'gone' ? null : { id: v[k] } })
      return data
    }
    const out = await batchGet<{ id: string }>({ query: 'getShipment', fields: 'id' }, ['gone', 'here'], { run })
    expect([...out.keys()]).toEqual(['here'])
  })
})
