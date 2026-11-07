#!/usr/bin/env node
/**
 * Seed the four REVENUE divisions on the DEV site (PHASE0-plan §5.6, DECIDED-9). Not the billing
 * `Division` table (that is scripts/seedDivisions.mjs): this is `OwnershipDivision`, the tag the
 * board, the dashboards and the ownership rules read.
 *
 *   node scripts/seedRevDivisions.mjs            dry run (default): prints the plan, writes nothing
 *   node scripts/seedRevDivisions.mjs --apply    performs the plan
 *
 * Target state: exactly four ACTIVE divisions —
 *   ASSETS "Ivan Cartage", BROKERAGE "BCAT Logistics", CAR_SHIPPING "Auto Shipping" (a RENAME of the
 *   existing row: same code, so every rule and every tagged shipment keeps working) and OWNER_OPERATOR
 *   "Owner Operators" (made top-level, with the owners/flows it used to inherit copied onto it so its
 *   behaviour does not change).
 *
 * Only the existing SAVE_OWNERSHIP_DIVISION / ARCHIVE_OWNERSHIP_DIVISION actions are used: no raw
 * table writes, nothing is ever deleted, and anything not in the target list is ARCHIVED — but only
 * when no active rule and no active subsidiary still names it. A referenced division is left alone and
 * the plan lists exactly what references it (Ryne decides: PHASE0 O-7).
 *
 * `intakeEmail` is filled ONLY where blank, with the UNCONFIRMED placeholders below, saved with
 * `intakeEmailConfirmed:false`: the Divisions page badges them UNCONFIRMED and the inbound matcher
 * ignores them until an admin confirms the mailbox. A non-blank address is never overwritten.
 *
 * Dev by default: refuses any AppSync endpoint or Cognito pool but the dev ones, with a throwaway ADMIN
 * identity that is deleted (and re-read to prove it) in `finally`. Idempotent: a second run is a no-op.
 *
 * SALES REP BY DIVISION (AW-CDE-plan C.5): `--reps --suffix <non-production table suffix>` instead seeds
 * `TmsSettings.divisionSalesReps` (BROKERAGE = Ryne Bandolik, ASSETS = the non-login "Ivan Cartage" profile `ivan-cartage`,
 * CAR_SHIPPING and OWNER_OPERATOR = Ruben Vargas, matched by UserProfile name) and creates the `ivan-cartage` UserProfile
 * (role NONE, status ACTIVE) when absent. Dry run unless --apply; existing map entries are never overwritten; a named person
 * who is not found (or is ambiguous) FAILS the run (exit 2), nobody is invented. Direct DynamoDB (UserProfile is read-only
 * to clients); the production suffix is refused outright, there is no production path for this mode.
 *
 * Production only via `--target prod` (the shared gate in lib/prodGate.mjs; `--outputs <repo-root amplify_outputs.json>`,
 * signs in with BCAT_EMAIL / BCAT_PASSWORD, no identity is minted):
 *   --target prod --i-mean-production, env BCAT_ALLOW_PROD=<today>, fresh prodpre-seedRevDivisions- backups to --apply,
 *   typed confirmation; a dry run unless --apply (see lib/prodGate.mjs).
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'
import { loadAmplifyOutputs } from './lib/tmsConfig.mjs'
import { PROD_GATE_OPTIONS, requireProd } from './lib/prodGate.mjs'
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const DEV_APPSYNC = APPSYNC_URL_RE

/** UNCONFIRMED placeholders — nothing routes to these until an admin confirms the mailbox exists. */
export const PLACEHOLDER_EMAILS = {
  ASSETS: 'tenders-ivan-cartage@bcatcorp.com',
  BROKERAGE: 'tenders-bcat-logistics@bcatcorp.com',
  CAR_SHIPPING: 'tenders-auto-shipping@bcatcorp.com',
  OWNER_OPERATOR: 'tenders-owner-operators@bcatcorp.com',
}

/** Run order matters only for display: ASSETS first, as the board lists it. */
export const TARGET_DIVISIONS = [
  { code: 'ASSETS', name: 'Ivan Cartage', sortOrder: 10, topLevel: false },
  { code: 'BROKERAGE', name: 'BCAT Logistics', sortOrder: 20, topLevel: false },
  { code: 'CAR_SHIPPING', name: 'Auto Shipping', brand: 'Auto Shipping', sortOrder: 30, topLevel: false },
  { code: 'OWNER_OPERATOR', name: 'Owner Operators', sortOrder: 40, topLevel: true },
]

