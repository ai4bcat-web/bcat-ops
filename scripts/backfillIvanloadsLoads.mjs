#!/usr/bin/env node
/**
 * Backfill the owner-operator loads that were tendered to ivanloads@bcatcorp.com
 * but never made it into the Load table.
 *
 * WHY THIS EXISTS
 *   ivanloads@bcatcorp.com has taken 502 messages (May–Sep 2026) and not one was
 *   ever ingested: scripts/loadsEmailBridge.gs did not exist, so DriverSubmission
 *   is empty in production. Dispatch has been rebuilding loads out of that
 *   mailbox by hand, and the owner-operator tenders that landed in the first
 *   settlement week fell through the cracks.
 *
 * SCOPE — only what moves owner-operator settlement dollars
 *   A load reaches a settlement only with deliveryDriverId + deliveryAppt + rate
 *   and a delivery on/after OWNER_OP_FIRST_PERIOD (src/lib/ownerOperatorTrips.ts
 *   -> ownerOpTripsFor). Every ivanloads@ message from 2026-09-19 on was triaged
 *   and the full 502-message history was searched for the four owner operators by
 *   name. Four tenders name one explicitly and are not settling; they are PLAN.
 *   Attribution comes ONLY from an explicit statement in the email or a DRIVER
 *   field on the rate con — never inferred from a sibling load (see AMBIGUOUS).
 *
 * SAFETY
 *   • Dry run is the DEFAULT. Nothing is written without --apply.
 *   • Each row is keyed by the broker's own immutable reference (`ref`). A ref
 *     already present on a Load is never duplicated: it resolves to ASSIGN (fill
 *     the missing driver), SKIP (already correct) or CONFLICT (a different driver
 *     is on it → reported, never overwritten).
 *   • Creates use the deterministic id `ivanloads-<ref>` with a conditional put,
 *     so a concurrent or repeated run cannot insert twice even if the reference
 *     index missed. ASSIGN is likewise conditional on the driver still being
 *     unset. Re-running after a successful --apply prints SKIP for every row.
 *
 * WHY IT WRITES DYNAMODB AND NOT APPSYNC
 *   The other backfills in this directory sign in as a staff user. This one
 *   needs no human secret: it reads and writes the model tables with the ambient
 *   AWS credentials, the same way the intake Lambdas do (PutCommand with
 *   __typename + ISO createdAt/updatedAt, conditional on attribute_not_exists).
 *   Two consequences, both acceptable for a one-shot backfill:
 *     – onCreateLoad/onUpdateLoad subscriptions do not fire, so an app tab open
 *       at the time needs a refresh to see the rows;
 *     – the Load stream still fires, which is harmless here: broker-load-alert
 *       only acts when the "Broker Need to Cover" driver is the one assigned.
 *
 * aljexId NOTE
 *   Load.aljexId is `String!` and feeds OTR's InvoiceNo (src/lib/otrInvoice.ts).
 *   These loads were never built in Aljex, so no Aljex PRO exists to copy;
 *   aljexId is set to the broker reference — the only external identity there is
 *   — and the provenance goes in `notes`. Overwrite it with the real PRO once the
 *   load is built in the TMS.
 *
 * Usage:
 *   node scripts/backfillIvanloadsLoads.mjs                      # dry run (default)
 *   node scripts/backfillIvanloadsLoads.mjs --apply               # write
 *   node scripts/backfillIvanloadsLoads.mjs --actor=you@bcatcorp.com --apply
 *   node scripts/backfillIvanloadsLoads.mjs --table-suffix=-abc123-NONE
 *   node scripts/backfillIvanloadsLoads.mjs --outputs=/tmp/sandbox/amplify_outputs.json
 *
 * Needs AWS credentials for the target account (AWS_REGION defaults to us-east-1).
 */
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const __dirname = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const ACTOR = flag('actor') ?? 'scripts/backfillIvanloadsLoads.mjs'
const REGION = process.env.AWS_REGION ?? 'us-east-1'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

