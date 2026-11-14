#!/usr/bin/env node
/**
 * Cost to run — daily collector (Ryne, 2026-11-14: "display somewhere in settings what the
 * entire app bcat ops takes to run … Twilio … Hermes … AWS, email, hosting, everything").
 *
 * Runs on the Mac (launchd com.bcat.cost-collector, daily) with the Mac's own AWS profile.
 * Every source is read-only:
 *   - AWS Cost Explorer: daily cost by SERVICE and USAGE_TYPE (account 273354631837).
 *     The account also runs outreach-engine (ECS/EC2/RDS/ELB/App Runner), JobsDone OS and the
 *     Command Center, so shared services are split:
 *       Amplify  → by build minutes per app/branch (list-jobs),
 *       AppSync  → by request count per API (CloudWatch Latency SampleCount),
 *       DynamoDB → provisioned capacity belongs to the old dev-* tables (not BCAT Ops); the
 *                  on-demand part is split by consumed read+write units per stack suffix.
 *     Small services (Lambda, S3, SES, Cognito, CloudWatch, Location, Route 53…) count 100%
 *     to BCAT Ops: an upper bound, labelled as such.
 *   - Twilio: every message and call on the dispatch number (SSM /bcat/dispatch/<pool>/),
 *     priced by Twilio itself, plus the number's monthly rental.
 *   - Hermes: ~/.hermes/state.db session costs for the BCAT Ops jobs only (Hermes cron ids
 *     below, and Command Center iv1/iv2 runs matched by time). Hermes prices them: estimated.
 *   - App AI calls: invocations of the prod parser Lambdas × a per-call estimate.
 *
 * Writes DashboardRollup rows (existing table; the rollup Lambda ignores other kinds):
 *   COST:YYYY-MM  payload { days: { 'YYYY-MM-DD': { <serviceKey>: cents } }, excluded: { 'YYYY-MM-DD': cents } }
 *   COST:META     payload { services, asOf, sources, notes }
 * No secrets are stored; Twilio keys are read from SSM at run time only.
 *
 *   node scripts/costCollector.mjs                 # last 3 days + current/previous month rows
 *   node scripts/costCollector.mjs --backfill      # everything each source still has (AWS: 14 months)
 *   node scripts/costCollector.mjs --dry-run       # print, write nothing
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The AWS SDK comes from the repo's node_modules; launchd runs a copy of this file, so the
// repo is found through BCAT_OPS_DIR (default ~/bcat-ops) when the script's own parent has none.
const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = existsSync(join(here, 'node_modules', '@aws-sdk', 'client-dynamodb')) ? here : (process.env.BCAT_OPS_DIR ?? join(homedir(), 'bcat-ops'))
const require = createRequire(join(repo, 'package.json'))
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb')

const PROD = '5ucwdyvwivelbo4k4jomvrwel4'
const BCAT_TEST_STACKS = ['nc3jsnxdmjhkpequimypiatkma', 'js4yuycvl5dmnghwply2z5z4hy', '77mgrracnrcflguidiahp2vq34', 'i562xmvfkbdyfassgxyegfctea', 'zqugbyh4mfgybm23ewrx3dyzpa']
const BCAT_AMPLIFY_APP = 'd3dejqzs77khq6'
const ROLLUP_TABLE = `DashboardRollup-${PROD}-NONE`
const DISPATCH_SSM = '/bcat/dispatch/us-east-1_IbPKPNJC9/'
const TWILIO_NUMBER_MONTHLY_CENTS = 115
// Hermes cron jobs that do BCAT Ops work (fuel, maintenance invoices, HOS, fuel anomalies, birthdays).
const HERMES_BCAT_CRON = new Set(['0e4a75121399', 'deabadc8ec9f', 'aa33291bf992', '25e57f077364', 'd2dbb2508102'])
const CC_BCAT_JOBS = new Set(['iv1', 'iv2'])
const CC_STORE = join(homedir(), 'AI_WORKSPACE/bcat-command-center/data/store.json')
const HERMES_DB = join(homedir(), '.hermes/state.db')
// Prod Lambdas that call Claude once per invocation, with a per-call estimate in cents
// (a rate con / screenshot / vendor bill is a few thousand input tokens and ~1k output on Sonnet).
const AI_LAMBDAS = [
  { match: '-ma-rateconparserlambda', centsPerCall: 3 },
  { match: '-ma-tripscreenshotparserlamb', centsPerCall: 2 },
  { match: '-ma-vendorapintakelambda', centsPerCall: 3 },
]
// Not BCAT Ops: outreach-engine and friends share this AWS account.
const EXCLUDED_SERVICES = new Set([
  'Amazon Elastic Container Service', 'EC2 - Other', 'Amazon Elastic Compute Cloud - Compute',
  'Amazon Relational Database Service', 'Amazon Elastic Load Balancing', 'AWS App Runner',
  'Amazon Virtual Private Cloud', 'Amazon EC2 Container Registry (ECR)', 'Amazon Elastic Container Registry Public',
  'AWS Secrets Manager',
])

export const SERVICES = [
  { key: 'aws.amplify.prod', label: 'Amplify hosting & builds (live app)', category: 'hosting', source: 'billed', note: 'Split by build minutes per app' },
  { key: 'aws.route53', label: 'DNS (Route 53)', category: 'hosting', source: 'billed' },
  { key: 'aws.appsync.prod', label: 'AppSync API (live app)', category: 'backend', source: 'billed', note: 'Split by requests per API' },
  { key: 'aws.dynamodb.prod', label: 'DynamoDB database (live app)', category: 'backend', source: 'billed', note: 'Split by reads/writes per stack' },
  { key: 'aws.lambda', label: 'Lambda functions', category: 'backend', source: 'billed', note: 'Whole account (upper bound)' },
  { key: 'aws.s3', label: 'S3 file storage', category: 'backend', source: 'billed', note: 'Whole account (upper bound)' },
  { key: 'aws.cloudwatch', label: 'CloudWatch logs & metrics', category: 'backend', source: 'billed', note: 'Whole account (upper bound)' },
  { key: 'aws.location', label: 'AWS Location (maps, geocoding)', category: 'thirdparty', source: 'billed' },
  { key: 'aws.backend.other', label: 'Other AWS (KMS, CodeBuild, API Gateway…)', note: 'Whole account (upper bound)', category: 'backend', source: 'billed' },
  { key: 'aws.ses', label: 'SES e-mail sending', category: 'email', source: 'billed' },
  { key: 'aws.cognito', label: 'Cognito sign-in', category: 'auth', source: 'billed' },
  { key: 'aws.amplify.dev', label: 'Amplify builds (dev & test branches)', category: 'dev', source: 'billed', note: 'Split by build minutes per app' },
  { key: 'aws.appsync.dev', label: 'AppSync API (dev & test stacks)', category: 'dev', source: 'billed', note: 'Split by requests per API' },
  { key: 'aws.dynamodb.dev', label: 'DynamoDB (dev & test stacks)', category: 'dev', source: 'billed', note: 'Split by reads/writes per stack' },
  { key: 'aws.tax', label: 'AWS tax', category: 'other', source: 'billed' },
  { key: 'twilio.sms', label: 'Twilio texts (dispatch number)', category: 'phone', source: 'billed' },
  { key: 'twilio.voice', label: 'Twilio calls (dispatch number)', category: 'phone', source: 'billed' },
  { key: 'twilio.number', label: 'Twilio number rental', category: 'phone', source: 'billed', note: '$1.15/month' },
  { key: 'ai.hermes', label: 'Hermes agents (fuel, maintenance invoices, HOS, birthdays)', category: 'ai', source: 'estimated', note: 'Hermes price estimate per run (OpenRouter)' },
  { key: 'ai.app', label: 'App AI (rate con, trip screenshot, vendor bill parsing)', category: 'ai', source: 'estimated', note: 'Invocations × per-call estimate' },
]

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const BACKFILL = args.has('--backfill')

const day = (d) => d.toISOString().slice(0, 10)
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return day(d) }
const today = day(new Date())
const START = BACKFILL ? '2025-10-01' : addDays(`${today.slice(0, 7)}-01`, -31).slice(0, 7) + '-01'
const END = today // exclusive in Cost Explorer

const aws = (argv) => JSON.parse(execFileSync('aws', [...argv, '--output', 'json'], { maxBuffer: 256 * 1024 * 1024 }).toString() || 'null')

/** days[date][key] += cents */
const days = {}
const excluded = {}
const add = (date, key, cents) => {
  if (!cents || date < START || date >= END) return
  const d = (days[date] ??= {})
  d[key] = (d[key] ?? 0) + cents
}

