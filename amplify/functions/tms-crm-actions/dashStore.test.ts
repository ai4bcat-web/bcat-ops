import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { describe, expect, it } from 'vitest'
import type { Db, Row } from '../_shared/crmStore'
import type { DashboardSpec } from '../../../src/lib/dashboards/types'
import { CONFLICT_ERROR, DASH_INDEX_ID, dashStore, type StoredDashboard } from './dashStore'

/** A two-command stand-in: Get and TransactWrite (Put + ConditionExpression) over one table. */
function fakeDb(): { db: Db; rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const canceled = () => Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' })
  const db = {
    async send(cmd: unknown) {
      if (cmd instanceof GetCommand) return { Item: rows.get(String((cmd.input.Key as Row).id)) }
      if (cmd instanceof TransactWriteCommand) {
        const puts = (cmd.input.TransactItems ?? []).map((t) => t.Put!)
        for (const p of puts) {
          const cur = rows.get(String((p.Item as Row).id))
          const cond = p.ConditionExpression
          if (cond === 'attribute_not_exists(id)' && cur) throw canceled()
          if (cond === 'version = :v' && cur?.version !== (p.ExpressionAttributeValues as Row)[':v']) throw canceled()
        }
        for (const p of puts) rows.set(String((p.Item as Row).id), structuredClone(p.Item as Row))
        return {}
      }
      throw new Error('unsupported command')
    },
  } as unknown as Db
  return { db, rows }
}

const spec: DashboardSpec = {
  v: 1, title: 'T', scope: { kind: 'ME' },
  filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: [], repIds: [], modes: [] },
  widgets: [{ id: 'w1', type: 'KPI', title: 'R', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue'] } } }],
}
const rec = (id: string, over: Partial<StoredDashboard> = {}): StoredDashboard => ({
  id, title: id, scope: 'ME', ownerId: 'o', ownerName: null, sharedWith: { userIds: [], teamKeys: [] }, spec, specVersion: 1,
  widgetCount: 1, createdBy: 'o', updatedBy: 'o', archivedAt: null, version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...over,
})

describe('dashStore over DashboardRollup rows', () => {
  it('writes DASH:<id> rows plus one index row, and reads them back', async () => {
    const { db, rows } = fakeDb()
    const store = dashStore(db, 'T')
    await store.commit(rec('a'), null)
    await store.commit(rec('b', { title: 'B' }), null)
    expect([...rows.keys()].sort()).toEqual([DASH_INDEX_ID, 'DASH:a', 'DASH:b'])
    expect(rows.get('DASH:a')).toMatchObject({ kind: 'DASH', periodKey: 'a', __typename: 'DashboardRollup' })
    expect(typeof rows.get('DASH:a')!.payload).toBe('string')
    expect((await store.index()).map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(await store.get('a')).toMatchObject({ id: 'a', version: 1, spec: { title: 'T' } })
    expect(await store.get('zzz')).toBeNull()
  })

  it('rejects a duplicate create and a stale expected version; archive drops the index entry but keeps the row', async () => {
    const { db, rows } = fakeDb()
    const store = dashStore(db, 'T')
    await store.commit(rec('a'), null)
    await expect(store.commit(rec('a'), null)).rejects.toThrow(CONFLICT_ERROR)
    await expect(store.commit(rec('a', { version: 2 }), 7)).rejects.toThrow(CONFLICT_ERROR)
    await store.commit(rec('a', { version: 2, archivedAt: '2026-11-02T00:00:00Z' }), 1)
    expect(await store.index()).toEqual([])
    expect(rows.has('DASH:a')).toBe(true)
    expect((await store.get('a'))?.archivedAt).toBe('2026-11-02T00:00:00Z')
  })
})