// ── Constants read from the app, so they cannot drift ────────────────────────

/** Pull `export const NAME = <literal>` out of a source file. Throws if absent. */
function appConstant(relPath, name) {
  const src = readFileSync(resolve(__dirname, relPath), 'utf8')
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*('([^']*)'|[0-9.]+)`))
  if (!m) throw new Error(`${name} not found in ${relPath} — update this script`)
  return m[2] !== undefined ? m[2] : Number(m[1])
}

const FACTORING_FEE_PCT = appConstant('../src/lib/driverPay.ts', 'FACTORING_FEE_PCT')
const OWNER_OP_FIRST_PERIOD = appConstant('../src/lib/ownerOperatorTrips.ts', 'OWNER_OP_FIRST_PERIOD')
/** Pay groups that settle on the owner-operator page (mirrors isOwnerOperatorGroup). */
const OWNER_OP_GROUPS = new Set(['AMAZON', 'OWNER_OPERATOR'])

// ── The plan ─────────────────────────────────────────────────────────────────
//
// `ref`      the broker's immutable load/order number — dedupe key, written to
//            both tmsId and aljexId.
// `driverId` the owner operator, taken ONLY from `evidence`.
// `load`     the row to create when `ref` is not already on a Load.
//
// Rates are CENTS. Appointment instants are UTC: Arizona is MST (UTC-7, no DST),
// Illinois/Texas are CDT (UTC-5) and Kentucky is EDT (UTC-4) on these dates.

const DRIVERS = {
  LEE: '81c0ce77-ded1-4956-894d-86a58d9406f8',
  CHAD: 'f5d86672-cd51-4b96-9812-cc42032c73ed',
  ROY: 'd64f643f-cab8-4a41-b1e8-33774a0315f8',
  MICHAEL: '54398587-96d3-4a5b-bc25-f7b3c452da91',
}

