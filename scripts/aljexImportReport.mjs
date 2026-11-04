#!/usr/bin/env node
/**
 * Writes Docs/tms-build/ALJEX_IMPORT_REPORT.md from the reconcile output of an import run
 * (`summary.json`, written by the engine next to the run's CSV reports). The report holds counts,
 * sums and PRO numbers only: no names, no cell values.
 *
 *   node scripts/aljexImportReport.mjs --summary <path/to/summary.json> [--out Docs/tms-build/ALJEX_IMPORT_REPORT.md]
 *   node scripts/aljexImportReport.mjs --run-dir <objects dir of the run> [--out ...]   # finds imports/runs/<job>/summary.json
 *   add --stdout to print instead of writing.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const DEFAULT_OUT = join(root, 'Docs/tms-build/ALJEX_IMPORT_REPORT.md')

export function parseArgs(argv) {
  const flags = new Set()
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const name = a.slice(2)
    if (name === 'stdout') flags.add(name)
    else {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) throw new Error(`--${name} needs a value`)
      values[name] = v
    }
  }
  return { flags, values }
}

/** `--summary` wins; `--run-dir` is searched for the newest imports/runs/<job>/summary.json (or a summary.json directly inside). */
export function findSummary({ summary, runDir }) {
  if (summary) return resolve(summary)
  if (!runDir) throw new Error('pass --summary <summary.json> or --run-dir <dir>')
  const dir = resolve(runDir)
  if (existsSync(join(dir, 'summary.json'))) return join(dir, 'summary.json')
  const runs = join(dir, 'imports', 'runs')
  if (!existsSync(runs)) throw new Error(`no summary.json in ${dir} and no imports/runs below it`)
  const found = readdirSync(runs)
    .map((job) => join(runs, job, 'summary.json'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (found.length === 0) throw new Error(`no summary.json under ${runs}`)
  return found[0]
}

async function loadRenderer() {
  const entry = join(root, 'amplify/functions/tms-aljex-import/engine/report.ts')
  const outDir = join(root, 'node_modules/.cache/aljex-cli')
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, 'report.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'error', tsconfig: join(root, 'amplify/tsconfig.json') })
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)).renderImportReport
}

export async function main(argv) {
  const { flags, values } = parseArgs(argv)
  const path = findSummary({ summary: values.summary, runDir: values['run-dir'] })
  const summary = JSON.parse(readFileSync(path, 'utf8'))
  const render = await loadRenderer()
  const md = `${render(summary)}\n`
  if (flags.has('stdout')) process.stdout.write(md)
  else {
    const out = resolve(values.out ?? DEFAULT_OUT)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, md)
    process.stdout.write(`wrote ${out} from ${path}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
