#!/usr/bin/env node
/**
 * READ-ONLY sample generator for the carrier rate confirmation (src/lib/carrierRateCon.ts).
 * Builds the rate con for one PRODUCTION load with the real builder and writes the PDF (+ PNG renders when
 * `pdftoppm` is installed) so it can be compared with the reference (~/aljex-export/ratecon-example).
 *
 *   npx tsx scripts/awRateConSamples.mjs [--pro 14832] [--rep <e-mail of the FROM rep when the load has none>] [--out ~/aljex-export/reports/pdf-samples] [--suffix <prod suffix>]
 *
 * Only Scan / Get commands are imported, nothing is written to any table, nothing is e-mailed. Without --pro it
 * picks the newest load that has an active LoadCarrier and CARRIER charge lines. PRO 14832 is used when present.
 * Output (PDF + PNG, mode 0600) holds real carrier / stop data, so it goes only into the 0600 reports folder;
 * stdout carries counts and the file names, never a name, phone or e-mail.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const REGION = 'us-east-1'

const parseJson = (v) => {
  let x = v
  for (let i = 0; i < 4 && typeof x === 'string'; i++) { try { x = JSON.parse(x) } catch { break } }
  return x
}

async function scan(client, table, filter) {
  const rows = []
  let key
  do {
    const out = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ...(filter ?? {}) }))
    for (const item of out.Items ?? []) rows.push(unmarshall(item))
    key = out.LastEvaluatedKey
  } while (key)
  return rows
}

/** The load + its assignment, carrier-side charges, carrier and rep, as the rate con needs them. */
export async function readLoad({ client, suffix, pro, fallbackRep }) {
  const t = (m) => `${m}-${suffix}`
  let loads = pro
    ? await scan(client, t('Load'), {
      FilterExpression: 'contains(aljexId, :p) OR begins_with(loadNumber, :p)',
      ExpressionAttributeValues: { ':p': { S: pro } },
    })
    : []
  loads = loads.filter((l) => String(l.aljexId ?? '').trim() === pro || String(l.loadNumber ?? '').split('-')[0] === pro)
  const lcs = await scan(client, t('LoadCarrier'), {
    FilterExpression: '#s = :a',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':a': { S: 'ACTIVE' } },
  })
  const lcByLoad = new Map(lcs.map((c) => [c.loadId, c]))
  let load = loads.find((l) => lcByLoad.has(l.id)) ?? null
  const picked = load ? 'requested' : 'fallback'
  if (!load) {
    const all = await scan(client, t('Load'), { FilterExpression: 'attribute_exists(loadNumber)' })
    load = all
      .filter((l) => lcByLoad.has(l.id))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0] ?? null
  }
  if (!load) throw new Error('no load with an active LoadCarrier found')
  const loadCarrier = lcByLoad.get(load.id)
  const charges = (await scan(client, t('LoadCharge'), {
    FilterExpression: 'loadId = :l',
    ExpressionAttributeValues: { ':l': { S: load.id } },
  })).filter((c) => c.side === 'CARRIER' && (c.loadCarrierId == null || c.loadCarrierId === loadCarrier.id))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  const carrier = loadCarrier.carrierId
    ? (await scan(client, t('Carrier'), { FilterExpression: 'id = :c', ExpressionAttributeValues: { ':c': { S: loadCarrier.carrierId } } }))[0] ?? null
    : null
  // The app falls back to whoever is building the document; a script has no session, so --rep stands in.
  const repEmail = loadCarrier.carrierRepId ?? load.carrierRepId ?? fallbackRep ?? null
  const profiles = repEmail
    ? await scan(client, t('UserProfile'), { FilterExpression: 'email = :e', ExpressionAttributeValues: { ':e': { S: repEmail } } })
    : []
  const orders = load.orderId
    ? await scan(client, t('Order'), { FilterExpression: 'id = :o', ExpressionAttributeValues: { ':o': { S: load.orderId } } })
    : []
  return { load, loadCarrier, charges, carrier, profiles, order: orders[0] ?? null, picked }
}

