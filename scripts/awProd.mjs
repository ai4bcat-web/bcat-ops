#!/usr/bin/env node
/**
 * The guarded PRODUCTION entry point of the Aljex data load (Step AW). One wrapper; every step is a DRY RUN unless
 * `--apply` is given AND env AW_PROD_CONFIRM=<today YYYY-MM-DD>-<step> is set. The per-file scripts keep refusing
 * production on their own; this wrapper reuses their planners/engines against the production stack.
 *
 *   node scripts/awProd.mjs <step> --suffix 5ucwdyvwivelbo4k4jomvrwel4 [--apply] [step flags]
 *
 *   settings                                   PRO series: TmsSettings.nextShipmentNumber=19999 + proScheme NUMERIC (+1 AuditLog)
 *   jenny                                      Jenny's Cognito groups page-billingRelease / page-aljexSignoff (+ UserProfile.extraPages)
 *   backfill [--cutoff D] [--export-keys f] [--batch N] [--evaluate] [--allow-empty-shipments]
 *                                              link existing Loads to Shipments by Load id (BACKFILL_SHIPMENT); run AFTER `loads`
 *   customers|carriers|ar --file f.csv --cutoff D   per-file imports, OFFLINE (importAljex.mjs file --target prod:TAG: the Lambda refuses production tables);
 *                                              PLAN then APPLY; --live-tag TAG on apply; --plan runs the PLAN. AWS credentials only, no staff password
 *   ap-aging|ap-expected --file f.csv --cutoff D   same, AP aging / AP expected
 *   stage-export --file big.csv                stages the big export LOCALLY (importAljex.mjs stage); nothing is uploaded or written
 *   loads --source big.csv --live-tag TAG [--ar-file aljex-ar.csv] [--resume JOBID]   the Aljex load (importAljex.mjs run --target prod:TAG)
 *   tax-ids --source carriers.csv              Fed/SS # -> encrypted vault via tms-carrier-actions IMPORT_TAX_IDS, 100-row batches
 *   reconcile --entity E --source-job ID [--customers-job ID] --cutoff D   offline report (importAljex.mjs reconcile-entity); --apply publishes the RECONCILE job + report files
 *   verify                                     read-only: every table's ItemCount, settings, Jenny, vault
 *
 * Apply also needs: ~/bcat-ops-backups/LATEST_BACKUP_STAMP younger than 6 h, production root stack UPDATE_COMPLETE, no Amplify
 * job running on main, BCAT_SCHEMA_STAGE on main >= the stage that creates the step's tables. Only the steps that still use the staff-signed Lambda/AppSync API
 * (backfill, incl. backfill-check --evaluate) sign in with BCAT_EMAIL / BCAT_PASSWORD (a staff user of the production pool). The production AppSync URL, pool ids and Lambda names are
 * found with read-only aws amplify/cloudformation/appsync/lambda calls; nothing secret is read or printed.
 * Logs: ~/bcat-ops-backups/aw-prod-logs/<step>-<timestamp>.log (counts and status only) + <step>.checkpoint.json (resume).
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { register } from 'node:module'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { fileArgs, pickDataSafetyBucket, reconcileArgs, stageArgs } from './lib/awProdOffline.mjs'
import {
  AwProdRefusal, PROD_API_ID, PROD_SUFFIX, REGION, STEPS, STEP_NAMES, checkBackupStamp, confirmTokenFor, createCheckpoint, createLog,
  defaultAws, evaluateRun, localDate, logTableDiff, maskPro, readProdState, resolveProdSuffix, scrub, sha, snapshotTables,
} from './lib/awProdGuard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const LAMBDA_PREFIX = 'amplify-d3dejqzs77khq6-ma'
const STAFF_POOL = 'us-east-1_IbPKPNJC9'
const STAFF_CLIENT = '1qr651dshigrv8a6c338d4f709'

const OPTIONS = {
  suffix: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, fresh: { type: 'boolean' },
  file: { type: 'string' }, source: { type: 'string' }, 'ar-file': { type: 'string' }, 'live-tag': { type: 'string' }, resume: { type: 'string' }, plan: { type: 'boolean' },
  cutoff: { type: 'string' }, 'export-keys': { type: 'string' }, batch: { type: 'string' }, evaluate: { type: 'boolean' },
  'allow-empty-shipments': { type: 'boolean' }, entity: { type: 'string' }, 'source-job': { type: 'string' }, 'customers-job': { type: 'string' },
}

const USAGE = `Usage: node scripts/awProd.mjs <${STEP_NAMES.join('|')}> --suffix ${PROD_API_ID} [--apply] [step flags]
Dry run is the default. Apply needs --apply AND env AW_PROD_CONFIRM=<YYYY-MM-DD>-<step>. See the header of scripts/awProd.mjs.`

// ── production connections (lazy; every one is a seam for tests) ─────────────────────────────────

export function productionOutputs(graphqlUrl) {
  if (!graphqlUrl?.includes('.appsync-api.')) throw new AwProdRefusal('the production AppSync URL could not be read')
  return {
    version: '1.3',
    auth: { aws_region: REGION, user_pool_id: STAFF_POOL, user_pool_client_id: STAFF_CLIENT },
    data: { url: graphqlUrl, aws_region: REGION, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS', authorization_types: [] },
  }
}

function makeDeps() {
  const dynamo = new DynamoDBClient({ region: REGION })
  const doc = DynamoDBDocumentClient.from(dynamo, { marshallOptions: { removeUndefinedValues: true } })
  const aws = defaultAws
  return {
    aws,
    dynamo,
    doc,
    lambda: new LambdaClient({ region: REGION, maxAttempts: 1 }),
    readProdState: () => readProdState(aws),
    checkBackupStamp: () => checkBackupStamp(),
    stages: async () => {
      register('./lib/tsExtensionlessHooks.mjs', import.meta.url)
      return import('../amplify/data/stages.ts')
    },
    handlers: {},
    async apiClient() {
      const api = await aws(['appsync', 'get-graphql-api', '--api-id', PROD_API_ID])
      const outputs = productionOutputs(api.graphqlApi?.uris?.GRAPHQL)
      const { authenticateTmsUser } = await import('./lib/tmsAuth.mjs')
      const { createTmsClient } = await import('./lib/tmsClient.mjs')
      const auth = await authenticateTmsUser(outputs)
      return createTmsClient({ endpoint: auth.endpoint, token: auth.token })
    },
    async lambdaName(fragment) {
      const fns = (await aws(['lambda', 'list-functions'])).Functions ?? []
      const hits = fns.map((f) => f.FunctionName).filter((n) => n.toLowerCase().startsWith(`${LAMBDA_PREFIX}-${fragment}`))
      if (hits.length !== 1) throw new Error(`expected exactly one production lambda ${LAMBDA_PREFIX}-${fragment}*, found ${hits.length}`)
      return hits[0]
    },
    async accountId() {
      return JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' })).Account
    },
  }
}

/** Run `fn` with console output copied (scrubbed) into the log. */
async function tee(log, fn) {
  const { log: l, error: e } = console
  const wrap = (orig) => (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.info(s); orig(scrub(s)) }
  console.log = wrap(l)
  console.error = wrap(e)
  try { return await fn() } finally { console.log = l; console.error = e }
}