const PLAN = [
  {
    ref: '3380829',
    driverId: DRIVERS.LEE,
    evidence: 'ivanloads@ 2026-09-30 17:45 CDT from ryne@majesticfit.com, subject "Lee Lara", '
      + 'attachment 3380829_20260930172700.ratecon.pdf (King of Freight order 3380829). '
      + 'The subject IS the driver assignment.',
    load: {
      customer: 'KING OF FREIGHT',
      pickupNumber: 'BAY PHOENIX -- VAIL 10126',
      originName: 'BAY INSULATION',
      originCity: 'PHOENIX, AZ',
      destinationName: 'JOB SITE (SEE BOL)',
      destinationCity: 'VAIL, AZ',
      pickupAppt: '2026-10-01T13:00:00.000Z',   // 10/01/26 06:00 MST
      pickupApptType: 'exact',
      deliveryAppt: '2026-10-01T18:00:00.000Z', // 10/01/26 11:00 MST
      deliveryApptType: 'exact',
      rate: 65_000,
    },
  },
  {
    ref: '409670',
    driverId: DRIVERS.LEE,
    evidence: 'ivanloads@ 2026-09-28 09:37 CDT from Ryne@bcatcorp.com, subject '
      + '"Fwd: Released - Order 409670: PHOENIX, AZ -> SOUTH HOLLAND, IL", body '
      + '"Build this under Lee Lara as Driver please"; order-409670.pdf also carries '
      + 'DRIVER NAME: LEE.',
    load: {
      customer: 'ONE WAY TRAILERS',
      pickupNumber: '409670',
      originName: 'TFORCE PHO',
      originCity: 'PHOENIX, AZ',
      destinationName: 'TFORCE SOH',
      destinationCity: 'SOUTH HOLLAND, IL',
      pickupAppt: '2026-09-28T15:00:00.000Z',   // pickup ETA 09/28, gate hours 8-5 M-F (MST)
      pickupApptType: 'fcfs',
      deliveryAppt: '2026-10-05T13:00:00.000Z', // delivery ETA 10/05, gate hours 8-5 M-F (CDT)
      deliveryApptType: 'fcfs',
      rate: 5_000,
    },
  },
  {
    ref: '98553',
    driverId: DRIVERS.MICHAEL,
    evidence: 'ivanloads@ 2026-09-29 09:04 CDT from Ryne@bcatcorp.com, subject '
      + '"Fwd: Rate Cons TX-KY & KY-TX", body "MICHAEL BODLE DRIVER"; the second '
      + 'attachment 98553-carrier_confirmation_one.pdf names DRIVER: Michael Bodle, '
      + 'TRUCK #: 0012. (The first, 98515, is already load 14524.)',
    load: {
      customer: 'RED LIGHTNING LOGISTICS, INC',
      pickupNumber: 'RETURN TRAILER',
      originName: 'THERMAL EQUIPMENT SALES',
      originCity: 'LEXINGTON, KY',
      destinationName: 'DAIKIN COMFORT',
      destinationCity: 'WALLER, TX',
      pickupAppt: '2026-10-01T04:00:00.000Z',   // Thu 10/01, live unload, no clock time (EDT)
      pickupApptType: 'tbd',
      deliveryAppt: '2026-10-05T22:00:00.000Z', // Mon 10/05 drop by 5:00 PM (CDT)
      deliveryApptType: 'exact',
      rate: 0, // rate con Flat Rate $0.00 — empty-trailer return leg
      note: 'Rate con flat rate is $0.00: this is the empty-trailer return leg of 98515. '
        + 'It belongs on the settlement as a trip line but moves no dollars.',
    },
  },
  {
    // Already in production as load 14515 with no driver on it, so this resolves
    // to ASSIGN rather than CREATE. It sits in the same plan because the
    // settlement effect is identical: with no deliveryDriverId the load is
    // invisible to ownerOpTripsFor and Lee is paid nothing for it.
    ref: '38558447',
    driverId: DRIVERS.LEE,
    evidence: 'ivanloads@ 2026-09-28 12:16 CDT from Ryne@bcatcorp.com, subject '
      + '"Fwd: TQL PO 38558447 eRate Confirmation", body "driver LEE please".',
    load: {
      customer: 'TOTAL QUALITY LOGISTICS',
      pickupNumber: '38558447',
      originCity: 'PHOENIX, AZ',
      destinationCity: 'PHOENIX, AZ',
      pickupAppt: '2026-09-29T05:00:00.000Z',
      pickupApptType: 'fcfs',
      deliveryAppt: '2026-10-03T05:00:00.000Z',
      deliveryApptType: 'fcfs',
      rate: 250_000,
    },
  },
]

/**
 * Tenders that reached ivanloads@ and are deliberately NOT acted on, because no
 * email and no rate con names a driver. Printed every run so the gap stays
 * visible; filling these in is a dispatch decision, not a guess this script may
 * make.
 */
const AMBIGUOUS = [
  {
    ref: '4010756658',
    what: 'Schneider route 4010756658 MESA, AZ → TEMPE, AZ, delivers 2026-10-02, $450.00',
    state: 'Load 14548 exists with no deliveryDriverId.',
    why: 'ivanloads@ 2026-09-30 10:49 CDT forwarded it with an empty body. Its three sibling '
      + 'Schneider routes (4010729373 / 4010730180 / 4010756649) were each explicitly assigned '
      + 'to Chad, but this one names nobody. Assigning it on the pattern would be a guess.',
  },
]

// ── Table discovery ──────────────────────────────────────────────────────────

/**
 * Resolve the AppSync API id behind the amplify_outputs.json this repo is
 * configured with, by matching its GraphQL endpoint against the account's APIs.
 * The Amplify model-table suffix is `-<thatApiId>-<branch>`, so this is what
 * ties "the backend the app talks to" to "the tables to touch". The AppSync
 * client is imported lazily: if it is not installed, the caller falls back to
 * requiring --table-suffix rather than guessing between backends.
 */
