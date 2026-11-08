#!/usr/bin/env node
/**
 * Step AW stage B: load the PRODUCTION export (read-only local backup) into the REHEARSAL stack's tables.
 *
 *   node scripts/rehearsalLoad.mjs --api-id <rehearsal AppSync id> [--tables A,B] [--from <dir>]   # dry run (default)
 *   node scripts/rehearsalLoad.mjs --api-id <id> --apply                                            # write
 *   node scripts/rehearsalLoad.mjs --api-id <id> --files [--bucket <name>] [--apply]                # S3 sync command
 *
 * Source: ~/bcat-ops-backups/2026-11-08-pre-aljex-migration/tables-main/<Model>.jsonl (DynamoDB-JSON, one item
 * per line; opened read-only, never moved or written). Target: existing `<Model>-<apiId>-NONE` tables only
 * (never created). Put-by-key is idempotent; a PUT replaces the whole item.
 *
 * Hard guards: the api id must not be the production or dev AppSync id; --from must resolve under
 * ~/bcat-ops-backups; a table the rehearsal lacks is skipped; --apply needs Amplify branch `rehearsal` to carry
 * BCAT_DEV_STACK=true (so SES/Twilio/Slack/EventBridge are inert there). Cognito users are NOT loaded.
 * Dry-run is the default; the files destination bucket must not be the production or dev bucket.
 *
 * Outside-contact attributes that exist in the data (names only, counted): see OUTSIDE_CONTACT_ATTRS.
 */
import { createReadStream, realpathSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DynamoDBClient, ListTablesCommand, ScanCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { PROD_SUFFIX_FRAGMENT, DEV_SUFFIX_FRAGMENT } from './lib/prodGate.mjs'

export const REGION = 'us-east-1'
export const APP_ID = 'd3dejqzs77khq6'
export const BRANCH = 'rehearsal'
export const PROD_BUCKET = 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg'
export const DEV_BUCKET = 'amplify-d3dejqzs77khq6-de-bcatrateconfirmsbucketf4-u2z3qq1ar9hf'
export const BACKUP_BUCKET_PREFIX = 's3://bcat-ops-backup-273354631837-20261108/prod/files-bucket/'
export const DEFAULT_FROM = path.join(homedir(), 'bcat-ops-backups', '2026-11-08-pre-aljex-migration', 'tables-main')
export const BATCH_SIZE = 25
/** Attribute names that would trigger outside contact if application code ran against them. */
export const OUTSIDE_CONTACT_ATTRS = ['phone', 'email', 'cell', 'mobile', 'smsNumber', 'contactEmail', 'contactPhone', 'dispatcherEmail', 'driverEmail', 'driverPhone']

export class RehearsalError extends Error {}

// ── pure guards ──────────────────────────────────────────────────────────────────────────────────

/** `<apiId>` -> the table suffix `<apiId>-NONE`; refuses prod, dev, and anything not shaped like an AppSync id. */
export function rehearsalSuffix(apiId) {
  if (typeof apiId !== 'string' || !/^[a-z0-9]{20,32}$/.test(apiId)) throw new RehearsalError(`--api-id "${apiId}" is not an AppSync api id`)
  if (apiId === PROD_SUFFIX_FRAGMENT) throw new RehearsalError('refusing: that is the PRODUCTION api id')
  if (apiId === DEV_SUFFIX_FRAGMENT) throw new RehearsalError('refusing: that is the DEV stack api id')
  return `${apiId}-NONE`
}

/** The backup dir must resolve (symlinks followed) under <home>/bcat-ops-backups. Returns the real path. */
export function assertBackupPath(from, home = homedir(), realpath = realpathSync) {
  const root = path.join(home, 'bcat-ops-backups')
  let real
  try { real = realpath(path.resolve(from)) } catch { throw new RehearsalError(`--from path does not exist: ${from}`) }
  let realRoot = root
  try { realRoot = realpath(root) } catch { /* root missing => real path cannot be under it */ }
  const rel = path.relative(realRoot, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new RehearsalError(`refusing: --from must be under ${root}`)
  return real
}

/** Destination bucket for --files: never production or dev. */
export function assertFilesBucket(bucket) {
  if (typeof bucket !== 'string' || !/^[a-z0-9.-]{3,63}$/.test(bucket)) throw new RehearsalError(`bad bucket name "${bucket}"`)
  if (bucket === PROD_BUCKET) throw new RehearsalError('refusing: destination is the PRODUCTION files bucket')
  if (bucket === DEV_BUCKET) throw new RehearsalError('refusing: destination is the DEV files bucket')
  return bucket
}

/** `amplify get-branch` environmentVariables must say BCAT_DEV_STACK=true. */
export const branchIsDevStack = (envVars) => envVars?.BCAT_DEV_STACK === 'true'

// ── pure data helpers ────────────────────────────────────────────────────────────────────────────

/** One jsonl line -> DynamoDB-JSON item (accepts a bare item or {"Item": {...}}); null for blank lines. */
export function parseLine(line) {
  if (!line || !line.trim()) return null
  let obj
  try { obj = JSON.parse(line) } catch { throw new RehearsalError('malformed JSON line') }
  const item = obj && typeof obj === 'object' && obj.Item && typeof obj.Item === 'object' ? obj.Item : obj
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RehearsalError('line is not an item object')
  const keys = Object.keys(item)
  if (!keys.length) throw new RehearsalError('empty item')
  for (const k of keys) {
    const v = item[k]
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) throw new RehearsalError('attribute is not DynamoDB-JSON')
  }
  return item
}

export function chunk(items, size = BATCH_SIZE) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * BatchWriteItem one chunk (<=25 PUTs) with unprocessed-item retry and exponential backoff.
 * Returns { written, failed }. `send` is (command) => Promise<{UnprocessedItems?}>; `sleep` injectable.
 */
export async function batchPut(send, table, items, { maxAttempts = 8, baseMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let pending = items.map((Item) => ({ PutRequest: { Item } }))
  for (let attempt = 0; pending.length && attempt < maxAttempts; attempt++) {
    if (attempt) await sleep(Math.min(5000, baseMs * 2 ** (attempt - 1)))
    const res = await send(new BatchWriteItemCommand({ RequestItems: { [table]: pending } }))
    pending = res?.UnprocessedItems?.[table] ?? []
  }
  return { written: items.length - pending.length, failed: pending.length }
}

/** Count which watched attribute names appear on an item (names only, never values). */
export function countContactAttrs(item, counts) {
  for (const k of Object.keys(item)) if (OUTSIDE_CONTACT_ATTRS.includes(k)) counts[k] = (counts[k] ?? 0) + 1
}

export function parseArgv(argv) {
  const o = { apply: false, files: false, tables: null, apiId: null, bucket: null, from: DEFAULT_FROM }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new RehearsalError(`${a} needs a value`); return v }
    if (a === '--api-id') o.apiId = val()
    else if (a === '--tables') o.tables = val().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--from') o.from = val()
    else if (a === '--bucket') o.bucket = val()
    else if (a === '--apply') o.apply = true
    else if (a === '--dry-run') o.apply = false
    else if (a === '--files') o.files = true
    else throw new RehearsalError(`unknown argument ${a}`)
  }
  return o
}