const OWNER_KEYS = ['building', 'booking', 'tracking', 'invoicing', 'carrierPay', 'settlements']
const FLOW_KEYS = ['calendar', 'dispatch', 'driverApp', 'driverPay', 'fleetDashboards', 'carShipping']

const norm = (s) => (typeof s === 'string' && s.trim() !== '' ? s.trim().toLowerCase() : null)
const blank = (s) => typeof s !== 'string' || s.trim() === ''
const asJson = (v) => {
  if (typeof v !== 'string') return v ?? null
  try { return JSON.parse(v) } catch { return null }
}

/** Existing values win; a slot the child leaves empty takes the parent's. */
function mergeSlots(keys, own, parent, isSet) {
  const out = {}
  for (const key of keys) {
    const mine = own?.[key]
    if (isSet(mine)) out[key] = mine
    else if (isSet(parent?.[key])) out[key] = parent[key]
  }
  return Object.keys(out).length ? out : null
}
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The whole plan, pure: no I/O. `divisions` are OwnershipDivision rows (owners/flows may still be
 * JSON strings), `rules` are OwnershipRule rows, `shipmentCounts` an optional Map code -> n (info only).
 * Returns { steps, blocked, notes, final } where each step is
 *   { kind: 'SAVE', code, input, why: string[] } | { kind: 'ARCHIVE', code, why: string[] }.
 */
