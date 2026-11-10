#!/usr/bin/env node
/**
 * Seed the three Ivan Cartage company phones (Ryne 2026-11-10). Dry by default, prod-gated apply. Idempotent: a label that already
 * exists is never touched (the drivers' assignments are made on the Driver info page). Writes ONLY CompanyPhone rows + AuditLog.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awCompanyPhones.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCompanyPhones --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-companyphones node scripts/awCompanyPhones.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const SCRIPT = 'awCompanyPhones';
export const PHONES = Object.freeze([
  { label: 'One Ivan Cartage', number: '(312) 608-8970', sortOrder: 1 },
  { label: 'Two Ivan Cartage', number: '(312) 608-8956', sortOrder: 2 },
  { label: 'Three Ivan Cartage', number: '(312) 608-5383', sortOrder: 3 },
]);

/** Pure: the phones still to create. */
export const planPhones = (existing) => PHONES.filter((p) => !existing.some((e) => e.label === p.label));

export async function phonesGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-companyphones`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-companyphones');
  }
  return gate;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await phonesGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const existing = (await doc.send(new ScanCommand({ TableName: `CompanyPhone-${suffix}`, ConsistentRead: true }))).Items ?? [];
  const todo = planPhones(existing);
  console.log(`company phones now ${existing.length}; to create ${todo.length}: ${todo.map((p) => p.label).join(', ') || '(none)'}`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'company phones');
  const now = new Date().toISOString();
  for (const p of todo) {
    await doc.send(new PutCommand({ TableName: `CompanyPhone-${suffix}`, Item: { ...p, __typename: 'CompanyPhone', assignedDriverId: null, createdAt: now, updatedAt: now }, ConditionExpression: 'attribute_not_exists(label)' }));
    await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'COMPANY_PHONE', entityId: p.label, action: 'AW_COMPANY_PHONES', user: `system:${SCRIPT}`, changes: JSON.stringify({ created: p }), createdAt: now, updatedAt: now } }));
  }
  console.log(`CREATED ${todo.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
