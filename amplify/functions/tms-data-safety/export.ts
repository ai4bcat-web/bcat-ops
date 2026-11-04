/**
 * Data-safety engine: S3 DynamoDB exports (nightly + manual), resumable CSV
 * export of whole tables, and the accountant CSVs. All AWS access goes through
 * `Deps` so the tests drive it with in-memory fakes.
 *
 * Table names are never configured one by one: every model's table is
 * `<Model>-<suffix>` where the suffix (`<apiId>-NONE`) is read off
 * SHIPMENT_TABLE_NAME. Rehearsal copies (`...-NONE-rh<tag>`) therefore never match.
 */
import {
  DescribeContinuousBackupsCommand,
  DescribeExportCommand,
  DescribeTableCommand,
  ExportTableToPointInTimeCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  ScanCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHash } from 'crypto'
import { buildAccountingFiles } from './accounting'
import { orderColumns, rawHeaderLine, rawRowLine, sha256Hex } from './csv'

export type Row = Record<string, unknown>
export type ExportScope = 'TMS' | 'ALL'
export type ExportKind = 'NIGHTLY' | 'NIGHTLY_CHECK' | 'S3_EXPORT' | 'CSV_ALL' | 'ACCOUNTING'
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL'
export type TableStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED_NO_PITR'

export interface PartMeta {
  name: string
  key: string
  rows: number
  bytes: number
  sha256: string
}

export interface TableProgress {
  table: string
  status: TableStatus
  exportArn?: string | null
  rows?: number | null
  bytes?: number | null
  files?: number | null
  pii?: boolean
  error?: string | null
  /** Stored with the job so the manifest and the download links need no listing; never returned to clients. */
  parts?: PartMeta[]
}

export interface JobRec {
  id: string
  kind: ExportKind
  status: JobStatus
  scope?: ExportScope | null
  tables: TableProgress[]
  prefix?: string | null
  cursor?: Row | null
  heartbeatAt?: string | null
  includesPii?: boolean | null
  startedBy?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
  createdAt?: string
}

export interface Deps {
  db: DynamoDBClient
  s3: S3Client
  lambda: LambdaClient
  bucket: string
  jobTable: string
  auditTable: string
  /** `<apiId>-NONE`, shared by every table of this stack. */
  suffix: string
  functionName: string
  now: () => string
  nowMs: () => number
  uuid: () => string
  presign: (key: string, filename: string, expiresInSeconds: number) => Promise<string>
  /** Scan page cap; unset in production (1 MB pages). */
  pageLimit?: number
}

// ── Scope ───────────────────────────────────────────────────────────────────

export const TMS_TABLES = [
  'Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Invoice', 'ArPayment',
  'CarrierBill', 'ApPayment', 'Customer', 'Location', 'Carrier', 'CarrierContact', 'CarrierPaymentMethod',
  'CarrierDocument', 'ShipmentDocument', 'ShipmentNotice', 'ProClaim', 'Quote', 'TmsSettings', 'Division',
  'OwnershipDivision', 'OwnershipRule', 'FactoringItem', 'LegacyAljexRow', 'AljexCodeMap', 'AljexImportJob',
  'AljexMappingProfile', 'AuditLog',
]
/** Prefix families that belong to the TMS scope (Commission*). */
const TMS_PREFIXES = ['Commission']
/** Never written to a CSV a person can download (settings rows that may hold secrets). */
export const CSV_DENYLIST = ['Integration']
export const PII_TABLES = [
  'Driver', 'DriverSubmission', 'DriverSubmissionDoc', 'UserProfile', 'CarrierContact', 'Customer', 'Location',
  'LegacyAljexRow', 'CarrierPaymentMethod',
]

export const ACCOUNTING_PREFIX = 'accounting/'
export const ACCOUNTING_FILES = ['invoices.csv', 'ar-payments.csv', 'carrier-bills.csv', 'ap-payments.csv']
export const LINK_TTL_SECONDS = 900
const SEGMENTS = 4
const PART_BYTES = 40 * 1024 * 1024
const HEARTBEAT_EVERY_MS = 20_000
const SAFETY_MS = 60_000
const STALL_MS = 3 * 60_000

