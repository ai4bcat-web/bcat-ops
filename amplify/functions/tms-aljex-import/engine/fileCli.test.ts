/**
 * The offline per-file import commands (`file`, `stage`, `reconcile-entity` in engine/cli.ts): the replacement for the Lambda's
 * production-refusing file actions. In-memory tables with the production policy stand in for DynamoDB.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arCsv } from '../../../../src/lib/aljex/layouts/arReportFixture'
import { CUSTOMER_COLUMNS } from '../../../../src/lib/aljex/layouts/customers'
import { csvOf } from '../../../../src/lib/aljex/layouts/apFilesFixture'
import { main, prepareUpload } from './cli'
import { DEV_SUFFIX, PROD_SUFFIX, productionPolicy } from './tables'

const dir = mkdtempSync(join(tmpdir(), 'aljex-filecli-'))
const run = async (argv: string[], ctx = {}) => {
  const lines: string[] = []
  const code = await main(argv, { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) }, ctx)
  return { code, text: lines.join('\n') }
}

describe('offline file imports', () => {
  it('strips the refused columns before anything is read (Web Password never reaches the engine)', () => {
    const headers = [...Object.values(CUSTOMER_COLUMNS), 'Web Password']
    const csv = csvOf([headers, headers.map((h) => (h === 'Web Password' ? 'CANARY-SECRET' : 'x'))])
    const out = prepareUpload('CUSTOMERS_MASTER', csv)
    expect(out.dropped).toEqual(['Web Password'])
    expect(out.csv).not.toMatch(/CANARY-SECRET|Web Password/)
    expect(() => prepareUpload('AR_REPORT', csv)).toThrow(/not an? /i)
  })

  it('a dry run over production-shaped tables prints the plan and writes nothing; apply writes through the guarded store', async () => {
    const file = join(dir, 'ar.csv')
    writeFileSync(file, arCsv())
    const args = ['file', '--kind', 'ar', '--file', file, '--cutoff', '2026-11-07', '--memory', '--target', 'live:plan']
    const dry = await run(args, { prod: productionPolicy(PROD_SUFFIX) })
    expect(dry.code).toBe(0)
    expect(dry.text).toMatch(/== ar dry run \(PLAN\) job aljexrun:\S+ PLANNED/)
    expect(dry.text).toMatch(/Dry run only: nothing was written/)
    expect(dry.text).not.toMatch(/ apply \(APPLY\)/)
    const applied = await run([...args.slice(0, -1), 'live:AW-TEST', '--apply'], { prod: productionPolicy(DEV_SUFFIX) })
    expect(applied.code).toBe(0)
    expect(applied.text).toMatch(/== ar apply \(APPLY\) job aljexrun:\S+ APPLIED/)
  })

  it('refuses a production policy that is not exactly the production or rehearsal-seam suffix', () => {
    expect(() => productionPolicy('zzzzzzzzzzzzzzzzzzzz-NONE')).toThrow(/never/)
  })

  it('refuses an apply without a live tag target and a file of the wrong kind', async () => {
    const file = join(dir, 'ar2.csv')
    writeFileSync(file, arCsv())
    const wrongKind = await run(['file', '--kind', 'customers', '--file', file, '--cutoff', '2026-11-07', '--memory', '--target', 'live:plan'], { prod: productionPolicy(DEV_SUFFIX) })
    expect(wrongKind.code).toBe(1)
    expect(wrongKind.text).toMatch(/is not a Customer list/)
    const badCutoff = await run(['file', '--kind', 'ar', '--file', file, '--cutoff', 'yesterday', '--memory', '--target', 'live:plan'], {})
    expect(badCutoff.code).toBe(1)
  })
})
