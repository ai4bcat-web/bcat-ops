/**
 * Lambda environment-size guard. AWS refuses a function whose environment variables total over
 * 4,096 bytes (key + value, as Lambda counts them) and CloudFormation only finds out at deploy
 * (job 158: tms-directory-actions, 4,122 bytes). This reads a synthesized assembly and fails
 * above LIMIT_BYTES (calibrated, see TOKEN_FACTOR) for EVERY AWS::Lambda::Function, printing every function's size.
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
 * Calibration against what Lambda really measured (deployed dev functions, 11-04). Plain strings are
 * counted exactly; only CloudFormation tokens are estimated (below), and those estimates run high:
 * the five token variables of tms-directory-actions estimate 392 B and measured 277 B (0.71), the
 * table-name-heavy routers ran 0.84-0.89 overall. A factor over the WHOLE total under-counted the
 * string-heavy tms-directory-actions (13 secrets): 0.9 x raw 4,218 = 3,796 passed while its real
 * environment is ~4,103, over the 4,096 cap. So the factor applies to the token estimate only, set
 * above the observed 0.71, and the guard compares exact strings + tokens x TOKEN_FACTOR to LIMIT_BYTES.
 * Re-calibrate on a new measurement.
 */
export const TOKEN_FACTOR = 0.8
export const TOKEN_BYTES = 60
export const ARN_BYTES = 120

const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

/** Resolved-size estimate of one template value. */
export function valueBytes(v) {
  return valueParts(v).exact + valueParts(v).tokens
}

/** A template value split into the bytes Lambda will count exactly and the bytes that are estimated tokens. */
export function valueParts(v) {
  if (typeof v === 'string') return { exact: bytes(v), tokens: 0 }
  if (typeof v === 'number' || typeof v === 'boolean') return { exact: bytes(v), tokens: 0 }
  if (v && typeof v === 'object') {
    if ('Fn::Join' in v) {
      const [sep, parts] = v['Fn::Join']
      const sum = { exact: bytes(sep) * Math.max(0, parts.length - 1), tokens: 0 }
      for (const p of parts) {
        const q = valueParts(p)
        sum.exact += q.exact
        sum.tokens += q.tokens
      }
      return sum
    }
    if ('Fn::GetAtt' in v) return { exact: 0, tokens: /Arn$/.test(String([].concat(v['Fn::GetAtt']).at(-1))) ? ARN_BYTES : TOKEN_BYTES }
    if ('Fn::Sub' in v) return { exact: bytes([].concat(v['Fn::Sub'])[0]), tokens: TOKEN_BYTES }
    return { exact: 0, tokens: TOKEN_BYTES }
  }
  return { exact: 0, tokens: 0 }
}

/**
 * Amplify secret() entries in a Lambda's AMPLIFY_SSM_ENV_CONFIG as {key, ssm}: `key` is the env var, `ssm` the
 * shared parameter it reads (a few keys alias one parameter). Resource-reference entries (AMPLIFY_DATA_*, no
 * sharedPath) are not secrets and are skipped. [] when absent or still a token.
 */
export function ssmSecretNames(config) {
  if (typeof config !== 'string') return []
  try {
    return Object.entries(JSON.parse(config))
      .filter(([, v]) => v && typeof v.sharedPath === 'string')
      .map(([key, v]) => ({ key, ssm: v.sharedPath.split('/').at(-1) }))
  } catch {
    return []
  }
}

export function lambdaEnvSizes(template) {
  const out = []
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    if (r.Type !== 'AWS::Lambda::Function') continue
    const vars = r.Properties?.Environment?.Variables ?? {}
    let exact = 0
    let tokens = 0
    for (const [k, v] of Object.entries(vars)) {
      const p = valueParts(v)
      exact += bytes(k) + p.exact
      tokens += p.tokens
    }
    out.push({ id, name: r.Properties?.FunctionName ?? id, count: Object.keys(vars).length, raw: exact + tokens, bytes: Math.round(exact + tokens * TOKEN_FACTOR), secrets: ssmSecretNames(vars.AMPLIFY_SSM_ENV_CONFIG) })
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
  console.log(`Lambda environment sizes (estimated; limit ${LIMIT_BYTES}, AWS hard cap 4096; tokens: ARN ${ARN_BYTES}, other ${TOKEN_BYTES}; strings exact, tokens x ${TOKEN_FACTOR} calibrated on measured Lambdas)`)
  for (const s of sizes) console.log(`${String(s.bytes).padStart(6)}  (raw ${String(s.raw).padStart(5)})  ${String(s.count).padStart(3)} vars  ${String(s.secrets.length).padStart(2)} secrets  ${s.name}`)
  console.log(`top 5: ${sizes.slice(0, 5).map((s) => `${s.name}=${s.bytes}`).join(', ')}`)
  const over = sizes.filter((s) => s.bytes > LIMIT_BYTES)
  for (const s of over) console.log(`FAIL  ${s.name}: ${s.bytes} bytes of environment variables (limit ${LIMIT_BYTES})`)
  return over.length === 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: node scripts/checkLambdaEnvSize.mjs <cdk.out dir>')
  process.exit(reportLambdaEnv(scanAssembly(process.argv[2])) ? 0 : 3)
}
