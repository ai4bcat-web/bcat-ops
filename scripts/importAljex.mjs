#!/usr/bin/env node
/**
 * Offline Aljex import driver: the same engine the Lambda worker runs, from a laptop with AWS credentials.
 * Dev stack by default; BCAT_STACK=rehearsal aims every non-prod command at the rehearsal branch's tables instead
 * (scripts/lib/stackConfig.mjs; rehearsal-create / run / seed-counter / rehearsal-drop all follow it). The engine refuses production table names. PRODUCTION only through `--target prod:<liveTag>`
 * behind the shared gate (scripts/lib/prodGate.mjs): env BCAT_ALLOW_PROD=<today YYYY-MM-DD>, --i-mean-production,
 * fresh `prodpre-importAljex-` on-demand backups of the 17 written tables (scripts/prodBackup.mjs), a printed plan,
 * a dry run unless --apply, and the typed confirmation <account id>:<table suffix> (prompt or --confirm-prod).
 * Real exports stay outside the repo; this script never copies one into it and prints aggregates only.
 *
 *   node scripts/importAljex.mjs rehearsal-create --tag rh1103          # on-demand backup + restore to <Table>-<devSuffix>-rh1103
 *   node scripts/importAljex.mjs run --source <csv> --slice every:8 --target rehearsal:rh1103 [--synthetic] [--no-apply]
 *   node scripts/importAljex.mjs run --source <csv> --target live:<liveTag>   # real data needs a reconciled rehearsal first
 *   node scripts/importAljex.mjs resume --run <jobId> --target rehearsal:rh1103
 *   node scripts/importAljex.mjs seed-counter --target rehearsal:rh1103 [--apply] [--enable-numeric]
 *   node scripts/importAljex.mjs rehearsal-drop --tag rh1103            # deletes only tables ending -rh<tag> and the tag's backups
 *   node scripts/importAljex.mjs backup-create|backup-restore --tag rh1103
 *   node scripts/importAljex.mjs pitr-restore --table Shipment --time 2026-11-03T12:00:00Z --as Shipment-<devSuffix>-rhNNN
 *   node scripts/importAljex.mjs rollback --run <applyJobId> --target ... --i-understand-dev-only [--apply]   # dev-only delete rollback
 *
 * Per-file imports (Step AW; the same gate in production; dry run unless --apply, which needs --target live|prod:<tag>):
 *   node scripts/importAljex.mjs file --kind customers|carriers|ap|ar|active-check --file <csv> [--aging-file <csv> --expected-file <csv>] --cutoff YYYY-MM-DD --target live:<tag> [--apply]
 *   node scripts/importAljex.mjs stage --source <big export csv> --target live:<tag>              # local STAGE only, nothing leaves the machine
 *   node scripts/importAljex.mjs reconcile-entity --entity CUSTOMERS|CARRIERS|AP|AR|SHIPMENTS --source-job <id> [--customers-job <id>] --cutoff D --target live:<tag> [--apply --bucket <b>]
 *
 * Production (plan = stage + plan, writes nothing; --apply writes):
 *   BCAT_ALLOW_PROD=$(date +%F) node scripts/importAljex.mjs run --source <csv> --target prod:<liveTag> --i-mean-production [--apply]
 *   ... resume --run <jobId> --target prod:<liveTag> --i-mean-production --apply
 *   ... seed-counter --target prod:<liveTag> --i-mean-production [--apply] [--enable-numeric]
 *   ... rollback --run <applyJobId> --target prod:<liveTag> --i-mean-production [--apply]
 *   ... pitr-restore --table Shipment --time <iso> --as Shipment-<prodSuffix>-rhNNN --target prod --i-mean-production --apply
 *   Test-only rehearsal seam: add --prod-mode-rehearsal-suffix=<dev suffix | dev suffix-rhTAG> to run the same gated path on dev tables.
 *   add --memory to any run against an in-memory table set (no AWS): smoke tests with a synthetic file.
 *
 * `--slice every:N` keeps data rows 1, N+1, 2N+1, ... (1-based, header excluded); the profiler's slice
 * selector must use the same rule so expected values are computed on the same rows.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { splitProdArgs } from './lib/importAljexArgs.mjs'
import { requireProd } from './lib/prodGate.mjs'
import { STACK, isRehearsal } from './lib/stackConfig.mjs'
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const entry = join(root, 'amplify/functions/tms-aljex-import/engine/cli.ts')

/** Bundle the engine (TypeScript) next to node_modules so the externalised AWS SDK resolves. */
async function bundle() {
  const engineDir = dirname(entry)
  const stamp = createHash('sha1')
  for (const dir of [engineDir, dirname(engineDir), join(root, 'src/lib'), join(root, 'src/lib/aljex'), join(root, 'src/lib/aljex/layouts'), join(root, 'amplify/functions/_shared')]) {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f)
      if (statSync(p).isFile()) stamp.update(f).update(readFileSync(p))
    }
  }
  const outDir = join(root, 'node_modules/.cache/aljex-cli')
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, `cli-${stamp.digest('hex').slice(0, 12)}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'error',
    tsconfig: join(root, 'amplify/tsconfig.json'),
  })
  return outfile
}

/** Gate first: a refused production run never even builds the engine. */
let split;
let gate = null;
try {
  split = splitProdArgs(process.argv.slice(2))
  if (split.prod) {
    gate = await requireProd({
      script: split.command === 'reconcile-entity' ? 'importAljexRecon' : 'importAljex',
      values: split.values,
      tables: (split.command === 'reconcile-entity' ? PROD_WRITE_SETS.importAljexRecon : PROD_WRITE_SETS.importAljex).models,
      readOnly: split.readOnly,
    })
    if (gate.rehearsal === false && split.synthetic) throw new Error('--synthetic is never allowed against production')
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// BCAT_STACK=rehearsal: the engine's own-stack rule (engine/tables.ts ownStackSuffix) accepts the rehearsal branch's tables
// instead of the dev ones. Production stays refused by name in every mode; this never applies to a gated --target prod run.
if (isRehearsal && !gate) {
  process.env.BCAT_DEV_STACK = 'true'
  process.env.ORDER_TABLE_NAME = `Order-${STACK.tableSuffix}`
  process.env.LOAD_TABLE_NAME = `Load-${STACK.tableSuffix}`
}

if (gate && split.stopAfterPlan) {
  console.log(`dry run: ${split.command} writes; nothing was done. Add --apply to run it.`)
} else {
  const outfile = await bundle()
  const { main, productionPolicy } = await import(pathToFileURL(outfile).href)
  process.exitCode = await main(split.cliArgv, undefined, gate ? { prod: productionPolicy(gate.suffix) } : {})
}
