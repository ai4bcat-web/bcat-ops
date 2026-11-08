import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { authorize } from './authorize'
import { FakeAws } from './fakeAws'
import { dispatch, type AppSyncEvent } from './handler'
import type { Row } from './export'

// Synthetic data only.
const OWNER = { sub: 's1', username: 'ryne@bcatcorp.com', claims: { email: 'ryne@bcatcorp.com' } }
const STAFF = { sub: 's2', username: 'rep@bcatcorp.com', claims: { email: 'rep@bcatcorp.com', 'cognito:groups': ['USER'] } }
const ADMIN = { sub: 's3', username: 'adm@bcatcorp.com', claims: { email: 'adm@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
const ctx = { getRemainingTimeInMillis: () => 900_000 }
const noLookup = async (): Promise<string> => ''

function call(aws: FakeAws, action: string, input: Row, identity = OWNER): Promise<Row> {
  const event: AppSyncEvent = { arguments: { action, input }, identity }
  return dispatch(event, ctx, aws.deps(), (id) => authorize(id, noLookup))
}

/** Non-nullable (`.required()`) fields of an Amplify model, read from the schema source. */
function requiredFields(model: string): string[] {
  const src = readFileSync(resolve(__dirname, '../../data/resource.ts'), 'utf8')
  const start = src.search(new RegExp(`^  ${model}: a\\s*$`, 'm'))
  if (start < 0) throw new Error(`model ${model} not found`)
  const body = src.slice(start, src.indexOf('})', start))
  const names = [...body.matchAll(/^\s+(\w+):\s+a\.[^\n]*\.required\(\)/gm)].map((m) => m[1])
  return names
}

function seed(aws: FakeAws): void {
  aws.seed('Shipment', [], true)
  aws.seed('Customer', [{ id: 'c1', name: 'Synthetic Co' }], true)
  aws.seed('Driver', [{ id: 'd1' }], true)
  aws.seed('Integration', [{ id: 'i1', secret: 'x' }], true)
  aws.seed('AuditLog', [], true)
  aws.seed('DataExportJob', [], true)
}

describe('authorization and routing', () => {
  it('lets only the owner or an ADMIN through', async () => {
    const aws = new FakeAws()
    seed(aws)
    await expect(call(aws, 'EXPORT_LIST', {}, STAFF)).rejects.toThrow(/Forbidden/)
    await expect(call(aws, 'EXPORT_LIST', {}, null as never)).rejects.toThrow(/Unauthorized/)
    await expect(call(aws, 'EXPORT_LIST', {}, OWNER)).resolves.toEqual({ jobs: [] })
    await expect(call(aws, 'EXPORT_LIST', {}, ADMIN)).resolves.toEqual({ jobs: [] })
  })

  it('treats an event with arguments as AppSync even when it carries a kind', async () => {
    const aws = new FakeAws()
    seed(aws)
    const sneaky = { kind: 'NIGHTLY', arguments: { action: 'EXPORT_LIST' }, identity: STAFF } as unknown as AppSyncEvent
    await expect(dispatch(sneaky, ctx, aws.deps(), (id) => authorize(id, noLookup))).rejects.toThrow(/Forbidden/)
    expect(aws.exportCalls).toEqual([])
  })

  it('rejects unknown actions and kinds', async () => {
    const aws = new FakeAws()
    seed(aws)
    await expect(call(aws, 'DROP_TABLES', {})).rejects.toThrow(/Unknown action/)
    await expect(dispatch({ kind: 'WIPE' }, ctx, aws.deps())).rejects.toThrow(/Unknown kind/)
  })
})

describe('nightly', () => {
  it('exports the TMS tables on a weekday and everything on Sunday, once per day', async () => {
    const aws = new FakeAws()
    seed(aws)
    const deps = aws.deps()
    aws.ms = Date.parse('2026-11-02T07:15:00Z') // Monday
    const mon = await dispatch({ kind: 'NIGHTLY' }, ctx, deps)
    expect(mon).toMatchObject({ jobId: 'nightly-2026-11-02', scope: 'TMS' })
    expect(aws.exportCalls.map((c) => String(c.TableArn).split('/')[1].split('-')[0]).sort()).toEqual(['AuditLog', 'Customer', 'Shipment'])
    expect(await dispatch({ kind: 'NIGHTLY' }, ctx, deps)).toMatchObject({ skipped: true })

    aws.exportCalls.length = 0
    aws.ms = Date.parse('2026-11-01T07:15:00Z') // Sunday
    const sun = await dispatch({ kind: 'NIGHTLY' }, ctx, deps)
    expect(sun).toMatchObject({ scope: 'ALL' })
    const exported = aws.exportCalls.map((c) => String(c.TableArn).split('/')[1].split('-')[0])
    expect(exported).toEqual(expect.arrayContaining(['Driver', 'Customer', 'Integration']))
  })

  it('reports the latest nightly and PITR coverage in the status', async () => {
    const aws = new FakeAws()
    seed(aws)
    aws.seed('Invoice', [], false)
    await dispatch({ kind: 'NIGHTLY' }, ctx, aws.deps())
    const status = await call(aws, 'DATA_STATUS', {})
    expect(status).toMatchObject({
      bucketName: 'bucket',
      pitrDisabled: ['Invoice'],
      earliestRestorableTime: '2026-11-01T00:00:00.000Z',
    })
    expect((status.latestNightly as Row).id).toBe('nightly-2026-11-02')
    expect(status.s3SyncCommand).toContain('s3://bucket/')
  })
})

describe('CSV export actions', () => {
  const start = (aws: FakeAws, input: Row): Promise<Row> => call(aws, 'CSV_EXPORT_START', input)

  it('requires the PII acknowledgement and the typed phrase for ALL', async () => {
    const aws = new FakeAws()
    seed(aws)
    await expect(start(aws, { scope: 'TMS', acknowledgePii: false })).rejects.toThrow(/personal data/)
    await expect(start(aws, { scope: 'ALL', acknowledgePii: true })).rejects.toThrow(/EXPORT ALL/)
    await expect(start(aws, { scope: 'ALL', acknowledgePii: true, confirmText: 'export all' })).rejects.toThrow(/EXPORT ALL/)
    expect(aws.invokes).toEqual([])
  })

  it('never exports the denylisted table, even when asked by name', async () => {
    const aws = new FakeAws()
    seed(aws)
    await expect(start(aws, { scope: 'ALL', acknowledgePii: true, confirmText: 'EXPORT ALL', tables: ['Integration'] })).rejects.toThrow(/not available/)
    const res = await start(aws, { scope: 'ALL', acknowledgePii: true, confirmText: 'EXPORT ALL' })
    const tables = ((res.job as Row).tables as { table: string }[]).map((t) => t.table)
    expect(tables).not.toContain('Integration')
    expect(tables).toContain('Driver')
  })

  it('runs end to end: start, one running job at a time, status, audited links', async () => {
    const aws = new FakeAws()
    seed(aws)
    const deps = aws.deps()
    const started = await start(aws, { scope: 'TMS', acknowledgePii: true, tables: ['Customer'] })
    const jobId = (started.job as Row).id as string
    expect(aws.invokes).toEqual([{ kind: 'CSV_CONTINUE', jobId }])
    await expect(start(aws, { scope: 'TMS', acknowledgePii: true })).rejects.toThrow(/already running/)

    // the self-invoke
    await dispatch({ kind: 'CSV_CONTINUE', jobId }, ctx, deps)
    const status = (await call(aws, 'CSV_EXPORT_STATUS', { jobId })).job as Row
    expect(status.status).toBe('COMPLETED')
    expect(JSON.stringify(status)).not.toContain('sha256')

    const links = await call(aws, 'CSV_EXPORT_LINKS', { jobId })
    expect(links).toMatchObject({ jobId, expiresInSeconds: 900 })
    const files = links.files as { name: string; url: string; pii: boolean }[]
    expect(files.map((f) => f.name)).toContain('raw/Customer/Customer-0001.csv')
    expect(files.every((f) => f.url.includes('ttl=900'))).toBe(true)
    expect(links.manifestUrl).toContain('manifest.json')
    expect(JSON.stringify(aws.rows('DataExportJob'))).not.toContain('https://signed')

    const actions = aws.rows('AuditLog').map((r) => r.action)
    expect(actions).toEqual(['CSV_EXPORT_START', 'CSV_EXPORT_LINKS'])
    const audit = JSON.parse(aws.rows('AuditLog')[1].changes as string)
    expect(audit).toMatchObject({ scope: 'TMS', includesPii: true, fileCount: files.length })
  })

  it('re-kicks a running job whose worker went quiet, once', async () => {
    const aws = new FakeAws()
    seed(aws)
    const started = await start(aws, { scope: 'TMS', acknowledgePii: true, tables: ['Customer'] })
    const jobId = (started.job as Row).id as string
    aws.invokes.length = 0
    await call(aws, 'CSV_EXPORT_STATUS', { jobId })
    expect(aws.invokes).toEqual([])
    aws.ms += 4 * 60_000
    await call(aws, 'CSV_EXPORT_STATUS', { jobId })
    await call(aws, 'CSV_EXPORT_STATUS', { jobId })
    expect(aws.invokes).toEqual([{ kind: 'CSV_CONTINUE', jobId }])
  })

  it('validates accounting dates', async () => {
    const aws = new FakeAws()
    seed(aws)
    await expect(call(aws, 'ACCOUNTING_EXPORT', { from: '03/01/2026' })).rejects.toThrow(/YYYY-MM-DD/)
    const res = await call(aws, 'ACCOUNTING_EXPORT', { from: '2026-03-01' })
    expect((res.job as Row).kind).toBe('ACCOUNTING')
  })
})

describe('rows this Lambda writes carry every required field', () => {
  it('writes AuditLog and DataExportJob rows that satisfy the schema', async () => {
    const aws = new FakeAws()
    seed(aws)
    const started = await call(aws, 'CSV_EXPORT_START', { scope: 'TMS', acknowledgePii: true, tables: ['Customer'] })
    await call(aws, 'EXPORT_NOW', { scope: 'TMS' })
    await dispatch({ kind: 'NIGHTLY' }, ctx, aws.deps())
    await call(aws, 'CSV_EXPORT_LINKS', { jobId: (started.job as Row).id })

    for (const model of ['AuditLog', 'DataExportJob']) {
      const required = ['id', 'createdAt', 'updatedAt', ...requiredFields(model)]
      const rows = aws.rows(model)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        for (const field of required) {
          expect(row[field], `${model}.${field}`).not.toBeUndefined()
          expect(row[field], `${model}.${field}`).not.toBeNull()
        }
        expect(row.__typename).toBe(model)
      }
    }
    expect(requiredFields('AuditLog')).toEqual(['entityType', 'entityId', 'action', 'user', 'changes'])
  })
})
