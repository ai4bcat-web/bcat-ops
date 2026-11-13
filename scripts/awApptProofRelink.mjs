#!/usr/bin/env node
/**
 * DRY RUN ONLY. Finds Appts screenshots that are still in S3 but no longer linked to their stop
 * (Ryne 2026-11-13). Saving a shipment's order form rebuilt every stop from the fields the form
 * edits and dropped apptProofs / apptStatus with them; the objects under appt-proofs/{loadId}/{stopId}/
 * were never deleted. The save path is fixed (carryStopState); this lists what could be relinked.
 *
 * A stop counts as wiped when it has no apptStatus key: a reschedule writes one, and the remove
 * button deletes the object, so neither leaves an orphan behind on a stop without a status. Only
 * slots that are empty now are proposed (a screenshot re-uploaded after the wipe stays), each with
 * the newest object for that slot.
 *
 *   node scripts/awApptProofRelink.mjs --suffix 5ucwdyvwivelbo4k4jomvrwel4-NONE \
 *     --bucket amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg [--out file.json]
 *
 * Writes nothing to DynamoDB or S3. Applying is a separate, authorized step (backup first).
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const SLOTS = ['request', 'e2open', 'email'];

const stopsOf = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

/** Group S3 keys appt-proofs/{loadId}/{stopId}/{slot}-{ms}.{ext} by load → stop → slot, newest first. */
export function indexProofObjects(keys) {
  const index = new Map();
  for (const key of keys) {
    const m = /^appt-proofs\/([^/]+)\/([^/]+)\/(request|e2open|email)-(\d+)\.\w+$/.exec(key);
    if (!m) continue;
    const [, loadId, stopId, slot, ms] = m;
    const k = `${loadId}|${stopId}|${slot}`;
    const list = index.get(k) ?? [];
    list.push({ key, ms: Number(ms) });
    index.set(k, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.ms - a.ms);
  return index;
}

/** The relinks to propose. Pure, so it is tested. */
export function proposeRelinks(loads, index) {
  const out = [];
  for (const load of loads) {
    for (const stop of stopsOf(load.stops)) {
      if (!stop?.id) continue;
      if ('apptStatus' in stop) continue;
      const proofs = {};
      for (const slot of SLOTS) {
        if (stop.apptProofs?.[slot]) continue;
        const hit = index.get(`${load.id}|${String(stop.id).replace(/[^\w.-]+/g, '_')}|${slot}`);
        if (hit?.length) proofs[slot] = hit[0].key;
      }
      if (Object.keys(proofs).length) {
        out.push({ loadId: load.id, pro: load.aljexId ?? load.loadNumber ?? null, stopId: stop.id, stopType: stop.type, stopName: stop.name ?? null, proofs });
      }
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { suffix: { type: 'string' }, bucket: { type: 'string' }, out: { type: 'string' } } });
  if (!values.suffix || !values.bucket) throw new Error('--suffix and --bucket are required');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { scanAll } = await import('./awCustomerEmail.mjs');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
  const s3 = new S3Client({ region: 'us-east-1' });
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: values.bucket, Prefix: 'appt-proofs/', ContinuationToken: token }));
    keys.push(...(r.Contents ?? []).map((o) => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  const loads = await scanAll(doc, `Load-${values.suffix}`, ['id', 'stops', 'aljexId', 'loadNumber']);
  const relinks = proposeRelinks(loads, indexProofObjects(keys));
  const slots = relinks.reduce((n, r) => n + Object.keys(r.proofs).length, 0);
  console.log(`[dry run] ${keys.length} proof objects, ${loads.length} loads → ${relinks.length} stops / ${slots} screenshots to relink`);
  for (const r of relinks) console.log(`  PRO ${r.pro ?? '?'} ${r.stopType} ${r.stopName ?? ''} (${r.stopId}): ${Object.keys(r.proofs).join(', ')}`);
  if (values.out) writeFileSync(values.out, JSON.stringify(relinks, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
