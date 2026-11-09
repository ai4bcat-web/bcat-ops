#!/usr/bin/env node
/**
 * Verify-payment bills (queue item 15 / Ryne 2026-11-09). READ-ONLY: scans production CarrierBill, writes nothing to AWS.
 *
 *   node scripts/verifyPaymentBills.mjs [--xlsx ~/aljex-export/not-paid-yet-2026-11-08.xlsx] [--suffix <table suffix>]
 *        [--out ~/aljex-export/reports/verify-payment-bills-2026-11-09.csv] [--emit-module src/lib/verifyPaymentPros.ts]
 *
 * Reads Ryne's not-paid-yet sheet (Aljex says paid, Ryne has not paid it) with `unzip` (no npm deps), joins each PRO to
 * the CarrierBill rows of that shipment number, and writes a 0600 CSV (PRO, carrier, pay-to, amount, due date, BCAT bill
 * status, what to check). Stdout carries counts only. `--emit-module` regenerates the PRO-key module the app flags from.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE';
const REGION = 'us-east-1';

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Excel 1900 date serial -> YYYY-MM-DD (the 1900 leap-year bug makes serial 60 = 1900-02-29; every modern serial is offset 25569 from the Unix epoch). */
export function excelSerialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 61) return '';
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Parse sheet1 of an .xlsx into arrays of strings (shared strings resolved). */
export function readXlsxRows(path) {
  const unzip = (member) => execFileSync('unzip', ['-p', path, member], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const shared = [...unzip('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const rows = [];
  for (const rowMatch of unzip('xl/worksheets/sheet1.xml').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1];
      if (!ref) continue;
      const type = /t="(\w+)"/.exec(c[1])?.[1];
      const v = c[2] ? /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] : undefined;
      cells[colIndex(ref)] = v === undefined ? '' : type === 's' ? shared[Number(v)] ?? '' : decode(v);
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

export function parseNotPaid(rows) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const at = (name) => header.findIndex((h) => h.startsWith(name));
  const [pro, due, vendor, payTo, amount] = ['pro', 'duedate', 'vendor', 'pay to', 'amount'].map(at);
  if ([pro, due, vendor, payTo, amount].some((i) => i < 0)) throw new Error('unexpected sheet header');
  return rows.slice(1).filter((r) => String(r[pro] ?? '').trim() !== '').map((r) => ({
    pro: String(r[pro]).trim(),
    carrier: String(r[vendor] ?? '').trim(),
    payTo: String(r[payTo] ?? '').trim(),
    amountCents: Math.round(Number(r[amount] || 0) * 100),
    dueDate: excelSerialToIso(r[due]),
  }));
}

/** What the person verifying has to look at, from the BCAT side of the same PRO. */
export function checkFor(bills) {
  if (bills.length === 0) return 'NO BCAT BILL: confirm the carrier was paid outside BCAT (check/ACH record), then record the bill + payment or pay it';
  const live = bills.filter((b) => b.status !== 'VOID');
  if (live.length === 0) return 'BCAT bill is VOID: confirm whether the carrier was paid; re-create the bill if not';
  if (live.some((b) => b.status === 'PAID')) return 'BCAT says PAID but Ryne has not paid it: verify the payment (ApPayment date/method/reference) against the bank before trusting it';
  if (live.some((b) => b.status === 'PARTIAL')) return 'BCAT says PARTIAL: confirm what was paid and pay or reverse the remainder';
  return `BCAT bill is ${live[0].status}: pay it or confirm it was paid elsewhere`;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function scanBills(suffix) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await doc.send(new ScanCommand({
      TableName: `CarrierBill-${suffix}`,
      ProjectionExpression: 'id, shipmentNumber, #s, billNumber, netCents, paidCents, balanceCents, paidAt, dueAt, carrierName',
      ExpressionAttributeNames: { '#s': 'status' },
      ExclusiveStartKey,
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const proKey = (v) => String(v ?? '').trim().replace(/^L/i, '');

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { xlsx: { type: 'string' }, suffix: { type: 'string' }, out: { type: 'string' }, 'emit-module': { type: 'string' } },
  });
  const xlsx = values.xlsx ?? join(homedir(), 'aljex-export', 'not-paid-yet-2026-11-08.xlsx');
  const out = values.out ?? join(homedir(), 'aljex-export', 'reports', 'verify-payment-bills-2026-11-09.csv');
  const sheet = parseNotPaid(readXlsxRows(xlsx));
  const bills = await scanBills(values.suffix ?? PROD_SUFFIX);
  const byPro = new Map();
  for (const b of bills) {
    const k = proKey(b.shipmentNumber);
    if (k) byPro.set(k, [...(byPro.get(k) ?? []), b]);
  }
  const lines = [['PRO', 'carrier', 'pay-to', 'amount', 'due date', 'BCAT bill status', 'BCAT net', 'BCAT paid', 'BCAT paid on', 'what to check'].join(',')];
  const tally = {};
  for (const r of sheet) {
    const mine = byPro.get(proKey(r.pro)) ?? [];
    const live = mine.filter((b) => b.status !== 'VOID');
    const status = mine.length === 0 ? 'NO BILL' : live.length === 0 ? 'VOID' : live.map((b) => b.status).join('+');
    tally[status] = (tally[status] ?? 0) + 1;
    const b = live[0];
    lines.push([
      r.pro, r.carrier, r.payTo, (r.amountCents / 100).toFixed(2), r.dueDate, status,
      b ? (Number(b.netCents ?? 0) / 100).toFixed(2) : '', b ? (Number(b.paidCents ?? 0) / 100).toFixed(2) : '', b?.paidAt ? String(b.paidAt).slice(0, 10) : '',
      checkFor(mine),
    ].map(csvCell).join(','));
  }
  writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  const total = sheet.reduce((n, r) => n + r.amountCents, 0);
  console.log(`sheet PROs ${sheet.length}, total $${(total / 100).toFixed(2)}; BCAT status ${JSON.stringify(tally)}; CSV written (0600)`);

  if (values['emit-module']) {
    const pros = sheet.map((r) => proKey(r.pro)).sort((a, b) => Number(a) - Number(b));
    writeFileSync(values['emit-module'], `/**\n * PROs of the carrier bills Aljex marks paid but Ryne has not paid (not-paid-yet-2026-11-08.xlsx: ${pros.length} PROs).\n * Generated by scripts/verifyPaymentBills.mjs --emit-module; PRO keys only, no names or amounts.\n */\nexport const VERIFY_PAYMENT_PROS: readonly string[] = ${JSON.stringify(pros)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
