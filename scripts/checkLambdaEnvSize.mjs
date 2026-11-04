/**
 * Lambda environment-size guard. AWS refuses a function whose environment variables total over
 * 4,096 bytes (key + value, as Lambda counts them) and CloudFormation only finds out at deploy
 * (job 158: tms-directory-actions, 4,122 bytes). This reads a synthesized assembly and fails
 * above LIMIT_BYTES (calibrated, see ESTIMATE_FACTOR) for EVERY AWS::Lambda::Function, printing every function's size.
 *
 * Values that are CloudFormation tokens (Ref / GetAtt / Join / Sub / Select ...) have no length
 * until deploy, so they are ESTIMATED conservatively: 120 bytes for an ARN (GetAtt ...Arn), 60
 * for anything else (a table name, an id). Plain strings are counted exactly.
 *
 *   imported by measureDataTemplate.mjs; or: node scripts/checkLambdaEnvSize.mjs <cdk.out dir>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LIMIT_BYTES = 3900
/**
 * Calibration against what Lambda really measured. The raw estimate runs high: tms-directory-actions
 * before the fix estimated 5,504 where Lambda said 4,122 (deploy 158, 0.75); the deployed dev
 * functions read 0.85-0.89 of their raw estimate (shipment 3,397 vs 3,993, finance 2,645 vs 3,045,
 * tracking 3,084 vs 3,471). The guard compares raw * ESTIMATE_FACTOR to LIMIT_BYTES, with the
 * factor set above the observed ratios so it errs toward failing. Re-calibrate on a new measurement.
 */
export const ESTIMATE_FACTOR = 0.9
export const TOKEN_BYTES = 60
export const ARN_BYTES = 120

const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

/** Resolved-size estimate of one template value. */
export function valueBytes(v) {
  if (typeof v === 'string') return bytes(v)
  if (typeof v === 'number' || typeof v === 'boolean') return bytes(v)
  if (v && typeof v === 'object') {
    if ('Fn::Join' in v) {
      const [sep, parts] = v['Fn::Join']
      return parts.reduce((n, p) => n + valueBytes(p), 0) + bytes(sep) * Math.max(0, parts.length - 1)
    }
    if ('Fn::GetAtt' in v) return /Arn$/.test(String([].concat(v['Fn::GetAtt']).at(-1))) ? ARN_BYTES : TOKEN_BYTES
    if ('Fn::Sub' in v) return bytes([].concat(v['Fn::Sub'])[0]) + TOKEN_BYTES
    return TOKEN_BYTES
  }
  return 0
}

export function lambdaEnvSizes(template) {
  const out = []
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    if (r.Type !== 'AWS::Lambda::Function') continue
    const vars = r.Properties?.Environment?.Variables ?? {}
    let total = 0
    for (const [k, v] of Object.entries(vars)) total += bytes(k) + valueBytes(v)
    out.push({ id, name: r.Properties?.FunctionName ?? id, count: Object.keys(vars).length, raw: total, bytes: Math.round(total * ESTIMATE_FACTOR) })
  }
  return out
}

export function scanAssembly(outdir) {
  return readdirSync(outdir)
    .filter((n) => n.endsWith('.template.json'))
    .flatMap((n) => lambdaEnvSizes(JSON.parse(readFileSync(join(outdir, n), 'utf8'))))
    .sort((a, b) => b.bytes - a.bytes)
}

/** Prints every function; returns false when any is over the limit. */
export function reportLambdaEnv(sizes) {
  console.log(`Lambda environment sizes (estimated; limit ${LIMIT_BYTES}, AWS hard cap 4096; tokens: ARN ${ARN_BYTES}, other ${TOKEN_BYTES}; raw x ${ESTIMATE_FACTOR} calibrated on measured Lambdas)`)
  for (const s of sizes) console.log(`${String(s.bytes).padStart(6)}  (raw ${String(s.raw).padStart(5)})  ${String(s.count).padStart(3)} vars  ${s.name}`)
  console.log(`top 5: ${sizes.slice(0, 5).map((s) => `${s.name}=${s.bytes}`).join(', ')}`)
  const over = sizes.filter((s) => s.bytes > LIMIT_BYTES)
  for (const s of over) console.log(`FAIL  ${s.name}: ${s.bytes} bytes of environment variables (limit ${LIMIT_BYTES})`)
  return over.length === 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: node scripts/checkLambdaEnvSize.mjs <cdk.out dir>')
  process.exit(reportLambdaEnv(scanAssembly(process.argv[2])) ? 0 : 3)
}
