#!/usr/bin/env node
/**
 * Offline Aljex import driver: the same engine the Lambda worker runs, from a laptop with AWS credentials.
 * DEV STACK ONLY (it refuses production table names). Real exports stay outside the repo; this script never
 * copies one into it and prints aggregates only (counts, sums, timings).
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

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const entry = join(root, 'amplify/functions/tms-aljex-import/engine/cli.ts')

/** Bundle the engine (TypeScript) next to node_modules so the externalised AWS SDK resolves. */
async function bundle() {
  const engineDir = dirname(entry)
  const stamp = createHash('sha1')
  for (const dir of [engineDir, join(root, 'src/lib/aljex'), join(root, 'amplify/functions/_shared')]) {
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

const outfile = await bundle()
const { main } = await import(pathToFileURL(outfile).href)
process.exitCode = await main(process.argv.slice(2))
