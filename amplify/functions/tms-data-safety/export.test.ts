import { describe, expect, it } from 'vitest'
import { FakeAws } from './fakeAws'
import {
  checkS3Exports, createJob, createS3ExportJob, getJob, listModels, newAccountingJob, newCsvJob, resolveTables,
  runAccountingJob, runCsvJob, runS3Export, type Row,
} from './export'
import { sha256Hex } from './csv'

// Synthetic data only.
function seedLedger(aws: FakeAws): void {
  aws.seed('Customer', [
    { id: 'c1', name: 'Synthetic, "Quoted" Freight', notes: 'line1\nline2', rating: 4, active: true, billTo: [{ id: 'b1' }] },
    { id: 'c2', name: 'Plain Co', extra: { deep: 1 } },
    { id: 'c3', name: '=NOT_A_FORMULA_HERE' },
  ])
  aws.seed('Invoice', [])
  aws.seed('ArPayment', [])
  aws.seed('CarrierBill', [])
  aws.seed('ApPayment', [])
  aws.seed('Carrier', [])
  aws.seed('Shipment', [])
  aws.seed('Load', [])
}

describe('table scope', () => {
  it('lists only this stack’s tables (other stacks and rehearsal copies never match)', async () => {
    const aws = new FakeAws()
    seedLedger(aws)
    expect((await listModels(aws.deps())).sort()).toEqual(['ApPayment', 'ArPayment', 'Carrier', 'CarrierBill', 'Customer', 'Invoice', 'Load', 'Shipment'])
  })

  it('narrows to TMS, honours the denylist and refuses tables outside the scope', () => {
    const models = ['Shipment', 'CommissionRule', 'Driver', 'Integration', 'Customer']
    expect(resolveTables(models, 'TMS')).toEqual(['Shipment', 'CommissionRule', 'Customer'])
    expect(resolveTables(models, 'ALL', { denylist: ['Integration'] })).toEqual(['Shipment', 'CommissionRule', 'Driver', 'Customer'])
    expect(resolveTables(models, 'ALL', { denylist: ['Integration'], requested: ['Driver'] })).toEqual(['Driver'])
    expect(() => resolveTables(models, 'TMS', { requested: ['Driver'] })).toThrow(/not available/)
    expect(() => resolveTables(models, 'ALL', { denylist: ['Integration'], requested: ['Integration'] })).toThrow(/not available/)
  })
})

describe('CSV export job', () => {
  it('dumps every row faithfully, with a manifest whose hashes match the files', async () => {
    const aws = new FakeAws()
    seedLedger(aws)
    const deps = aws.deps()
    const job = newCsvJob(deps, { id: 'csv-1', scope: 'TMS', tables: ['Customer'], startedBy: 'o@x.test' })
    await createJob(deps, job)
    const done = await runCsvJob(deps, 'csv-1', 900_000)
    expect(done?.status).toBe('COMPLETED')

    const file = aws.objects.get('exports/csv/csv-1/raw/Customer/Customer-0001.csv')!
    const lines = file.split('\r\n')
    // id first, then every attribute seen anywhere in the table, alphabetical
    expect(lines[0]).toBe('id,active,billTo,extra,name,notes,rating')
    expect(lines).toContain('c1,true,"[{""id"":""b1""}]",,"Synthetic, ""Quoted"" Freight","line1\nline2",4')
    expect(lines).toContain('c2,,,"{""deep"":1}",Plain Co,,')
    // raw dumps are never rewritten, even when a value looks like a formula
    expect(lines).toContain('c3,,,,=NOT_A_FORMULA_HERE,,')

    const manifest = JSON.parse(aws.objects.get('exports/csv/csv-1/manifest.json')!)
    const entry = manifest.files.find((f: Row) => f.table === 'Customer')
    expect(entry).toMatchObject({ rows: 3, bytes: Buffer.byteLength(file), sha256: sha256Hex(file), pii: true })
    expect(manifest.piiTables).toContain('Customer')
    expect(manifest.files.map((f: Row) => f.table)).toEqual(
      expect.arrayContaining(['accounting/invoices.csv', 'accounting/ar-payments.csv', 'accounting/carrier-bills.csv', 'accounting/ap-payments.csv']),
    )
    // accounting files exist even for empty ledgers, header only
    expect(aws.objects.get('exports/csv/csv-1/accounting/invoices.csv')!.startsWith('\uFEFFinvoice_number,')).toBe(true)
  })

  it('resumes across invocations without losing or duplicating a row', async () => {
    const aws = new FakeAws()
    seedLedger(aws)
    const many = Array.from({ length: 23 }, (_, i) => ({ id: `r${String(i).padStart(3, '0')}`, n: i, ...(i === 17 ? { late: 'x' } : {}) }))
    aws.seed('Quote', many)
    const deps = aws.deps({ pageLimit: 2 })
    await createJob(deps, newCsvJob(deps, { id: 'csv-2', scope: 'TMS', tables: ['Quote'], startedBy: 'o@x.test' }))

    // No time budget at all: every invocation advances one scan round, then hands over.
    let invocations = 0
    for (let guard = 0; guard < 200; guard++) {
      invocations++
      const job = await runCsvJob(deps, 'csv-2', 0)
      if (job?.status !== 'RUNNING') break
    }
    const job = (await getJob(deps, 'csv-2'))!
    expect(job.status).toBe('COMPLETED')
    expect(invocations).toBeGreaterThan(3)
    expect(aws.invokes.filter((p) => p.kind === 'CSV_CONTINUE' && p.jobId === 'csv-2').length).toBe(invocations - 1)

    const quote = job.tables.find((t) => t.table === 'Quote')!
    expect(quote.status).toBe('COMPLETED')
    expect(quote.rows).toBe(23)
    const ids: string[] = []
    for (const part of quote.parts!) {
      const lines = aws.objects.get(part.key)!.split('\r\n').filter(Boolean)
      // every part carries the full header, including the attribute only row 17 has
      expect(lines[0]).toBe('id,late,n')
      ids.push(...lines.slice(1).map((l) => l.split(',')[0]))
    }
    expect(ids.sort()).toEqual(many.map((r) => r.id))
  })

  it('marks a failing table FAILED, keeps the rest, and ends PARTIAL', async () => {
    const aws = new FakeAws()
    seedLedger(aws)
    const deps = aws.deps()
    const broken = { ...aws.db, send: async (cmd: { constructor: { name: string }; input: Row }) => {
      if (cmd.constructor.name === 'ScanCommand' && String(cmd.input.TableName).startsWith('Quote-')) throw new Error('throttled hard')
      return aws.db.send(cmd)
    } }
    const d2 = { ...deps, db: broken as unknown as typeof deps.db }
    aws.seed('Quote', [{ id: 'q1' }])
    await createJob(d2, newCsvJob(d2, { id: 'csv-3', scope: 'TMS', tables: ['Customer', 'Quote'], startedBy: 'o@x.test' }))
    const job = await runCsvJob(d2, 'csv-3', 900_000)
    expect(job?.status).toBe('PARTIAL')
    expect(job?.tables.find((t) => t.table === 'Quote')).toMatchObject({ status: 'FAILED', error: 'throttled hard' })
    expect(job?.tables.find((t) => t.table === 'Customer')?.status).toBe('COMPLETED')
    expect(job?.error).toContain('Quote')
  })

  it('writes the accounting files alone, honouring the filter', async () => {
    const aws = new FakeAws()
    seedLedger(aws)
    aws.seed('Invoice', [
      { id: '1', number: '1', orderId: 'o', shipmentId: 's', customerId: 'c1', invoiceDate: '2026-01-05', dueAt: '2026-02-04', termsDays: 30, totalCents: 100, paidCents: 0, writtenOffCents: 0, balanceCents: 100, status: 'ISSUED', createdBy: 'u' },
      { id: '2', number: '2', orderId: 'o', shipmentId: 's', customerId: 'c1', invoiceDate: '2026-03-05', dueAt: '2026-04-04', termsDays: 30, totalCents: 200, paidCents: 0, writtenOffCents: 0, balanceCents: 200, status: 'ISSUED', createdBy: 'u' },
    ])
    const deps = aws.deps()
    await createJob(deps, newAccountingJob(deps, 'acct-1', 'o@x.test', { from: '2026-03-01' }))
    const job = await runAccountingJob(deps, 'acct-1')
    expect(job?.status).toBe('COMPLETED')
    const csv = aws.objects.get('exports/csv/acct-1/accounting/invoices.csv')!.split('\r\n').filter(Boolean)
    expect(csv).toHaveLength(2)
    expect(csv[1].startsWith('2,')).toBe(true)
    expect(csv[1]).toContain('"Synthetic, ""Quoted"" Freight"')
  })
})