// ── AWS Cost Explorer ───────────────────────────────────────────────────────────
function costExplorer() {
  const out = []
  let token
  do {
    const r = aws(['ce', 'get-cost-and-usage', '--time-period', `Start=${START},End=${END}`, '--granularity', 'DAILY',
      '--metrics', 'UnblendedCost', '--group-by', 'Type=DIMENSION,Key=SERVICE', 'Type=DIMENSION,Key=USAGE_TYPE',
      ...(token ? ['--next-page-token', token] : [])])
    for (const t of r.ResultsByTime) {
      for (const g of t.Groups) out.push({ date: t.TimePeriod.Start, service: g.Keys[0], usage: g.Keys[1], cents: Number(g.Metrics.UnblendedCost.Amount) * 100 })
    }
    token = r.NextPageToken
  } while (token)
  return out
}

/** Share of a day's use that is BCAT prod / BCAT dev / other, from per-day weights. */
function splitter(weightsByDay) {
  return (date, cents, prodKey, devKey) => {
    const w = weightsByDay[date]
    const total = w ? w.prod + w.dev + w.other : 0
    if (!total) { add(date, prodKey, cents); return } // no usage signal that day: count it to the live app
    add(date, prodKey, (cents * w.prod) / total)
    add(date, devKey, (cents * w.dev) / total)
    excluded[date] = (excluded[date] ?? 0) + (cents * w.other) / total
  }
}