export function planRevDivisions({ divisions, rules = [], shipmentCounts = new Map() }) {
  const rows = new Map(divisions.map((d) => [d.code ?? d.id, {
    ...d, code: d.code ?? d.id, owners: asJson(d.owners), flows: asJson(d.flows),
  }]))
  const steps = []
  const blocked = []
  const notes = []
  const targetCodes = new Set(TARGET_DIVISIONS.map((t) => t.code))
  const taken = new Map() // normalised active address -> code
  for (const d of rows.values()) if (d.active && norm(d.intakeEmail)) taken.set(norm(d.intakeEmail), d.code)

  for (const target of TARGET_DIVISIONS) {
    const row = rows.get(target.code)
    const why = []
    const next = row
      ? { ...row }
      : {
        id: target.code, code: target.code, name: target.name, brand: target.brand ?? null, parentId: null, color: null,
        sortOrder: target.sortOrder, active: true, owners: null, flows: null, intakeEmail: null,
      }
    if (!row) why.push('create (not present)')
    if (next.name !== target.name) { why.push(`rename "${next.name}" -> "${target.name}"`); next.name = target.name }
    if (target.brand && (blank(next.brand) || next.brand === row?.name) && next.brand !== target.brand) {
      why.push(`brand -> "${target.brand}"`)
      next.brand = target.brand
    }
    if (!next.active) { why.push('reactivate'); next.active = true }
    if (target.topLevel && next.parentId != null) {
      const parent = rows.get(next.parentId)
      why.push(`make top-level (was under ${next.parentId}); copy owners/flows it inherited so behaviour is unchanged`)
      // Inherit through the whole chain, nearest ancestor first, exactly as the app resolves it.
      let owners = next.owners
      let flows = next.flows
      for (let at = parent, hops = 0; at && hops < 10; at = rows.get(at.parentId), hops += 1) {
        owners = mergeSlots(OWNER_KEYS, owners, at.owners, (v) => typeof v === 'string' && v.trim() !== '')
        flows = mergeSlots(FLOW_KEYS, flows, at.flows, (v) => typeof v === 'boolean')
      }
      next.owners = owners
      next.flows = flows
      next.parentId = null
    }
    let filled = false
    if (blank(next.intakeEmail)) {
      const placeholder = PLACEHOLDER_EMAILS[target.code]
      const owner = taken.get(placeholder)
      if (owner && owner !== target.code) {
        blocked.push({ code: target.code, reason: `placeholder ${placeholder} is already used by ${owner}` })
      } else {
        why.push(`intake e-mail blank -> ${placeholder} (UNCONFIRMED)`)
        next.intakeEmail = placeholder
        taken.set(placeholder, target.code)
        filled = true
      }
    } else {
      notes.push(`${target.code}: keeps its existing intake e-mail (never overwritten)`)
    }
    if (why.length === 0) continue
    const input = {
      id: target.code, code: target.code, name: next.name, brand: next.brand ?? null, parentId: next.parentId ?? null,
      color: next.color ?? null, sortOrder: next.sortOrder ?? target.sortOrder, active: next.active,
      owners: next.owners ?? null, flows: next.flows ?? null,
      intakeEmail: blank(next.intakeEmail) ? null : next.intakeEmail,
      ...(filled ? { intakeEmailConfirmed: false } : {}),
    }
    // A brand-new row is a create: SAVE_OWNERSHIP_DIVISION refuses an `id` for a code that does not exist yet.
    if (!row) delete input.id
    steps.push({ kind: 'SAVE', code: target.code, input, why })
    rows.set(target.code, { ...next, version: row?.version })
  }

  // Everything else that is active is archived — deepest first, and only when nothing active still names it.
  const rest = [...rows.values()].filter((d) => d.active && !targetCodes.has(d.code))
  const archived = new Set()
  const depth = (d) => { let n = 0; for (let at = d; at?.parentId && n < 10; at = rows.get(at.parentId)) n += 1; return n }
  rest.sort((a, b) => depth(b) - depth(a) || String(a.code).localeCompare(String(b.code)))
  for (const d of rest) {
    const refs = []
    for (const child of rows.values()) {
      if (child.code !== d.code && child.active && child.parentId === d.code && !archived.has(child.code)) {
        refs.push(`active subsidiary ${child.code}`)
      }
    }
    for (const rule of rules) {
      if (rule.active !== false && rule.divisionCode === d.code) refs.push(`active rule "${rule.name ?? rule.id}" (${rule.id})`)
    }
    const shipments = shipmentCounts.get(d.code) ?? 0
    if (refs.length) {
      blocked.push({ code: d.code, reason: `not archived — still referenced by ${refs.join('; ')}${shipments ? `; ${shipments} shipment(s) tagged` : ''}` })
      continue
    }
    archived.add(d.code)
    steps.push({
      kind: 'ARCHIVE', code: d.code,
      why: [`not in the target list${shipments ? ` (${shipments} shipment(s) stay tagged and resolvable)` : ''}; no active rule or subsidiary names it`],
    })
  }

  const final = [...rows.values()].map((d) => ({ ...d, active: d.active && !archived.has(d.code) }))
  return { steps, blocked, notes, final }
}

/** Dry-run text: exactly what would change, the four addresses for Ryne, and what is blocked. */
export function describePlan(plan, { apply }) {
  const out = [apply ? 'APPLY' : 'DRY RUN (nothing written; pass --apply to perform)']
  if (plan.steps.length === 0) out.push('nothing to do: the four revenue divisions are already in the target state')
  for (const s of plan.steps) out.push(`  ${s.kind} ${s.code}: ${s.why.join('; ')}`)
  for (const b of plan.blocked) out.push(`  BLOCKED ${b.code}: ${b.reason}`)
  for (const n of plan.notes) out.push(`  note: ${n}`)
  out.push('Intake e-mail placeholders (UNCONFIRMED — for Ryne to confirm or replace in Divisions & ownership):')
  for (const t of TARGET_DIVISIONS) out.push(`  ${t.name.padEnd(16)} ${PLACEHOLDER_EMAILS[t.code]}`)
  return out.join('\n')
}

/** Performs the steps in order through two injected calls (the real ones are router actions). */
export async function applyPlan(plan, { save, archive }) {
  const done = []
  for (const s of plan.steps) {
    if (s.kind === 'SAVE') await save(s.input)
    else await archive({ id: s.code })
    done.push(`${s.kind} ${s.code}`)
  }
  return done
}

// ── Sales rep by division (seed values live here, never in app code) ─────────