async function apiIdForConfiguredBackend() {
  const outputsPath = flag('outputs') ?? resolve(__dirname, '../amplify_outputs.json')
  let url
  try {
    url = JSON.parse(readFileSync(outputsPath, 'utf8'))?.data?.url
  } catch {
    return null
  }
  if (!url) return null

  let mod
  try {
    mod = await import('@aws-sdk/client-appsync')
  } catch {
    return null
  }
  const appsync = new mod.AppSyncClient({ region: REGION })
  let token
  do {
    const page = await appsync.send(new mod.ListGraphqlApisCommand({ nextToken: token, maxResults: 25 }))
    for (const api of page.graphqlApis ?? []) {
      if (api.uris?.GRAPHQL === url) return { apiId: api.apiId, url }
    }
    token = page.nextToken
  } while (token)
  return null
}

/**
 * Amplify suffixes every model table with the same `-<apiId>-<branch>`. Find it
 * from the Load tables rather than hardcoding, so the script also runs against a
 * sandbox. With several backends in the account it narrows by the API id behind
 * amplify_outputs.json, and refuses to pick one otherwise.
 */
async function resolveTableSuffix() {
  const override = flag('table-suffix')
  if (override) return override

  const names = []
  let start
  do {
    const page = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }))
    names.push(...(page.TableNames ?? []))
    start = page.LastEvaluatedTableName
  } while (start)

  const candidates = names.filter((n) => /^Load-[^-]+-[^-]+$/.test(n))
  if (candidates.length === 1) return candidates[0].slice('Load'.length)

  if (candidates.length > 1) {
    const configured = await apiIdForConfiguredBackend()
    const match = configured && candidates.find((n) => n.startsWith(`Load-${configured.apiId}-`))
    if (match) {
      console.log(`${candidates.length} backends in ${REGION}; using the one behind ${configured.url}`)
      return match.slice('Load'.length)
    }
  }

  throw new Error(
    `cannot pick a Load table in ${REGION}: found ${candidates.length}`
    + `${candidates.length ? ` (${candidates.join(', ')})` : ''}`
    + '. Pass --table-suffix=-<apiId>-<branch>, or --outputs=<amplify_outputs.json>.')
}

async function scanAll(table, projection, names) {
  const items = []
  let key
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: projection,
      ExpressionAttributeNames: names,
      ExclusiveStartKey: key,
    }))
    items.push(...(page.Items ?? []))
    key = page.LastEvaluatedKey
  } while (key)
  return items
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/** 'N/A' and padding are sentinels in this table — they are not identities. */
function cleanRef(value) {
  const v = (value ?? '').trim()
  if (!v) return null
  return v.toUpperCase() === 'N/A' ? null : v.toUpperCase()
}

/** Sunday of the pay week containing an ISO date. Mirrors ownerOperatorProfit.ts. */
function weekOf(isoDate) {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}

/**
 * Marginal change to the driver's check from adding `freight` dollars of gross,
 * under the two modes documented in src/lib/driverPay.ts. The factoring fee is
 * charged on gross in both.
 */
function checkDelta(freight, payPercent, expensesBeforePercent) {
  const fee = freight * FACTORING_FEE_PCT
  return round2(expensesBeforePercent ? payPercent * (freight - fee) : payPercent * freight - fee)
}

/** The two stops a created load gets, matching deriveLegacyFields' mirrors. */
function buildStops(load, driverId) {
  return [
    {
      id: randomUUID(), type: 'pickup', sequence: 0,
      name: load.originName ?? null, city: load.originCity ?? null,
      appt: load.pickupAppt, apptType: load.pickupApptType, driverId,
    },
    {
      id: randomUUID(), type: 'delivery', sequence: 1,
      name: load.destinationName ?? null, city: load.destinationCity ?? null,
      appt: load.deliveryAppt, apptType: load.deliveryApptType, driverId,
    },
  ]
}

