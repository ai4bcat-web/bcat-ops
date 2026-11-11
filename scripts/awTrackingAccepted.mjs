#!/usr/bin/env node
/**
 * Back-fill LoadCarrier.trackingAcceptedAt (Ryne 2026-11-11: boards show sent / accepted). tracking-api now stamps it when a driver first
 * accepts a link; this fills it for links accepted before that. Dry by default, prod-gated apply.
 *
 * For every LoadCarrier whose ACTIVE tracking link (LoadCarrier.trackingLinkId) has a consentAt and whose own trackingAcceptedAt is empty,
 * set trackingAcceptedAt = that consentAt with a condition that it is still empty, and add one AuditLog row. A link with no consent, a
 * revoked or expired link, or a leg that already has a value is left exactly as it is.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awTrackingAccepted.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awTrackingAccepted --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-trackingaccepted node scripts/awTrackingAccepted.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const SCRIPT = 'awTrackingAccepted';

/**
 * Pure: the legs to fill. `links` and `carriers` are the raw table rows. A leg qualifies when its trackingLinkId names a link that is not
 * revoked, has a consentAt, and the leg has no trackingAcceptedAt yet.
 */
export function planAccepted(carriers, links) {
  const byId = new Map(links.map((l) => [l.id, l]));
  const out = [];
  for (const lc of carriers) {
    if (!lc.trackingLinkId || lc.trackingAcceptedAt) continue;
    const link = byId.get(lc.trackingLinkId);
    if (!link || link.status === 'REVOKED' || !link.consentAt) continue;
    out.push({ carrier: lc, link, acceptedAt: String(link.consentAt) });
  }
  return out;
}

async function scan(doc, table) { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; }

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models });
  if (gate?.apply && process.env.AW_PROD_CONFIRM !== `${localDate(new Date())}-trackingaccepted`) throw new Error('AW_PROD_CONFIRM must be <today>-trackingaccepted');
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const [carriers, links] = await Promise.all([scan(doc, `LoadCarrier-${suffix}`), scan(doc, `TrackingLink-${suffix}`)]);
  const plan = planAccepted(carriers, links);
  console.log(`${plan.length} assignment(s) with an accepted link and no trackingAcceptedAt${apply ? '' : ' (dry run)'}`);
  const now = () => new Date().toISOString();
  let done = 0; let skipped = 0; let failed = 0;
  for (const p of plan) {
    const label = `${p.carrier.id} (${p.carrier.shipmentId ?? ''}) link ${p.link.id}`;
    if (!apply) { console.log(`WOULD ${label}: trackingAcceptedAt = ${p.acceptedAt}`); continue; }
    try {
      assertWritableSuffix(suffix, 'tracking accepted back-fill');
      await doc.send(new UpdateCommand({
        TableName: `LoadCarrier-${suffix}`, Key: { id: p.carrier.id },
        UpdateExpression: 'SET trackingAcceptedAt = :at, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(trackingAcceptedAt)',
        ExpressionAttributeValues: { ':at': p.acceptedAt, ':now': now() },
      }));
      await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'LOAD_CARRIER', entityId: String(p.carrier.id), action: 'AW_TRACKING_ACCEPTED', user: `system:${SCRIPT}`, changes: JSON.stringify({ trackingLinkId: p.link.id, trackingAcceptedAt: p.acceptedAt }), createdAt: now(), updatedAt: now() } }));
      console.log(`DONE  ${label}`);
      done += 1;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') { console.log(`SKIP  ${label}: already set`); skipped += 1; continue; }
      failed += 1;
      console.log(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(apply ? `FILLED ${done}, SKIPPED ${skipped}, FAILED ${failed}` : 'DRY RUN: nothing written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