/** Seed identities. `match` is a normalised UserProfile name; `create` = non-login profile made when absent. */
export const DIVISION_REP_SEED = {
  BROKERAGE: { match: 'ryne bandolik' },
  ASSETS: { id: 'ivan-cartage', name: 'Ivan Cartage', match: 'ivan cartage', create: true },
  CAR_SHIPPING: { match: 'ruben vargas' },
  OWNER_OPERATOR: { match: 'ruben vargas' },
}
export const REP_SEED_USER = 'migration:seedRevDivisions'
const PROD_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4'

const normName = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '')

/**
 * Pure plan for `TmsSettings.divisionSalesReps`. `profiles` = UserProfile rows, `settings` = the TmsSettings row (or null).
 * Returns { createProfile, reps, patch, missing, notes }: `reps` is the final map, `patch` the map to write (null = no change),
 * `missing` lists divisions whose person could not be resolved uniquely (a non-empty list fails the run).
 */
export function planDivisionReps({ profiles, settings, nowIso = new Date().toISOString() }) {
  let current = settings?.divisionSalesReps ?? {}
  if (typeof current === 'string') { try { current = JSON.parse(current) } catch { current = {} } }
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {}
  const reps = {}
  const missing = []
  const notes = []
  let createProfile = null
  for (const [division, seed] of Object.entries(DIVISION_REP_SEED)) {
    if (typeof current[division] === 'string' && current[division].trim() !== '') {
      reps[division] = current[division]
      notes.push(`${division}: keeps its existing rep (never overwritten)`)
      continue
    }
    const hits = profiles.filter((p) => (seed.id && p.id === seed.id) || normName(p.name) === seed.match)
    if (hits.length === 1) { reps[division] = hits[0].id; continue }
    if (hits.length > 1) { missing.push({ division, reason: `${hits.length} profiles match "${seed.match}"` }); continue }
    if (seed.create) {
      createProfile = {
        id: seed.id, __typename: 'UserProfile', email: `${seed.id}@no-login.invalid`, name: seed.name, role: 'NONE', status: 'ACTIVE',
        teamKeys: [], claims: [], extraPages: [], createdBy: REP_SEED_USER, updatedBy: REP_SEED_USER, version: 1, createdAt: nowIso, updatedAt: nowIso,
      }
      reps[division] = seed.id
      continue
    }
    missing.push({ division, reason: `no UserProfile named "${seed.match}" in this stack` })
  }
  const changed = Object.keys(reps).some((k) => reps[k] !== current[k])
  return { createProfile, reps, patch: changed && missing.length === 0 ? { ...current, ...reps } : null, missing, notes }
}

export function describeRepPlan(plan, { apply, suffix }) {
  const out = [`${apply ? 'APPLY' : 'DRY RUN (nothing written; pass --apply to perform)'} — divisionSalesReps on ${suffix}`]
  if (plan.createProfile) out.push(`  CREATE UserProfile ${plan.createProfile.id} ("${plan.createProfile.name}", role NONE, ACTIVE, no login)`)
  for (const [d, id] of Object.entries(plan.reps)) out.push(`  ${d} -> ${id}`)
  for (const m of plan.missing) out.push(`  MISSING ${m.division}: ${m.reason}`)
  for (const n of plan.notes) out.push(`  note: ${n}`)
  if (!plan.patch && plan.missing.length === 0) out.push('  nothing to do')
  return out.join('\n')
}

