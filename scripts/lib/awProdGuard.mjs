/**
 * Guard, log, checkpoint and table-count helpers for scripts/awProd.mjs (the ONE guarded production entry point of
 * the Aljex data load). Nothing here loosens the per-file production refusals: those scripts and the engine guards are
 * untouched. This module decides WHEN awProd may touch production and records what it did (counts only).
 *
 * Production is identified by the AppSync API id / table suffix only. Dev (nc3jsnxdmjhkpequimypiatkma) and every other
 * suffix is refused. Dry run is the default; an apply needs --apply AND env AW_PROD_CONFIRM=<today>-<step>, a backup
 * stamp younger than 6 hours, a production root stack in UPDATE_COMPLETE, no Amplify job running on main, and a deployed
 * BCAT_SCHEMA_STAGE high enough to have created the tables the step needs.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { ScanCommand } from '@aws-sdk/lib-dynamodb'

export const PROD_API_ID = '5ucwdyvwivelbo4k4jomvrwel4'
export const PROD_SUFFIX = `${PROD_API_ID}-NONE`
export const DEV_API_ID = 'nc3jsnxdmjhkpequimypiatkma'
export const APP_ID = 'd3dejqzs77khq6'
export const BRANCH = 'main'
export const REGION = 'us-east-1'
export const STAMP_MAX_AGE_MS = 6 * 60 * 60 * 1000
export const BACKUPS_DIR = join(homedir(), 'bcat-ops-backups')
export const STAMP_FILE = join(BACKUPS_DIR, 'LATEST_BACKUP_STAMP')
export const LOG_DIR = join(BACKUPS_DIR, 'aw-prod-logs')
/** What the stack's table-less schema stage means when BCAT_SCHEMA_STAGE is unset: everything (stages.ts FINAL_STAGE). */
export const FINAL_STAGE = 4

const ALJEX_IMPORT_MODELS = [
  'Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Customer', 'Location', 'Carrier',
  'Invoice', 'ArPayment', 'CarrierBill', 'ApPayment', 'ProClaim', 'TmsSettings', 'AuditLog', 'LegacyAljexRow',
]
const FILE_MODELS = [...ALJEX_IMPORT_MODELS, 'AljexImportJob']

/**
 * Per step: `writes` = models whose counts are snapshotted before/after (an apply may touch them), `reads` = extra models
 * the step needs to exist (stage check), `mutates` = false for steps that can never change production state.
 * `plan` = the dry run itself stages a job (Lambda PLAN); never true for the default dry run.
 */
export const STEPS = {
  settings: { writes: ['TmsSettings', 'AuditLog'], reads: ['ProClaim'] },
  jenny: { writes: ['UserProfile'], reads: [] },
  backfill: { writes: ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'ProClaim', 'AuditLog'], reads: [] },
  'stage-export': { writes: ['AljexImportJob'], reads: [] },
  customers: { writes: FILE_MODELS, reads: [] },
  carriers: { writes: FILE_MODELS, reads: [] },
  'ap-aging': { writes: FILE_MODELS, reads: [] },
  'ap-expected': { writes: FILE_MODELS, reads: [] },
  ar: { writes: FILE_MODELS, reads: [] },
  loads: { writes: ALJEX_IMPORT_MODELS, reads: ['AljexImportJob'] },
  'tax-ids': { writes: ['Carrier'], reads: [] },
  reconcile: { writes: ['AljexImportJob'], reads: [] },
  verify: { writes: [], reads: [], readOnly: true },
}
export const STEP_NAMES = Object.keys(STEPS)

export class AwProdRefusal extends Error {
  /** @param {string} message @param {string[]} [failures] */
  constructor(message, failures = []) {
    super(message)
    this.name = 'AwProdRefusal'
    this.failures = failures
  }
}

export const pad = (n) => String(n).padStart(2, '0')
export const localDate = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
export const confirmTokenFor = (step, now = new Date()) => `${localDate(now)}-${step}`
export const stamp = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-')

/** The production table suffix for a `--suffix` value (bare API id or `<id>-NONE`); throws for anything else. */
export function resolveProdSuffix(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) throw new AwProdRefusal(`--suffix ${PROD_API_ID} is required for every awProd step (there is no default)`)
  if (v.includes(DEV_API_ID)) throw new AwProdRefusal('Refusing the DEV suffix: awProd only targets production. Use the per-file scripts for dev.')
  if (v !== PROD_API_ID && v !== PROD_SUFFIX) throw new AwProdRefusal(`Refusing suffix "${v}": awProd only accepts ${PROD_API_ID}`)
  return PROD_SUFFIX
}

/** Highest stage that creates a model the step uses. `stages` = { MODEL_STAGE, PRODUCTION_MODELS, LAST_MODEL_STAGE }. */
export function requiredStage(step, stages) {
  const spec = STEPS[step]
  if (!spec) throw new AwProdRefusal(`Unknown step "${step}"`)
  let need = step === 'verify' ? 0 : 0
  if (['customers', 'carriers', 'ap-aging', 'ap-expected', 'ar', 'stage-export', 'loads', 'reconcile'].includes(step)) need = stages.LAST_MODEL_STAGE
  for (const m of [...spec.writes, ...spec.reads]) {
    if (stages.PRODUCTION_MODELS.has(m)) continue
    need = Math.max(need, stages.MODEL_STAGE[m] ?? stages.LAST_MODEL_STAGE)
  }
  if (step === 'tax-ids') need = Math.max(need, 1)
  return need
}