describe('S3 point-in-time exports', () => {
  it('exports PITR tables, records skips, and settles on the check', async () => {
    const aws = new FakeAws()
    aws.seed('Shipment', [], true)
    aws.seed('Customer', [], true)
    aws.seed('Invoice', [], false)
    aws.seed('Driver', [], true)
    const deps = aws.deps()
    const created = await createS3ExportJob(deps, { id: 'nightly-2026-11-02', kind: 'NIGHTLY', scope: 'TMS', prefix: 'exports/nightly/2026-11-02/', startedBy: 'system:nightly' })
    expect(created?.tables.map((t) => t.table)).toEqual(['Customer', 'Invoice', 'Shipment'])
    const started = await runS3Export(deps, 'nightly-2026-11-02')
    expect(started?.status).toBe('RUNNING')
    expect(started?.tables.find((t) => t.table === 'Invoice')?.status).toBe('SKIPPED_NO_PITR')
    expect(aws.exportCalls.map((c) => c.S3Prefix).sort()).toEqual(['exports/nightly/2026-11-02/Customer/', 'exports/nightly/2026-11-02/Shipment/'])
    for (const c of aws.exportCalls) {
      expect(c).toMatchObject({ S3Bucket: 'bucket', ExportFormat: 'DYNAMODB_JSON' })
      expect(String(c.ClientToken).length).toBeLessThanOrEqual(36)
    }

    aws.exportStatus.set('arn:aws:dynamodb:us-east-1:111:table/Customer-api1-NONE/export/1', 'COMPLETED')
    aws.exportStatus.set('arn:aws:dynamodb:us-east-1:111:table/Shipment-api1-NONE/export/1', 'FAILED')
    await checkS3Exports(deps)
    const job = (await getJob(deps, 'nightly-2026-11-02'))!
    expect(job.status).toBe('PARTIAL')
    expect(job.tables.find((t) => t.table === 'Shipment')).toMatchObject({ status: 'FAILED', error: 'boom' })
    expect(job.tables.find((t) => t.table === 'Customer')?.status).toBe('COMPLETED')
    expect(job.finishedAt).toBeTruthy()
  })

  it('refuses to start the same nightly twice', async () => {
    const aws = new FakeAws()
    aws.seed('Shipment', [], true)
    const deps = aws.deps()
    const start = { id: 'nightly-2026-11-02', kind: 'NIGHTLY' as const, scope: 'TMS' as const, prefix: 'p/', startedBy: 's' }
    expect(await createS3ExportJob(deps, start)).not.toBeNull()
    expect(await createS3ExportJob(deps, start)).toBeNull()
  })
})