// ── AWS (read-only except the rehearsal PUTs) ────────────────────────────────────────────────────

function aws(args) {
  const r = spawnSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new RehearsalError(`aws ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || '').split('\n')[0]}`)
  return r.stdout ? JSON.parse(r.stdout) : null
}

function discoverApiId() {
  const apis = aws(['appsync', 'list-graphql-apis']).graphqlApis ?? []
  const cands = apis.filter((a) => a.apiId !== PROD_SUFFIX_FRAGMENT && a.apiId !== DEV_SUFFIX_FRAGMENT)
  const tagged = cands.filter((a) => Object.values(a.tags ?? {}).some((v) => String(v).toLowerCase().includes(BRANCH)))
  if (tagged.length === 1) return tagged[0].apiId
  throw new RehearsalError(`cannot discover the rehearsal api id (candidates: ${cands.map((c) => c.apiId).join(', ') || 'none'}); pass --api-id`)
}

function discoverFilesBucket() {
  const buckets = (aws(['s3api', 'list-buckets']).Buckets ?? []).map((b) => b.Name)
  const m = buckets.filter((n) => n.startsWith(`amplify-${APP_ID}-re`) && n.includes('bcatrateconfirmsbucket'))
  if (m.length !== 1) throw new RehearsalError(`cannot discover the rehearsal files bucket (${m.length} matches); pass --bucket`)
  return m[0]
}

function preflightDevStack() {
  const b = aws(['amplify', 'get-branch', '--app-id', APP_ID, '--branch-name', BRANCH]).branch
  return branchIsDevStack(b?.environmentVariables)
}

async function listTables(client) {
  const names = []
  let start
  do {
    const r = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start }))
    names.push(...(r.TableNames ?? []))
    start = r.LastEvaluatedTableName
  } while (start)
  return names
}

async function scanCount(client, table) {
  let n = 0
  let key
  do {
    const r = await client.send(new ScanCommand({ TableName: table, Select: 'COUNT', ExclusiveStartKey: key }))
    n += r.Count ?? 0
    key = r.LastEvaluatedKey
  } while (key)
  return n
}