/** BCAT_SCHEMA_STAGE the same way amplify/data/stages.ts reads it: unset/empty = everything, capped at FINAL_STAGE. */
export function parseStage(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return FINAL_STAGE
  const n = Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 0) throw new AwProdRefusal(`BCAT_SCHEMA_STAGE=${JSON.stringify(raw)} on main is not a non-negative integer`)
  return Math.min(n, FINAL_STAGE)
}

// ── environment state (read-only AWS metadata) ─────────────────────────────────────────────────────

export const defaultAws = async (args) => {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) reject(new Error(`aws ${args.slice(0, 2).join(' ')} failed`))
      else resolve(JSON.parse(out))
    })
  })
}

const COMPLETE_ROOT = 'UPDATE_COMPLETE'

/**
 * Read-only: production root stack status, Amplify jobs on main, deployed schema stage. `aws(args)` returns parsed JSON.
 * @returns {Promise<{rootStack: string|null, rootStatus: string|null, runningJobs: number, stage: number|null, stageError?: string}>}
 */
export async function readProdState(aws = defaultAws) {
  const prefix = `amplify-${APP_ID}-${BRANCH}-branch-`
  const stacks = (await aws(['cloudformation', 'list-stacks'])).StackSummaries ?? []
  const roots = stacks
    .filter((s) => s.StackName.startsWith(prefix) && !s.ParentId && s.StackStatus !== 'DELETE_COMPLETE')
    .sort((a, b) => String(b.CreationTime).localeCompare(String(a.CreationTime)))
  const root = roots[0] ?? null
  const jobs = (await aws(['amplify', 'list-jobs', '--app-id', APP_ID, '--branch-name', BRANCH, '--max-results', '10'])).jobSummaries ?? []
  const runningJobs = jobs.filter((j) => ['RUNNING', 'PENDING', 'PROVISIONING'].includes(j.status)).length
  const branch = (await aws(['amplify', 'get-branch', '--app-id', APP_ID, '--branch-name', BRANCH])).branch ?? {}
  let stage = null
  let stageError
  try {
    stage = parseStage(branch.environmentVariables?.BCAT_SCHEMA_STAGE)
  } catch (err) {
    stageError = err.message
  }
  return { rootStack: root?.StackName ?? null, rootStatus: root?.StackStatus ?? null, runningJobs, stage, ...(stageError ? { stageError } : {}) }
}

/** Age of the backup stamp file: { ok, ageMinutes, reason }. `fs` seam for tests. */
export function checkBackupStamp({ now = new Date(), file = STAMP_FILE, fs = { existsSync, statSync } } = {}) {
  if (!fs.existsSync(file)) return { ok: false, ageMinutes: null, reason: `backup stamp ${file} is missing` }
  const age = now.getTime() - fs.statSync(file).mtime.getTime()
  const ageMinutes = Math.round(age / 60000)
  if (age > STAMP_MAX_AGE_MS) return { ok: false, ageMinutes, reason: `backup stamp is ${ageMinutes} min old (limit 360)` }
  if (age < -60_000) return { ok: false, ageMinutes, reason: 'backup stamp is dated in the future' }
  return { ok: true, ageMinutes, reason: null }
}

export const STAMP_HELP = `Create the stamp ONLY after the fresh production backup finished:  date -u +%FT%TZ > ${STAMP_FILE}`

/**
 * Pure refusal matrix. `suffix` is already resolved. Dry run: only unknown-step/suffix problems throw earlier; the
 * rest is returned as `wouldRefuse` so the dry run can show what an apply would hit.
 * @returns {{failures: string[]}}
 */
export function evaluateRun({ step, apply, env, now = new Date(), stampState, state, stages, extra = [] }) {
  const failures = [...extra]
  if (apply) {
    const want = confirmTokenFor(step, now)
    if (env.AW_PROD_CONFIRM !== want) failures.push(`set AW_PROD_CONFIRM=${want} (typed per step; today's date and this step name)`)
  }
  if (!stampState?.ok) failures.push(`${stampState?.reason ?? 'backup stamp not checked'}. ${STAMP_HELP}`)
  if (state?.rootStatus !== COMPLETE_ROOT) failures.push(`production root stack is ${state?.rootStatus ?? 'NOT FOUND'}, must be ${COMPLETE_ROOT}`)
  if ((state?.runningJobs ?? 0) > 0) failures.push(`${state.runningJobs} Amplify job(s) on ${BRANCH} are running/pending: wait for them to finish`)
  if (state?.stage == null) failures.push(`deployed BCAT_SCHEMA_STAGE could not be read${state?.stageError ? ` (${state.stageError})` : ''}`)
  else {
    const need = requiredStage(step, stages)
    if (state.stage < need) failures.push(`BCAT_SCHEMA_STAGE on ${BRANCH} is ${state.stage}; ${step} needs stage >= ${need} (the stage that creates its tables)`)
  }
  return { failures }
}