export function suffixFromShipmentTable(shipmentTable: string): string {
  if (!shipmentTable.startsWith('Shipment-')) throw new Error('SHIPMENT_TABLE_NAME is not configured')
  return shipmentTable.slice('Shipment-'.length)
}

export async function listModels(deps: Deps): Promise<string[]> {
  const tail = `-${deps.suffix}`
  const models: string[] = []
  let start: string | undefined
  do {
    const res = await deps.db.send(new ListTablesCommand({ ExclusiveStartTableName: start }))
    for (const name of res.TableNames ?? []) if (name.endsWith(tail)) models.push(name.slice(0, -tail.length))
    start = res.LastEvaluatedTableName
  } while (start)
  return models.sort()
}

export function inTmsScope(model: string): boolean {
  return TMS_TABLES.includes(model) || TMS_PREFIXES.some((p) => model.startsWith(p))
}

/** Tables of a scope that exist in the stack; `requested` narrows (and is validated against) the scope. */
export function resolveTables(models: string[], scope: ExportScope, opts: { requested?: string[]; denylist?: string[] } = {}): string[] {
  const deny = opts.denylist ?? []
  const inScope = models.filter((m) => !deny.includes(m) && (scope === 'ALL' || inTmsScope(m)))
  if (!opts.requested || opts.requested.length === 0) return inScope
  const unknown = opts.requested.filter((t) => !inScope.includes(t))
  if (unknown.length > 0) throw new Error(`Tables not available in scope ${scope}: ${unknown.join(', ')}`)
  return inScope.filter((m) => opts.requested!.includes(m))
}

export const tableNameOf = (deps: Deps, model: string): string => `${model}-${deps.suffix}`

// ── Job rows ────────────────────────────────────────────────────────────────

