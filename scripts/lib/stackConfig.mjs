/**
 * The single stack selector for every dev harness and guard.
 *
 *   BCAT_STACK=dev        (default) the long-lived dev stack, exactly as every script always behaved
 *   BCAT_STACK=rehearsal  the `rehearsal` Amplify branch: a full copy stack with its own tables, pools, bucket
 *
 * `dev` is hard-coded (nothing is looked up, nothing changes). `rehearsal` is DISCOVERED at runtime with the
 * AWS CLI (read-only calls: cloudformation list-stacks / list-stack-resources, appsync get-graphql-api,
 * lambda get-function-url-config) from the root CloudFormation stack Amplify names
 * `amplify-<appId>-<branch>-branch-<hash>`, and cached in scripts/.stack-cache.json (git-ignored). Everything
 * resolved here is an id or a URL; there are no secrets in it.
 *
 * Production is never selectable: an unknown BCAT_STACK value throws, and a resolved stack that contains any
 * production id (pools, clients, AppSync id, table suffix, bucket, origin) or any DEV id while claiming to be
 * the rehearsal is rejected before it is cached or returned.
 *
 *   node scripts/lib/stackConfig.mjs --print            # the selected stack's resolved ids
 *   BCAT_STACK=rehearsal node scripts/lib/stackConfig.mjs --print [--refresh]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STACK_ENV = 'BCAT_STACK'
export const REFRESH_ENV = 'BCAT_STACK_REFRESH'
export const APP_ID = 'd3dejqzs77khq6'
export const REGION = 'us-east-1'
export const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.stack-cache.json')

const FIELDS = ['name', 'origin', 'apiId', 'apiUrl', 'tableSuffix', 'staffPoolId', 'staffClientId', 'driverPoolId', 'driverClientId', 'filesBucket', 'publicApi', 'region', 'lambdaPrefix']

/** Amplify names every function/bucket `amplify-<appId>-<first two letters of the branch>-<logical id>-<hash>`. */
const lambdaPrefixOf = (branch) => `amplify-${APP_ID}-${branch.slice(0, 2)}`

/** The dev stack: constants copied from what the scripts always hard-coded. Never discovered. */
const DEV = Object.freeze({
  name: 'dev',
  origin: 'https://dev.d3dejqzs77khq6.amplifyapp.com',
  apiId: 'nc3jsnxdmjhkpequimypiatkma',
  apiUrl: 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql',
  tableSuffix: 'nc3jsnxdmjhkpequimypiatkma-NONE',
  staffPoolId: 'us-east-1_UKhMNVAG1',
  staffClientId: '59284j3vm69gqg49cinjrr4dci',
  driverPoolId: 'us-east-1_nnJzcFvTY',
  driverClientId: 'qvnqkida69qhuquir2tahjvq',
  filesBucket: 'amplify-d3dejqzs77khq6-de-bcatrateconfirmsbucketf4-u2z3qq1ar9hf',
  publicApi: 'https://jk65s5nfkj2sfnnoang4huvbvq0bsruo.lambda-url.us-east-1.on.aws',
  region: REGION,
  lambdaPrefix: lambdaPrefixOf('dev'),
})

/** The production stack's identifiers. Used only to REFUSE; nothing here is ever a target. */
export const PRODUCTION = Object.freeze({
  apiId: '5ucwdyvwivelbo4k4jomvrwel4',
  tableSuffix: '5ucwdyvwivelbo4k4jomvrwel4-NONE',
  staffPoolId: 'us-east-1_IbPKPNJC9',
  staffClientId: '1qr651dshigrv8a6c338d4f709',
  driverPoolId: 'us-east-1_xXK4vjhtC',
  driverClientId: '6473jg3g61nn8g78vkmrqr1rbg',
  filesBucket: 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg',
  origins: Object.freeze(['https://ops.bcatcorp.com', 'https://main.d3dejqzs77khq6.amplifyapp.com']),
})

const REHEARSAL_BRANCH = 'rehearsal'
const REHEARSAL_ORIGIN = `https://${REHEARSAL_BRANCH}.${APP_ID}.amplifyapp.com`

export const KNOWN_STACKS = Object.freeze(['dev', 'rehearsal'])

/** The selected stack name. Default dev; anything but dev|rehearsal throws (production is never a value). */
export function selectedStackName(env = process.env) {
  const raw = env[STACK_ENV]
  if (raw === undefined || raw === '') return 'dev'
  if (!KNOWN_STACKS.includes(raw)) throw new Error(`${STACK_ENV} must be one of ${KNOWN_STACKS.join('|')} (got "${raw}")`)
  return raw
}

/**
 * Refuse a resolved stack that is not exactly what it claims. Pure; throws on the first problem.
 * @param {Record<string, string>} cfg
 */