// ── scrubbed log ───────────────────────────────────────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const TAXLIKE = /\b\d{2}-\d{7}\b|\b\d{3}-\d{2}-\d{4}\b/g
const PHONE = /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g
const LONGDIGITS = /\b\d{9,}\b/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SECRETKV = /(password|passwd|secret|token|fed\/?ss|bank|routing|account)\s*[:=]\s*\S+/gi
const BEARER = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g

/** Mask anything that could be PII or a secret in a free-text line. Counts and short words survive. */
export function scrub(text) {
  return String(text)
    .replace(BEARER, '[token]')
    .replace(SECRETKV, (m) => `${m.split(/[:=]/)[0]}=[hidden]`)
    .replace(EMAIL, '[email]')
    .replace(TAXLIKE, '[id]')
    .replace(PHONE, '[phone]')
    .replace(UUID, '[uuid]')
    .replace(LONGDIGITS, '[digits]')
}

/** `***123`: the only form in which a PRO is ever logged. */
export const maskPro = (pro) => `***${String(pro ?? '').slice(-3)}`

/**
 * One log file per run. `info` writes scrubbed text; `counts` writes only finite numbers. `fs` seam for tests.
 * @returns {{path: string, info: (s: string) => void, counts: (label: string, obj: Record<string, number>) => void, lines: string[]}}
 */
export function createLog(step, { dir = LOG_DIR, now = new Date(), fs = { mkdirSync, appendFileSync } } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const path = join(dir, `${step}-${stamp(now)}.log`)
  const lines = []
  const write = (line) => {
    lines.push(line)
    fs.appendFileSync(path, `${line}\n`)
  }
  return {
    path,
    lines,
    info: (s) => write(scrub(s)),
    counts: (label, obj) => {
      const parts = Object.entries(obj).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([k, v]) => `${scrub(k)}=${v}`)
      write(`${scrub(label)}: ${parts.join(' ')}`)
    },
  }
}

// ── checkpoint ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Completed-chunk ledger kept next to the logs: `<step>.checkpoint.json`. Keyed by an input fingerprint so a different
 * input never resumes an old run. Holds chunk keys (hashes) and counters only.
 */
export function createCheckpoint(step, fingerprint, { dir = LOG_DIR, fs = { existsSync, readFileSync, writeFileSync, mkdirSync }, fresh = false } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const path = join(dir, `${step}.checkpoint.json`)
  let data = { step, fingerprint, done: {} }
  if (!fresh && fs.existsSync(path)) {
    try {
      const prev = JSON.parse(fs.readFileSync(path, 'utf8'))
      if (prev.step === step && prev.fingerprint === fingerprint && prev.done && typeof prev.done === 'object') data = prev
    } catch { /* unreadable: start over */ }
  }
  const save = () => fs.writeFileSync(path, JSON.stringify(data))
  return {
    path,
    has: (key) => Object.hasOwn(data.done, key),
    get: (key) => data.done[key],
    mark: (key, value = true) => { data.done[key] = value; save() },
    size: () => Object.keys(data.done).length,
  }
}

export const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// ── table counts ───────────────────────────────────────────────────────────────────────────────────

const UNKNOWN = null

/** DescribeTable ItemCount (DynamoDB refreshes it about every 6 h) and, when `exact`, a Scan COUNT. null = table absent. */
export async function countTable({ dynamo, doc }, table, { exact = false } = {}) {
  let described = UNKNOWN
  try {
    const r = await dynamo.send(new DescribeTableCommand({ TableName: table }))
    described = Number(r.Table?.ItemCount ?? 0)
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return { described: UNKNOWN, scanned: UNKNOWN }
    throw err
  }
  let scanned = UNKNOWN
  if (exact && doc) {
    scanned = 0
    let key
    do {
      const p = await doc.send(new ScanCommand({ TableName: table, Select: 'COUNT', ExclusiveStartKey: key }))
      scanned += Number(p.Count ?? 0)
      key = p.LastEvaluatedKey
    } while (key)
  }
  return { described, scanned }
}

/** Snapshot `<Model>-<suffix>` counts for every model. Scan COUNT is exact; used for the tables an apply writes. */
export async function snapshotTables(clients, models, suffix, opts = { exact: true }) {
  const out = {}
  for (const m of models) out[m] = await countTable(clients, `${m}-${suffix}`, opts)
  return out
}

/** Logs "<model> before=… after=… delta=…" for every table; numbers only. */
export function logTableDiff(log, before, after) {
  for (const m of Object.keys(after)) {
    const b = before[m] ?? {}
    const a = after[m]
    const pick = (x) => x?.scanned ?? x?.described
    const nb = pick(b)
    const na = pick(a)
    log.info(`table ${m}: before ${nb ?? 'absent'}, after ${na ?? 'absent'}${typeof nb === 'number' && typeof na === 'number' ? `, delta ${na - nb}` : ''} (DescribeTable ${b.described ?? 'n/a'} -> ${a.described ?? 'n/a'})`)
  }
}
