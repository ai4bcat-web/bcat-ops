import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, newestProdpreBackup, prodRehearsalCreate, prodRehearsalDrop, prodRehearsalPairs } from './cli'
import type { EngineTargetPolicy } from '../../../../src/types/tms'
import { makeFixture } from './testKit'
import { assertTargets, DEV_SUFFIX, productionPolicy, productionRehearsalPolicy, productionRehearsalTables, PROD_SUFFIX, tableSetFor, TargetRefused, WRITTEN_TABLES } from './tables'

const live = { target: 'LIVE' as const, targetTag: null, liveTag: 'GO-LIVE' }
const reh = (tag = 'abc') => ({ target: 'REHEARSAL' as const, targetTag: tag, liveTag: null })
const prod = tableSetFor(PROD_SUFFIX, PROD_SUFFIX)

describe('production rehearsal policy (copies of the production tables)', () => {
  it('writes exactly the -rh<tag> copies of the WRITTEN tables and reads every other production table', () => {
    const rh = productionRehearsalTables('abc')
    for (const t of WRITTEN_TABLES) expect(rh[t]).toBe(`${prod[t]}-rhabc`)
    expect(rh.aljexImportJob).toBe(prod.aljexImportJob)
    expect(rh.aljexMappingProfile).toBe(prod.aljexMappingProfile)
    expect(() => assertTargets(prod, rh, reh(), productionRehearsalPolicy('abc'))).not.toThrow()
  })

  it('refuses a LIVE job, another tag, and a job without a tag under the rehearsal policy', () => {
    const rh = productionRehearsalTables('abc')
    const p = productionRehearsalPolicy('abc')
    expect(() => assertTargets(prod, rh, live, p)).toThrow(/REHEARSAL jobs tagged abc/)
    expect(() => assertTargets(prod, rh, reh('xyz'), p)).toThrow(/REHEARSAL jobs tagged abc/)
    expect(() => assertTargets(prod, rh, { target: 'REHEARSAL', targetTag: null, liveTag: null }, p)).toThrow(TargetRefused)
  })

  it.each(WRITTEN_TABLES)('a REHEARSAL job can never write the live table for %s', (t) => {
    const rh = { ...productionRehearsalTables('abc'), [t]: prod[t] }
    expect(() => assertTargets(prod, rh, reh(), productionRehearsalPolicy('abc'))).toThrow(/must use/)
  })

  it('refuses a copy tagged differently from the policy, dev tables, and a mixed stack', () => {
    const p = productionRehearsalPolicy('abc')
    expect(() => assertTargets(prod, productionRehearsalTables('xyz'), reh(), p)).toThrow(/must use/)
    const dev = tableSetFor(DEV_SUFFIX, `${DEV_SUFFIX}-rhabc`)
    expect(() => assertTargets(dev, dev, reh(), p)).toThrow(/must use/)
    const mixed = { ...productionRehearsalTables('abc'), aljexMappingProfile: `AljexMappingProfile-${DEV_SUFFIX}` }
    expect(() => assertTargets(prod, mixed, reh(), p)).toThrow(/must use/)
  })

  it('rejects malformed tags and hand-built policies that widen it', () => {
    expect(() => productionRehearsalPolicy('A!')).toThrow(TargetRefused)
    const rh = productionRehearsalTables('abc')
    expect(() => assertTargets(prod, rh, reh(), { readSuffix: DEV_SUFFIX, writeSuffix: PROD_SUFFIX, production: true, rehearsalTag: 'abc' })).toThrow(/Malformed/)
    expect(() => assertTargets(prod, rh, reh(), { readSuffix: PROD_SUFFIX, writeSuffix: PROD_SUFFIX, production: true, rehearsalTag: 'a' })).toThrow(/Malformed/)
  })

  it('LIVE production policy is unchanged: exactly the production tables, LIVE jobs only', () => {
    const p = productionPolicy(PROD_SUFFIX)
    expect(p.rehearsalTag).toBeUndefined()
    expect(() => assertTargets(prod, prod, live, p)).not.toThrow()
    expect(() => assertTargets(prod, prod, reh(), p)).toThrow(/LIVE jobs only/)
    expect(() => assertTargets(prod, productionRehearsalTables('abc'), reh(), p)).toThrow(/must use/)
    expect(() => assertTargets(prod, productionRehearsalTables('abc'), live, p)).toThrow(/must use/)
    expect(() => assertTargets(prod, prod, live)).toThrow(/production table/)
    expect(() => assertTargets(prod, productionRehearsalTables('abc'), reh())).toThrow(/production table/)
  })
})

// ── a fake DynamoDB for the copy lifecycle ────────────────────────────────────────────────────

interface FakeBackup { table: string; name: string; at: string; status?: string; items: number }

