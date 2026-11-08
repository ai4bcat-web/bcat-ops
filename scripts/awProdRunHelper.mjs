#!/usr/bin/env node
/**
 * Node helpers for scripts/awProdRun.sh (the guided production data-load runner). Prints counts / yes-no flags only:
 * never a row value, e-mail, password or tax id. No production write of any kind lives here.
 *
 *   rows <csv> <kind>             -> "rows=N" and "sensitive=yes|no" (kind: customers|carriers|ap-aging|ap-expected|ar|export)
 *   pros <csv> <out>              -> writes the first column of every data row to <out> (mode 600): the --export-keys list
 *   login <prod|dev|rehearsal>    -> signs in with BCAT_EMAIL / BCAT_PASSWORD through the same AppSync/Cognito path awProd uses
 *   jenny <prod|dev|rehearsal>    -> "jenny: found|not found" (read-only Cognito ListUsers; the e-mail is never printed)
 *   suffix <dev|rehearsal>        -> "apiId=<table suffix fragment>"
 *   dev-outputs <dev|rehearsal> <path>   -> writes the non-production amplify outputs JSON awImport.mjs needs
 *   dev-settings | dev-backfill   -> test-mode (dev / rehearsal) stand-ins that print awProd's settings / backfill log lines
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SENSITIVE = {
  customers: ['web password'],
  carriers: ['fed/ss #', 'bank account', 'routing #', 'account #'],
  export: ['web password', 'fed/ss #', 'bank account', 'routing #'],
}
const PROD_STAFF_POOL = 'us-east-1_IbPKPNJC9'
const JENNY = 'jenny@bcatcorp.com'

/** RFC-4180 records of `text` (quoted newlines allowed). Pure. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let any = false
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += c
    } else if (c === '"') { quoted = true; any = true } else if (c === ',') { row.push(field); field = ''; any = true } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      if (any || field !== '') { row.push(field); rows.push(row) }
      row = []; field = ''; any = false
    } else { field += c; any = true }
  }
  if (any || field !== '') { row.push(field); rows.push(row) }
  return rows
}

export function describeCsv(text, kind) {
  const rows = parseCsv(text)
  const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const refused = SENSITIVE[kind] ?? []
  return { rows: Math.max(0, rows.length - 1), sensitive: refused.some((h) => headers.includes(h)) }
}

function targetOutputs(target) {
  if (target === 'prod') {
    const url = JSON.parse(execFileSync('aws', ['appsync', 'get-graphql-api', '--api-id', '5ucwdyvwivelbo4k4jomvrwel4', '--output', 'json'], { encoding: 'utf8' })).graphqlApi?.uris?.GRAPHQL
    return import('./awProd.mjs').then((m) => m.productionOutputs(url))
  }
  return import('./lib/stackConfig.mjs').then(({ STACK }) => ({
    version: '1.3',
    auth: { aws_region: STACK.region, user_pool_id: STACK.staffPoolId, user_pool_client_id: STACK.staffClientId, username_attributes: ['email'] },
    data: { url: STACK.apiUrl, aws_region: STACK.region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS', authorization_types: [] },
  }))
}

async function login(target) {
  try {
    const { authenticateTmsUser } = await import('./lib/tmsAuth.mjs')
    await authenticateTmsUser(await targetOutputs(target))
    console.log('login: OK')
  } catch (err) {
    console.log(`login: FAILED (${err?.name ?? 'Error'})`)
    process.exitCode = 1
  }
}

async function jenny(target) {
  const pool = target === 'prod' ? PROD_STAFF_POOL : (await import('./lib/stackConfig.mjs')).STACK.staffPoolId
  const out = JSON.parse(execFileSync('aws', ['cognito-idp', 'list-users', '--user-pool-id', pool, '--query', 'Users[].Attributes[?Name==`email`].Value[]', '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  const hits = out.flat().filter((e) => String(e).trim().toLowerCase() === JENNY).length
  console.log(`jenny: ${hits === 1 ? 'found' : hits === 0 ? 'not found' : 'duplicated'}`)
  if (hits !== 1) process.exitCode = 1
}

async function devClients() {
  const { DynamoDBClient, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb')
  const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb')
  const { STACK } = await import('./lib/stackConfig.mjs')
  const dynamo = new DynamoDBClient({ region: STACK.region })
  const doc = DynamoDBDocumentClient.from(dynamo, { marshallOptions: { removeUndefinedValues: true } })
  return { dynamo, doc, STACK, DescribeTableCommand, ScanCommand }
}

async function devSettings() {
  const { doc, STACK, ScanCommand } = await devClients()
  const mod = await import('./seedSeries20000.mjs')
  const settings = ((await doc.send(new ScanCommand({ TableName: `TmsSettings-${STACK.tableSuffix}` }))).Items ?? []).find((r) => r.id === 'default') ?? null
  const plan = mod.planSeries20000({ settings, maxClaimedPro: null })
  console.log(`settings plan: ${plan.action} (${plan.action === 'SET' ? 'counter -> 19999, NUMERIC; first PRO 20000' : plan.reason})`)
  if (plan.action === 'REFUSE') process.exitCode = 2
}

async function devBackfill(argv) {
  const { register } = await import('node:module')
  register('./lib/tsExtensionlessHooks.mjs', import.meta.url)
  const { doc, dynamo, STACK, DescribeTableCommand } = await devClients()
  const m = await import('./awBackfillShipments.mjs')
  const { resolveBatchSize } = await import('./backfillShipments.mjs')
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const keysFile = opt('export-keys')
  const exportKeys = keysFile ? m.parseExportKeys(readFileSync(resolve(process.cwd(), keysFile), 'utf8')) : new Set()
  const first = await m.run({ read: () => m.readSource(doc, STACK.tableSuffix), client: undefined, apply: false, cutoff: opt('cutoff'), exportKeys, batchSize: resolveBatchSize() })
  const kv = (o) => Object.entries(o).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`backfill before: ${kv({ ...first.before.report.counts, ...first.before.window.outOfWindow, totalLoads: first.before.window.totalLoads })}`)
  const shipments = await dynamo.send(new DescribeTableCommand({ TableName: `Shipment-${STACK.tableSuffix}` })).then((r) => Number(r.Table?.ItemCount ?? 0), () => 0)
  console.log(`table Shipment: before ${shipments}, after ${shipments}, delta 0`)
  console.log('backfill refusals not evaluated (test mode)')
}

export async function main(argv) {
  const [cmd, a, b] = argv
  if (cmd === 'rows' || cmd === 'pros') {
    const text = readFileSync(resolve(a), 'utf8')
    if (cmd === 'rows') {
      const d = describeCsv(text, b)
      console.log(`rows=${d.rows}`)
      console.log(`sensitive=${d.sensitive ? 'yes' : 'no'}`)
    } else {
      const rows = parseCsv(text)
      const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
      const i = Math.max(0, headers.indexOf('pro #'))
      writeFileSync(resolve(b), `${rows.slice(1).map((r) => (r[i] ?? '').trim()).join('\n')}\n`, { mode: 0o600 })
      chmodSync(resolve(b), 0o600)
      console.log(`pros=${rows.length - 1}`)
    }
  } else if (cmd === 'login') await login(a)
  else if (cmd === 'jenny') await jenny(a)
  else if (cmd === 'suffix') {
    process.env.BCAT_STACK = a
    const { STACK } = await import('./lib/stackConfig.mjs')
    console.log(`apiId=${STACK.tableSuffix.replace(/-NONE$/, '')}`)
  } else if (cmd === 'dev-outputs') {
    process.env.BCAT_STACK = a
    writeFileSync(resolve(b), JSON.stringify(await targetOutputs(a)), { mode: 0o600 })
  } else if (cmd === 'dev-settings') await devSettings()
  else if (cmd === 'dev-backfill') await devBackfill(argv.slice(1))
  else {
    console.error('usage: awProdRunHelper.mjs rows|pros|login|jenny|suffix|dev-outputs|dev-settings|dev-backfill ...')
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`${err?.name ?? 'Error'}: helper failed`)
    process.exit(1)
  })
}