function stackOf(id) {
  if (id.includes(PROD)) return 'prod'
  if (BCAT_TEST_STACKS.some((s) => id.includes(s))) return 'dev'
  return 'other'
}

function amplifyBuildWeights() {
  const weights = {}
  for (const app of aws(['amplify', 'list-apps']).apps) {
    for (const b of aws(['amplify', 'list-branches', '--app-id', app.appId]).branches) {
      let token
      do {
        const r = aws(['amplify', 'list-jobs', '--app-id', app.appId, '--branch-name', b.branchName, '--max-results', '50', ...(token ? ['--next-token', token] : [])])
        for (const j of r.jobSummaries) {
          if (!j.startTime || !j.endTime) continue
          const date = j.startTime.slice(0, 10)
          const mins = (new Date(j.endTime) - new Date(j.startTime)) / 60000
          const who = app.appId !== BCAT_AMPLIFY_APP ? 'other' : b.branchName === 'main' ? 'prod' : 'dev'
          const w = (weights[date] ??= { prod: 0, dev: 0, other: 0 })
          w[who] += Math.max(mins, 0)
        }
        token = r.nextToken
        if (r.jobSummaries.length && r.jobSummaries.at(-1).startTime?.slice(0, 10) < START) token = undefined
      } while (token)
    }
  }
  return weights
}

/** Daily Sum (or SampleCount) per dimension value, via GetMetricData in chunks. */
function metricDaily(namespace, metric, dimName, values, stat) {
  const series = {}
  const startTime = `${START}T00:00:00Z`
  const endTime = `${END}T00:00:00Z`
  for (let i = 0; i < values.length; i += 100) {
    const chunk = values.slice(i, i + 100)
    const queries = chunk.map((v, k) => ({ Id: `m${k}`, MetricStat: { Metric: { Namespace: namespace, MetricName: metric, Dimensions: [{ Name: dimName, Value: v }] }, Period: 86400, Stat: stat }, ReturnData: true }))
    let token
    do {
      const r = aws(['cloudwatch', 'get-metric-data', '--start-time', startTime, '--end-time', endTime, '--metric-data-queries', JSON.stringify(queries), ...(token ? ['--next-token', token] : [])])
      for (const res of r.MetricDataResults) {
        const v = chunk[Number(res.Id.slice(1))]
        res.Timestamps.forEach((ts, n) => { ((series[v] ??= {})[ts.slice(0, 10)] = (series[v]?.[ts.slice(0, 10)] ?? 0) + res.Values[n]) })
      }
      token = r.NextToken
    } while (token)
  }
  return series
}

function weightsFrom(series) {
  const weights = {}
  for (const [id, byDay] of Object.entries(series)) {
    const who = stackOf(id)
    for (const [date, n] of Object.entries(byDay)) { const w = (weights[date] ??= { prod: 0, dev: 0, other: 0 }); w[who] += n }
  }
  return weights
}