function fakeDb(backups: FakeBackup[], opts: { existing?: string[]; restoredItems?: (table: string) => number } = {}) {
  const tables = new Set(opts.existing ?? [])
  const restored: string[] = []
  const deleted: string[] = []
  const counts = new Map<string, number>()
  const byArn = new Map(backups.map((b) => [`arn:${b.table}:${b.name}`, b]))
  const db = {
    restored,
    deleted,
    tables,
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
      const i = cmd.input
      switch (cmd.constructor.name) {
        case 'ListBackupsCommand':
          return {
            BackupSummaries: backups
              .filter((b) => b.table === i.TableName)
              .map((b) => ({ TableName: b.table, BackupName: b.name, BackupArn: `arn:${b.table}:${b.name}`, BackupStatus: b.status ?? 'AVAILABLE', BackupCreationDateTime: new Date(b.at) })),
          }
        case 'DescribeBackupCommand':
          return { BackupDescription: { SourceTableDetails: { ItemCount: byArn.get(i.BackupArn)!.items } } }
        case 'DescribeTableCommand':
          if (!tables.has(i.TableName)) throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' })
          return { Table: { TableStatus: 'ACTIVE' } }
        case 'RestoreTableFromBackupCommand': {
          tables.add(i.TargetTableName)
          restored.push(i.TargetTableName)
          const b = byArn.get(i.BackupArn)!
          counts.set(i.TargetTableName, opts.restoredItems ? opts.restoredItems(i.TargetTableName) : b.items)
          return {}
        }
        case 'ScanCommand':
          return { Count: counts.get(i.TableName) ?? 0 }
        case 'DeleteTableCommand':
          tables.delete(i.TableName)
          deleted.push(i.TableName)
          return {}
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`)
      }
    },
  }
  return db
}

const pairs = prodRehearsalPairs('abc')
const stock = (name = 'prodpre-importAljex-20261108T142330', at = '2026-11-08T14:23:30Z'): FakeBackup[] => pairs.map((p, n) => ({ table: p.source, name, at, items: 10 + n }))
const sink = () => {
  const lines: string[] = []
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) } }
}

describe('prodRehearsalCreate / prodRehearsalDrop', () => {
  it('lists every WRITTEN table once and only as <live>-rh<tag>', () => {
    expect(pairs).toHaveLength(WRITTEN_TABLES.length)
    for (const p of pairs) {
      expect(p.source.endsWith(PROD_SUFFIX)).toBe(true)
      expect(p.target).toBe(`${p.source}-rhabc`)
    }
  })

  it('picks the newest AVAILABLE prodpre-importAljex backup per table, ignoring other names and unfinished backups', async () => {
    const t = pairs[0].source
    const db = fakeDb([
      { table: t, name: 'prodpre-importAljex-old', at: '2026-11-08T10:00:00Z', items: 1 },
      { table: t, name: 'prodpre-importAljex-new', at: '2026-11-08T14:00:00Z', items: 2 },
      { table: t, name: 'prodpre-importAljex-newest-but-creating', at: '2026-11-08T15:00:00Z', status: 'CREATING', items: 3 },
      { table: t, name: 'prodpre-backfillCrm-newer', at: '2026-11-08T16:00:00Z', items: 4 },
      { table: t, name: 'aljex-rh-abc-Shipment', at: '2026-11-08T17:00:00Z', items: 5 },
    ])
    expect((await newestProdpreBackup(db as never, t))?.name).toBe('prodpre-importAljex-new')
    expect(await newestProdpreBackup(db as never, pairs[1].source)).toBeNull()
    expect((await newestProdpreBackup(db as never, t, 'prodpre-backfillCrm-'))?.name).toBe('prodpre-backfillCrm-newer')
  })

  it('dry run prints the backup per table and restores nothing', async () => {
    const db = fakeDb([...stock('prodpre-importAljex-A', '2026-11-08T13:00:00Z'), ...stock('prodpre-importAljex-B', '2026-11-08T14:23:30Z')])
    const { lines, io } = sink()
    await prodRehearsalCreate(db as never, 'abc', 'abc', { apply: false }, io)
    expect(db.restored).toEqual([])
    expect(lines.filter((l) => l.includes('prodpre-importAljex-B'))).toHaveLength(pairs.length)
    expect(lines.some((l) => l.includes('prodpre-importAljex-A'))).toBe(false)
    expect(lines.join('\n')).toMatch(/dry run/)
  })

  it('apply restores only new -rh siblings and verifies the item counts', async () => {
    const db = fakeDb(stock())
    const { lines, io } = sink()
    await prodRehearsalCreate(db as never, 'abc', 'abc', { apply: true }, io)
    expect(db.restored.sort()).toEqual(pairs.map((p) => p.target).sort())
    expect(db.restored.every((n) => n.endsWith('-rhabc') && n.includes(PROD_SUFFIX))).toBe(true)
    expect(lines[lines.length - 1]).toMatch(/ready: 17 tables, counts match/)
  })

  it('fails (copies left in place) when a copy has a different item count, unless explicitly accepted', async () => {
    const bad = pairs[2].target
    const mk = () => fakeDb(stock(), { restoredItems: (name) => (name === bad ? 999 : Number(stock().find((b) => `${b.table}-rhabc` === name)!.items)) })
    await expect(prodRehearsalCreate(mk() as never, 'abc', 'abc', { apply: true }, sink().io)).rejects.toThrow(/item counts differ.*999/)
    const { lines, io } = sink()
    await prodRehearsalCreate(mk() as never, 'abc', 'abc', { apply: true, acceptCountMismatch: true }, io)
    expect(lines[lines.length - 1]).toMatch(/ACCEPTED/)
  })

  it('refuses an existing target unless --reuse, and reuse restores only the missing ones', async () => {
    const existing = [pairs[0].target]
    await expect(prodRehearsalCreate(fakeDb(stock(), { existing }) as never, 'abc', 'abc', { apply: true }, sink().io)).rejects.toThrow(/already exist/)
    const db = fakeDb(stock(), { existing })
    // the reused copy is unscanned in the fake (0 items): accept the count, only the restore set matters here
    await prodRehearsalCreate(db as never, 'abc', 'abc', { apply: true, reuse: true, acceptCountMismatch: true }, sink().io)
    expect(db.restored).toHaveLength(pairs.length - 1)
    expect(db.restored).not.toContain(existing[0])
  })

  it('refuses before restoring anything when a table has no prodpre backup, and on a tag that differs from the target', async () => {
    const db = fakeDb(stock().slice(1))
    await expect(prodRehearsalCreate(db as never, 'abc', 'abc', { apply: true }, sink().io)).rejects.toThrow(/no AVAILABLE prodpre-importAljex-\* backup for: Shipment/)
    expect(db.restored).toEqual([])
    await expect(prodRehearsalCreate(fakeDb(stock()) as never, 'abc', 'xyz', { apply: true }, sink().io)).rejects.toThrow(/does not match/)
  })

  it('drop deletes only the -rh<tag> copies after --apply; never a live table', async () => {
    const copies = pairs.map((p) => p.target)
    const db = fakeDb([], { existing: [...copies, ...pairs.map((p) => p.source)] })
    await prodRehearsalDrop(db as never, 'abc', 'abc', { apply: false }, sink().io)
    expect(db.deleted).toEqual([])
    await prodRehearsalDrop(db as never, 'abc', 'abc', { apply: true }, sink().io)
    expect(db.deleted.sort()).toEqual([...copies].sort())
    expect(pairs.every((p) => db.tables.has(p.source))).toBe(true)
    await expect(prodRehearsalDrop(db as never, 'abc', 'xyz', { apply: true }, sink().io)).rejects.toThrow(/does not match/)
  })
})

describe('engine CLI under the production rehearsal policy', () => {
  const SRC = join(mkdtempSync(join(tmpdir(), 'aljex-prodrh-src-')), 'x.csv')
  writeFileSync(SRC, 'a,b\n')
  const run = async (argv: string[], p: EngineTargetPolicy) => {
    const { lines, io } = sink()
    const code = await main(argv, io, { prod: p })
    return { code, text: lines.join('\n') }
  }

  it('runs a REHEARSAL job end to end against the copies (memory), naming where the job rows live', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aljex-prodrh-')), 'synthetic.csv')
    writeFileSync(file, makeFixture({ rows: 60, seed: 7 }).csv)
    const r = await run(['run', '--memory', '--synthetic', '--source', file, '--target', 'rehearsal:abc'], productionRehearsalPolicy('abc'))
    expect(r.code).toBe(0)
    expect(r.text).toMatch(/PRODUCTION REHEARSAL abc: writes ONLY the -rhabc copies/)
    expect(r.text).toMatch(/NOT in the production AljexImportJob table/)
    expect(r.text).toMatch(/reconciled YES/)
  })

  it('refuses live targets, another tag, and every command outside run/resume/rehearsal-create/-drop', async () => {
    const p = productionRehearsalPolicy('abc')
    expect((await run(['run', '--memory', '--source', SRC, '--target', 'live:GO'], p)).code).toBe(1)
    expect((await run(['run', '--memory', '--source', SRC, '--target', 'rehearsal:xyz'], p)).text).toMatch(/rehearsal:abc jobs only/)
    for (const cmd of ['seed-counter', 'rollback', 'pitr-restore', 'file', 'stage', 'reconcile-entity', 'backup-create', 'drop-copy']) {
      expect((await run([cmd, '--tag', 'abc'], p)).text).toMatch(/run \| resume \| rehearsal-create \| rehearsal-drop only/)
    }
  })

  it('the LIVE production policy still refuses rehearsal commands and targets', async () => {
    const p = productionPolicy(PROD_SUFFIX)
    expect((await run(['rehearsal-create', '--tag', 'abc'], p)).text).toMatch(/dev tooling/)
    expect((await run(['rehearsal-drop', '--tag', 'abc'], p)).text).toMatch(/dev tooling/)
    expect((await run(['run', '--memory', '--source', SRC, '--target', 'rehearsal:abc'], p)).text).toMatch(/LIVE|live/)
  })
})