export function assertStackSafe(cfg) {
  for (const f of FIELDS) if (typeof cfg[f] !== 'string' || !cfg[f]) throw new Error(`stack "${cfg?.name}" is missing ${f}`)
  const blob = JSON.stringify(cfg)
  if (blob.includes(PRODUCTION.apiId)) throw new Error(`stack "${cfg.name}" resolved to the PRODUCTION AppSync id: refusing`)
  for (const k of ['staffPoolId', 'staffClientId', 'driverPoolId', 'driverClientId', 'filesBucket']) {
    if (cfg[k] === PRODUCTION[k]) throw new Error(`stack "${cfg.name}" resolved ${k} to the PRODUCTION value: refusing`)
  }
  if (PRODUCTION.origins.includes(cfg.origin)) throw new Error(`stack "${cfg.name}" resolved the PRODUCTION origin: refusing`)
  if (cfg.tableSuffix !== `${cfg.apiId}-NONE`) throw new Error(`stack "${cfg.name}" table suffix does not match its AppSync id`)
  if (cfg.lambdaPrefix === lambdaPrefixOf('ma')) throw new Error(`stack "${cfg.name}" resolved the PRODUCTION lambda/bucket prefix: refusing`)
  if (cfg.name === 'rehearsal') {
    for (const k of ['lambdaPrefix', 'apiId', 'tableSuffix', 'staffPoolId', 'staffClientId', 'driverPoolId', 'driverClientId', 'filesBucket', 'apiUrl', 'publicApi']) {
      if (cfg[k] === DEV[k]) throw new Error(`rehearsal resolved ${k} to the DEV value: discovery picked the wrong stack`)
    }
    if (cfg.origin !== REHEARSAL_ORIGIN) throw new Error(`rehearsal origin must be ${REHEARSAL_ORIGIN}`)
  }
}

// ── discovery (rehearsal) ────────────────────────────────────────────────────────────────────────

const defaultAws = (args) => JSON.parse(execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }))

const COMPLETE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'])

/**
 * Discover the rehearsal branch's stack. `aws(args)` returns parsed JSON (injectable for tests).
 * @param {(args: string[]) => any} aws
 * @param {string} [branch] only tests pass another branch (to prove the discovery reproduces the dev constants)
 */
export function discoverRehearsal(aws = defaultAws, branch = REHEARSAL_BRANCH) {
  const prefix = `amplify-${APP_ID}-${branch}-branch-`
  const stacks = aws(['cloudformation', 'list-stacks']).StackSummaries ?? []
  const roots = stacks
    .filter((s) => s.StackName.startsWith(prefix) && !s.ParentId && s.StackStatus !== 'DELETE_COMPLETE')
    .sort((a, b) => String(b.CreationTime).localeCompare(String(a.CreationTime)))
  if (roots.length === 0) throw new Error(`no CloudFormation stack named ${prefix}* yet: the rehearsal branch has not finished its first backend deploy`)
  const root = roots[0]
  if (!COMPLETE.has(root.StackStatus)) throw new Error(`rehearsal stack ${root.StackName} is ${root.StackStatus}, not deployed yet`)

  const resources = (stack) => aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]).StackResourceSummaries ?? []
  const children = resources(root.StackName).filter((r) => r.ResourceType === 'AWS::CloudFormation::Stack')
  const child = (kind) => children.find((r) => r.LogicalResourceId.startsWith(kind))?.PhysicalResourceId
  const stackOf = {}
  for (const kind of ['auth', 'data', 'storage']) {
    const id = child(kind)
    if (!id) throw new Error(`rehearsal stack ${root.StackName} has no ${kind} child stack`)
    stackOf[kind] = resources(id)
  }
  const one = (list, type, test, what) => {
    const hit = list.find((r) => r.ResourceType === type && test(r.LogicalResourceId))
    if (!hit) throw new Error(`rehearsal stack ${root.StackName}: ${what} not found`)
    return hit.PhysicalResourceId
  }
  const staffPoolId = one(stackOf.auth, 'AWS::Cognito::UserPool', () => true, 'staff user pool')
  const staffClientId = one(stackOf.auth, 'AWS::Cognito::UserPoolClient', () => true, 'staff user pool client')
  const driverPoolId = one(stackOf.data, 'AWS::Cognito::UserPool', (l) => l.startsWith('BcatDriverPool'), 'driver user pool')
  const driverClientId = one(stackOf.data, 'AWS::Cognito::UserPoolClient', (l) => l.startsWith('BcatDriverPoolClient'), 'driver user pool client')
  const apiArn = one(stackOf.data, 'AWS::AppSync::GraphQLApi', () => true, 'AppSync API')
  const filesBucket = one(stackOf.storage, 'AWS::S3::Bucket', (l) => l.startsWith('bcatRateConfirmsBucket'), 'files bucket')
  const trackingFnArn = one(stackOf.data, 'AWS::Lambda::Url', (l) => l.startsWith('TrackingApiUrl'), 'tracking API function URL')

  const apiId = apiArn.split('/').pop()
  const apiUrl = aws(['appsync', 'get-graphql-api', '--api-id', apiId]).graphqlApi?.uris?.GRAPHQL
  const publicApi = aws(['lambda', 'get-function-url-config', '--function-name', trackingFnArn]).FunctionUrl?.replace(/\/$/, '')
  if (!apiUrl || !publicApi) throw new Error(`rehearsal stack ${root.StackName}: AppSync URL or tracking API URL could not be read`)

  return {
    name: 'rehearsal', origin: `https://${branch}.${APP_ID}.amplifyapp.com`, apiId, apiUrl, tableSuffix: `${apiId}-NONE`,
    staffPoolId, staffClientId, driverPoolId, driverClientId, filesBucket, publicApi, region: REGION,
    lambdaPrefix: lambdaPrefixOf(branch), stackName: root.StackName,
  }
}

