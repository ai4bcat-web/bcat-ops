#!/usr/bin/env node
/**
 * One-off (dev + rehearsal, before cutover): move every clear `Carrier.einNumber` attribute into the encrypted tax-ID
 * vault and remove it from the row (AW_TAXID_DESIGN.md §9.3). The schema no longer exposes the field; this clears the
 * data still sitting on the items.
 *
 *   BCAT_STACK=dev|rehearsal node scripts/migrateEinField.mjs            # dry run: counts only
 *   BCAT_STACK=dev|rehearsal node scripts/migrateEinField.mjs --apply
 *
 * Invokes tms-carrier-actions `{ internal: 'MIGRATE_EIN_FIELD' }` directly with the operator's AWS credentials. The
 * Lambda refuses the production API id. Output is counts only; no value is read, written or printed here.
 */
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda'
import { REGION, STACK } from './lib/stackConfig.mjs'

const apply = process.argv.includes('--apply')
const lambda = new LambdaClient({ region: REGION })

const want = `${STACK.lambdaPrefix}-tmscarrieractions`
const names = []
let marker
do {
  const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
  for (const f of r.Functions ?? []) if (f.FunctionName?.toLowerCase().startsWith(want)) names.push(f.FunctionName)
  marker = r.NextMarker
} while (marker)
if (names.length !== 1) throw new Error(`expected exactly one ${want}* Lambda in ${STACK.name}, found ${names.length}`)

const res = await lambda.send(new InvokeCommand({
  FunctionName: names[0],
  InvocationType: 'RequestResponse',
  Payload: Buffer.from(JSON.stringify({ internal: 'MIGRATE_EIN_FIELD', dryRun: !apply })),
}))
const body = JSON.parse(Buffer.from(res.Payload ?? []).toString('utf8') || 'null')
if (res.FunctionError) {
  console.error(`MIGRATE_EIN_FIELD failed on ${STACK.name}: ${body?.errorMessage ?? res.FunctionError}`)
  process.exit(1)
}
console.log(`stack ${STACK.name} (${apply ? 'APPLIED' : 'dry run'}):`, JSON.stringify(body))
