#!/usr/bin/env node
/**
 * Ivan Cartage shipments read "Assets Local" / "Assets Owner Operator" / "Assets Box Truck" by their driver (Ryne 2026-11-11).
 * Back-fill for the shipments tagged ASSETS with no subdivision that already have an ACTIVE driver leg: the subdivision is set from
 * `Driver.fleetGroup` (falling back to `Driver.driverType` only when the fleet is empty), the same rule the booking path now uses
 * (`driverOwnershipKind`): LOCAL -> LOCAL, OWNER_OPERATOR / AMAZON -> OWNER_OPERATOR, BOX_TRUCK -> BOX_TRUCK. Anything else is left as it is.
 *
 * Touched: Shipment (revSubdivision) + its Load rows (same tag columns), one conditional UpdateItem each (only while the subdivision is
 * still empty and the source is unchanged) and one AuditLog row per shipment. A hand-picked subdivision is never read or written, a shipment
 * that is not ASSETS is never touched, and a HAND tag with no subdivision is changed only on a TENDER (intake) shipment, where it was the
 * intake's own division stamp; that one becomes source INTAKE so a later driver change re-tags it.
 * Dry by default, prod-gated apply.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awAssetsSubdivision.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awAssetsSubdivision --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-assetssub node scripts/awAssetsSubdivision.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { driverOwnershipKind } from '../src/lib/driverOwnership.ts';

export const SCRIPT = 'awAssetsSubdivision';
const SUBDIVISION_OF = { OWNER_OPERATOR: 'OWNER_OPERATOR', BOX_TRUCK: 'BOX_TRUCK', LOCAL: 'LOCAL' };
const empty = (v) => v == null || String(v).trim() === '';

/**
 * Pure: the shipments to re-tag. `shipments`, `loads`, `legs` (LoadCarrier) and `drivers` are table rows.
 * Returns [{ shipment, loads, subdivision, source, driverId, kind }].
 */
export function planAssetsSubdivision({ shipments, loads, legs, drivers }) {
  const loadsByShipment = new Map();
  for (const l of loads) { const k = String(l.shipmentId ?? ''); if (k) loadsByShipment.set(k, [...(loadsByShipment.get(k) ?? []), l]); }
  const legByLoad = new Map();
  for (const leg of legs) if (leg.status === 'ACTIVE' && !empty(leg.driverId) && !legByLoad.has(String(leg.loadId))) legByLoad.set(String(leg.loadId), leg);
  const driverById = new Map(drivers.map((d) => [String(d.id), d]));
  const plan = [];
  for (const shipment of shipments) {
    if (shipment.voidedAt || shipment.deletedAt) continue;
    if (shipment.revDivision !== 'ASSETS' || !empty(shipment.revSubdivision)) continue;
    const source = shipment.revTagSource ?? null;
    if (source === 'HAND' && shipment.source !== 'TENDER') continue;
    const own = (loadsByShipment.get(String(shipment.id)) ?? []).slice().sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0));
    const leg = own.map((l) => legByLoad.get(String(l.id))).find(Boolean);
    const driver = leg ? driverById.get(String(leg.driverId)) : null;
    if (!driver) continue;
    const kind = driverOwnershipKind({ fleetGroup: driver.fleetGroup, driverType: driver.driverType });
    const subdivision = kind ? SUBDIVISION_OF[kind] : null;
    if (!subdivision) continue;
    plan.push({ shipment, loads: own, subdivision, source: source === 'HAND' ? 'INTAKE' : (source ?? 'RULE'), driverId: String(driver.id), kind });
  }
  return plan;
}

async function scan(doc, table) { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; }

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models });
  if (gate?.apply && process.env.AW_PROD_CONFIRM !== `${localDate(new Date())}-assetssub`) throw new Error('AW_PROD_CONFIRM must be <today>-assetssub');
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const [shipments, loads, legs, drivers] = await Promise.all(['Shipment', 'Load', 'LoadCarrier', 'Driver'].map((m) => scan(doc, `${m}-${suffix}`)));
  const plan = planAssetsSubdivision({ shipments, loads, legs, drivers });
  console.log(`${plan.length} ASSETS shipment(s) to give a subdivision${apply ? '' : ' (dry run)'}`);
  const now = () => new Date().toISOString();
  let done = 0; let skipped = 0; let failed = 0;
  for (const p of plan) {
    const label = `${p.shipment.number ?? p.shipment.id}: ASSETS -> ${p.subdivision} (driver ${p.driverId}, ${p.kind})${p.source === 'INTAKE' && p.shipment.revTagSource === 'HAND' ? ' [intake stamp]' : ''}`;
    if (!apply) { console.log(`WOULD ${label}`); continue; }
    try {
      assertWritableSuffix(suffix, 'Assets subdivision');
      try {
        await doc.send(new UpdateCommand({
          TableName: `Shipment-${suffix}`, Key: { id: p.shipment.id },
          UpdateExpression: 'SET revSubdivision = :sub, revTagSource = :src, updatedAt = :now',
          ConditionExpression: 'revDivision = :assets AND (attribute_not_exists(revSubdivision) OR attribute_type(revSubdivision, :nul) OR revSubdivision = :blank) AND (attribute_not_exists(revTagSource) OR revTagSource = :was)',
          ExpressionAttributeValues: { ':sub': p.subdivision, ':src': p.source, ':now': now(), ':assets': 'ASSETS', ':nul': 'NULL', ':blank': '', ':was': p.shipment.revTagSource ?? 'RULE' },
        }));
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') { console.log(`SKIP  ${label}: changed since the scan`); skipped += 1; continue; }
        throw err;
      }
      for (const load of p.loads) {
        await doc.send(new UpdateCommand({
          TableName: `Load-${suffix}`, Key: { id: load.id },
          UpdateExpression: 'SET revSubdivision = :sub, revTagSource = :src, updatedAt = :now',
          ConditionExpression: 'revDivision = :assets',
          ExpressionAttributeValues: { ':sub': p.subdivision, ':src': p.source, ':now': now(), ':assets': 'ASSETS' },
        })).catch((err) => { if (err?.name !== 'ConditionalCheckFailedException') throw err; });
      }
      await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: String(p.shipment.id), action: 'AW_ASSETS_SUBDIVISION', user: `system:${SCRIPT}`, changes: JSON.stringify({ from: { revSubdivision: null, revTagSource: p.shipment.revTagSource ?? null }, to: { revSubdivision: p.subdivision, revTagSource: p.source }, driverId: p.driverId, kind: p.kind }), createdAt: now(), updatedAt: now() } }));
      console.log(`DONE  ${label}`);
      done += 1;
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(apply ? `RE-TAGGED ${done}, SKIPPED ${skipped}, FAILED ${failed}` : 'DRY RUN: nothing written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
