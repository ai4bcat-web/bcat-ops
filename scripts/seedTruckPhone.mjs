#!/usr/bin/env node
/**
 * Step AK — put a test work phone on the truck currently assigned to driver John Brittich (dev; production only
 * through the shared gate, and CUTOVER_PLAN ADVISES AGAINST running this on production: it is a test fixture).
 *
 *   node scripts/seedTruckPhone.mjs --phone=<US number>            # dry run (default): prints the plan
 *   node scripts/seedTruckPhone.mjs --phone=<US number> --apply    # writes TruckConfig.phone / phoneLabel
 *   node scripts/seedTruckPhone.mjs --revert --apply               # writes phone: null, phoneLabel: null
 *   node scripts/seedTruckPhone.mjs --phone=<US number> --target prod --i-mean-production --outputs <repo-root amplify_outputs.json>
 *                                                                   # production-gated (scripts/lib/prodGate.mjs); dry run unless --apply;
 *                                                                   # signs in as BCAT_EMAIL / BCAT_PASSWORD (ADMIN), mints nobody
 *
 * The number comes ONLY from --phone= or the AJK_SEED_PHONE environment variable. It is never
 * stored in this repository and is printed masked (last four digits). Truck choice: the truck on
 * John Brittich's driver file (`assignedTruckId`); `--truck=<unitNumber>` names one instead
 * (it does NOT assign that truck to the driver). Without --target prod: the endpoint is the dev AppSync API,
 * a production table suffix anywhere in the target aborts before a single read, a throwaway admin login is
 * minted in the dev pool and deleted afterwards. With --target prod the shared gate decides and the
 * identity is the BCAT_EMAIL / BCAT_PASSWORD ADMIN login on the pool in --outputs. SSM is never touched.
 */
import { pathToFileURL } from 'node:url'
import { parseArgs as nodeParseArgs } from 'node:util'
import { PROD_GATE_OPTIONS, requireProd } from './lib/prodGate.mjs'
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs'

export const DRIVER_NAME = 'John Brittich'
export const PHONE_LABEL = 'Dev test phone (Ryne)'
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4'
const DEV_API_HOST = 'f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com'

/** US E.164 only (what Twilio is set up for). Returns null for anything else. */
export function toE164(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return national.length === 10 ? `+1${national}` : null
}

/** A number becomes `***-***-0142`: logs carry the last four digits and nothing else. */
export function mask(number) {
  const digits = String(number ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '(none)'
}

/** Throws unless the target is the dev stack. */
export function assertDevTarget({ endpoint, suffix }) {
  const where = `${endpoint ?? ''} ${suffix ?? ''}`
  if (where.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error('Refusing to run against production: this seed is a dev-only test fixture.')
  }
  if (endpoint && !endpoint.includes(DEV_API_HOST)) {
    throw new Error(`Refusing a non-dev endpoint (${endpoint}).`)
  }
}

/**
 * Decide what to write. Pure.
 * @returns {{ ok: true, action: 'create'|'update'|'unchanged', input: object, truck: { id: string, unit: string }, driver: { id: string } }
 *   | { ok: false, code: 2, error: string }}
 */
export function planTruckPhone({ drivers, equipment, configs, truckUnit, phone, revert }) {
  const matches = drivers.filter((d) => d.name === DRIVER_NAME)
  if (matches.length !== 1) {
    const candidates = matches.map((d) => `${d.id} (${d.name})`).join(', ')
    return {
      ok: false, code: 2,
      error: matches.length === 0
        ? `No driver named "${DRIVER_NAME}" on dev.`
        : `${matches.length} drivers are named "${DRIVER_NAME}" — refusing to guess: ${candidates}`,
    }
  }
  const driver = matches[0]

  let truck
  if (truckUnit) {
    truck = equipment.find((e) => e.type === 'truck' && String(e.unitNumber) === String(truckUnit))
    if (!truck) return { ok: false, code: 2, error: `No truck with unit ${truckUnit} on dev.` }
  } else {
    if (!driver.assignedTruckId) {
      return { ok: false, code: 2, error: `${DRIVER_NAME} has no assigned truck on dev; assign one in Files › Edit or pass --truck=<unit>` }
    }
    truck = equipment.find((e) => e.id === driver.assignedTruckId)
    if (!truck) return { ok: false, code: 2, error: `${DRIVER_NAME}'s assigned truck ${driver.assignedTruckId} is not in Equipment.` }
  }

  const existing = configs.find((c) => c.truckId === truck.id) ?? null
  const input = { truckId: truck.id, unitNumber: String(truck.unitNumber) }
  if (revert) {
    input.phone = null
    input.phoneLabel = null
  } else {
    input.phone = phone
    input.phoneLabel = PHONE_LABEL
  }
  const same = existing && (existing.phone ?? null) === input.phone && (existing.phoneLabel ?? null) === input.phoneLabel
  const action = same ? 'unchanged' : existing ? 'update' : 'create'
  return { ok: true, action, input, truck: { id: truck.id, unit: String(truck.unitNumber) }, driver: { id: driver.id } }
}

/** One masked line per fact; never the raw number. */
export function describePlan(plan, apply) {
  if (!plan.ok) return `ERROR: ${plan.error}`
  const what = plan.input.phone ? `phone ${mask(plan.input.phone)}` : 'phone cleared'
  const verb = plan.action === 'unchanged' ? 'already set' : `${apply ? 'wrote' : 'would write'} (${plan.action})`
  return `driver ${plan.driver.id} → truck ${plan.truck.unit} (${plan.truck.id}): ${what} — ${verb}`
}

export function parseArgs(argv, env = {}) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean' },
      revert: { type: 'boolean' },
      truck: { type: 'string' },
      phone: { type: 'string' },
      outputs: { type: 'string' },
      ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  })
  return {
    apply: values.apply === true,
    revert: values.revert === true,
    truckUnit: values.truck || null,
    phone: values.phone ?? env.AJK_SEED_PHONE ?? null,
    values,
  }
}