function collectAws() {
  const rows = costExplorer()
  const amplify = splitter(amplifyBuildWeights())
  const apis = aws(['appsync', 'list-graphql-apis']).graphqlApis.map((a) => a.apiId)
  const appsync = splitter(weightsFrom(metricDaily('AWS/AppSync', 'Latency', 'GraphQLAPIId', apis, 'SampleCount')))
  const tables = aws(['dynamodb', 'list-tables']).TableNames
  const reads = metricDaily('AWS/DynamoDB', 'ConsumedReadCapacityUnits', 'TableName', tables, 'Sum')
  const writes = metricDaily('AWS/DynamoDB', 'ConsumedWriteCapacityUnits', 'TableName', tables, 'Sum')
  for (const [t, byDay] of Object.entries(writes)) for (const [d, n] of Object.entries(byDay)) ((reads[t] ??= {})[d] = (reads[t][d] ?? 0) + n)
  const dynamo = splitter(weightsFrom(reads))

  for (const r of rows) {
    const { date, service, usage, cents } = r
    if (!cents) continue
    if (EXCLUDED_SERVICES.has(service)) { excluded[date] = (excluded[date] ?? 0) + cents; continue }
    if (service === 'AWS Amplify') amplify(date, cents, 'aws.amplify.prod', 'aws.amplify.dev')
    else if (service === 'AWS AppSync') appsync(date, cents, 'aws.appsync.prod', 'aws.appsync.dev')
    else if (service === 'Amazon DynamoDB') {
      // Provisioned capacity is the old dev-* tables, none of them BCAT Ops.
      if (/CapacityUnit-Hrs/.test(usage)) excluded[date] = (excluded[date] ?? 0) + cents
      else dynamo(date, cents, 'aws.dynamodb.prod', 'aws.dynamodb.dev')
    }
    else if (service === 'AWS Lambda') add(date, 'aws.lambda', cents)
    else if (service === 'Amazon Simple Storage Service') add(date, 'aws.s3', cents)
    else if (service === 'AmazonCloudWatch') add(date, 'aws.cloudwatch', cents)
    else if (service === 'Amazon Location Service') add(date, 'aws.location', cents)
    else if (service === 'Amazon Simple Email Service') add(date, 'aws.ses', cents)
    else if (service === 'Amazon Cognito') add(date, 'aws.cognito', cents)
    else if (service === 'Amazon Route 53') add(date, 'aws.route53', cents)
    else if (service === 'Tax') add(date, 'aws.tax', cents)
    else add(date, 'aws.backend.other', cents)
  }
}

// ── Twilio ──────────────────────────────────────────────────────────────────────
function ssm(name) {
  return execFileSync('aws', ['ssm', 'get-parameter', '--with-decryption', '--name', DISPATCH_SSM + name, '--query', 'Parameter.Value', '--output', 'text']).toString().trim()
}