function readCache(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {} } catch { return {} }
}

/**
 * Resolve a stack by name. `dev` is the constant table; `rehearsal` comes from the cache when it validates,
 * otherwise from discovery (then cached). Synchronous so existing `export const` constants keep working.
 * @param {string} name
 * @param {{env?: Record<string, string|undefined>, aws?: (args: string[]) => any, cacheFile?: string}} [opts]
 */
export function resolveStack(name, { env = process.env, aws, cacheFile = CACHE_FILE } = {}) {
  if (name === 'dev') return DEV
  if (name !== 'rehearsal') throw new Error(`unknown stack "${name}"`)
  const cache = readCache(cacheFile)
  if (env[REFRESH_ENV] !== '1' && cache.rehearsal) {
    try { assertStackSafe(cache.rehearsal); return Object.freeze({ ...cache.rehearsal }) } catch { /* stale or invalid: rediscover */ }
  }
  const cfg = discoverRehearsal(aws)
  assertStackSafe(cfg)
  writeFileSync(cacheFile, `${JSON.stringify({ ...cache, rehearsal: { ...cfg, resolvedAt: new Date().toISOString() } }, null, 2)}\n`)
  return Object.freeze(cfg)
}

/** The stack selected by BCAT_STACK, resolved at import time. Every harness reads its ids from here. */
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1]
export const STACK = resolveStack(selectedStackName(), { env: isMain && process.argv.includes('--refresh') ? { ...process.env, [REFRESH_ENV]: '1' } : process.env })
export const isRehearsal = STACK.name === 'rehearsal'

// A table-suffix override left over from a dev session must never silently aim a rehearsal run at the dev tables.
if (isRehearsal) {
  for (const k of ['DEV_TABLE_SUFFIX', 'TABLE_SUFFIX']) {
    const v = process.env[k]
    if (v && v !== STACK.tableSuffix) throw new Error(`${k}=${v} does not match the rehearsal table suffix ${STACK.tableSuffix}: unset it or pass the rehearsal suffix`)
  }
}

/**
 * The deployed name of one of the selected stack's Lambda functions. `dev` returns `devName` (the name the script
 * always used); `rehearsal` finds the function whose name starts with `<lambdaPrefix>-<fragment>` (lower-cased
 * logical id, e.g. 'tmsshipmentactionslambda') with `aws lambda list-functions`. Never returns a production function.
 */
export function lambdaName(fragment, devName, { aws = defaultAws } = {}) {
  if (!isRehearsal) return devName
  const want = `${STACK.lambdaPrefix}-${fragment.toLowerCase()}`
  const fns = aws(['lambda', 'list-functions']).Functions ?? []
  const hits = fns.map((f) => f.FunctionName).filter((n) => n.toLowerCase().startsWith(want))
  if (hits.length !== 1) throw new Error(`expected exactly one rehearsal lambda named ${want}*, found ${hits.length}`)
  return hits[0]
}

/** Same as lambdaName for an IAM role (`amplify-<app>-<xx>-<fragment>*`). */
export function roleName(fragment, devName, { aws = defaultAws } = {}) {
  if (!isRehearsal) return devName
  const want = `${STACK.lambdaPrefix}-${fragment.toLowerCase()}`
  const hits = (aws(['iam', 'list-roles']).Roles ?? []).map((r) => r.RoleName).filter((n) => n.toLowerCase().startsWith(want))
  if (hits.length !== 1) throw new Error(`expected exactly one rehearsal role named ${want}*, found ${hits.length}`)
  return hits[0]
}

/** Escape a string for a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Anchored regex matching exactly the selected stack's AppSync URL (for the harnesses' "refuse any other API" guard). */
export const APPSYNC_URL_RE = new RegExp(`^${esc(STACK.apiUrl)}$`)
/** The selected stack's AppSync host. */
export const API_HOST = new URL(STACK.apiUrl).host

/** The printable (non-secret) view. */
export const describeStack = (cfg = STACK) => Object.fromEntries([...FIELDS, 'stackName', 'resolvedAt'].filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]))

if (isMain) {
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(describeStack(), null, 2))
  } else {
    console.log('usage: [BCAT_STACK=dev|rehearsal] node scripts/lib/stackConfig.mjs --print')
    process.exitCode = 1
  }
}