/**
 * Project a driver assignment onto an existing stops array exactly the way the
 * app does: withStopsFromLegacy (src/lib/stops.ts) copies pickupDriverId onto the
 * FIRST pickup stop and deliveryDriverId onto the LAST delivery stop, and leaves
 * middle stops alone. Anything else and getStops()/deriveLegacyFields would
 * disagree with the legacy columns on the next app-side edit.
 */
function assignDriverToStops(stops, driverId) {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const last = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  return ordered.map((s) => (s.id === first?.id || s.id === last?.id ? { ...s, driverId } : s))
}

// ── Main ─────────────────────────────────────────────────────────────────────

const suffix = await resolveTableSuffix()
const LOAD_TABLE = `Load${suffix}`
const DRIVER_TABLE = `Driver${suffix}`
const SETTING_TABLE = `DriverPaySetting${suffix}`

console.log(`${REGION} · tables ${LOAD_TABLE} / ${DRIVER_TABLE} / ${SETTING_TABLE}`)
console.log(APPLY
  ? `APPLY — the CREATE/ASSIGN rows below will be written as ${ACTOR}.\n`
  : 'DRY RUN — nothing will be written. Re-run with --apply to write.\n')

const [drivers, settings, loads] = await Promise.all([
  scanAll(DRIVER_TABLE, 'id, #n, active', { '#n': 'name' }),
  scanAll(SETTING_TABLE, 'id, driverId, payGroup, payPercent, expensesBeforePercent, active'),
  scanAll(LOAD_TABLE,
    'id, aljexId, tmsId, pickupNumber, customer, originCity, destinationCity,'
    + ' deliveryAppt, pickupDriverId, deliveryDriverId, #r, stops',
    { '#r': 'rate' }),
])

const driverById = new Map(drivers.map((d) => [d.id, d]))
const settingByDriver = new Map(
  settings
    .filter((s) => s.active !== false && OWNER_OP_GROUPS.has(s.payGroup ?? 'AMAZON'))
    .map((s) => [s.driverId, s]),
)

// Fail before touching anything if the pinned ids or the pay config went stale.
for (const row of PLAN) {
  const d = driverById.get(row.driverId)
  if (!d) throw new Error(`plan row ${row.ref}: driver ${row.driverId} is not on the roster`)
  if (d.active === false) throw new Error(`plan row ${row.ref}: driver ${d.name} is inactive`)
  if (!settingByDriver.has(row.driverId)) {
    throw new Error(`plan row ${row.ref}: ${d.name} has no active owner-operator DriverPaySetting`)
  }
  const week = weekOf(row.load.deliveryAppt)
  if (week < OWNER_OP_FIRST_PERIOD) {
    throw new Error(`plan row ${row.ref}: pay week ${week} precedes OWNER_OP_FIRST_PERIOD ${OWNER_OP_FIRST_PERIOD}`)
  }
}

// Reference index over every external identity a Load carries, so a row staff
// already built under a random UUID is still recognised.
const byRef = new Map()
for (const l of loads) {
  for (const ref of [cleanRef(l.tmsId), cleanRef(l.aljexId), cleanRef(l.pickupNumber)]) {
    if (ref && !byRef.has(ref)) byRef.set(ref, l)
  }
}

const actions = PLAN.map((row) => {
  const existing = byRef.get(cleanRef(row.ref)) ?? null
  if (!existing) return { row, kind: 'CREATE', existing: null }
  if (!existing.deliveryDriverId) return { row, kind: 'ASSIGN', existing }
  if (existing.deliveryDriverId === row.driverId) return { row, kind: 'SKIP', existing }
  return { row, kind: 'CONFLICT', existing }
})

// ── Print the plan ───────────────────────────────────────────────────────────

