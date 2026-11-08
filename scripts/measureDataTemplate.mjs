/**
 * What the dev branch's data stack actually weighs.
 *
 * CloudFormation refuses a nested-stack template over 1,000,000 bytes, and the TMS
 * data stack is the one that grows every step. This runs the SAME synth the Amplify
 * build runs — `Toolkit.fromAssemblyBuilder` + `tsImport('amplify/backend.ts')` +
 * the `amplifySynth` message — against the dev branch's context, then prints the
 * byte count of every template over 100 KB and the data stack's asset key.
 *
 * BCAT_SCHEMA_STAGE=k (amplify/data/stages.ts) synthesizes stage k of the staged schema deploy.
 * It writes nothing to AWS. Deploy credentials are still needed because synth
 * resolves branch secrets.
 *
 *   node scripts/measureDataTemplate.mjs [--branch dev] [--app-id d3dejqzs77khq6]
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { MemoryContext, StackSelectionStrategy, Toolkit } from '@aws-cdk/toolkit-lib'
import { CloudAssembly } from 'aws-cdk-lib/cx-api'
import { tsImport } from 'tsx/esm/api'

import { reportLambdaEnv, scanAssembly } from './checkLambdaEnvSize.mjs'

const CAP_BYTES = 1_000_000
const GUARD_BYTES = 995_000
const RESOURCE_CAP = 500
const REPORT_OVER = 100_000

const { values } = parseArgs({
  options: {
    branch: { type: 'string' },
    'app-id': { type: 'string', default: 'd3dejqzs77khq6' },
    'prod-shape': { type: 'boolean', default: false },
    'no-build-env': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`node scripts/measureDataTemplate.mjs [--branch dev] [--app-id d3dejqzs77khq6]
node scripts/measureDataTemplate.mjs --prod-shape [--no-build-env]

--prod-shape synthesizes as main would after the merge: branch main, BCAT_DEV_STACK and
BCAT_ISOLATED_PREVIEW unset (so no dev secret stripping, rules enabled, no SES deny), the
Amplify build env var LENGTHS from scripts/lib/prodBuildEnv.json filled with 'x' (skip with
--no-build-env), and the secret names checked against scripts/lib/prodSecretNames.json.
No values are read or written; nothing touches AWS.
Exit: 2 template over ${CAP_BYTES}, 3 a Lambda env over ${LIMIT_BYTES}, 4 template over the ${GUARD_BYTES} guard, 5 over the ${RESOURCE_CAP}-resource cap.`)
  process.exit(0)
}

const prodShape = values['prod-shape']
if (prodShape) {
  if (values.branch && values.branch !== 'main') throw new Error('--prod-shape synthesizes branch main; drop --branch')
  values.branch = 'main'
  delete process.env.BCAT_DEV_STACK
  delete process.env.BCAT_ISOLATED_PREVIEW
  delete process.env.PORTAL_ORIGIN
  process.env.AWS_BRANCH = 'main'
  process.env.AWS_APP_ID = values['app-id']
  if (!values['no-build-env']) {
    const lengths = JSON.parse(readFileSync(new URL('./lib/prodBuildEnv.json', import.meta.url), 'utf8'))
    for (const [name, len] of Object.entries(lengths)) if (!name.startsWith('_')) process.env[name] = 'x'.repeat(len)
  }
} else {
  values.branch ??= 'dev'
  if (values.branch === 'main') {
    throw new Error('Use --prod-shape to measure main: it synthesizes only, and sets the production build shape explicitly')
  }
}

const outdir = mkdtempSync(join(tmpdir(), 'bcat-synth-'))
const backend = resolve(process.cwd(), 'amplify/backend.ts')

const toolkit = new Toolkit({ color: false })
const cx = await toolkit.fromAssemblyBuilder(
  async () => {
    await tsImport(pathToFileURL(backend).toString(), import.meta.url)
    // The App only synthesizes when it hears this; the deployer does the same.
    process.emit('message', 'amplifySynth', undefined)
    return new CloudAssembly(outdir)
  },
  {
    contextStore: new MemoryContext({
      'amplify-backend-namespace': values['app-id'],
      'amplify-backend-name': values.branch,
      'amplify-backend-type': 'branch',
    }),
    outdir,
  },
)

await toolkit.synth(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } })

const templates = readdirSync(outdir)
  .filter((name) => name.endsWith('.template.json'))
  .map((name) => ({ name, bytes: statSync(join(outdir, name)).size }))
  .sort((a, b) => b.bytes - a.bytes)

const isData = (name) => /data[0-9A-F]{8}\.nested\.template\.json$/i.test(name)
const data = templates.find((t) => isData(t.name))

const assets = readdirSync(outdir)
  .filter((name) => name.endsWith('.assets.json'))
  .flatMap((name) => Object.entries(JSON.parse(readFileSync(join(outdir, name), 'utf8')).files ?? {}))
const dataAsset = data
  ? assets.find(([, file]) =>
      Object.values(file.source ?? {}).some((v) => typeof v === 'string' && v.endsWith(data.name)),
    )
  : null

console.log(`branch:    ${values.branch}`)
console.log(`stage:     ${process.env.BCAT_SCHEMA_STAGE?.trim() || 'all'}  (BCAT_SCHEMA_STAGE; see Docs/tms-build/AW_STAGED_DEPLOY.md)`)
console.log(`templates: ${templates.length}`)
console.log('')
for (const t of templates.filter((t) => t.bytes >= REPORT_OVER)) {
  console.log(`${String(t.bytes).padStart(9)}  ${t.name}`)
}
console.log('')
if (!data) {
  console.log('No data stack template found — check the nested-template naming.')
  process.exit(1)
}
const headroom = CAP_BYTES - data.bytes
const resources = Object.keys(JSON.parse(readFileSync(join(outdir, data.name), 'utf8')).Resources ?? {}).length
console.log(`data stack: ${data.bytes} bytes, ${headroom} under the ${CAP_BYTES} cap (guard ${GUARD_BYTES}: ${GUARD_BYTES - data.bytes})`)
console.log(`resources:  ${resources} of ${RESOURCE_CAP}`)
// Every stack of the app, for scale against CloudFormation's 2,500 created+updated+deleted per operation
// (scripts/stageDeployCheck.mjs measures the per-stage delta).
const allResources = templates.reduce(
  (sum, t) => sum + Object.keys(JSON.parse(readFileSync(join(outdir, t.name), 'utf8')).Resources ?? {}).length,
  0,
)
console.log(`all stacks: ${allResources} resources in ${templates.length} templates`)
if (dataAsset) console.log(`asset key:  ${dataAsset[0]}`)
console.log(`outdir:     ${outdir}`)
console.log('')
const sizes = scanAssembly(outdir)
const envOk = reportLambdaEnv(sizes)
if (prodShape) {
  const { secrets: prodSecrets } = JSON.parse(readFileSync(new URL('./lib/prodSecretNames.json', import.meta.url), 'utf8'))
  const used = new Map()
  for (const s of sizes) for (const { ssm } of s.secrets) used.set(ssm, (used.get(ssm) ?? 0) + 1)
  console.log('')
  console.log(`secrets in AMPLIFY_SSM_ENV_CONFIG (${used.size} distinct SSM parameters, ${sizes.reduce((n, s) => n + s.secrets.length, 0)} Lambda x secret pairs; shared SSM holds ${prodSecrets.length} names):`)
  for (const [n, c] of [...used].sort()) console.log(`  ${prodSecrets.includes(n) ? 'present ' : 'MISSING '} ${n}  (${c} Lambdas)`)
  const missing = [...used.keys()].filter((n) => !prodSecrets.includes(n))
  if (missing.length) console.log(`note: ${missing.join(', ')} not in prod SSM; those Lambdas degrade at cold start (deploy does not fail)`)
}
if (headroom <= 0) process.exit(2)
if (!envOk) process.exit(3)
if (prodShape && data.bytes > GUARD_BYTES) process.exit(4)
if (resources > RESOURCE_CAP) process.exit(5)