async function twilioPages(path, query, auth, sid) {
  const out = []
  let url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}.json?${new URLSearchParams({ ...query, PageSize: '1000' })}`
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!res.ok) throw new Error(`Twilio ${path} ${res.status}`)
    const body = await res.json()
    out.push(...(body.messages ?? body.calls ?? []))
    url = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : null
  }
  return out
}

async function collectTwilio() {
  const sid = ssm('TWILIO_ACCOUNT_SID')
  const auth = Buffer.from(`${ssm('TWILIO_API_KEY_SID')}:${ssm('TWILIO_API_KEY_SECRET')}`).toString('base64')
  const num = ssm('DISPATCH_NUMBER')
  const after = { 'DateSent>': START }
  const seen = new Set()
  for (const q of [{ From: num }, { To: num }]) {
    for (const m of await twilioPages('Messages', { ...q, ...after }, auth, sid)) {
      if (seen.has(m.sid)) continue
      seen.add(m.sid)
      add(day(new Date(m.date_sent ?? m.date_created)), 'twilio.sms', Math.abs(Number(m.price ?? 0)) * 100)
    }
    for (const c of await twilioPages('Calls', { ...q, 'StartTime>': START }, auth, sid)) {
      if (seen.has(c.sid)) continue
      seen.add(c.sid)
      add(day(new Date(c.start_time ?? c.date_created)), 'twilio.voice', Math.abs(Number(c.price ?? 0)) * 100)
    }
  }
  // The number was bought 2026-10-10; rental spread evenly over each day it has existed.
  for (let d = '2026-10-10' > START ? '2026-10-10' : START; d < END; d = addDays(d, 1)) {
    const dim = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate()
    add(d, 'twilio.number', TWILIO_NUMBER_MONTHLY_CENTS / dim)
  }
}

// ── Hermes ──────────────────────────────────────────────────────────────────────
function collectHermes() {
  if (!existsSync(HERMES_DB)) return
  const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', HERMES_DB,
    "select id, source, cwd, started_at, coalesce(actual_cost_usd, estimated_cost_usd, 0) as usd from sessions where started_at is not null"]).toString() || '[]')
  // Command Center runs: a Hermes CLI session started inside an iv1/iv2 job run's window is that run.
  const windows = []
  if (existsSync(CC_STORE)) {
    for (const jr of JSON.parse(readFileSync(CC_STORE, 'utf8')).jobRuns ?? []) {
      if (!CC_BCAT_JOBS.has(jr.jobDefinitionId) || !jr.claimedAt) continue
      windows.push([Date.parse(jr.claimedAt) - 60_000, Date.parse(jr.completedAt ?? jr.lastHeartbeatAt ?? jr.claimedAt) + 60_000])
    }
  }
  for (const s of rows) {
    const t = Number(s.started_at) * 1000
    const cron = /^cron_([0-9a-f]{12})_/.exec(s.id)?.[1]
    const bcat = (cron && HERMES_BCAT_CRON.has(cron))
      || (s.source === 'cli' && (s.cwd ?? '').includes('bcat-command-center') && windows.some(([a, b]) => t >= a && t <= b))
    if (bcat) add(day(new Date(t)), 'ai.hermes', Number(s.usd) * 100)
  }
}

// ── App AI (Claude in Lambdas) ──────────────────────────────────────────────────
function collectAppAi() {
  const names = aws(['lambda', 'list-functions', '--query', 'Functions[].FunctionName'])
  for (const { match, centsPerCall } of AI_LAMBDAS) {
    const fns = names.filter((n) => n.includes(match))
    for (const byDay of Object.values(metricDaily('AWS/Lambda', 'Invocations', 'FunctionName', fns, 'Sum'))) {
      for (const [date, n] of Object.entries(byDay)) add(date, 'ai.app', n * centsPerCall)
    }
  }
}

// ── Write ───────────────────────────────────────────────────────────────────────
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]).filter(([, v]) => v))

async function main() {
  const sources = {}
  for (const [name, fn] of [['aws', collectAws], ['twilio', collectTwilio], ['hermes', collectHermes], ['appAi', collectAppAi]]) {
    try { await fn(); sources[name] = { ok: true, at: new Date().toISOString() } } catch (e) { sources[name] = { ok: false, error: String(e.message ?? e).slice(0, 300), at: new Date().toISOString() } }
  }
  const months = {}
  for (const [date, svc] of Object.entries(days)) (months[date.slice(0, 7)] ??= { days: {}, excluded: {} }).days[date] = round(svc)
  for (const [date, c] of Object.entries(excluded)) (months[date.slice(0, 7)] ??= { days: {}, excluded: {} }).excluded[date] = Math.round(c * 100) / 100

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
  const now = new Date().toISOString()
  const put = async (id, payload, merge) => {
    const prev = (await doc.send(new GetCommand({ TableName: ROLLUP_TABLE, Key: { id } }))).Item
    let body = payload
    if (merge && prev?.payload) {
      // Days outside this run's window keep what an earlier run stored.
      const old = typeof prev.payload === 'string' ? JSON.parse(prev.payload) : prev.payload
      body = { days: { ...old.days, ...payload.days }, excluded: { ...old.excluded, ...payload.excluded } }
    }
    const item = { __typename: 'DashboardRollup', id, kind: 'COST', periodKey: id.slice(5), schemaVersion: 1, payload: JSON.stringify(body), computedAt: now, createdAt: prev?.createdAt ?? now, updatedAt: now, version: (prev?.version ?? 0) + 1 }
    if (DRY) { console.log(id, JSON.stringify(body).length, 'bytes'); return }
    await doc.send(new PutCommand({ TableName: ROLLUP_TABLE, Item: item }))
  }
  for (const [m, body] of Object.entries(months).sort()) await put(`COST:${m}`, body, true)
  await put('COST:META', {
    services: SERVICES,
    asOf: addDays(END, -1),
    collectedAt: now,
    sources,
    notes: [
      'AWS costs are billed figures; shared services are split between BCAT Ops and the other apps in the same AWS account.',
      'Cost Explorer lags about a day, so the latest day can still grow.',
      'Hermes and app AI figures are estimates. Anthropic, OpenRouter and other subscriptions can be entered as fixed monthly costs.',
    ],
  }, false)
  const totals = Object.fromEntries(Object.entries(months).map(([m, b]) => [m, Math.round(Object.values(b.days).reduce((s, d) => s + Object.values(d).reduce((a, c) => a + c, 0), 0)) / 100]))
  const byService = {}
  for (const [m, b] of Object.entries(months)) {
    const s = (byService[m] = {})
    for (const d of Object.values(b.days)) for (const [k, c] of Object.entries(d)) s[k] = (s[k] ?? 0) + c
    for (const k of Object.keys(s)) s[k] = Math.round(s[k]) / 100
    s['(not BCAT Ops)'] = Math.round(Object.values(b.excluded).reduce((a, c) => a + c, 0)) / 100
  }
  console.log(JSON.stringify({ dry: DRY, start: START, end: END, sources, monthlyDollars: totals, ...(DRY ? { byService } : {}) }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
