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
 * Documents cleaned by an older version of the pipeline are picked up too: the scan
 * version is bumped whenever the correction rules change, and a page carrying a lower one
 * was cleaned by rules we have since decided were wrong. That is how a readability fix
 * reaches the PODs that are already on file rather than only the next ones.
 *
 *   node scripts/backfillDriverDocScans.mjs            # report only
 *   node scripts/backfillDriverDocScans.mjs --apply    # actually run it
 *   node scripts/backfillDriverDocScans.mjs --force    # re-run everything regardless
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/*
 * Read the pipeline's version from its own source rather than restating it here.
 *
 * This is a plain .mjs script, so it cannot import the TypeScript module. A second copy of
 * the number is the kind of thing that stays right for one release: the version would be
 * bumped in the Lambda, the backfill would still think everything was current, and the fix
 * would silently never reach the documents already on file — which is the entire job.
 */
const POD_SCAN_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '../amplify/functions/pod-actions/scan-version.ts'), 'utf8')
  const found = /POD_SCAN_VERSION\s*=\s*(\d+)/.exec(src)
  if (!found) throw new Error('could not read POD_SCAN_VERSION from scan-version.ts')
  return Number(found[1])
})()

const REGION = 'us-east-1'
const SUFFIX = process.env.TABLE_SUFFIX ?? '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const POD_FUNCTION = process.env.POD_FUNCTION_NAME ?? 'pod-actions-46198baffbf671f8'
const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')

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
    // A page cleaned by an older pipeline was cleaned by rules we have since corrected.
    const stale = pages.filter((d) => Number(d.scanVersion ?? 0) < POD_SCAN_VERSION)
    if (!FORCE && combinedKey && uncleaned.length === 0 && stale.length === 0) continue
    work.push({ sub, kind, pages, uncleaned, stale, combinedKey })
  }
}

console.log(
  `submissions=${subs.length} docs=${docs.length} needing work=${work.length}` +
    ` (scan version ${POD_SCAN_VERSION}${FORCE ? ', forced' : ''})`,
)
for (const w of work) {
  console.log(`  ${w.kind} sub=${w.sub.id} ref=${w.sub.referenceNumber ?? '-'} driver=${w.sub.driverName}`)
  console.log(
    `      pages=${w.pages.length} never-cleaned=${w.uncleaned.length}` +
      ` old-version=${w.stale.length} combined=${w.combinedKey ?? 'none'}`,
  )
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
