/**
 * What the dev branch's data stack actually weighs.
 *
 * CloudFormation refuses a nested-stack template over 1,000,000 bytes, and the TMS
 * data stack is the one that grows every step. This runs the SAME synth the Amplify
 * build runs — `Toolkit.fromAssemblyBuilder` + `tsImport('amplify/backend.ts')` +
 * the `amplifySynth` message — against the dev branch's context, then prints the
 * byte count of every template over 100 KB and the data stack's asset key.
 *
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

const CAP_BYTES = 1_000_000
const REPORT_OVER = 100_000

const { values } = parseArgs({
  options: {
    branch: { type: 'string', default: 'dev' },
    'app-id': { type: 'string', default: 'd3dejqzs77khq6' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log('node scripts/measureDataTemplate.mjs [--branch dev] [--app-id d3dejqzs77khq6]')
  process.exit(0)
}

if (values.branch === 'main') {
  throw new Error('Refusing to synthesize the production branch: this build is dev-only')
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
console.log(`data stack: ${data.bytes} bytes, ${headroom} under the ${CAP_BYTES} cap`)
if (dataAsset) console.log(`asset key:  ${dataAsset[0]}`)
console.log(`outdir:     ${outdir}`)
if (headroom <= 0) process.exit(2)