async function* readItems(file) {
  const rl = createInterface({ input: createReadStream(file, { flags: 'r', encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const item = parseLine(line)
    if (item) yield item
  }
}

async function main() {
  const o = parseArgv(process.argv.slice(2))
  const apiId = o.apiId ?? discoverApiId()
  const suffix = rehearsalSuffix(apiId)
  const mode = o.apply ? 'APPLY' : 'dry-run'

  if (o.files) {
    const bucket = assertFilesBucket(o.bucket ?? discoverFilesBucket())
    const cmd = ['aws', 's3', 'sync', BACKUP_BUCKET_PREFIX, `s3://${bucket}/`]
    console.log(`rehearsalLoad --files  mode=${mode}\n  ${cmd.join(' ')}`)
    if (!o.apply) return console.log('(not run; add --apply). The backup bucket is only read.')
    if (!preflightDevStack()) throw new RehearsalError(`refusing --apply: branch ${BRANCH} does not have BCAT_DEV_STACK=true`)
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' })
    if (r.status !== 0) throw new RehearsalError(`s3 sync exit ${r.status}`)
    return
  }

  const dir = assertBackupPath(o.from)
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort()
  const models = o.tables ? files.filter((m) => o.tables.includes(m)) : files
  if (o.tables) for (const t of o.tables) if (!files.includes(t)) throw new RehearsalError(`no ${t}.jsonl in ${dir}`)

  console.log(`rehearsalLoad  mode=${mode}  api=${apiId}  source=${dir}  models=${models.length}`)
  if (o.apply) {
    if (!preflightDevStack()) throw new RehearsalError(`refusing --apply: branch ${BRANCH} does not have BCAT_DEV_STACK=true`)
    console.log(`preflight: branch ${BRANCH} has BCAT_DEV_STACK=true (SES/Twilio/Slack/EventBridge guarded)`)
  }

  // Table list is read-only; in a dry run an undeployed stack just means "skip".
  const client = new DynamoDBClient({ region: REGION })
  let existing = null
  try { existing = new Set(await listTables(client)) } catch (e) { if (o.apply) throw e }
  const rehearsalModels = existing ? [...existing].filter((t) => t.endsWith(`-${suffix}`)).map((t) => t.slice(0, -(suffix.length + 1))) : []
  if (existing && !rehearsalModels.length) console.log('rehearsal tables not found (stack not deployed yet?); source counts only')
  if (o.apply && !rehearsalModels.length) throw new RehearsalError('no rehearsal tables found; nothing to apply to')

  const summary = []
  const contact = {}
  let total = 0
  for (const model of models) {
    const file = path.join(dir, `${model}.jsonl`)
    const table = `${model}-${suffix}`
    const row = { model, source: 0, written: 0, failed: 0, skipped: false }
    const present = rehearsalModels.includes(model)
    const batch = []
    const flush = async () => {
      if (!batch.length) return
      const r = await batchPut((c) => client.send(c), table, batch.splice(0))
      row.written += r.written
      row.failed += r.failed
    }
    for await (const item of readItems(file)) {
      row.source++
      if (model === 'Driver') countContactAttrs(item, contact)
      if (o.apply && present) { batch.push(item); if (batch.length === BATCH_SIZE) await flush() }
    }
    if (o.apply && present) await flush()
    row.skipped = Boolean(existing) && rehearsalModels.length > 0 && !present
    total += row.source
    summary.push(row)
    console.log(`  ${model.padEnd(26)} source=${row.source}${o.apply ? ` written=${row.written} failed=${row.failed}` : ''}${row.skipped ? '  SKIPPED (rehearsal lacks model)' : ''}`)
  }
  console.log(`source total: ${total} items in ${models.length} tables`)

  const newInDev = rehearsalModels.filter((m) => !files.includes(m)).sort()
  if (newInDev.length) console.log(`new in dev (no jsonl): ${newInDev.join(', ')}`)
  console.log(`outside-contact attributes present on Driver rows (counts only): ${JSON.stringify(contact)}`)
  console.log('Cognito users are NOT loaded; the rehearsal uses its own temp identities.')

  if (o.apply) {
    let mismatch = 0
    for (const r of summary.filter((s) => !s.skipped)) {
      const count = await scanCount(client, `${r.model}-${suffix}`)
      const ok = count === r.source && r.failed === 0
      if (!ok) mismatch++
      console.log(`  verify ${r.model.padEnd(26)} source=${r.source} rehearsal=${count} ${ok ? 'OK' : 'MISMATCH'}`)
    }
    if (mismatch) throw new RehearsalError(`${mismatch} table(s) failed verification`)
  } else {
    console.log('\nDRY RUN: nothing written. Re-run with --apply to load.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`\nERROR: ${e?.message ?? e}`); process.exit(1) })
}