function jobToItem(job: JobRec, nowIso: string): Row {
  return {
    id: job.id,
    __typename: 'DataExportJob',
    kind: job.kind,
    status: job.status,
    scope: job.scope ?? undefined,
    tables: JSON.stringify(job.tables),
    prefix: job.prefix ?? undefined,
    cursor: job.cursor ? JSON.stringify(job.cursor) : undefined,
    heartbeatAt: job.heartbeatAt ?? nowIso,
    includesPii: job.includesPii ?? false,
    startedBy: job.startedBy ?? undefined,
    startedAt: job.startedAt ?? nowIso,
    finishedAt: job.finishedAt ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt ?? nowIso,
    updatedAt: nowIso,
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value && typeof value === 'object' ? (value as T) : fallback
}

function itemToJob(item: Row): JobRec {
  return {
    id: String(item.id),
    kind: item.kind as ExportKind,
    status: item.status as JobStatus,
    scope: (item.scope as ExportScope | undefined) ?? null,
    tables: parseJson<TableProgress[]>(item.tables, []),
    prefix: (item.prefix as string | undefined) ?? null,
    cursor: parseJson<Row | null>(item.cursor, null),
    heartbeatAt: (item.heartbeatAt as string | undefined) ?? null,
    includesPii: (item.includesPii as boolean | undefined) ?? false,
    startedBy: (item.startedBy as string | undefined) ?? null,
    startedAt: (item.startedAt as string | undefined) ?? null,
    finishedAt: (item.finishedAt as string | undefined) ?? null,
    error: (item.error as string | undefined) ?? null,
    createdAt: item.createdAt as string | undefined,
  }
}

export async function getJob(deps: Deps, id: string): Promise<JobRec | null> {
  const res = await deps.db.send(new GetItemCommand({ TableName: deps.jobTable, Key: marshall({ id }) }))
  return res.Item ? itemToJob(unmarshall(res.Item)) : null
}

/** Insert a job; false when the id already exists. */
export async function createJob(deps: Deps, job: JobRec): Promise<boolean> {
  try {
    await deps.db.send(
      new PutItemCommand({
        TableName: deps.jobTable,
        Item: marshall(jobToItem(job, deps.now()), { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

/** Single-writer overwrite (one worker owns a running job). Stamps the heartbeat. */
export async function saveJob(deps: Deps, job: JobRec): Promise<void> {
  job.heartbeatAt = deps.now()
  const existing = job.createdAt
  await deps.db.send(
    new PutItemCommand({
      TableName: deps.jobTable,
      Item: marshall(jobToItem({ ...job, createdAt: existing }, deps.now()), { removeUndefinedValues: true }),
    }),
  )
}

export async function scanJobs(deps: Deps): Promise<JobRec[]> {
  const out: JobRec[] = []
  let key: Record<string, never> | undefined
  do {
    const res = await deps.db.send(new ScanCommand({ TableName: deps.jobTable, ExclusiveStartKey: key as never }))
    for (const item of res.Items ?? []) out.push(itemToJob(unmarshall(item)))
    key = res.LastEvaluatedKey as never
  } while (key)
  return out
}

/** What clients see: stored extras (`parts`) and the heavy cursor state stay server-side. */
export function publicJob(job: JobRec): Row {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    scope: job.scope ?? null,
    tables: job.tables.map(({ parts: _parts, ...rest }) => ({ ...rest, files: rest.files ?? _parts?.length ?? null })),
    prefix: job.prefix ?? null,
    cursor: null,
    heartbeatAt: job.heartbeatAt ?? null,
    includesPii: job.includesPii ?? false,
    startedBy: job.startedBy ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
  }
}

export async function writeAudit(
  deps: Deps,
  who: string,
  action: string,
  entityId: string,
  changes: Row,
): Promise<void> {
  const now = deps.now()
  await deps.db.send(
    new PutItemCommand({
      TableName: deps.auditTable,
      Item: marshall(
        {
          id: deps.uuid(),
          __typename: 'AuditLog',
          entityType: 'DataExport',
          entityId,
          action,
          user: who,
          changes: JSON.stringify(changes),
          createdAt: now,
          updatedAt: now,
        },
        { removeUndefinedValues: true },
      ),
    }),
  )
}

export async function invokeSelf(deps: Deps, payload: Row): Promise<void> {
  await deps.lambda.send(
    new InvokeCommand({
      FunctionName: deps.functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  )
}

async function putObject(deps: Deps, key: string, body: string, contentType: string): Promise<void> {
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: Buffer.from(body, 'utf8'), ContentType: contentType }))
}

async function getObjectText(deps: Deps, key: string): Promise<string | null> {
  try {
    const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }))
    return (await res.Body?.transformToString('utf-8')) ?? null
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') return null
    throw err
  }
}

function summarizeStatus(tables: TableProgress[]): { status: JobStatus; failed: number } {
  const failed = tables.filter((t) => t.status === 'FAILED' || t.status === 'SKIPPED_NO_PITR').length
  const completed = tables.filter((t) => t.status === 'COMPLETED').length
  if (failed === 0) return { status: 'COMPLETED', failed }
  return { status: completed === 0 ? 'FAILED' : 'PARTIAL', failed }
}

// ── S3 (DynamoDB-JSON) exports ──────────────────────────────────────────────

export interface S3ExportStart {
  id: string
  kind: 'NIGHTLY' | 'S3_EXPORT'
  scope: ExportScope
  prefix: string
  startedBy: string
}

/** Create the job (false if `id` exists). The work itself is runS3Export. */
export async function createS3ExportJob(deps: Deps, start: S3ExportStart): Promise<JobRec | null> {
  const models = await listModels(deps)
  const tables = resolveTables(models, start.scope)
  const job: JobRec = {
    id: start.id,
    kind: start.kind,
    status: 'RUNNING',
    scope: start.scope,
    tables: tables.map((table) => ({ table, status: 'PENDING', pii: PII_TABLES.includes(table) })),
    prefix: start.prefix,
    includesPii: true,
    startedBy: start.startedBy,
    startedAt: deps.now(),
    createdAt: deps.now(),
  }
  return (await createJob(deps, job)) ? job : null
}

async function exportOne(deps: Deps, job: JobRec, progress: TableProgress): Promise<void> {
  const TableName = tableNameOf(deps, progress.table)
  try {
    const cb = await deps.db.send(new DescribeContinuousBackupsCommand({ TableName }))
    const enabled = cb.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED'
    if (!enabled) {
      progress.status = 'SKIPPED_NO_PITR'
      return
    }
    const desc = await deps.db.send(new DescribeTableCommand({ TableName }))
    const arn = desc.Table?.TableArn
    if (!arn) throw new Error('table ARN unavailable')
    const exp = await deps.db.send(
      new ExportTableToPointInTimeCommand({
        TableArn: arn,
        S3Bucket: deps.bucket,
        S3Prefix: `${job.prefix}${progress.table}/`,
        ExportFormat: 'DYNAMODB_JSON',
        ClientToken: createHash('sha1').update(`${job.id}:${progress.table}`).digest('hex').slice(0, 32),
      }),
    )
    progress.exportArn = exp.ExportDescription?.ExportArn ?? null
    progress.status = 'RUNNING'
  } catch (err) {
    progress.status = 'FAILED'
    progress.error = String((err as Error)?.message ?? err).slice(0, 300)
  }
}

/** Start every pending table's export, 10 at a time. */
export async function runS3Export(deps: Deps, jobId: string): Promise<JobRec | null> {
  const job = await getJob(deps, jobId)
  if (!job || job.status !== 'RUNNING') return job
  const pending = job.tables.filter((t) => t.status === 'PENDING')
  for (let i = 0; i < pending.length; i += 10) {
    await Promise.all(pending.slice(i, i + 10).map((t) => exportOne(deps, job, t)))
    await saveJob(deps, job)
  }
  finalizeS3Job(deps, job)
  await saveJob(deps, job)
  return job
}

function finalizeS3Job(deps: Deps, job: JobRec): void {
  const waiting = job.tables.some((t) => t.status === 'PENDING' || t.status === 'RUNNING')
  if (waiting) return
  const { status, failed } = summarizeStatus(job.tables)
  job.status = status
  job.finishedAt = deps.now()
  if (failed > 0) {
    const skipped = job.tables.filter((t) => t.status === 'SKIPPED_NO_PITR').length
    job.error = `${failed - skipped} failed, ${skipped} skipped (point-in-time recovery off)`
  }
}

/** DescribeExport every in-flight export of every running S3 job. */
export async function checkS3Exports(deps: Deps): Promise<JobRec[]> {
  const jobs = (await scanJobs(deps)).filter((j) => (j.kind === 'NIGHTLY' || j.kind === 'S3_EXPORT') && j.status === 'RUNNING')
  for (const job of jobs) {
    for (const t of job.tables) {
      if (t.status !== 'RUNNING' || !t.exportArn) continue
      try {
        const res = await deps.db.send(new DescribeExportCommand({ ExportArn: t.exportArn }))
        const d = res.ExportDescription
        if (d?.ExportStatus === 'COMPLETED') {
          t.status = 'COMPLETED'
          t.rows = d.ItemCount ?? null
          t.bytes = d.BilledSizeBytes ?? null
        } else if (d?.ExportStatus === 'FAILED') {
          t.status = 'FAILED'
          t.error = (d.FailureMessage ?? d.FailureCode ?? 'export failed').slice(0, 300)
        }
      } catch (err) {
        t.error = String((err as Error)?.message ?? err).slice(0, 300)
      }
    }
    // A table the worker never reached (the invocation died) must not hold the job open forever.
    const age = deps.nowMs() - Date.parse(job.heartbeatAt ?? job.startedAt ?? deps.now())
    for (const t of job.tables) {
      if (t.status === 'PENDING' && age > 2 * 3600_000) {
        t.status = 'FAILED'
        t.error = 'export was never started'
      }
    }
    finalizeS3Job(deps, job)
    await saveJob(deps, job)
  }
  return jobs
}

// ── Scanning ────────────────────────────────────────────────────────────────

interface Segment {
  lastKey: Row | null
  done: boolean
}

async function scanPage(
  deps: Deps,
  tableName: string,
  segment: number,
  seg: Segment,
  projection?: string[],
): Promise<Row[]> {
  const names: Record<string, string> = {}
  if (projection) projection.forEach((p, i) => (names[`#p${i}`] = p))
  const res = await deps.db.send(
    new ScanCommand({
      TableName: tableName,
      Segment: segment,
      TotalSegments: SEGMENTS,
      Limit: deps.pageLimit,
      ExclusiveStartKey: seg.lastKey ? marshall(seg.lastKey) : undefined,
      ...(projection ? { ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','), ExpressionAttributeNames: names } : {}),
    }),
  )
  seg.lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : null
  seg.done = !res.LastEvaluatedKey
  return (res.Items ?? []).map((i) => unmarshall(i))
}

/** One parallel round: a page from every unfinished segment. */
async function scanRound(deps: Deps, tableName: string, segments: Segment[], projection?: string[]): Promise<Row[]> {
  const pages = await Promise.all(
    segments.map((seg, i) => (seg.done ? Promise.resolve([] as Row[]) : scanPage(deps, tableName, i, seg, projection))),
  )
  return pages.flat()
}

async function scanAll(deps: Deps, model: string, projection?: string[]): Promise<Row[]> {
  const segments: Segment[] = Array.from({ length: SEGMENTS }, () => ({ lastKey: null, done: false }))
  const rows: Row[] = []
  while (segments.some((s) => !s.done)) rows.push(...(await scanRound(deps, tableNameOf(deps, model), segments, projection)))
  return rows
}

// ── CSV export ──────────────────────────────────────────────────────────────

interface CsvCursor {
  table: string
  phase: 'HEADER' | 'DATA'
  segments: Segment[]
}

const freshCursor = (table: string, phase: CsvCursor['phase']): CsvCursor => ({
  table,
  phase,
  segments: Array.from({ length: SEGMENTS }, () => ({ lastKey: null, done: false })),
})

const accountingEntry = (file: string): string => `${ACCOUNTING_PREFIX}${file}`

export interface CsvStart {
  id: string
  scope: ExportScope
  tables: string[]
  startedBy: string
}

export function newCsvJob(deps: Deps, start: CsvStart): JobRec {
  const now = deps.now()
  return {
    id: start.id,
    kind: 'CSV_ALL',
    status: 'RUNNING',
    scope: start.scope,
    tables: [
      ...start.tables.map((table): TableProgress => ({ table, status: 'PENDING', pii: PII_TABLES.includes(table) })),
      ...ACCOUNTING_FILES.map((f): TableProgress => ({ table: accountingEntry(f), status: 'PENDING', pii: true })),
    ],
    prefix: `exports/csv/${start.id}/`,
    // The accounting files carry customer and carrier names, so every CSV job has personal data.
    includesPii: true,
    startedBy: start.startedBy,
    startedAt: now,
    createdAt: now,
  }
}

export function newAccountingJob(deps: Deps, id: string, startedBy: string, options: Row): JobRec {
  const now = deps.now()
  return {
    id,
    kind: 'ACCOUNTING',
    status: 'RUNNING',
    scope: null,
    tables: ACCOUNTING_FILES.map((f): TableProgress => ({ table: accountingEntry(f), status: 'PENDING', pii: true })),
    prefix: `exports/csv/${id}/`,
    cursor: { options },
    includesPii: true,
    startedBy,
    startedAt: now,
    createdAt: now,
  }
}

async function exportCsvTable(deps: Deps, job: JobRec, progress: TableProgress, deadline: number): Promise<'DONE' | 'YIELD'> {
  const model = progress.table
  const tableName = tableNameOf(deps, model)
  const columnsKey = `${job.prefix}_state/${model}.columns.json`
  const resumed = job.cursor?.table === model
  let cur: CsvCursor = resumed ? (job.cursor as unknown as CsvCursor) : freshCursor(model, 'HEADER')
  progress.status = 'RUNNING'
  let lastBeat = deps.nowMs()
  const beat = async (): Promise<void> => {
    if (deps.nowMs() - lastBeat < HEARTBEAT_EVERY_MS) return
    lastBeat = deps.nowMs()
    await saveJob(deps, job)
  }

  // Pass 1: the union of attributes (resumable through the cursor + a state object).
  let columns: string[]
  if (cur.phase === 'HEADER') {
    const seen = new Set<string>(['id'])
    if (resumed) for (const c of parseJson<string[]>(await getObjectText(deps, columnsKey), [])) seen.add(c)
    do {
      for (const row of await scanRound(deps, tableName, cur.segments)) for (const k of Object.keys(row)) seen.add(k)
      await beat()
      if (cur.segments.some((s) => !s.done) && deps.nowMs() > deadline) {
        await putObject(deps, columnsKey, JSON.stringify([...seen]), 'application/json')
        job.cursor = cur as unknown as Row
        return 'YIELD'
      }
    } while (cur.segments.some((s) => !s.done))
    columns = orderColumns(seen)
    await putObject(deps, columnsKey, JSON.stringify(columns), 'application/json')
    cur = freshCursor(model, 'DATA')
    job.cursor = cur as unknown as Row
    await saveJob(deps, job)
  } else {
    columns = parseJson<string[]>(await getObjectText(deps, columnsKey), ['id'])
  }

  // Pass 2: rows → part files. A cursor is only ever saved right after a part lands in S3.
  const parts = progress.parts ?? (progress.parts = [])
  let buf: string[] = []
  let bufBytes = 0
  let bufRows = 0
  const flush = async (): Promise<void> => {
    if (bufRows === 0 && parts.length > 0) return
    const body = rawHeaderLine(columns) + buf.join('')
    const name = `${model}-${String(parts.length + 1).padStart(4, '0')}.csv`
    const key = `${job.prefix}raw/${model}/${name}`
    await putObject(deps, key, body, 'text/csv; charset=utf-8')
    parts.push({ name: `raw/${model}/${name}`, key, rows: bufRows, bytes: Buffer.byteLength(body), sha256: sha256Hex(body) })
    progress.rows = (progress.rows ?? 0) + bufRows
    progress.bytes = (progress.bytes ?? 0) + Buffer.byteLength(body)
    progress.files = parts.length
    buf = []
    bufBytes = 0
    bufRows = 0
  }
  do {
    for (const row of await scanRound(deps, tableName, cur.segments)) {
      const line = rawRowLine(row, columns)
      buf.push(line)
      bufBytes += Buffer.byteLength(line)
      bufRows++
    }
    const more = cur.segments.some((s) => !s.done)
    if (more && (bufBytes >= PART_BYTES || deps.nowMs() > deadline)) {
      await flush()
      job.cursor = cur as unknown as Row
      if (deps.nowMs() > deadline) return 'YIELD'
      await saveJob(deps, job)
    }
    await beat()
  } while (cur.segments.some((s) => !s.done))
  await flush()
  progress.status = 'COMPLETED'
  job.cursor = null
  return 'DONE'
}

const ACCOUNTING_MODELS: Record<string, string[]> = {
  Invoice: [
    'id', 'number', 'orderId', 'shipmentId', 'shipmentNumber', 'customerId', 'customerName', 'invoiceDate', 'dueAt',
    'termsDays', 'termsText', 'totalCents', 'paidCents', 'writtenOffCents', 'balanceCents', 'status', 'factored',
    'factoringItemId', 'divisionKey', 'issuedBy', 'paidAt', 'voidedAt', 'voidReason', 'createdBy',
  ],
  ArPayment: [
    'id', 'customerId', 'kind', 'receivedAt', 'method', 'reference', 'amountCents', 'appliedCents', 'unappliedCents',
    'applications', 'invoiceId', 'reversesPaymentId', 'reversedByPaymentId', 'note', 'createdBy',
  ],
  CarrierBill: [
    'id', 'billNumber', 'loadId', 'shipmentId', 'shipmentNumber', 'loadNumber', 'carrierId', 'carrierName', 'carrierMc',
    'billDate', 'dueAt', 'termsDays', 'grossCents', 'quickPayFeeCents', 'netCents', 'billedCents', 'varianceCents',
    'paidCents', 'creditedCents', 'balanceCents', 'status', 'approvedAt', 'approvedBy', 'payeeKind', 'voidedAt',
    'voidReason', 'createdBy',
  ],
  ApPayment: [
    'id', 'carrierId', 'kind', 'paidAt', 'method', 'reference', 'amountCents', 'appliedCents', 'unappliedCents',
    'applications', 'reversesPaymentId', 'reversedByPaymentId', 'note', 'createdBy',
  ],
  Customer: ['id', 'name'],
  Carrier: ['id', 'name', 'mcNumber'],
  Shipment: ['id', 'number'],
  Load: ['id', 'aljexId', 'orderId', 'shipmentId', 'leg', 'loadNumber'],
}

/** Read the ledgers, build the four files, upload, and record them on the job's accounting entries. */
async function runAccounting(deps: Deps, job: JobRec): Promise<void> {
  const entries = job.tables.filter((t) => t.table.startsWith(ACCOUNTING_PREFIX))
  const options = (job.kind === 'ACCOUNTING' ? (job.cursor?.options as Row | undefined) : undefined) ?? {}
  try {
    const data: Record<string, Row[]> = {}
    for (const [model, projection] of Object.entries(ACCOUNTING_MODELS)) data[model] = await scanAll(deps, model, projection)
    const files = buildAccountingFiles(
      {
        invoices: data.Invoice, arPayments: data.ArPayment, carrierBills: data.CarrierBill, apPayments: data.ApPayment,
        customers: data.Customer, carriers: data.Carrier, shipments: data.Shipment, loads: data.Load,
      },
      { from: options.from as string | undefined, to: options.to as string | undefined, status: options.status as string | string[] | undefined },
    )
    for (const file of files) {
      const entry = entries.find((e) => e.table === accountingEntry(file.name))
      if (!entry) continue
      const key = `${job.prefix}${ACCOUNTING_PREFIX}${file.name}`
      await putObject(deps, key, file.content, 'text/csv; charset=utf-8')
      entry.status = 'COMPLETED'
      entry.rows = file.rows
      entry.bytes = Buffer.byteLength(file.content)
      entry.files = 1
      entry.parts = [{ name: entry.table, key, rows: file.rows, bytes: entry.bytes, sha256: sha256Hex(file.content) }]
    }
  } catch (err) {
    for (const e of entries) {
      if (e.status === 'COMPLETED') continue
      e.status = 'FAILED'
      e.error = String((err as Error)?.message ?? err).slice(0, 300)
    }
  }
}

async function finishFileJob(deps: Deps, job: JobRec): Promise<void> {
  const { status } = summarizeStatus(job.tables)
  const files = job.tables.flatMap((t) => (t.parts ?? []).map((p) => ({ ...p, table: t.table, pii: !!t.pii })))
  const manifest = {
    jobId: job.id,
    kind: job.kind,
    scope: job.scope ?? null,
    generatedAt: deps.now(),
    startedBy: job.startedBy,
    includesPii: job.includesPii ?? false,
    piiTables: job.tables.filter((t) => t.pii && !t.table.startsWith(ACCOUNTING_PREFIX)).map((t) => t.table),
    notes: [
      'raw/<Table>/*.csv: one file set per table; header = id first then attributes alphabetically; nested maps and lists are JSON text; numbers and booleans are as stored (money is integer cents); nothing is rewritten, so the files are re-importable.',
      'accounting/*.csv: UTF-8 with BOM; money in decimal dollars; dates YYYY-MM-DD; one row per application; text cells that could execute in a spreadsheet are prefixed with an apostrophe.',
      'Files contain customer, carrier and driver personal data where listed in piiTables. Handle accordingly.',
    ],
    files,
    tables: job.tables.map(({ parts: _p, ...t }) => t),
  }
  await putObject(deps, `${job.prefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json')
  job.status = status
  job.cursor = null
  job.finishedAt = deps.now()
  const failed = job.tables.filter((t) => t.status === 'FAILED')
  if (failed.length > 0) job.error = `${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} failed: ${failed.map((t) => t.table).join(', ')}`.slice(0, 500)
  await saveJob(deps, job)
}

/** Continue a CSV_ALL job inside this invocation's time budget; re-invokes itself when out of time. */
export async function runCsvJob(deps: Deps, jobId: string, remainingMs: number): Promise<JobRec | null> {
  const job = await getJob(deps, jobId)
  if (!job || job.status !== 'RUNNING' || job.kind !== 'CSV_ALL') return job
  const deadline = deps.nowMs() + remainingMs - SAFETY_MS
  let didWork = false
  for (const progress of job.tables) {
    if (progress.table.startsWith(ACCOUNTING_PREFIX) || progress.status === 'COMPLETED' || progress.status === 'FAILED') continue
    didWork = true
    let result: 'DONE' | 'YIELD'
    try {
      result = await exportCsvTable(deps, job, progress, deadline)
    } catch (err) {
      progress.status = 'FAILED'
      progress.error = String((err as Error)?.message ?? err).slice(0, 300)
      job.cursor = null
      await saveJob(deps, job)
      continue
    }
    await saveJob(deps, job)
    if (result === 'YIELD') {
      await invokeSelf(deps, { kind: 'CSV_CONTINUE', jobId })
      return job
    }
  }
  if (job.tables.some((t) => t.table.startsWith(ACCOUNTING_PREFIX) && t.status === 'PENDING')) {
    // Accounting is one uninterruptible step: start it only with room to finish, unless a fresh invocation has nothing else to do.
    if (didWork && deps.nowMs() > deadline - 120_000) {
      await saveJob(deps, job)
      await invokeSelf(deps, { kind: 'CSV_CONTINUE', jobId })
      return job
    }
    await runAccounting(deps, job)
  }
  await finishFileJob(deps, job)
  return job
}

export async function runAccountingJob(deps: Deps, jobId: string): Promise<JobRec | null> {
  const job = await getJob(deps, jobId)
  if (!job || job.status !== 'RUNNING' || job.kind !== 'ACCOUNTING') return job
  await runAccounting(deps, job)
  await finishFileJob(deps, job)
  return job
}

/** A RUNNING file job whose worker went quiet is re-kicked (once per stall window). */
export async function kickIfStalled(deps: Deps, job: JobRec): Promise<boolean> {
  if (job.status !== 'RUNNING' || (job.kind !== 'CSV_ALL' && job.kind !== 'ACCOUNTING')) return false
  const beat = Date.parse(job.heartbeatAt ?? job.startedAt ?? '') || 0
  if (deps.nowMs() - beat < STALL_MS) return false
  job.heartbeatAt = deps.now()
  await saveJob(deps, job)
  await invokeSelf(deps, { kind: job.kind === 'CSV_ALL' ? 'CSV_CONTINUE' : 'ACCOUNTING_RUN', jobId: job.id })
  return true
}

export interface DownloadLink {
  name: string
  key: string
  url: string
  bytes: number | null
  sha256: string | null
  pii: boolean
}

export async function buildLinks(deps: Deps, job: JobRec): Promise<{ files: DownloadLink[]; manifestUrl: string | null }> {
  const files: DownloadLink[] = []
  for (const t of job.tables) {
    for (const p of t.parts ?? []) {
      files.push({
        name: p.name,
        key: p.key,
        url: await deps.presign(p.key, p.name.split('/').pop() ?? p.name, LINK_TTL_SECONDS),
        bytes: p.bytes,
        sha256: p.sha256,
        pii: !!t.pii,
      })
    }
  }
  const manifestUrl =
    job.status === 'RUNNING' ? null : await deps.presign(`${job.prefix}manifest.json`, 'manifest.json', LINK_TTL_SECONDS)
  return { files, manifestUrl }
}
