#!/usr/bin/env -S npx tsx
/**
 * Make the big POD and customer rate confirmation PDFs on shipments small enough to e-mail (Ryne 2026-11-16, invoice 14918: a 22.8 MB POD that
 * made the invoice "over 10 MB"). Every ACTIVE POD / RATE_CON / CUSTOMER_RATE_CON PDF over --min-mb (default 5) has its big pictures re-encoded
 * (`shrinkPdfImages`, the same routine uploads use) and is written NEXT TO the original under a new key; the document row then points at the
 * lighter file. The original object stays in S3 and its key is written to the AuditLog (and to the row's originalS3Key when it has none).
 *
 * Dry run by default: lists each document with before / after sizes. `--apply` backs up every row it will change (~/bcat-ops-backups/manual),
 * writes each row conditionally on its updatedAt, and adds one AuditLog row per document (DOC_COMPRESS_PDF).
 *
 *   npx tsx scripts/shrinkPodPdfs.mts --suffix 5ucwdyvwivelbo4k4jomvrwel4-NONE --bucket <documents bucket> [--min-mb 5] [--pro 14918] [--apply]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { shrinkPdfImages } from '../amplify/functions/_shared/pdfShrink.ts'

type Row = Record<string, unknown>
const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const suffix = arg('--suffix')
const bucket = arg('--bucket')
if (!suffix || !bucket) throw new Error('--suffix and --bucket are required')
const APPLY = args.includes('--apply')
const MIN_BYTES = Math.round(Number(arg('--min-mb') ?? 5) * 1024 * 1024)
const onlyPro = arg('--pro')
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
const s3 = new S3Client({ region: 'us-east-1' })
const t = (model: string) => `${model}-${suffix}`
const TYPES = new Set(['POD', 'RATE_CON', 'CUSTOMER_RATE_CON'])

async function scanAll(model: string, filter?: { expression: string; values: Row }): Promise<Row[]> {
  const out: Row[] = []
  let ExclusiveStartKey: Row | undefined
  do {
    const r = await doc.send(new ScanCommand({
      TableName: t(model), ExclusiveStartKey,
      ...(filter ? { FilterExpression: filter.expression, ExpressionAttributeValues: filter.values } : {}),
    }))
    out.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey as Row | undefined
  } while (ExclusiveStartKey)
  return out
}

async function bytesOf(key: string): Promise<Uint8Array> {
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket!, Key: key }))
  return (got.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
}

const mb = (n: number) => (n / 1048576).toFixed(2)
const rows = (await scanAll('ShipmentDocument', { expression: '#s = :a', values: { ':a': 'ACTIVE' } }).catch(() => scanAll('ShipmentDocument')))
  .filter((r) => TYPES.has(String(r.type)) && r.status === 'ACTIVE' && /pdf/i.test(String(r.contentType ?? 'application/pdf')) && typeof r.s3Key === 'string')
let candidates = rows.filter((r) => Number(r.sizeBytes ?? 0) >= MIN_BYTES || Number(r.sizeBytes ?? 0) === 0)
if (onlyPro) {
  const ship = (await scanAll('Shipment', { expression: '#n = :n', values: { ':n': onlyPro } }).catch(() => []))
  const ids = new Set(ship.map((s) => String(s.id)))
  candidates = candidates.filter((r) => ids.has(String(r.shipmentId)))
}
const shipments = new Map((await scanAll('Shipment')).map((s) => [String(s.id), String(s.number ?? s.id)]))

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const backups: Row[] = []
const report: { pro: string; doc: string; type: string; before: number; after: number; images: number; key: string }[] = []
let skipped = 0
let failed = 0

for (const row of candidates) {
  const pro = shipments.get(String(row.shipmentId)) ?? String(row.shipmentId)
  try {
    const bytes = await bytesOf(String(row.s3Key))
    if (bytes.byteLength < MIN_BYTES) { skipped += 1; continue }
    const shrunk = await shrinkPdfImages(bytes)
    if (!shrunk.changed) { skipped += 1; continue }
    const newKey = `shipment-docs/${row.shipmentId}/${row.id}-small.pdf`
    report.push({ pro, doc: String(row.id), type: String(row.type), before: shrunk.before, after: shrunk.after, images: shrunk.images, key: newKey })
    console.log(`${pro}\t${row.type}\t${mb(shrunk.before)} MB -> ${mb(shrunk.after)} MB\t${row.name}`)
    if (!APPLY) continue
    backups.push(row)
    await s3.send(new PutObjectCommand({ Bucket: bucket!, Key: newKey, Body: shrunk.bytes, ContentType: 'application/pdf' }))
    const now = new Date().toISOString()
    await doc.send(new UpdateCommand({
      TableName: t('ShipmentDocument'), Key: { id: row.id },
      UpdateExpression: 'SET s3Key = :k, sizeBytes = :n, pdfConversion = :c, updatedAt = :now' + (row.originalS3Key ? '' : ', originalS3Key = :o, originalContentType = :ot'),
      ConditionExpression: 'updatedAt = :u AND s3Key = :old',
      ExpressionAttributeValues: {
        ':k': newKey, ':n': shrunk.after, ':c': 'COMPRESSED', ':now': now, ':u': row.updatedAt, ':old': row.s3Key,
        ...(row.originalS3Key ? {} : { ':o': row.s3Key, ':ot': 'application/pdf' }),
      },
    }))
    await doc.send(new PutCommand({
      TableName: t('AuditLog'),
      Item: {
        id: `audit-compress-${row.id}-${stamp}`, __typename: 'AuditLog', entityType: 'ShipmentDocument', entityId: row.id, action: 'DOC_COMPRESS_PDF',
        user: 'claude (for Ryne)', createdAt: now, updatedAt: now,
        changes: JSON.stringify({ pro, from: { s3Key: row.s3Key, sizeBytes: shrunk.before }, to: { s3Key: newKey, sizeBytes: shrunk.after }, images: shrunk.images }),
      },
    }))
  } catch (err) {
    failed += 1
    console.warn(`${pro}\t${row.id}\tFAILED\t${err instanceof Error ? err.message : String(err)}`)
  }
}

if (APPLY && backups.length) {
  const dir = `${homedir()}/bcat-ops-backups/manual`
  mkdirSync(dir, { recursive: true })
  const path = `${dir}/backup-pod-compress-${stamp}.json`
  writeFileSync(path, JSON.stringify(backups, null, 2))
  console.log('backup', path)
}
const before = report.reduce((a, r) => a + r.before, 0)
const after = report.reduce((a, r) => a + r.after, 0)
console.log(JSON.stringify({ apply: APPLY, candidates: candidates.length, changed: report.length, skipped, failed, totalBeforeMB: Number(mb(before)), totalAfterMB: Number(mb(after)) }))