const fileFingerprint = (path) => sha(`${path.split('/').pop()}:${statSync(resolve(process.cwd(), path)).size}:${sha(readFileSync(resolve(process.cwd(), path)))}`)

// ── steps ────────────────────────────────────────────────────────────────────────────────────────

async function stepSettings(ctx) {
  const { deps, log, apply } = ctx
  const mod = await import('./seedSeries20000.mjs')
  const settings = ((await deps.doc.send(new ScanCommand({ TableName: `TmsSettings-${PROD_SUFFIX}` }))).Items ?? []).find((r) => r.id === 'default') ?? null
  let maxClaimedPro = null
  for (let key; ;) {
    const p = await deps.doc.send(new ScanCommand({ TableName: `ProClaim-${PROD_SUFFIX}`, ProjectionExpression: 'id', ExclusiveStartKey: key }))
    for (const i of p.Items ?? []) if (typeof i.id === 'string' && /^\d{3,15}$/.test(i.id)) maxClaimedPro = Math.max(maxClaimedPro ?? 0, Number(i.id))
    key = p.LastEvaluatedKey
    if (!key) break
  }
  const plan = mod.planSeries20000({ settings, maxClaimedPro })
  log.info(`settings plan: ${plan.action} (${plan.action === 'SET' ? 'counter -> 19999, NUMERIC; first PRO 20000' : scrub(plan.reason)})`)
  if (plan.action === 'REFUSE') { process.exitCode = 2; return { status: 'refused' } }
  if (plan.action === 'NOOP' || !apply) return { status: plan.action === 'NOOP' ? 'noop' : 'dry-run' }
  const now = new Date().toISOString()
  await deps.doc.send(new UpdateCommand({
    TableName: `TmsSettings-${PROD_SUFFIX}`, Key: { id: 'default' }, ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(nextShipmentNumber) OR nextShipmentNumber < :floor)',
    UpdateExpression: 'SET nextShipmentNumber = :floor, proScheme = :scheme, updatedBy = :by, updatedAt = :at',
    ExpressionAttributeValues: { ':floor': mod.COUNTER_FLOOR, ':scheme': 'NUMERIC', ':by': mod.SERIES_USER, ':at': now },
  }))
  await deps.doc.send(new PutCommand({
    TableName: `AuditLog-${PROD_SUFFIX}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'TMS_SETTINGS', entityId: 'default', action: 'SEED_SERIES_20000', user: mod.SERIES_USER,
      changes: JSON.stringify({ before: { nextShipmentNumber: settings.nextShipmentNumber ?? null, proScheme: settings.proScheme ?? null }, after: plan.patch, maxClaimedPro }),
      createdAt: now, updatedAt: now,
    },
  }))
  return { status: 'applied' }
}

async function listUsers(cognito, poolId) {
  const { ListUsersCommand } = await import('@aws-sdk/client-cognito-identity-provider')
  const users = []
  let token
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }))
    users.push(...(page.Users ?? []))
    token = page.PaginationToken
  } while (token)
  return users
}

async function jennyPlan(deps) {
  const g = await import('./grantJenny.mjs')
  const cog = await import('@aws-sdk/client-cognito-identity-provider')
  const cognito = deps.cognito ?? new cog.CognitoIdentityProviderClient({ region: REGION })
  const found = g.usersWithEmail(await listUsers(cognito, STAFF_POOL), g.JENNY_EMAIL)
  let currentGroups = []
  if (found.length === 1) currentGroups = ((await cognito.send(new cog.AdminListGroupsForUserCommand({ UserPoolId: STAFF_POOL, Username: found[0].Username }))).Groups ?? []).map((x) => x.GroupName)
  let profile = null
  for (let key; ;) {
    const p = await deps.doc.send(new ScanCommand({ TableName: `UserProfile-${PROD_SUFFIX}`, ExclusiveStartKey: key }))
    profile = (p.Items ?? []).find((r) => String(r.email ?? '').trim().toLowerCase() === g.JENNY_EMAIL.toLowerCase()) ?? profile
    key = p.LastEvaluatedKey
    if (!key) break
  }
  return { g, cog, cognito, found, profile, plan: g.planGrant({ found, currentGroups, profile }) }
}

async function stepJenny(ctx) {
  const { deps, log, apply } = ctx
  const { g, cog, cognito, found, profile, plan } = await jennyPlan(deps)
  log.counts('jenny', { staffUsersMatching: found.length, profileRows: profile ? 1 : 0, groupsToAdd: plan.addGroups?.length ?? 0, extraPagesToAdd: plan.addExtraPages?.length ?? 0 })
  if (plan.error) { log.info('jenny: FAILED (user not found or ambiguous); nothing created'); process.exitCode = 2; return { status: 'refused' } }
  if (plan.profileMissing) log.info('WARNING: no UserProfile row for that user; groups are added but a Users-page save would strip them until the profile exists')
  if (!apply) return { status: 'dry-run' }
  for (const group of plan.addGroups) {
    try { await cognito.send(new cog.CreateGroupCommand({ UserPoolId: STAFF_POOL, GroupName: group, Description: 'Per-user billing grant (Step AW)' })) } catch (err) { if (err?.name !== 'GroupExistsException') throw err }
    await cognito.send(new cog.AdminAddUserToGroupCommand({ UserPoolId: STAFF_POOL, Username: plan.username, GroupName: group }))
  }
  if (plan.addExtraPages.length > 0 && profile) {
    await deps.doc.send(new UpdateCommand({
      TableName: `UserProfile-${PROD_SUFFIX}`, Key: { id: profile.id },
      UpdateExpression: 'SET extraPages = :pages, updatedAt = :now',
      ExpressionAttributeValues: { ':pages': [...new Set([...(profile.extraPages ?? []), ...plan.addExtraPages])], ':now': new Date().toISOString() },
    }))
  }
  void g
  return { status: 'applied' }
}

async function stepBackfill(ctx) {
  const { deps, log, apply, values, ckpt } = ctx
  register('./lib/tsExtensionlessHooks.mjs', import.meta.url)
  const m = await import('./awBackfillShipments.mjs')
  const { chunk, resolveBatchSize } = await import('./backfillShipments.mjs')
  const batchSize = resolveBatchSize(values.batch)
  const exportKeys = values['export-keys'] ? m.parseExportKeys(readFileSync(resolve(process.cwd(), values['export-keys']), 'utf8')) : new Set()
  const read = () => m.readSource(deps.doc, PROD_SUFFIX)
  const client = apply || values.evaluate ? await deps.apiClient() : undefined
  const first = await m.run({ read, client, apply: false, cutoff: values.cutoff, exportKeys, batchSize })
  const counts = first.before.report.counts
  log.counts('backfill before', { ...counts, ...first.before.window.outOfWindow, carriedOver: first.before.window.carriedOver, totalLoads: first.before.window.totalLoads })
  const after = first.before.window.outOfWindow.afterCutoff
  if (after > 0) log.info(`WARNING: ${after} Load(s) were created on or after the cutoff ${first.cutoff} (booked after Aljex was final); they are NOT linked by this step: STOP`)
  if (!client) log.info('backfill refusals not evaluated (add --evaluate to log in and run the BACKFILL_SHIPMENT dry run)')
  if (!apply) return { status: 'dry-run' }
  const shipments = (await deps.doc.send(new ScanCommand({ TableName: `Shipment-${PROD_SUFFIX}`, Select: 'COUNT', Limit: 1000 }))).Count ?? 0
  if (shipments === 0 && !values['allow-empty-shipments']) {
    throw new AwProdRefusal('the Shipment table is empty: run `loads` first (backfill before the load creates L<pro> duplicates). Pass --allow-empty-shipments only if that is intended.')
  }
  const ids = first.before.report.linkedById.map((e) => e.loadId)
  const total = { applied: 0, skipped: 0, missing: 0, conflicts: 0, chunksDone: 0, chunksSkipped: 0 }
  for (const ids200 of chunk(ids, 200)) {
    const key = `chunk:${sha(ids200.join(','))}`
    if (ckpt.has(key)) { total.chunksSkipped++; continue }
    const r = await m.applyLinks({ client, loadIds: ids200, batchSize })
    total.applied += r.applied; total.skipped += r.skipped.length; total.missing += r.missing.length; total.conflicts += r.conflicts.length
    if (r.conflicts.length === 0) { ckpt.mark(key); total.chunksDone++ }
  }
  log.counts('backfill applied', total)
  const reread = await m.run({ read, client: undefined, apply: false, cutoff: values.cutoff, exportKeys, batchSize })
  log.counts('backfill after', reread.before.report.counts)
  if (total.conflicts > 0) { process.exitCode = 2; return { status: 'conflicts' } }
  return { status: 'applied' }
}

const FILE_STEPS = {
  customers: { name: 'customers', flag: 'file' },
  carriers: { name: 'carriers', flag: 'file' },
  ar: { name: 'ar', flag: 'file' },
  'ap-aging': { name: 'ap', flag: 'aging-file' },
  'ap-expected': { name: 'ap', flag: 'expected-file' },
}

/** Spawns scripts/importAljex.mjs (the offline CLI that carries the production gate); every output line is scrubbed into the log. */
async function spawnImportAljex(ctx, args) {
  const { log, now } = ctx
  const env = { ...process.env, BCAT_ALLOW_PROD: localDate(now) }
  const { spawn } = await import('node:child_process')
  const code = await new Promise((res) => {
    const child = spawn('node', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = (buf) => { for (const line of String(buf).split('\n')) if (line.trim()) { log.info(line); process.stdout.write(`${scrub(line)}\n`) } }
    child.stdout.on('data', sink)
    child.stderr.on('data', sink)
    child.on('close', res)
  })
  log.info(`importAljex ${args[1]}: exit code ${code}`)
  return code
}

async function stepFile(ctx) {
  const { step, deps, log, apply, values, ckpt } = ctx
  if (!values.file) throw new AwProdRefusal(`${step} needs --file <csv>`)
  const imp = await import('./awImport.mjs')
  const spec = FILE_STEPS[step]
  const core = await imp.bundleCore()
  const raw = readFileSync(resolve(process.cwd(), values.file), 'utf8')
  const kind = imp.COMMANDS[spec.name].files.find(([, flag]) => flag === spec.flag)[0]
  const { csv, dropped } = imp.prepareUpload(core, kind, raw)
  const rows = core.parseCsvRows(csv).length - 1
  log.counts(`${step} local check`, { rows, strippedColumns: dropped.length })
  const key = `applied:${fileFingerprint(values.file)}`
  if (!apply && !values.plan) return { status: 'dry-run' }
  if (apply && ckpt.has(key)) { log.info(`${step}: this exact file was already applied (checkpoint); nothing to do`); return { status: 'already-applied' } }
  const args = fileArgs(step, values, { apply, account: apply ? await deps.accountId() : null })
  log.info(`${step}: offline import via importAljex file (${apply ? 'plan, then APPLY' : 'plan only, nothing written'}); no staff password needed`)
  const code = await (deps.importAljex ?? spawnImportAljex)(ctx, args)
  if (code !== 0) { process.exitCode = code ?? 1; return { status: 'failed' } }
  if (apply) ckpt.mark(key)
  return { status: apply ? 'applied' : 'planned' }
}

async function stepStageExport(ctx) {
  const { deps, log, apply, values } = ctx
  if (!values.file) throw new AwProdRefusal('stage-export needs --file <csv>')
  const size = statSync(resolve(process.cwd(), values.file)).size
  log.counts('stage-export local check', { bytes: size })
  if (!apply) return { status: 'dry-run' }
  log.info('stage-export: staging locally via importAljex stage (nothing is uploaded or written to AWS)')
  const code = await (deps.importAljex ?? spawnImportAljex)(ctx, stageArgs(values))
  if (code !== 0) { process.exitCode = code ?? 1; return { status: 'failed' } }
  return { status: 'staged' }
}

async function stepReconcile(ctx) {
  const { deps, log, apply, values } = ctx
  if (!values.entity || !values['source-job']) throw new AwProdRefusal('reconcile needs --entity and --source-job')
  if (!apply) { log.info(`reconcile ${values.entity}: would start a reconciliation job (writes AljexImportJob/report files)`); return { status: 'dry-run' } }
  // The tmsAljexImport Lambda is not deployed to production yet: take the files bucket from S3, not from the Lambda.
  const buckets = ((await deps.aws(['s3api', 'list-buckets'])).Buckets ?? []).map((b) => b.Name)
  const args = reconcileArgs(values, { account: await deps.accountId(), bucket: pickDataSafetyBucket(buckets, LAMBDA_PREFIX) })
  log.info(`reconcile ${values.entity}: offline report via importAljex reconcile-entity; publishes a RECONCILE job and the report files`)
  const code = await (deps.importAljex ?? spawnImportAljex)(ctx, args)
  if (code !== 0) { process.exitCode = code ?? 1; return { status: 'failed' } }
  return { status: 'reconciled' }
}

async function stepLoads(ctx) {
  const { deps, log, apply, values, now } = ctx
  if (!values['live-tag']) throw new AwProdRefusal('loads needs --live-tag <TAG> (the owner-typed live tag)')
  if (!values.source && !values.resume) throw new AwProdRefusal('loads needs --source <csv> (or --resume <jobId>)')
  const account = await deps.accountId()
  const args = values.resume
    ? ['scripts/importAljex.mjs', 'resume', '--run', values.resume]
    : ['scripts/importAljex.mjs', 'run', '--source', values.source]
  // The open AR report (Pro # only, read locally, never printed): decides which revenue-difference invoices carry the paid amount (revenueBasis.ts). Without it every such row keeps the Aljex amount and stays on the review list.
  if (values['ar-file'] && !values.resume) args.push('--ar-file', resolve(process.cwd(), values['ar-file']))
  args.push('--target', `prod:${values['live-tag']}`, '--i-mean-production')
  if (apply) args.push('--apply', '--confirm-prod', `${account}:${PROD_SUFFIX}`)
  const env = { ...process.env, BCAT_ALLOW_PROD: localDate(now) }
  log.info(`loads: delegating to importAljex ${values.resume ? 'resume' : 'run'} (${apply ? 'APPLY' : 'plan only'})`)
  const { spawn } = await import('node:child_process')
  const code = await new Promise((res) => {
    const child = spawn('node', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = (buf) => { for (const line of String(buf).split('\n')) if (line.trim()) { log.info(line); process.stdout.write(`${scrub(line)}\n`) } }
    child.stdout.on('data', sink)
    child.stderr.on('data', sink)
    child.on('close', res)
  })
  log.info(`loads: importAljex exit code ${code}`)
  if (code !== 0) { process.exitCode = code ?? 1; return { status: 'failed' } }
  return { status: apply ? 'applied' : 'planned' }
}

async function stepTaxIds(ctx) {
  const { deps, log, apply, values, ckpt } = ctx
  if (!values.source) throw new AwProdRefusal('tax-ids needs --source <carriers.csv>')
  const { DescribeTableCommand } = await import('@aws-sdk/client-dynamodb')
  const apiId = PROD_API_ID
  try {
    await deps.dynamo.send(new DescribeTableCommand({ TableName: `CarrierTaxVault-${apiId}` }))
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      log.info('vault not deployed: skipping tax IDs')
      console.log('vault not deployed: skipping tax IDs')
      return { status: 'skipped' }
    }
    throw err
  }
  const { runTaxIdImport, idKey } = await import('./lib/taxIdImport.mjs')
  let carriers
  let invoke
  if (apply) {
    const fn = await deps.lambdaName('tmscarrieractions')
    const { InvokeCommand } = await import('@aws-sdk/client-lambda')
    const lambda = deps.lambda
    invoke = async (rows) => {
      const key = `batch:${sha(rows.map((r) => `${r.aljexCarrierId}|${r.mcNumber}|${r.dotNumber}`).join(','))}`
      if (ckpt.has(key)) { ctx.skippedBatches = (ctx.skippedBatches ?? 0) + 1; return {} }
      const res = await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ internal: 'IMPORT_TAX_IDS', rows })) }))
      const body = JSON.parse(Buffer.from(res.Payload ?? []).toString('utf8') || '{}')
      if (res.FunctionError || body.errorType) throw new Error(`IMPORT_TAX_IDS failed (${String(body.errorType ?? res.FunctionError).slice(0, 60)})`)
      ckpt.mark(key, true)
      return body
    }
  } else {
    carriers = { byMc: new Map(), byDot: new Map(), byAljex: new Map() }
    for (let key; ;) {
      const r = await deps.doc.send(new ScanCommand({ TableName: `Carrier-${PROD_SUFFIX}`, ProjectionExpression: 'id, mcNumber, dotNumber, aljexCode', ExclusiveStartKey: key }))
      for (const c of r.Items ?? []) {
        if (idKey(c.mcNumber)) carriers.byMc.set(idKey(c.mcNumber), c.id)
        if (idKey(c.dotNumber)) carriers.byDot.set(idKey(c.dotNumber), c.id)
        if (c.aljexCode) carriers.byAljex.set(String(c.aljexCode), c.id)
      }
      key = r.LastEvaluatedKey
      if (!key) break
    }
  }
  const report = await runTaxIdImport({ chunks: createReadStream(resolve(process.cwd(), values.source), { encoding: 'utf8' }), production: true, apply, invoke, carriers })
  log.counts('tax-ids', { ...report, ...report.shapes, skippedBatchesFromCheckpoint: ctx.skippedBatches ?? 0 })
  return { status: apply ? 'applied' : 'dry-run' }
}

async function stepVerify(ctx) {
  const { deps, log } = ctx
  const names = []
  for (let start; ;) {
    const r = await deps.dynamo.send(new ListTablesCommand({ ExclusiveStartTableName: start }))
    names.push(...(r.TableNames ?? []).filter((n) => n.endsWith(`-${PROD_SUFFIX}`)))
    start = r.LastEvaluatedTableName
    if (!start) break
  }
  const models = names.map((n) => n.slice(0, -(PROD_SUFFIX.length + 1))).sort()
  const snap = await snapshotTables(deps, models, PROD_SUFFIX, { exact: false })
  log.counts('verify tables', { tables: models.length, expected: 110, withItems: models.filter((m) => (snap[m].described ?? 0) > 0).length })
  for (const m of models) log.counts(`  ${m}`, { itemCount: snap[m].described ?? 0 })
  const settings = ((await deps.doc.send(new ScanCommand({ TableName: `TmsSettings-${PROD_SUFFIX}` }))).Items ?? []).find((r) => r.id === 'default')
  log.counts('verify settings', { seriesAt19999: settings?.nextShipmentNumber === 19999 ? 1 : 0, numeric: settings?.proScheme === 'NUMERIC' ? 1 : 0 })
  const { plan } = await jennyPlan(deps)
  log.counts('verify jenny', { groupsMissing: plan.addGroups?.length ?? -1, extraPagesMissing: plan.addExtraPages?.length ?? 0 })
  const { DescribeTableCommand } = await import('@aws-sdk/client-dynamodb')
  const vault = await deps.dynamo.send(new DescribeTableCommand({ TableName: `CarrierTaxVault-${PROD_API_ID}` })).then(() => 1, () => 0)
  log.counts('verify vault', { present: vault })
  return { status: 'ok' }
}

export const HANDLERS = {
  settings: stepSettings, jenny: stepJenny, backfill: stepBackfill, customers: stepFile, carriers: stepFile, ar: stepFile, 'ap-aging': stepFile, 'ap-expected': stepFile,
  'stage-export': stepStageExport, reconcile: stepReconcile, loads: stepLoads, 'tax-ids': stepTaxIds, verify: stepVerify,
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{argv: string[], env?: Record<string, string|undefined>, now?: Date, deps?: any, logDir?: string, out?: (s: string) => void}} o
 * @returns {Promise<{status: string, logPath: string|null, failures: string[]}>}
 */
export async function runAwProd({ argv, env = process.env, now = new Date(), deps = makeDeps(), logDir, out = (s) => console.log(s) }) {
  const step = argv[0]
  const parsed = parseArgs({ args: argv.slice(1), options: OPTIONS, strict: true })
  const values = parsed.values
  if (!step || step.startsWith('-') || values.help) { out(USAGE); return { status: 'usage', logPath: null, failures: [] } }
  if (!STEPS[step]) throw new AwProdRefusal(`unknown step "${step}"\n${USAGE}`)
  resolveProdSuffix(values.suffix)
  const apply = values.apply === true
  const mutating = !STEPS[step].readOnly
  const logOpts = logDir ? { dir: logDir, now } : { now }
  const log = createLog(step, logOpts)
  log.info(`awProd ${step} ${apply ? 'APPLY' : 'DRY RUN'} on production (${PROD_SUFFIX}) at ${now.toISOString()}`)
  try {
    const stages = await deps.stages()
    const state = await deps.readProdState()
    log.info(`production root stack ${state.rootStatus ?? 'NOT FOUND'}; amplify jobs running ${state.runningJobs}; schema stage ${state.stage ?? 'unknown'}`)
    const { failures } = evaluateRun({ step, apply: apply && mutating, env, now, stampState: deps.checkBackupStamp(), state, stages })
    if (apply && failures.length > 0) {
      for (const f of failures) log.info(`REFUSED: ${f}`)
      out(`Refusing to apply ${step}:\n  - ${failures.join('\n  - ')}\nlog: ${log.path}`)
      process.exitCode = 2
      return { status: 'refused', logPath: log.path, failures }
    }
    if (!apply && mutating) {
      out(failures.length ? `Dry run. An apply would currently be refused:\n  - ${failures.join('\n  - ')}` : `Dry run. An apply would pass the guards; add --apply and AW_PROD_CONFIRM=${confirmTokenFor(step, now)}`)
    }
    const models = STEPS[step].writes
    const ckpt = createCheckpoint(step, step === 'verify' ? 'verify' : sha(JSON.stringify([step, values.file ? fileFingerprintSafe(values.file) : null, values.source ? fileFingerprintSafe(values.source) : null, values['ar-file'] ? fileFingerprintSafe(values['ar-file']) : null, values['live-tag'] ?? null, values.resume ?? null, values['export-keys'] ? fileFingerprintSafe(values['export-keys']) : null])), { ...(logDir ? { dir: logDir } : {}), fresh: values.fresh === true })
    if (ckpt.size() > 0) log.info(`resuming: ${ckpt.size()} completed chunk(s) in the checkpoint will be skipped`)
    const before = models.length ? await snapshotTables(deps, models, PROD_SUFFIX, { exact: apply }) : {}
    const handler = deps.handlers?.[step] ?? HANDLERS[step]
    const result = await handler({ step, deps, log, apply, values, ckpt, now, suffix: PROD_SUFFIX })
    if (models.length) {
      const after = await snapshotTables(deps, models, PROD_SUFFIX, { exact: apply })
      logTableDiff(log, before, after)
    }
    log.info(`status: ${result.status}`)
    out(`${step}: ${result.status}\nlog: ${log.path}`)
    return { status: result.status, logPath: log.path, failures: [] }
  } catch (err) {
    log.info(`FAILED: ${err instanceof AwProdRefusal ? err.message : err?.name ?? 'Error'}`)
    out(`log: ${log.path}`)
    throw err
  }
}

function fileFingerprintSafe(p) {
  try { return fileFingerprint(p) } catch { return `missing:${p.split('/').pop()}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAwProd({ argv: process.argv.slice(2) }).catch((err) => {
    console.error(scrub(err instanceof AwProdRefusal ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`))
    process.exit(err instanceof AwProdRefusal ? 2 : 1)
  })
}
