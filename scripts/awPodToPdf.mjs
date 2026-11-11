#!/usr/bin/env node
/**
 * Turn every proof-of-delivery that is a JPEG or PNG into a PDF (Ryne 2026-11-10). Dry by default, prod-gated apply.
 *
 * For each ACTIVE ShipmentDocument of type POD whose content type is image/jpeg or image/png: read the photo from the document bucket, wrap it
 * (upright, one letter page) as a PDF written NEXT TO it under the same key with .pdf (a new object; the photo is never touched or deleted),
 * then update the row (s3Key, contentType, name, sizeBytes) with a condition that the row still points at the photo, and add an AuditLog row
 * holding the old key. A document whose photo cannot be read or converted is listed and left exactly as it is.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awPodToPdf.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awPodToPdf --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-podtopdf node scripts/awPodToPdf.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { imageToPdf, isPodImage, pdfKeyFor, pdfNameFor } from '../amplify/functions/_shared/podPdf.ts';

export const SCRIPT = 'awPodToPdf';
export const PROD_BUCKET = 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg';

/** Pure: the ACTIVE POD documents still stored as a photo. */
export function podPhotos(documents) {
  return documents.filter((d) => d.type === 'POD' && d.status === 'ACTIVE' && typeof d.s3Key === 'string' && d.s3Key !== '' && isPodImage(d.contentType));
}

async function scan(doc, table) { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; }

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, bucket: { type: 'string' }, limit: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models });
  if (gate?.apply && process.env.AW_PROD_CONFIRM !== `${localDate(new Date())}-podtopdf`) throw new Error('AW_PROD_CONFIRM must be <today>-podtopdf');
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const bucket = values.bucket ?? (gate ? PROD_BUCKET : null);
  if (!bucket) throw new Error('--bucket <document bucket> is required off production');
  const limit = values.limit ? Number(values.limit) : Infinity;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const s3 = new S3Client({ region: REGION });
  const photos = podPhotos(await scan(doc, `ShipmentDocument-${suffix}`)).slice(0, limit);
  console.log(`${photos.length} POD photo(s) to convert in ${bucket}${apply ? '' : ' (dry run)'}`);
  const now = () => new Date().toISOString();
  let done = 0; let skipped = 0; let failed = 0;
  for (const d of photos) {
    const label = `${d.id} (${d.shipmentId}) ${d.name ?? ''}`.trim();
    const newKey = pdfKeyFor(d.s3Key);
    try {
      if (!apply) { console.log(`WOULD ${label}: ${d.s3Key} -> ${newKey}`); continue; }
      assertWritableSuffix(suffix, 'POD to PDF');
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: d.s3Key }));
      const pdf = await imageToPdf(await got.Body.transformToByteArray(), String(d.contentType), pdfNameFor(String(d.name ?? 'pod')));
      let exists = false;
      try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: newKey })); exists = true; } catch { /* not there yet */ }
      if (exists) { console.log(`SKIP  ${label}: ${newKey} already exists`); skipped += 1; continue; }
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: newKey, Body: pdf, ContentType: 'application/pdf' }));
      await doc.send(new UpdateCommand({
        TableName: `ShipmentDocument-${suffix}`, Key: { id: d.id },
        UpdateExpression: 'SET s3Key = :k, contentType = :ct, #n = :name, sizeBytes = :size, updatedAt = :now',
        ConditionExpression: 's3Key = :old',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':k': newKey, ':ct': 'application/pdf', ':name': pdfNameFor(String(d.name ?? 'pod')), ':size': pdf.length, ':now': now(), ':old': d.s3Key },
      }));
      await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: String(d.shipmentId), action: 'AW_POD_TO_PDF', user: `system:${SCRIPT}`, changes: JSON.stringify({ documentId: d.id, from: d.s3Key, to: newKey, fromContentType: d.contentType }), createdAt: now(), updatedAt: now() } }));
      console.log(`DONE  ${label}`);
      done += 1;
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(apply ? `CONVERTED ${done}, SKIPPED ${skipped}, FAILED ${failed}` : 'DRY RUN: nothing written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