async function scanTable(doc, TableName) {
  const items = []
  let ExclusiveStartKey
  do {
    const page = await doc.send(new ScanCommand({ TableName, ExclusiveStartKey }))
    items.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

/** `--reps --suffix <s>`: refuses production, fails loudly when a named person is absent. */
async function runReps({ suffix, apply }) {
  if (!suffix || suffix.includes(PROD_FRAGMENT)) throw new Error('--reps needs an explicit non-production --suffix (production is refused)')
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
  const profileTable = `UserProfile-${suffix}`
  const settingsTable = `TmsSettings-${suffix}`
  const profiles = await scanTable(doc, profileTable)
  const settings = (await scanTable(doc, settingsTable)).find((r) => r.id === 'default') ?? null
  if (!settings) throw new Error(`${settingsTable} has no 'default' row: refusing to create it`)
  const plan = planDivisionReps({ profiles, settings })
  console.log(describeRepPlan(plan, { apply, suffix }))
  if (plan.missing.length) { process.exitCode = 2; return }
  if (!apply) return
  if (plan.createProfile) {
    await doc.send(new PutCommand({ TableName: profileTable, Item: plan.createProfile, ConditionExpression: 'attribute_not_exists(id)' }))
  }
  if (plan.patch) {
    await doc.send(new UpdateCommand({
      TableName: settingsTable, Key: { id: 'default' }, ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET divisionSalesReps = :m, updatedBy = :by, updatedAt = :at',
      ExpressionAttributeValues: { ':m': plan.patch, ':by': REP_SEED_USER, ':at': new Date().toISOString() },
    }))
  }
  console.log('applied')
}

async function listAll(gqlCall, token, field, selection) {
  const items = []
  let next = null
  do {
    const r = await gqlCall(token, `query($n: String) { ${field}(limit: 1000, nextToken: $n) { items { ${selection} } nextToken } }`, { n: next })
    items.push(...r[field].items)
    next = r[field].nextToken
  } while (next)
  return items
}

/** The same AppSync call as devIdentity's `gql`/`routerAs`, against the endpoint of the outputs file (--target prod). */
const apiAt = (endpoint) => {
  const call = async (token, query, variables) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: JSON.stringify({ query, variables }),
    })
    const body = await res.json()
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '))
    return body.data
  }
  const router = (token, field) => async (action, input) => {
    const data = await call(token, `mutation($action:String!,$input:AWSJSON!){ ${field}(action:$action,input:$input) }`, { action, input: JSON.stringify(input ?? {}) })
    const raw = data[field]
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  }
  return { call, router }
}

/** Read the four lists, print the plan, and (apply) perform it, as the admin `token` through `api`. */
async function runPlan({ token, api, apply }) {
  const dir = api.router(token, 'tmsDirectoryActions')
  const divisions = await listAll(api.call, token, 'listOwnershipDivisions', 'id code name brand parentId color sortOrder active owners flows intakeEmail version')
  const rules = await listAll(api.call, token, 'listOwnershipRules', 'id name active divisionCode')
  const shipmentCounts = new Map()
  for (const s of await listAll(api.call, token, 'listShipments', 'revDivision')) {
    if (s.revDivision) shipmentCounts.set(s.revDivision, (shipmentCounts.get(s.revDivision) ?? 0) + 1)
  }
  const plan = planRevDivisions({ divisions, rules, shipmentCounts })
  console.log(describePlan(plan, { apply }))
  if (apply) {
    const done = await applyPlan(plan, {
      save: (input) => dir('SAVE_OWNERSHIP_DIVISION', input),
      archive: (input) => dir('ARCHIVE_OWNERSHIP_DIVISION', input),
    })
    console.log(`applied ${done.length} step(s): ${done.join(', ') || '-'}`)
  }
  if (plan.blocked.length) process.exitCode = 2
}

async function main() {
  const args = parseArgs({ options: { apply: { type: 'boolean' }, reps: { type: 'boolean' }, suffix: { type: 'string' }, outputs: { type: 'string' }, ...PROD_GATE_OPTIONS }, allowPositionals: false })
  if (args.values.reps) {
    await runReps({ suffix: args.values.suffix, apply: args.values.apply === true })
    return
  }
  const prod = await requireProd({ script: 'seedRevDivisions', values: args.values, tables: PROD_WRITE_SETS.seedRevDivisions.models })
  if (prod) {
    // Production (or the rehearsal seam): sign in as BCAT_EMAIL / BCAT_PASSWORD (an ADMIN) on the pool in the outputs
    // file. No throwaway identity is ever minted outside the dev pool.
    const outputs = loadAmplifyOutputs(args.values.outputs, prod)
    const auth = await authenticateTmsUser(outputs)
    await runPlan({ token: auth.token, api: apiAt(auth.endpoint), apply: prod.apply })
    return
  }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('seedRevDivisions refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('seedRevDivisions refuses any staff pool other than the dev pool')
  const apply = args.values.apply === true
  const email = `zz-revdiv-admin-${Date.now()}@example.invalid`
  let made = false
  try {
    const admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    await runPlan({ token: admin.token, api: { call: gql, router: routerAs }, apply })
  } finally {
    if (made) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary admin identity ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`seedRevDivisions failed: ${err?.message ?? err}`); process.exit(1) })
}