const rule = '─'.repeat(100)
console.log(`${loads.length} loads in the table; ${PLAN.length} plan row(s).\n${rule}`)
for (const { row, kind, existing } of actions) {
  const driver = driverById.get(row.driverId)
  const rate = existing?.rate ?? row.load.rate
  const deliveryAppt = existing?.deliveryAppt ?? row.load.deliveryAppt
  console.log(`${kind.padEnd(8)} ref ${row.ref}  ${driver.name}`)
  console.log(`         ${row.load.customer}  ${row.load.originCity ?? '?'} → ${row.load.destinationCity ?? '?'}`)
  console.log(`         delivers ${deliveryAppt.slice(0, 10)} (pay week ${weekOf(deliveryAppt)})  rate ${money(rate / 100)}`)
  if (existing) console.log(`         existing load id=${existing.id} aljexId=${(existing.aljexId ?? '').trim() || '—'}`)
  if (kind === 'CREATE') console.log(`         new load id=ivanloads-${row.ref}  aljexId=${row.ref}  tmsId=${row.ref}`)
  if (kind === 'ASSIGN') {
    const n = Array.isArray(existing.stops) ? existing.stops.length : 0
    console.log(`         set pickupDriverId + deliveryDriverId${n ? ` and the first/last of ${n} stops` : ''}; nothing else is touched`)
  }
  if (kind === 'CONFLICT') {
    const who = driverById.get(existing.deliveryDriverId)?.name ?? existing.deliveryDriverId
    console.log(`         ALREADY ASSIGNED TO ${who} — not touching it`)
  }
  if (row.load.note) console.log(`         ${row.load.note}`)
  console.log(`         evidence: ${row.evidence}`)
  console.log(rule)
}

// ── Settlement impact ────────────────────────────────────────────────────────

const effective = actions.filter((a) => a.kind === 'CREATE' || a.kind === 'ASSIGN')
console.log('\nSettlement impact of the rows above (per driver, per pay week):\n')
if (effective.length === 0) {
  console.log('  none — every plan row already settles correctly.')
} else {
  const buckets = new Map()
  for (const { row, existing } of effective) {
    const rate = existing?.rate ?? row.load.rate
    const week = weekOf(existing?.deliveryAppt ?? row.load.deliveryAppt)
    const key = `${row.driverId}|${week}`
    if (!buckets.has(key)) buckets.set(key, { driverId: row.driverId, week, freight: 0, refs: [] })
    const b = buckets.get(key)
    b.freight = round2(b.freight + rate / 100)
    b.refs.push(row.ref)
  }
  let totalFreight = 0
  let totalDelta = 0
  const ordered = [...buckets.values()].sort((a, c) =>
    a.week.localeCompare(c.week) || driverById.get(a.driverId).name.localeCompare(driverById.get(c.driverId).name))
  for (const b of ordered) {
    const s = settingByDriver.get(b.driverId)
    const before = s.expensesBeforePercent === true
    const delta = checkDelta(b.freight, s.payPercent, before)
    totalFreight = round2(totalFreight + b.freight)
    totalDelta = round2(totalDelta + delta)
    console.log(`  ${b.week}  ${driverById.get(b.driverId).name.padEnd(16)}`
      + ` gross +${money(b.freight)}  → check +${money(delta)}`
      + `   (${Math.round(s.payPercent * 100)}% ${before ? 'of gross − expenses' : 'of gross, then − expenses'},`
      + ` less the ${Math.round(FACTORING_FEE_PCT * 100)}% factoring fee)  [${b.refs.join(', ')}]`)
  }
  console.log(`\n  TOTAL  gross +${money(totalFreight)}  → checks +${money(totalDelta)}`)
}

// ── Not acted on ─────────────────────────────────────────────────────────────

