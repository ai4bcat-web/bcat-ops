#!/usr/bin/env node
/**
 * DRY RUN ONLY. Lists directory carriers MyCarrierPackets has never been pulled for (Ryne 2026-11-13,
 * LANDSTAR RANGER INC.). The scheduled mcp-sync walks MCP's *monitored* list and its changes feed, so
 * a carrier imported from Aljex that MCP does not monitor for us never gets its insurance, risk or
 * packet status, and the booking gate then refuses it for "no insurance on file" even though MCP has
 * certificates. The Cover dialog now pulls such a carrier on lookup; this lists the rest.
 *
 *   node scripts/awMcpUnsyncedCarriers.mjs --suffix 5ucwdyvwivelbo4k4jomvrwel4-NONE [--out file.json]
 *
 * Writes nothing. Pulling them is the carrier page's MyCarrierPackets sync (PULL_ONE), one at a time,
 * once authorized.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** A carrier with an MC or DOT and no MyCarrierPackets status has never been pulled. */
export function unsyncedCarriers(rows) {
  return rows
    .filter((r) => !r.mcpStatus && (String(r.mcNumber ?? '').trim() || String(r.dotNumber ?? '').trim()))
    .map((r) => ({ id: r.id, name: r.name ?? null, status: r.status ?? null, mcNumber: r.mcNumber ?? null, dotNumber: r.dotNumber ?? null, policies: (r.insurancePolicies ?? []).length }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function main() {
  const { values } = parseArgs({ options: { suffix: { type: 'string' }, out: { type: 'string' } } });
  if (!values.suffix) throw new Error('--suffix is required');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const rows = [];
  let key;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: `Carrier-${values.suffix}`, ExclusiveStartKey: key,
      ProjectionExpression: 'id, #n, #s, mcNumber, dotNumber, mcpStatus, insurancePolicies',
      ExpressionAttributeNames: { '#n': 'name', '#s': 'status' },
    }));
    rows.push(...(page.Items ?? []));
    key = page.LastEvaluatedKey;
  } while (key);
  const found = unsyncedCarriers(rows);
  const byStatus = found.reduce((m, r) => ({ ...m, [r.status ?? 'NONE']: (m[r.status ?? 'NONE'] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ carriers: rows.length, neverPulled: found.length, byStatus }, null, 2));
  for (const r of found) console.log(`${r.status ?? '-'}\t${r.mcNumber ?? ''}\t${r.dotNumber ?? ''}\t${r.name}`);
  if (values.out) writeFileSync(values.out, JSON.stringify(found, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