/** GraphQL against the endpoint a production-gated run signed in to (the dev helper is pinned to the dev API). */
async function gqlAt(endpoint, token, query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}

const TRUCK_CONFIG_FIELDS = 'truckId unitNumber phone phoneLabel'

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env)
  let phone = null
  if (!args.revert) {
    phone = toE164(args.phone)
    if (!phone) {
      console.error('A US phone number is required: --phone=<number> or env AJK_SEED_PHONE (it is never stored in the repo).')
      process.exit(2)
    }
  }
  const prod = await requireProd({ script: 'seedTruckPhone', values: args.values, tables: PROD_WRITE_SETS.seedTruckPhone.models })
  const apply = prod ? prod.apply : args.apply
  let token
  let gql
  let email
  let dev
  let created = false
  if (prod) {
    const { loadAmplifyOutputs } = await import('./lib/tmsConfig.mjs')
    const { authenticateTmsUser } = await import('./lib/tmsAuth.mjs')
    const auth = await authenticateTmsUser(loadAmplifyOutputs(args.values.outputs, prod))
    token = auth.token
    gql = (t, query, variables) => gqlAt(auth.endpoint, t, query, variables)
  } else {
    dev = await import('./lib/devIdentity.mjs')
    assertDevTarget({ endpoint: dev.DEV_API, suffix: process.env.TABLE_SUFFIX })
    gql = dev.gql
    email = `zz-ajk-seed-${Date.now()}@example.com`
  }
  try {
    if (!prod) token = (await dev.mintIdentity(email, ['ADMIN'])).token
    const list = async (field, fields) => {
      const rows = []
      let nextToken = null
      do {
        const data = await gql(token, `query($n:String){ ${field}(limit:1000, nextToken:$n){ items { ${fields} } nextToken } }`, { n: nextToken })
        rows.push(...data[field].items)
        nextToken = data[field].nextToken
      } while (nextToken)
      return rows
    }
    let schemaReady = true
    const [drivers, equipment] = await Promise.all([
      list('listDrivers', 'id name assignedTruckId'),
      list('listEquipment', 'id type unitNumber'),
    ])
    // Before the AJ/AK deploy the dev schema has no TruckConfig.phone: read what exists so the dry run still plans.
    const configs = await list('listTruckConfigs', TRUCK_CONFIG_FIELDS).catch(async (err) => {
      if (!/Field 'phone(Label)?' in type 'TruckConfig' is undefined/.test(err.message)) throw err
      schemaReady = false
      return list('listTruckConfigs', 'truckId unitNumber')
    })
    const plan = planTruckPhone({ drivers, equipment, configs, truckUnit: args.truckUnit, phone, revert: args.revert })
    console.log(describePlan(plan, apply && schemaReady))
    if (!plan.ok) process.exitCode = plan.code
    else if (apply && !schemaReady) {
      console.error('The dev schema has no TruckConfig.phone yet (AJ/AK not deployed) — nothing written; run --apply after the deploy.')
      process.exitCode = 3
    } else if (apply && plan.action !== 'unchanged') {
      const model = plan.action === 'create' ? 'Create' : 'Update'
      await gql(
        token,
        `mutation($input: ${model}TruckConfigInput!){ ${model.toLowerCase()}TruckConfig(input:$input){ ${TRUCK_CONFIG_FIELDS} } }`,
        { input: plan.input },
      )
    } else if (!apply) console.log('Dry run — pass --apply to write.')
  } finally {
    if (created) console.log(`throwaway login removed: ${await dev.deleteIdentity(email)}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