if (AMBIGUOUS.length > 0) {
  console.log('\nNOT acted on — no driver named anywhere in the email or the rate con:\n')
  for (const a of AMBIGUOUS) {
    console.log(`  ref ${a.ref}  ${a.what}`)
    console.log(`           ${a.state}`)
    console.log(`           ${a.why}\n`)
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

if (!APPLY) {
  console.log('Dry run complete — re-run with --apply to write the CREATE/ASSIGN rows above.')
  process.exit(0)
}

let created = 0, assigned = 0, skipped = 0, failed = 0
for (const { row, kind, existing } of actions) {
  const driver = driverById.get(row.driverId)
  const now = new Date().toISOString()
  try {
    if (kind === 'SKIP') {
      skipped++
      console.log(`SKIP     ${row.ref} — already on ${driver.name}`)
      continue
    }
    if (kind === 'CONFLICT') {
      skipped++
      console.log(`SKIP     ${row.ref} — assigned to someone else; resolve by hand`)
      continue
    }
    if (kind === 'CREATE') {
      const id = `ivanloads-${row.ref}`
      await ddb.send(new PutCommand({
        TableName: LOAD_TABLE,
        Item: {
          id,
          __typename: 'Load',
          aljexId: row.ref,
          tmsId: row.ref,
          pickupNumber: row.load.pickupNumber,
          customer: row.load.customer,
          originName: row.load.originName ?? null,
          originCity: row.load.originCity ?? null,
          destinationName: row.load.destinationName ?? null,
          destinationCity: row.load.destinationCity ?? null,
          pickupAppt: row.load.pickupAppt,
          pickupApptType: row.load.pickupApptType,
          deliveryAppt: row.load.deliveryAppt,
          deliveryApptType: row.load.deliveryApptType,
          pickupDriverId: row.driverId,
          deliveryDriverId: row.driverId,
          rate: row.load.rate,
          readyToInvoice: false,
          hot: false,
          unscheduled: false,
          stops: buildStops(row.load, row.driverId),
          notes: [
            'Backfilled from ivanloads@bcatcorp.com by scripts/backfillIvanloadsLoads.mjs.',
            `aljexId mirrors broker reference ${row.ref} — replace with the Aljex PRO once built in the TMS.`,
            row.load.note ?? null,
            row.evidence,
          ].filter(Boolean).join(' '),
          createdBy: ACTOR,
          updatedBy: ACTOR,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(id)',
      }))
      created++
      console.log(`CREATED  ${row.ref} → ${driver.name}  (id ${id})`)
      continue
    }
    // ASSIGN — conditional on the driver still being unset, so it can never
    // clobber an assignment someone made between the scan and this write.
    const sets = ['pickupDriverId = :d', 'deliveryDriverId = :d', 'updatedBy = :by', 'updatedAt = :ts']
    const values = { ':d': row.driverId, ':by': ACTOR, ':ts': now, ':null': 'NULL' }
    if (Array.isArray(existing.stops) && existing.stops.length > 0) {
      sets.push('#s = :stops')
      values[':stops'] = assignDriverToStops(existing.stops, row.driverId)
    }
    await ddb.send(new UpdateCommand({
      TableName: LOAD_TABLE,
      Key: { id: existing.id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: values[':stops'] ? { '#s': 'stops' } : undefined,
      ExpressionAttributeValues: values,
      ConditionExpression:
        'attribute_exists(id) AND (attribute_not_exists(deliveryDriverId) OR attribute_type(deliveryDriverId, :null))',
    }))
    assigned++
    console.log(`ASSIGNED ${row.ref} → ${driver.name}  (load ${existing.id})`)
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      skipped++
      console.log(`SKIP     ${row.ref} — changed under us (already created or assigned); re-run to re-plan`)
      continue
    }
    failed++
    console.error(`FAIL     ${row.ref}: ${err?.message ?? err}`)
  }
}

console.log(`\nDone: ${created} created, ${assigned} assigned, ${skipped} skipped, ${failed} failed.`)
if (failed > 0) process.exit(1)
