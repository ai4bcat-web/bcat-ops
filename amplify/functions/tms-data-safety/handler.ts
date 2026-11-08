/**
 * tms-data-safety Lambda — nightly + manual S3 exports, export-everything CSV,
 * accountant CSVs, backup status.
 *
 * Event routing (the Lambda's resource policy admits only AppSync, EventBridge
 * and this function itself):
 *  - an event with `arguments` is ALWAYS AppSync: owner/ADMIN gate, never honours `kind`;
 *  - an event with `kind` and no `arguments` is EventBridge / self-invoke:
 *    NIGHTLY, NIGHTLY_CHECK, S3_EXPORT, CSV_CONTINUE, ACCOUNTING_RUN.
 *
 * AppSync calls return within seconds: long work is started as a job row plus a
 * self-`Event` invoke and polled through CSV_EXPORT_STATUS.
 */
import { DescribeContinuousBackupsCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { parseInput } from '../_shared/actionInputs'
import { authorize, type AppSyncIdentity, type DataSafetyCaller } from './authorize'
import {
  CSV_DENYLIST,
  LINK_TTL_SECONDS,
  buildLinks,
  checkS3Exports,
  createJob,
  createS3ExportJob,
  getJob,
  invokeSelf,
  kickIfStalled,
  listModels,
  newAccountingJob,
  newCsvJob,
  publicJob,
  resolveTables,
  runAccountingJob,
  runCsvJob,
  runS3Export,
  scanJobs,
  suffixFromShipmentTable,
  tableNameOf,
  writeAudit,
  type Deps,
  type ExportScope,
  type JobRec,
  type Row,
} from './export'

export type DataSafetyAction =
  | 'DATA_STATUS'
  | 'EXPORT_NOW'
  | 'CSV_EXPORT_START'
  | 'CSV_EXPORT_STATUS'
  | 'CSV_EXPORT_LINKS'
  | 'EXPORT_LIST'
  | 'ACCOUNTING_EXPORT'

const ACTIONS: DataSafetyAction[] = [
  'DATA_STATUS', 'EXPORT_NOW', 'CSV_EXPORT_START', 'CSV_EXPORT_STATUS', 'CSV_EXPORT_LINKS', 'EXPORT_LIST', 'ACCOUNTING_EXPORT',
]

export type InternalKind = 'NIGHTLY' | 'NIGHTLY_CHECK' | 'S3_EXPORT' | 'CSV_CONTINUE' | 'ACCOUNTING_RUN'
const INTERNAL_KINDS: InternalKind[] = ['NIGHTLY', 'NIGHTLY_CHECK', 'S3_EXPORT', 'CSV_CONTINUE', 'ACCOUNTING_RUN']

export interface AppSyncEvent {
  arguments: { action: string; input?: string | Record<string, unknown> | null }
  identity?: AppSyncIdentity | null
}
export interface InternalEvent {
  kind: string
  jobId?: string
}
export type DataSafetyEvent = AppSyncEvent | InternalEvent
export interface LambdaContext {
  getRemainingTimeInMillis(): number
}

const RUNNING_WINDOW_MS = 10 * 60_000

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const s3 = new S3Client({})
  const bucket = env.DATA_SAFETY_BUCKET_NAME ?? ''
  return {
    db: new DynamoDBClient({}),
    s3,
    lambda: new LambdaClient({}),
    bucket,
    jobTable: env.DATA_EXPORT_JOB_TABLE_NAME ?? '',
    auditTable: env.AUDIT_LOG_TABLE_NAME ?? '',
    suffix: suffixFromShipmentTable(env.SHIPMENT_TABLE_NAME ?? ''),
    functionName: env.AWS_LAMBDA_FUNCTION_NAME ?? '',
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    uuid: randomUUID,
    presign: (key, filename, expiresIn) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` }),
        { expiresIn },
      ),
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

async function dataStatus(deps: Deps): Promise<Row> {
  try {
    await checkS3Exports(deps)
  } catch (err) {
    console.warn('[tms-data-safety] export refresh failed:', String(err))
  }
  const models = await listModels(deps)
  const disabled: string[] = []
  let enabled = 0
  let earliest: number | null = null
  for (let i = 0; i < models.length; i += 10) {
    await Promise.all(
      models.slice(i, i + 10).map(async (model) => {
        try {
          const res = await deps.db.send(new DescribeContinuousBackupsCommand({ TableName: tableNameOf(deps, model) }))
          const pitr = res.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          if (pitr?.PointInTimeRecoveryStatus === 'ENABLED') {
            enabled++
            const t = pitr.EarliestRestorableDateTime?.getTime()
            // Every table can be restored from the LATEST of the per-table earliest times.
            if (t !== undefined && (earliest === null || t > earliest)) earliest = t
          } else disabled.push(model)
        } catch {
          disabled.push(model)
        }
      }),
    )
  }
  const nightlies = (await scanJobs(deps)).filter((j) => j.kind === 'NIGHTLY').sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  return {
    bucketName: deps.bucket,
    tableCount: models.length,
    pitrEnabledCount: enabled,
    pitrDisabled: disabled.sort(),
    earliestRestorableTime: earliest === null ? null : new Date(earliest).toISOString(),
    latestNightly: nightlies[0] ? publicJob(nightlies[0]) : null,
    nightlyEnabled: true,
    s3SyncCommand: `aws s3 sync s3://${deps.bucket}/exports/ ./bcat-exports/`,
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

const today = (deps: Deps): string => deps.now().slice(0, 10)

function scopeOf(input: Row): ExportScope {
  if (input.scope === undefined || input.scope === 'TMS') return 'TMS'
  if (input.scope === 'ALL') return 'ALL'
  throw new Error('scope must be TMS or ALL')
}

async function exportNow(deps: Deps, input: Row, caller: DataSafetyCaller): Promise<Row> {
  const scope = scopeOf(input)
  const id = `manual-${today(deps)}-${deps.uuid().slice(0, 8)}`
  const job = await createS3ExportJob(deps, {
    id, kind: 'S3_EXPORT', scope, prefix: `exports/manual/${id.slice('manual-'.length)}/`, startedBy: caller.email,
  })
  if (!job) throw new Error('Export id collision; try again')
  await writeAudit(deps, caller.email, 'EXPORT_NOW', id, { scope, tables: job.tables.length })
  await invokeSelf(deps, { kind: 'S3_EXPORT', jobId: id })
  return { job: publicJob(job) }
}

async function startCsv(deps: Deps, input: Row, caller: DataSafetyCaller): Promise<Row> {
  const scope = scopeOf(input)
  if (input.acknowledgePii !== true) throw new Error('Confirm that you understand the export contains personal data')
  if (scope === 'ALL' && input.confirmText !== 'EXPORT ALL') throw new Error('Type EXPORT ALL to export every table')
  const requested = Array.isArray(input.tables) ? input.tables.map(String) : undefined
  const tables = resolveTables(await listModels(deps), scope, { requested, denylist: CSV_DENYLIST })
  if (tables.length === 0) throw new Error('No tables to export')
  const running = (await scanJobs(deps)).find(
    (j) => j.kind === 'CSV_ALL' && j.status === 'RUNNING' && deps.nowMs() - (Date.parse(j.heartbeatAt ?? j.startedAt ?? '') || 0) < RUNNING_WINDOW_MS,
  )
  if (running) throw new Error(`A CSV export is already running (${running.id})`)
  const id = `csv-${today(deps)}-${deps.uuid().slice(0, 8)}`
  const job = newCsvJob(deps, { id, scope, tables, startedBy: caller.email })
  if (!(await createJob(deps, job))) throw new Error('Export id collision; try again')
  await writeAudit(deps, caller.email, 'CSV_EXPORT_START', id, { scope, tables, includesPii: job.includesPii, acknowledgePii: true })
  await invokeSelf(deps, { kind: 'CSV_CONTINUE', jobId: id })
  return { job: publicJob(job) }
}

async function startAccounting(deps: Deps, input: Row, caller: DataSafetyCaller): Promise<Row> {
  const options: Row = {}
  for (const key of ['from', 'to'] as const) {
    const v = input[key]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${key} must be YYYY-MM-DD`)
    options[key] = v
  }
  if (input.status) options.status = input.status
  const id = `acct-${today(deps)}-${deps.uuid().slice(0, 8)}`
  const job = newAccountingJob(deps, id, caller.email, options)
  await createJob(deps, job)
  await writeAudit(deps, caller.email, 'ACCOUNTING_EXPORT', id, { ...options, includesPii: true })
  await invokeSelf(deps, { kind: 'ACCOUNTING_RUN', jobId: id })
  return { job: publicJob(job) }
}

async function requireJob(deps: Deps, input: Row): Promise<JobRec> {
  const jobId = typeof input.jobId === 'string' ? input.jobId : ''
  if (!jobId) throw new Error('jobId is required')
  const job = await getJob(deps, jobId)
  if (!job) throw new Error(`Export job not found: ${jobId}`)
  return job
}

async function csvStatus(deps: Deps, input: Row): Promise<Row> {
  const job = await requireJob(deps, input)
  await kickIfStalled(deps, job)
  return { job: publicJob(job) }
}

async function csvLinks(deps: Deps, input: Row, caller: DataSafetyCaller): Promise<Row> {
  const job = await requireJob(deps, input)
  if (job.kind !== 'CSV_ALL' && job.kind !== 'ACCOUNTING') throw new Error('Only CSV exports have download links')
  const { files, manifestUrl } = await buildLinks(deps, job)
  await writeAudit(deps, caller.email, 'CSV_EXPORT_LINKS', job.id, {
    scope: job.scope ?? null,
    tables: job.tables.map((t) => t.table),
    includesPii: job.includesPii ?? false,
    fileCount: files.length,
  })
  return {
    jobId: job.id,
    expiresInSeconds: LINK_TTL_SECONDS,
    files: files.map((f) => ({ name: f.name, key: f.key, url: f.url, bytes: f.bytes, sha256: f.sha256, pii: f.pii })),
    manifestUrl,
  }
}

async function exportList(deps: Deps): Promise<Row> {
  const jobs = (await scanJobs(deps)).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 50)
  return { jobs: jobs.map(publicJob) }
}

async function runAppSync(event: AppSyncEvent, deps: Deps, auth: typeof authorize): Promise<Row> {
  const action = event.arguments.action as DataSafetyAction
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}. Expected one of ${ACTIONS.join(', ')}`)
  const caller = await auth(event.identity)
  const input = parseInput(event.arguments.input)
  switch (action) {
    case 'DATA_STATUS':
      return dataStatus(deps)
    case 'EXPORT_NOW':
      return exportNow(deps, input, caller)
    case 'CSV_EXPORT_START':
      return startCsv(deps, input, caller)
    case 'CSV_EXPORT_STATUS':
      return csvStatus(deps, input)
    case 'CSV_EXPORT_LINKS':
      return csvLinks(deps, input, caller)
    case 'EXPORT_LIST':
      return exportList(deps)
    case 'ACCOUNTING_EXPORT':
      return startAccounting(deps, input, caller)
  }
}

// ── EventBridge / self ──────────────────────────────────────────────────────

async function runNightly(deps: Deps): Promise<Row> {
  const date = today(deps)
  // Sunday (UTC) is the full backup; weekdays export the TMS business tables.
  const scope: ExportScope = new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? 'ALL' : 'TMS'
  const id = `nightly-${date}`
  const job = await createS3ExportJob(deps, { id, kind: 'NIGHTLY', scope, prefix: `exports/nightly/${date}/`, startedBy: 'system:nightly' })
  if (!job) return { skipped: true, reason: 'already ran', jobId: id }
  const done = await runS3Export(deps, id)
  return { jobId: id, scope, status: done?.status ?? null }
}

async function runInternal(event: InternalEvent, context: LambdaContext, deps: Deps): Promise<Row> {
  const kind = event.kind as InternalKind
  if (!INTERNAL_KINDS.includes(kind)) throw new Error(`Unknown kind: ${event.kind}`)
  if (kind === 'NIGHTLY') return runNightly(deps)
  if (kind === 'NIGHTLY_CHECK') {
    const jobs = await checkS3Exports(deps)
    return { checked: jobs.length }
  }
  if (!event.jobId) throw new Error(`${kind} needs jobId`)
  const job =
    kind === 'S3_EXPORT'
      ? await runS3Export(deps, event.jobId)
      : kind === 'CSV_CONTINUE'
        ? await runCsvJob(deps, event.jobId, context.getRemainingTimeInMillis())
        : await runAccountingJob(deps, event.jobId)
  return { jobId: event.jobId, status: job?.status ?? null }
}

export async function dispatch(
  event: DataSafetyEvent,
  context: LambdaContext,
  deps: Deps,
  auth: typeof authorize = authorize,
): Promise<Row> {
  if ('arguments' in event && event.arguments) return runAppSync(event, deps, auth)
  if ('kind' in event && typeof event.kind === 'string') return runInternal(event, context, deps)
  throw new Error('Unrecognised event')
}

export const handler = async (event: DataSafetyEvent, context: LambdaContext): Promise<Row> =>
  dispatch(event, context, defaultDeps())
