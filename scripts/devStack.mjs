#!/usr/bin/env node
/**
 * Dev stack helpers (see Docs/DEV_STACK.md).
 *
 *   node scripts/devStack.mjs env                 # dev stack's Function URLs, pool ids, bucket
 *   node scripts/devStack.mjs copy-data [--tables Load,Driver] [--dry-run]
 *                                                 # production tables → dev tables (reads prod only)
 *   node scripts/devStack.mjs copy-files [--dry-run]
 *                                                 # production S3 bucket → dev bucket (aws s3 sync)
 *
 * The production table suffix is pinned below. The dev suffix is discovered from the
 * `Load-*-NONE` tables in the account: there must be exactly one that is not production
 * (pass --to <suffix> to choose when there is more than one).
 */
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, ListFunctionsCommand, ListFunctionUrlConfigsCommand } from '@aws-sdk/client-lambda'
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3'
import { CognitoIdentityProviderClient, ListUserPoolsCommand } from '@aws-sdk/client-cognito-identity-provider'
import { spawnSync } from 'node:child_process'

const REGION = 'us-east-1'
const APP_ID = 'd3dejqzs77khq6'
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const PROD_BUCKET = 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg'
const DEV_PREFIX = `amplify-${APP_ID}-de`

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const has = (name) => args.includes(name)

const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function listAllTables() {
  const names = []
  let last
  do {
    const r = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: last, Limit: 100 }))
    names.push(...(r.TableNames ?? []))
    last = r.LastEvaluatedTableName
  } while (last)
  return names
}

function devSuffixFrom(tables) {
  const forced = flag('--to')
  if (forced) return forced
  const suffixes = tables.filter((t) => t.startsWith('Load-')).map((t) => t.slice('Load-'.length)).filter((s) => s !== PROD_SUFFIX)
  if (suffixes.length !== 1) throw new Error(`expected exactly one non-production Load table, found: ${suffixes.join(', ') || 'none'} (pass --to <suffix>)`)
  return suffixes[0]
}

async function copyTable(model, devSuffix, dryRun) {
  const from = `${model}-${PROD_SUFFIX}`
  const to = `${model}-${devSuffix}`
  let rows = 0
  let written = 0
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: from, ExclusiveStartKey: startKey }))
    const items = page.Items ?? []
    rows += items.length
    startKey = page.LastEvaluatedKey
    if (dryRun) continue
    for (let i = 0; i < items.length; i += 25) {
      let batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }))
      let attempt = 0
      while (batch.length) {
        const r = await doc.send(new BatchWriteCommand({ RequestItems: { [to]: batch } }))
        written += batch.length
        const left = r.UnprocessedItems?.[to] ?? []
        written -= left.length
        batch = left
        if (batch.length) {
          attempt += 1
          await new Promise((res) => setTimeout(res, Math.min(5000, 200 * 2 ** attempt)))
        }
      }
    }
  } while (startKey)
  return { model, rows, written }
}

async function copyData() {
  const dryRun = has('--dry-run')
  const tables = await listAllTables()
  const devSuffix = devSuffixFrom(tables)
  const prodModels = tables.filter((t) => t.endsWith(`-${PROD_SUFFIX}`)).map((t) => t.slice(0, -(PROD_SUFFIX.length + 1)))
  const only = flag('--tables')?.split(',').map((s) => s.trim()).filter(Boolean)
  const models = (only ?? prodModels).filter((m) => {
    if (!tables.includes(`${m}-${devSuffix}`)) { console.warn(`skip ${m}: no dev table (model not in the dev schema yet)`); return false }
    return true
  })
  console.log(`${dryRun ? 'DRY RUN — ' : ''}copying ${models.length} tables  prod=${PROD_SUFFIX}  dev=${devSuffix}`)
  const results = []
  const queue = [...models]
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const model = queue.shift()
      const t0 = Date.now()
      try {
        const r = await copyTable(model, devSuffix, dryRun)
        results.push(r)
        console.log(`  ${model.padEnd(32)} ${String(r.rows).padStart(6)} rows ${dryRun ? '' : `→ ${r.written} written`}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (err) {
        console.error(`  ${model}: FAILED ${err?.message ?? err}`)
        results.push({ model, error: String(err?.message ?? err) })
      }
    }
  })
  await Promise.all(workers)
  const failed = results.filter((r) => r.error)
  console.log(`done: ${results.length - failed.length} ok, ${failed.length} failed, ${results.reduce((n, r) => n + (r.rows ?? 0), 0)} rows read`)
  if (failed.length) process.exitCode = 1
}

async function devBucket() {
  const s3 = new S3Client({ region: REGION })
  const r = await s3.send(new ListBucketsCommand({}))
  const b = (r.Buckets ?? []).map((x) => x.Name).filter((n) => n?.startsWith(DEV_PREFIX) && n.includes('bcatrateconfirms'))
  if (b.length !== 1) throw new Error(`expected one dev bucket, found: ${b.join(', ') || 'none'}`)
  return b[0]
}

async function copyFiles() {
  const to = await devBucket()
  const cmdArgs = ['s3', 'sync', `s3://${PROD_BUCKET}`, `s3://${to}`, ...(has('--dry-run') ? ['--dryrun'] : [])]
  console.log(`aws ${cmdArgs.join(' ')}`)
  const r = spawnSync('aws', cmdArgs, { stdio: 'inherit' })
  process.exitCode = r.status ?? 1
}

async function env() {
  const lambda = new LambdaClient({ region: REGION })
  const fns = []
  let marker
  do {
    const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
    fns.push(...(r.Functions ?? []).filter((f) => f.FunctionName?.startsWith(DEV_PREFIX)))
    marker = r.NextMarker
  } while (marker)
  console.log(`dev Lambdas: ${fns.length}`)
  for (const f of fns) {
    const u = await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: f.FunctionName }))
    for (const c of u.FunctionUrlConfigs ?? []) console.log(`  ${f.FunctionName}\n    ${c.FunctionUrl}`)
  }
  const cog = new CognitoIdentityProviderClient({ region: REGION })
  const pools = await cog.send(new ListUserPoolsCommand({ MaxResults: 60 }))
  for (const p of pools.UserPools ?? []) if (p.Name?.includes(`${APP_ID}-de`) || p.Name?.startsWith(DEV_PREFIX)) console.log(`pool: ${p.Name}  ${p.Id}`)
  try { console.log(`bucket: ${await devBucket()}`) } catch (e) { console.log(`bucket: ${e.message}`) }
  const tables = await listAllTables()
  try { console.log(`table suffix: ${devSuffixFrom(tables)}`) } catch (e) { console.log(`table suffix: ${e.message}`) }
}

const commands = { env, 'copy-data': copyData, 'copy-files': copyFiles }
if (!commands[cmd]) {
  console.error('usage: node scripts/devStack.mjs <env|copy-data|copy-files> [--tables A,B] [--to <suffix>] [--dry-run]')
  process.exit(2)
}
commands[cmd]().catch((err) => { console.error(err); process.exit(1) })
