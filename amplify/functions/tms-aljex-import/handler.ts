/**
 * tms-aljex-import Lambda handler — Step N1.
 *
 * AppSync custom mutation router for Aljex CSV bulk import.
 * Actions: ALJEX_IMPORT_PREVIEW, ALJEX_IMPORT_APPLY, LIST_ALJEX_IMPORT_JOBS.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { DynamoDBClient, PutItemCommand, ScanCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'crypto'
import { parseInput, type Caller } from '../_shared/actionInputs'
import { getById as storeGetById, marshallRow, nowIso, type Row } from '../_shared/shipmentStore'
import type { AljexColumnMapping } from './parser'
import { parseCsvRows } from './parser'
import { guessAljexMapping, mapAljexRow } from './mapper'
import { applyImport, previewImport, type ImportDeps, type ImportStore } from './import'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'

type Action = 'ALJEX_IMPORT_PREVIEW' | 'ALJEX_IMPORT_APPLY' | 'LIST_ALJEX_IMPORT_JOBS'

const ACTIONS: Action[] = ['ALJEX_IMPORT_PREVIEW', 'ALJEX_IMPORT_APPLY', 'LIST_ALJEX_IMPORT_JOBS']

interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

interface AppSyncEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const cognito = new CognitoIdentityProviderClient({})

const TABLES: ImportStore['tables'] = {
  aljexImportJob: process.env.ALJEX_IMPORT_JOB_TABLE_NAME ?? '',
  shipment: process.env.SHIPMENT_TABLE_NAME ?? '',
  order: process.env.ORDER_TABLE_NAME ?? '',
  load: process.env.LOAD_TABLE_NAME ?? '',
  loadFinancials: process.env.LOAD_FINANCIALS_TABLE_NAME ?? '',
  loadCharge: process.env.LOAD_CHARGE_TABLE_NAME ?? '',
  loadCarrier: process.env.LOAD_CARRIER_TABLE_NAME ?? '',
  customer: process.env.CUSTOMER_TABLE_NAME ?? '',
  location: process.env.LOCATION_TABLE_NAME ?? '',
  division: process.env.DIVISION_TABLE_NAME ?? '',
  settings: process.env.SETTINGS_TABLE_NAME ?? '',
  invoice: process.env.INVOICE_TABLE_NAME ?? '',
  carrierBill: process.env.CARRIER_BILL_TABLE_NAME ?? '',
  proClaim: process.env.PRO_CLAIM_TABLE_NAME ?? '',
  auditLog: process.env.AUDIT_LOG_TABLE_NAME ?? '',
}

const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'
const SETTINGS_ID = 'default'

const store: ImportStore = {
  db: dynamo,
  s3,
  bucketName: BUCKET_NAME,
  now: nowIso,
  uuid: randomUUID,
  tables: TABLES,
}

// ── Identity / Authorization ────────────────────────────────────────────────

async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[tms-aljex-import] could not resolve caller email:', String(err))
    return ''
  }
}

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

async function authorize(identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (!isAdmin) throw new Error('Forbidden: Aljex import requires owner or ADMIN')
  return { email, sub: identity.sub, groups, isAdmin }
}

// ── Store helpers ───────────────────────────────────────────────────────────

async function scanTable(tableName: string): Promise<Row[]> {
  if (!tableName) throw new Error('Table name is not configured')
  const items: Row[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const result = await dynamo.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined, Limit: 1000 }),
    )
    if (result.Items) items.push(...result.Items.map((item) => unmarshall(item)))
    lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined
  } while (lastKey)
  return items
}

async function putItem(tableName: string, item: Row): Promise<void> {
  if (!tableName) throw new Error('Table name is not configured')
  await dynamo.send(new PutItemCommand({ TableName: tableName, Item: marshallRow(item) }))
}

async function transactItems(items: TransactWriteItem[], label: string): Promise<void> {
  if (items.length === 0) return
  if (items.length > 100) {
    throw new Error(`${label}: transaction exceeds 100 items (${items.length})`)
  }
  await dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }))
}

async function readS3Text(key: string): Promise<string> {
  if (!BUCKET_NAME) throw new Error('Bucket name is not configured')
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
  const body = await result.Body?.transformToString('utf-8')
  if (body == null) throw new Error(`S3 object is empty: ${key}`)
  return body
}

async function uploadErrorCsv(key: string, body: string): Promise<void> {
  if (!BUCKET_NAME) return
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: Buffer.from(body, 'utf-8'),
      ContentType: 'text/csv',
    }),
  )
}

async function nextShipmentNumber(): Promise<string> {
  const now = nowIso()
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: TABLES.settings,
      Key: marshall({ id: SETTINGS_ID }),
      UpdateExpression:
        'ADD nextShipmentNumber :one SET createdAt = if_not_exists(createdAt, :now), updatedAt = :now, updatedBy = :by, #tn = if_not_exists(#tn, :tn)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: now },
        ':by': { S: 'tms-aljex-import' },
        ':tn': { S: 'TmsSettings' },
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  const settings = result.Attributes ? unmarshall(result.Attributes) : null
  const counter = typeof settings?.nextShipmentNumber === 'number' ? settings.nextShipmentNumber : 1
  const prefix = typeof settings?.shipmentPrefix === 'string' && settings.shipmentPrefix.trim()
    ? settings.shipmentPrefix.trim()
    : 'S'
  return `${prefix}${String(counter).padStart(6, '0')}`
}

async function getExistingJob(fileHash: string): Promise<Row | null> {
  return storeGetById(dynamo, TABLES.aljexImportJob, `aljex:${fileHash}`)
}

async function writeJob(
  jobId: string,
  status: 'DRY_RUN' | 'APPLIED' | 'FAILED',
  input: { fileName: string; fileHash: string; mapping?: AljexColumnMapping | null },
  rowCount: number,
  counts: Record<string, number>,
  errorKey: string | undefined,
  caller: Caller,
  note?: string,
): Promise<void> {
  const now = nowIso()
  const item: Row = {
    id: jobId,
    __typename: 'AljexImportJob',
    status,
    fileName: input.fileName,
    fileHash: input.fileHash,
    mapping: input.mapping ?? null,
    rowCount,
    counts,
    errorKey: errorKey ?? null,
    dryRun: status === 'DRY_RUN',
    note: note ?? null,
    createdBy: caller.email,
    ...(status === 'APPLIED'
      ? { appliedAt: now, appliedBy: caller.email }
      : { appliedAt: null, appliedBy: null }),
    createdAt: now,
    updatedAt: now,
  }
  await putItem(TABLES.aljexImportJob, item)
}

async function writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void> {
  if (!TABLES.auditLog) return
  const now = nowIso()
  try {
    await putItem(TABLES.auditLog, {
      id: randomUUID(),
      __typename: 'AuditLog',
      entityType,
      entityId,
      action,
      user: caller.email,
      changes: JSON.stringify(changes),
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    console.warn('[tms-aljex-import] audit log write failed:', String(err))
  }
}

function buildDeps(caller: Caller): ImportDeps {
  return {
    store,
    caller,
    marshallRow,
    readS3Text,
    getById: (tableName, id) => storeGetById(dynamo, tableName, id),
    scanTable,
    putItem,
    transactItems,
    uploadErrorCsv,
    nextShipmentNumber,
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function runPreview(input: Record<string, unknown>, caller: Caller): Promise<Row> {
  const { s3Key, fileName, fileHash, mapping } = validateInput(input)
  const existing = await getExistingJob(fileHash)
  if (existing) return existing

  const csvText = await readS3Text(s3Key)
  const { headers, rows: rawRows } = parseCsvRows(csvText)
  const resolvedMapping = mapping ?? guessAljexMapping(headers)
  const rows = rawRows.map((cells: string[]) => mapAljexRow(headers, cells, resolvedMapping))

  const deps = buildDeps(caller)
  const result = await previewImport(deps, { s3Key, fileName, fileHash, mapping: resolvedMapping }, rows)
  await writeJob(
    result.jobId,
    'DRY_RUN',
    { fileName, fileHash, mapping: resolvedMapping },
    rows.length,
    result.counts as unknown as Record<string, number>,
    result.errorKey,
    caller,
    result.note,
  )
  return {
    id: result.jobId,
    status: 'DRY_RUN',
    fileName,
    fileHash,
    mapping: resolvedMapping,
    rowCount: rows.length,
    counts: result.counts,
    errorKey: result.errorKey ?? null,
    dryRun: true,
    note: result.note ?? null,
    createdBy: caller.email,
    appliedAt: null,
    appliedBy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

async function runApply(input: Record<string, unknown>, caller: Caller): Promise<Row> {
  const { s3Key, fileName, fileHash, mapping } = validateInput(input)
  const existing = await getExistingJob(fileHash)
  if (existing && existing.status === 'APPLIED') return existing

  const csvText = await readS3Text(s3Key)
  const { headers, rows: rawRows } = parseCsvRows(csvText)
  const resolvedMapping = mapping ?? guessAljexMapping(headers)
  const rows = rawRows.map((cells: string[]) => mapAljexRow(headers, cells, resolvedMapping))

  const deps = buildDeps(caller)
  const result = await applyImport(deps, { s3Key, fileName, fileHash, mapping: resolvedMapping }, rows)
  await writeJob(
    result.jobId,
    'APPLIED',
    { fileName, fileHash, mapping: resolvedMapping },
    rows.length,
    result.counts as unknown as Record<string, number>,
    result.errorKey,
    caller,
    result.note,
  )
  await writeAudit('ALJEX_IMPORT', result.jobId, 'ALJEX_IMPORT_APPLY', caller, {
    fileName,
    fileHash,
    counts: result.counts,
  })
  return {
    id: result.jobId,
    status: 'APPLIED',
    fileName,
    fileHash,
    mapping: resolvedMapping,
    rowCount: rows.length,
    counts: result.counts,
    errorKey: result.errorKey ?? null,
    dryRun: false,
    note: result.note ?? null,
    createdBy: caller.email,
    appliedAt: nowIso(),
    appliedBy: caller.email,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

async function listJobs(_input: Record<string, unknown>, caller: Caller): Promise<Row> {
  const items = await scanTable(TABLES.aljexImportJob)
  return { jobs: items, count: items.length, createdBy: caller.email }
}

function validateInput(input: Record<string, unknown>): {
  s3Key: string
  fileName: string
  fileHash: string
  mapping?: AljexColumnMapping | null
} {
  const s3Key = typeof input.s3Key === 'string' ? input.s3Key.trim() : ''
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : ''
  const fileHash = typeof input.fileHash === 'string' ? input.fileHash.trim() : ''
  if (!s3Key) throw new Error('s3Key is required')
  if (!fileName) throw new Error('fileName is required')
  if (!fileHash) throw new Error('fileHash is required')
  const mapping = input.mapping && typeof input.mapping === 'object' && !Array.isArray(input.mapping)
    ? (input.mapping as AljexColumnMapping)
    : null
  return { s3Key, fileName, fileHash, mapping }
}

// ── Main handler ────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown action: ${action}. Expected one of ${ACTIONS.join(', ')}`)
  }
  const caller = await authorize(event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'ALJEX_IMPORT_PREVIEW':
      return runPreview(input, caller)
    case 'ALJEX_IMPORT_APPLY':
      return runApply(input, caller)
    case 'LIST_ALJEX_IMPORT_JOBS':
      return listJobs(input, caller)
  }
}
