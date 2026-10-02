/**
 * Re-run the scan cleanup and the merge over driver documents already uploaded.
 *
 * Documents that went in before the pipeline existed, or while the browser was still
 * merging pages into a PDF first, carry no cleaned copy and no finished PDF. This invokes
 * the same pod-actions steps the live upload path uses, in the same order, so a backfilled
 * document is indistinguishable from a fresh one.
 *
 * Read-only on the originals: cleaning writes a second copy beside them and merging writes
 * a third. Nothing is overwritten, so this is safe to re-run.
 *
 *   node scripts/backfillDriverDocScans.mjs            # report only
 *   node scripts/backfillDriverDocScans.mjs --apply    # actually run it
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const REGION = 'us-east-1'
const SUFFIX = process.env.TABLE_SUFFIX ?? '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const POD_FUNCTION = process.env.POD_FUNCTION_NAME ?? 'pod-actions-46198baffbf671f8'
const APPLY = process.argv.includes('--apply')

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
const lambda = new LambdaClient({ region: REGION })
const T = (n) => `${n}-${SUFFIX}`

async function scanAll(table) {
  const out = []
  let key
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }))
    out.push(...(r.Items ?? []))
    key = r.LastEvaluatedKey
  } while (key)
  return out
}

/** Invoke pod-actions the same way the driver API does, and surface what it answered. */
async function call(action, input) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: POD_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({
      arguments: { action, input: JSON.stringify(input) },
      // The same system marker driver-app-api uses: no human identity to present, and
      // inventing an email address would put a lie in the audit trail.
      identity: { claims: { bcatSystemCaller: true }, username: 'backfill-script' },
    })),
  }))
  const text = Buffer.from(res.Payload ?? []).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 300) }
  }
}

const [subs, docs] = await Promise.all([scanAll(T('DriverSubmission')), scanAll(T('DriverSubmissionDoc'))])
const docsBySubmission = new Map()
for (const d of docs) {
  const list = docsBySubmission.get(d.submissionId) ?? []
  list.push(d)
  docsBySubmission.set(d.submissionId, list)
}

const work = []
for (const sub of subs) {
  for (const kind of ['POD', 'RATECON']) {
    const pages = (docsBySubmission.get(sub.id) ?? []).filter((d) => d.kind === kind)
    if (pages.length === 0) continue
    const combinedKey = kind === 'POD' ? sub.combinedPodKey : sub.combinedRateconKey
    const uncleaned = pages.filter((d) => d.scanStatus !== 'READY' && d.scanStatus !== 'ORIGINAL_ONLY')
    if (combinedKey && uncleaned.length === 0) continue
    work.push({ sub, kind, pages, uncleaned, combinedKey })
  }
}

console.log(`submissions=${subs.length} docs=${docs.length} needing work=${work.length}`)
for (const w of work) {
  console.log(`  ${w.kind} sub=${w.sub.id} ref=${w.sub.referenceNumber ?? '-'} driver=${w.sub.driverName}`)
  console.log(`      pages=${w.pages.length} never-cleaned=${w.uncleaned.length} combined=${w.combinedKey ?? 'none'}`)
}
if (!APPLY) {
  console.log('\nreport only — pass --apply to run it')
  process.exit(0)
}

for (const w of work) {
  console.log(`\n${w.kind} ${w.sub.id} (${w.sub.referenceNumber ?? 'no ref'})`)
  for (const page of w.pages) {
    const out = await call('enhanceDriverDoc', { id: page.id })
    console.log(`   clean ${page.id} -> ${out.scanStatus ?? JSON.stringify(out).slice(0, 120)}`)
  }
  const out = await call('finalizeDriverDocs', { submissionId: w.sub.id, kind: w.kind })
  console.log(`   merge -> pages=${out.pages ?? '?'} key=${out.key ?? out.error ?? JSON.stringify(out).slice(0, 120)}`)
}
console.log('\ndone')
