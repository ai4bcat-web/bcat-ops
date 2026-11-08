#!/usr/bin/env node
/**
 * Operator CLI: Aljex carriers export `Fed/SS #` -> the encrypted carrier tax-ID vault (AW_TAXID_DESIGN.md §4.6, §8).
 *
 *   BCAT_STACK=dev|rehearsal node scripts/importCarrierTaxIds.mjs --source <carriers.csv>            # dry run: counts only
 *   BCAT_STACK=dev|rehearsal node scripts/importCarrierTaxIds.mjs --source <carriers.csv> --apply    # invoke the Lambda
 *
 * The browser wizard and the importer's stage step refuse a file that still has `Fed/SS #`; this is the one
 * controlled path. The column is read inside this process, batched 100 rows at a time into a direct
 * `RequestResponse` invoke of tms-carrier-actions with the operator's own AWS credentials (never S3, AppSync or the
 * browser), and NEVER written to a file, a log line or a report. Output is counts only.
 *
 * PRODUCTION IS REFUSED. `BCAT_STACK` only takes dev or rehearsal, and there is no production flag yet; one is added
 * later, deliberately, when Ryne is present (design Q7). Outside production the real values are replaced by
 * deterministic synthetic IDs (EIN prefix 00 / SSN area 000) before they are batched, so real values never leave the file.
 *
 * Bank Account and Routing # are not read and not imported.
 */
import { createReadStream } from 'node:fs'
import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda'
import { REGION, STACK } from './lib/stackConfig.mjs'
import { idKey, runTaxIdImport } from './lib/taxIdImport.mjs'

const USAGE = `Usage: BCAT_STACK=dev|rehearsal node scripts/importCarrierTaxIds.mjs --source <carriers.csv> [--apply]
  --source <file>   the Aljex carriers export (still containing Fed/SS #; the column is read here and nowhere else)
  --apply           invoke tms-carrier-actions IMPORT_TAX_IDS in 100-row batches. Without it: dry run, counts only.
Production is refused.`

const { values } = parseArgs({
  options: {
    source: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    target: { type: 'string' }, 'i-mean-production': { type: 'boolean', default: false }, production: { type: 'boolean', default: false },
  },
  strict: true,
})

if (values.help) { console.log(USAGE); process.exit(0) }
if (values.target || values['i-mean-production'] || values.production) {
  console.error('Refused: production tax-ID import is not enabled in this script. Use BCAT_STACK=dev or rehearsal.')
  process.exit(2)
}
if (!values.source) { console.error(USAGE); process.exit(2) }

const LAMBDA_FRAGMENT = 'tmscarrieractions'

async function carrierLambda(lambda) {
  const want = `${STACK.lambdaPrefix}-${LAMBDA_FRAGMENT}`
  const names = []
  let marker
  do {
    const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
    for (const f of r.Functions ?? []) if (f.FunctionName?.toLowerCase().startsWith(want)) names.push(f.FunctionName)
    marker = r.NextMarker
  } while (marker)
  if (names.length !== 1) throw new Error(`expected exactly one ${want}* Lambda in ${STACK.name}, found ${names.length}`)
  return names[0]
}

/** Read-only: which Aljex rows have a BCAT carrier to land on (dry run only). */
async function loadCarrierIndex() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
  const idx = { byMc: new Map(), byDot: new Map(), byAljex: new Map() }
  let key
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: `Carrier-${STACK.tableSuffix}`, ProjectionExpression: 'id, mcNumber, dotNumber, aljexCode', ExclusiveStartKey: key,
    }))
    for (const c of r.Items ?? []) {
      if (idKey(c.mcNumber)) idx.byMc.set(idKey(c.mcNumber), c.id)
      if (idKey(c.dotNumber)) idx.byDot.set(idKey(c.dotNumber), c.id)
      if (c.aljexCode) idx.byAljex.set(String(c.aljexCode), c.id)
    }
    key = r.LastEvaluatedKey
  } while (key)
  return idx
}

const apply = values.apply
const lambda = new LambdaClient({ region: REGION, maxAttempts: 1 })
let fn = null
if (apply) fn = await carrierLambda(lambda)

const invoke = async (rows) => {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: fn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ internal: 'IMPORT_TAX_IDS', rows })),
  }))
  const body = JSON.parse(Buffer.from(res.Payload ?? []).toString('utf8') || '{}')
  // Never echo the error text: report the class only.
  if (res.FunctionError || body.errorType) throw new Error(`IMPORT_TAX_IDS failed (${String(body.errorType ?? res.FunctionError).slice(0, 60)})`)
  return body
}

const report = await runTaxIdImport({
  chunks: createReadStream(values.source, { encoding: 'utf8' }),
  production: false,
  apply,
  invoke,
  carriers: apply ? undefined : await loadCarrierIndex(),
})

console.log(`stack: ${STACK.name}   mode: ${apply ? 'APPLY' : 'DRY RUN'}   values: SYNTHETIC (non-production)`)
console.log(JSON.stringify(report, null, 2))