/** Mirror of the assembly in RateConPanel (kept in step by hand; the panel owns the real mapping). */
export function inputOf({ load, loadCarrier, charges, carrier, profiles, order }, rateConRepOf, fallbackRep) {
  const stops = parseJson(load.stops) ?? []
  const lines = charges.map((c) => ({ label: c.label || c.code, amountCents: c.amountCents }))
  const extras = parseJson(order?.formExtras ?? order?.extras) ?? {}
  const notes = [extras?.instructions?.special, extras?.instructions?.rateCon]
    .map((s) => String(s ?? '').trim()).filter(Boolean).join('\n\n')
  return {
    carrier: {
      name: carrier?.name ?? loadCarrier.carrierName ?? 'Carrier',
      mcNumber: carrier?.mcNumber ?? loadCarrier.carrierMc ?? null,
      dotNumber: carrier?.dotNumber ?? null,
      phone: carrier?.phone ?? null,
    },
    loadCarrier,
    rep: rateConRepOf(profiles, loadCarrier.carrierRepId, load.carrierRepId, fallbackRep),
    loadNumber: load.loadNumber ?? load.aljexId ?? '',
    equipmentType: load.equipmentType ?? null,
    commodity: load.commodity ?? load.freightDescription ?? null,
    weightLbs: load.weight ?? null,
    miles: load.miles ?? null,
    pieces: load.pieces ?? null,
    stops: stops.map((s) => ({
      kind: s.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
      name: s.name ?? null,
      address: s.address?.street ?? null,
      city: s.address?.city ?? s.city ?? null,
      state: s.address?.state ?? null,
      zip: s.address?.zip ?? null,
      apptAt: s.appt ?? null,
      apptEnd: s.apptEnd ?? null,
      apptType: s.apptType ?? null,
      references: (s.refs ?? []).filter((r) => r.visibility === 'CARRIER' || r.visibility === 'ALL')
        .map((r) => ({ label: r.label || r.code, value: r.value })),
      instructions: [s.apptNote, s.stopNotes].filter(Boolean).join(' - ') || null,
      hours: s.contact?.hours ?? null,
    })),
    charges: lines,
    totalCents: lines.reduce((n, c) => n + c.amountCents, 0),
    notes,
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      pro: { type: 'string', default: '14832' }, out: { type: 'string' }, suffix: { type: 'string' },
      rep: { type: 'string', default: 'ryne@bcatcorp.com' },
    },
  })
  const suffix = values.suffix ?? PROD_SUFFIX
  const out = values.out ?? join(homedir(), 'aljex-export', 'reports', 'pdf-samples')
  const { buildRateConPdf, rateConRepOf } = await import('../src/lib/carrierRateCon.ts')
  const client = new DynamoDBClient({ region: REGION })
  const rows = await readLoad({ client, suffix, pro: values.pro, fallbackRep: values.rep })
  const input = inputOf(rows, rateConRepOf, values.rep)
  const bytes = await buildRateConPdf(input)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const base = join(out, 'ratecon-14832-bcat')
  writeFileSync(`${base}.pdf`, bytes, { mode: 0o600 })
  chmodSync(`${base}.pdf`, 0o600)
  const render = spawnSync('pdftoppm', ['-r', '110', '-png', `${base}.pdf`, base], { stdio: 'ignore' })
  console.log(JSON.stringify({
    script: 'awRateConSamples (read-only)',
    load: rows.picked,
    stops: input.stops.length,
    charges: input.charges.length,
    totalCents: input.totalCents,
    rep: input.rep ? 'present' : 'none',
    pdf: `${base}.pdf`,
    pngs: render.status === 0 ? `${base}-N.png` : 'pdftoppm unavailable',
  }))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1) })
}
