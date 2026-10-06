/**
 * otr-actions — every interaction between the factoring queue and OTR Solutions.
 *
 * Routing mirrors pod-actions: one AppSync mutation, an `action` discriminator,
 * and a JSON blob in/out so adding an action never changes the GraphQL schema.
 *
 * Money: Load.rate and FactoringItem.otrAmount are CENTS. OTR bills in DOLLARS.
 * The conversion lives in src/lib/otrInvoice.ts and nowhere else.
 *
 * Nothing here submits on its own. `submit` runs only when a human invokes it
 * from the queue row, and it refuses unless assembleOtrInvoice reports ready.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { randomUUID } from 'crypto'
import {
  assembleOtrInvoice,
  toOtrPayload,
  type ManualOverrides,
  type RateConExtract,
  type OtrReadiness,
} from '../../../src/lib/otrInvoice'
import { normalizeName } from '../../../src/lib/tmsDirectory'
import { localStatusFor } from '../../../src/lib/otrInvoiceStatus'
import { normalizePro } from '../../../src/lib/podPresence'
import {
  OtrClient,
  OtrError,
  OTR_DOC_TYPE,
  OTR_STAGING_BASE,
  type OtrInvoicePayload,
} from '../_shared/otrClient'
import { asciiProbePdf, highByteProbePdf, jpegProbe } from '../_shared/asciiProbePdf'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const s3 = new S3Client({})

const FACTORING_TABLE = process.env.FACTORING_ITEM_TABLE_NAME!
const LOAD_TABLE = process.env.LOAD_TABLE_NAME!
const CUSTOMER_TABLE = process.env.CUSTOMER_TABLE_NAME!
const LOCATION_TABLE = process.env.LOCATION_TABLE_NAME
const POD_TABLE = process.env.POD_DOCUMENT_TABLE_NAME
const SUBMISSION_TABLE = process.env.DRIVER_SUBMISSION_TABLE_NAME
const SUBMISSION_DOC_TABLE = process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME
const POD_FUNCTION_NAME = process.env.POD_FUNCTION_NAME ?? ''
const BUCKET = process.env.BUCKET_NAME!

function otr(): OtrClient {
  return new OtrClient({
    baseUrl: process.env.OTR_BASE_URL || OTR_STAGING_BASE,
    // Documents only. Unset falls back to uploading through baseUrl (v1).
    uploadBaseUrl: process.env.OTR_UPLOAD_BASE_URL || undefined,
    // Required by v2 on every invoice; v1 never asked for it.
    clientDot: process.env.OTR_CLIENT_DOT || undefined,
    subscriptionKey: process.env.OTR_SUBSCRIPTION_KEY!,
    username: process.env.OTR_USERNAME!,
    password: process.env.OTR_PASSWORD!,
  })
}

type Row = Record<string, unknown>

interface Args {
  action: string
  /**
   * AWSJSON. AppSync hands this over as a JSON STRING or as an already-parsed OBJECT
   * depending on how the value was serialised on the way in, so it must be typed as both.
   * Assuming the string form is what broke every call this Lambda served from the browser.
   */
  input?: string | Record<string, unknown> | null
}

/**
 * Read the action's input, whichever form AppSync delivered it in.
 *
 * `JSON.parse` on an object stringifies it first, so this was failing with
 * `"[object Object]" is not valid JSON` — on every single action, from every screen. The
 * queue looked like it worked because the rows had been prepared server-side by the email
 * intake; everything a person pressed in the browser was failing.
 *
 * Mirrors parseInput in pod-actions, which has always accepted both.
 */
export function parseArgsInput(input: Args['input']): Row {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    const parsed: unknown = JSON.parse(input)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Row
  }
  if (Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Invalid input: must be an object')
  }
  return input as Row
}

const nowIso = () => new Date().toISOString()
/** YYYY-MM-DD in UTC — OTR's InvoiceDate is the date submitted. */
const today = () => nowIso().slice(0, 10)

/** The live Load table stores aljexId with trailing spaces; always compare trimmed. */
const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

async function getFactoringItem(id: string): Promise<Row | null> {
  const r = await ddb.send(new GetCommand({ TableName: FACTORING_TABLE, Key: { id } }))
  return (r.Item as Row) ?? null
}

/**
 * Resolve a PRO to a Load by matching Load.aljexId. There is no index on
 * aljexId, so this scans — the table is small (hundreds of rows) and this runs
 * once per queue row, not per render. Projecting keeps the payload small.
 */
async function findLoadByPro(pro: string): Promise<Row | null> {
  const target = trim(pro)
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: LOAD_TABLE,
        ProjectionExpression:
          'id, aljexId, pickupNumber, rate, originCity, destinationCity, customer, customerId, rateConfirmKey, stops',
        ExclusiveStartKey,
      }),
    )
    const hit = (r.Items ?? []).find((i) => trim((i as Row).aljexId) === target)
    if (hit) return hit as Row
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return null
}

async function getCustomer(id?: string | null): Promise<Row | null> {
  if (!id) return null
  const r = await ddb.send(new GetCommand({ TableName: CUSTOMER_TABLE, Key: { id } }))
  return (r.Item as Row) ?? null
}

/** Find a customer by booked name, matching on the normalized form. */
async function findCustomerByName(name: string): Promise<Row | null> {
  const norm = normalizeName(name)
  if (!norm) return null
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: CUSTOMER_TABLE,
        ProjectionExpression: 'id, #n, normalizedName, mcNumber, aliases',
        ExpressionAttributeNames: { '#n': 'name' },
        ExclusiveStartKey,
      }),
    )
    const hit = (r.Items ?? []).find((i) => {
      const row = i as Row
      if (trim(row.normalizedName) === norm) return true
      if (typeof row.name === 'string' && normalizeName(row.name) === norm) return true
      const aliases = Array.isArray(row.aliases) ? (row.aliases as string[]) : []
      return aliases.some((a) => normalizeName(a) === norm)
    })
    if (hit) return hit as Row
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return null
}

async function getLocation(id?: string | null): Promise<Row | null> {
  if (!id || !LOCATION_TABLE) return null
  const r = await ddb.send(new GetCommand({ TableName: LOCATION_TABLE, Key: { id } }))
  return (r.Item as Row) ?? null
}

/** Newest POD from JobsDone that a human linked to this load. */
async function findJobsdonePod(loadId: string): Promise<Row | null> {
  if (!POD_TABLE) return null
  let ExclusiveStartKey: Record<string, unknown> | undefined
  const hits: Row[] = []
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: POD_TABLE,
        FilterExpression: 'loadId = :l',
        ExpressionAttributeValues: { ':l': loadId },
        ProjectionExpression: 'id, loadId, fileName, contentType, originalKey, enhancedKey, createdAt',
        ExclusiveStartKey,
      }),
    )
    hits.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  if (!hits.length) return null
  hits.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return hits[0]
}

/**
 * Newest POD a driver scanned in the PWA, or staff uploaded on their behalf.
 *
 * These land in DriverSubmissionDoc, keyed by their submission, and are linked to a load
 * either by the submission's `loadId` or by the PRO the driver typed. A POD that arrived
 * this way used to be invisible to submit, so a load with a perfectly good signed POD was
 * refused as "missing POD". Both stores count now, the same way the settlement page and
 * the driver API already do.
 *
 * Shaped like a PodDocument row so the caller does not care which store it came from;
 * `originalKey` carries the S3 key, which lives in the same bucket.
 */
async function findSubmittedPod(loadId: string, proNumber: string): Promise<Row | null> {
  return findSubmittedDoc(loadId, proNumber, 'POD')
}

/**
 * A document a driver or staff member sent through the app, for this load.
 *
 * Generalised from the POD lookup to cover rate confirmations as well. The queue used to
 * read a rate con from `load.rateConfirmKey` alone, so one uploaded through the driver app
 * — which is a normal way for it to arrive, the app offers RATECON alongside POD — was
 * invisible: the row showed "rate confirmation missing" with the document sitting in the
 * submission the whole time, and the submit then failed for a document we already had.
 */
async function findSubmittedDoc(
  loadId: string,
  proNumber: string,
  kind: 'POD' | 'RATECON',
): Promise<Row | null> {
  if (!SUBMISSION_TABLE || !SUBMISSION_DOC_TABLE) return null
  const wantedPro = normalizePro(proNumber)
  const label = kind === 'POD' ? 'POD' : 'RateCon'
  const combinedField = kind === 'POD' ? 'combinedPodKey' : 'combinedRateconKey'

  const subs = await scanAllRows(SUBMISSION_TABLE)
  const mine = subs.filter((sub) => {
    if (trim(sub.loadId) === loadId) return true
    const ref = normalizePro(typeof sub.referenceNumber === 'string' ? sub.referenceNumber : null)
    return !!wantedPro && ref === wantedPro
  })
  if (!mine.length) return null

  /*
   * The finished PDF wins, when there is one.
   *
   * It is the cleaned pages merged into one document, which is what OTR should receive. The
   * fallback below sends a single page, and for a multi-page POD that means sending one
   * sheet of several — so this is not only about quality.
   */
  const withCombined = mine
    .filter((sub) => trim(sub[combinedField]))
    .sort((a, b) => String(b.combinedAt ?? '').localeCompare(String(a.combinedAt ?? '')))[0]
  if (withCombined) {
    return {
      id: withCombined.id,
      loadId,
      fileName: `${label}-${proNumber || String(withCombined.id).slice(-6)}.pdf`,
      contentType: 'application/pdf',
      originalKey: trim(withCombined[combinedField]),
      createdAt: withCombined.combinedAt,
      // Already the cleaned, merged document — there is nothing left to enhance.
      enhancedKey: trim(withCombined[combinedField]),
    }
  }

  const ids = new Set(mine.map((sub) => String(sub.id)))
  const docs = (await scanAllRows(SUBMISSION_DOC_TABLE)).filter(
    (d) => d.kind === kind && ids.has(String(d.submissionId)) && trim(d.s3Key),
  )
  if (!docs.length) return null

  // Newest page wins. A multi-page POD is already combined into one PDF on the way in.
  docs.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))
  const doc = docs[0]
  return {
    id: doc.id,
    loadId,
    fileName: doc.fileName ?? `${label}-${proNumber}.pdf`,
    contentType: doc.contentType,
    originalKey: doc.s3Key,
    /*
     * The CLEANED page, when the scan has produced one.
     *
     * This was not returned at all, so every driver-submitted POD reached OTR as the raw
     * camera photo — deskewed by nothing, cropped to nothing — while a cleaned copy sat in
     * S3 beside it. Only a merged multi-page POD escaped, because that path returns the
     * combined PDF. The caller already prefers enhancedKey; it was simply never given one.
     */
    enhancedKey: doc.scanStatus === 'READY' ? doc.enhancedKey : null,
    scanStatus: doc.scanStatus,
    submissionId: doc.submissionId,
    createdAt: doc.uploadedAt,
  }
}

async function scanAllRows(table: string): Promise<Row[]> {
  const out: Row[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }))
    out.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}

/*
 * How long a submit will wait for a POD to be cleaned up before sending it anyway.
 *
 * Both this function and pod-actions time out at 60s, and by the time documents are being
 * uploaded the invoice already exists at OTR — so running out the clock here would lose an
 * invoice we had just created. Twenty seconds is enough for the scan of a dock photo and
 * leaves the uploads room to finish. Going over it costs quality on one submit, not the
 * submit itself: the scan carries on in its own lambda and the cleaned copy is there for
 * next time.
 */
const ENHANCE_WAIT_MS = 20_000
const ENHANCE_POLL_MS = 1_500

/**
 * The POD, cleaned up, if cleaning it up is still possible.
 *
 * PODs are deskewed, cropped and contrast-corrected by pod-actions after every upload, and
 * the cleaned copy is what OTR should receive — a flash-lit phone photo of a bill of lading
 * is a different document from the same page straightened and thresholded. That cleanup is
 * queued asynchronously so a driver at a dock is not left watching a spinner, which leaves
 * one window open: a submit pressed while the scan is still PENDING used to fall straight
 * through to the raw photo. This closes that window by asking for the scan and waiting.
 *
 * Only a submission-backed POD can be re-scanned, and only one that has not already been
 * through the scanner: READY has a cleaned copy, ORIGINAL_ONLY means the scanner looked and
 * found no page worth extracting, and asking it to look a second time would just spend the
 * wait to arrive at the same answer.
 *
 * Returns the best POD available when the wait is over — never null, never throws. Every
 * failure here means sending the original, which is what would have been sent anyway.
 */
async function enhancedPodForSend(
  pod: Row | null,
  loadId: string,
  proNumber: string,
): Promise<Row | null> {
  if (!pod || trim(pod.enhancedKey)) return pod

  const submissionId = trim(pod.submissionId)
  const status = trim(pod.scanStatus)
  if (!submissionId || !POD_FUNCTION_NAME) return pod
  if (status === 'ORIGINAL_ONLY') return pod

  console.log('[otr-actions] POD has no cleaned copy yet; asking for the scan before sending', {
    loadId,
    submissionId,
    scanStatus: status || '(none)',
  })

  try {
    await new LambdaClient({}).send(
      new InvokeCommand({
        FunctionName: POD_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ action: 'scanDriverDocs', submissionId, kind: 'POD' })),
      }),
    )
  } catch (err) {
    console.error('[otr-actions] could not ask for the scan; sending the original', {
      submissionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return pod
  }

  /*
   * Polled rather than invoked synchronously: the scan runs in its own lambda either way,
   * and watching the table means a wait that runs out leaves the scan running instead of
   * killing it. Re-read through findPod so a multi-page POD picks up the merged PDF the
   * scan writes to the submission, not just the cleaned first page.
   */
  const deadline = Date.now() + ENHANCE_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ENHANCE_POLL_MS))
    const fresh = await findPod(loadId, proNumber)
    if (fresh && trim(fresh.enhancedKey)) {
      console.log('[otr-actions] sending the cleaned POD', { loadId, submissionId })
      return fresh
    }
    if (fresh && trim(fresh.scanStatus) === 'ORIGINAL_ONLY') return fresh
  }

  console.warn('[otr-actions] POD scan did not finish in time; sending the original', {
    loadId,
    submissionId,
  })
  return pod
}

/** A POD for this load from either store. JobsDone first, since a human linked it there. */
async function findPod(loadId: string, proNumber = ''): Promise<Row | null> {
  return (await findJobsdonePod(loadId)) ?? (await findSubmittedPod(loadId, proNumber))
}

/**
 * A rate confirmation for this load, from wherever it reached BCAT Ops.
 *
 * The key on the Load wins: that is the one staff attached to the load itself, and it is
 * what the drawer shows. Failing that, a submission carrying a RATECON counts — the app
 * accepts rate confirmations as readily as PODs, and a document already in the building
 * should not have to be uploaded a second time to satisfy the queue.
 */
async function findRatecon(load: Row, proNumber = ''): Promise<Row | null> {
  const onLoad = trim(load.rateConfirmKey)
  if (onLoad) {
    return {
      id: `load:${load.id}`,
      loadId: load.id,
      fileName: `RateCon-${proNumber || String(load.id).slice(-6)}.pdf`,
      contentType: 'application/pdf',
      originalKey: onLoad,
      createdAt: load.updatedAt,
    }
  }
  return findSubmittedDoc(String(load.id), proNumber, 'RATECON')
}

/**
 * Exported for findPod.test.ts only. Which store a POD comes from decides whether an
 * invoice can be created at all, and that is worth testing directly rather than through
 * the whole submit action.
 */
export const __testFindPod = findPod

/** Exported for enhanceBeforeSend.test.ts only, for the same reason as __testFindPod. */
export const __testEnhancedPodForSend = enhancedPodForSend

/** Exported for findRatecon.test.ts only, for the same reason as __testFindPod. */
export const __testFindRatecon = findRatecon

/** First pickup and last delivery stop, for Location lookups. */
function endpointStops(load: Row): { origin?: Row; destination?: Row } {
  const raw = load.stops
  const stops: Row[] = Array.isArray(raw)
    ? (raw as Row[])
    : typeof raw === 'string'
      ? (JSON.parse(raw || '[]') as Row[])
      : []
  const ordered = [...stops].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
  return {
    origin: ordered.find((s) => s.type === 'pickup'),
    destination: [...ordered].reverse().find((s) => s.type === 'delivery'),
  }
}

/** Everything assembleOtrInvoice needs, gathered from the row's linked records. */
async function buildReadiness(item: Row): Promise<{ readiness: OtrReadiness; load: Row | null }> {
  const loadId = trim(item.loadId)
  const load = loadId
    ? ((await ddb.send(new GetCommand({ TableName: LOAD_TABLE, Key: { id: loadId } }))).Item as Row) ??
      null
    : await findLoadByPro(String(item.proNumber ?? ''))

  if (!load) {
    /*
     * No load has been built in BCAT Ops for this PRO.
     *
     * Everything else on the row is genuinely unknown, but the PRO is not — the Aljex
     * invoice email that created this row names it in its subject and it is the row's own
     * id. Passing it through is why 14529 showed "Invoice number (PRO)" as missing while
     * sitting in a row titled 14529.
     */
    return {
      readiness: assembleOtrInvoice({
        load: {},
        proNumber: trim(item.proNumber) || trim(item.id) || null,
        manual: (item.otrManualFields as ManualOverrides) ?? null,
        submissionDate: today(),
      }),
      load: null,
    }
  }

  const { origin, destination } = endpointStops(load)
  const [customer, originLoc, destLoc, pod, ratecon] = await Promise.all([
    getCustomer(load.customerId as string | undefined),
    getLocation(origin?.locationId as string | undefined),
    getLocation(destination?.locationId as string | undefined),
    findPod(String(load.id), String(item.proNumber ?? '')),
    findRatecon(load, String(item.proNumber ?? '')),
  ])

  // Fall back to a name match so a load booked before the directory existed
  // still finds its broker MC.
  const resolvedCustomer =
    customer ?? (load.customer ? await findCustomerByName(String(load.customer)) : null)

  const readiness = assembleOtrInvoice({
    load: {
      aljexId: load.aljexId as string,
      pickupNumber: load.pickupNumber as string,
      rate: load.rate as number,
      originCity: load.originCity as string,
      destinationCity: load.destinationCity as string,
      customerId: load.customerId as string,
      customer: load.customer as string,
      rateConfirmKey: load.rateConfirmKey as string,
    },
    // Populated once the rate-con parser is extended; absent is handled.
    rateCon: (item.rateConExtract as RateConExtract) ?? null,
    // The row's own PRO, so a factoring row whose load was never built still knows it.
    proNumber: trim(item.proNumber) || trim(item.id) || null,
    customerMcNumber: resolvedCustomer?.mcNumber as string | undefined,
    // The name on the broker record, and whether anything ever checked it against the MC.
    // Nothing does today, so this is false everywhere until a lookup exists.
    customerName: resolvedCustomer?.name as string | undefined,
    customerNameVerified: resolvedCustomer?.mcNameVerified === true,
    originLocation: originLoc
      ? { city: originLoc.city as string, state: originLoc.state as string, zip: originLoc.zip as string }
      : null,
    destinationLocation: destLoc
      ? { city: destLoc.city as string, state: destLoc.state as string, zip: destLoc.zip as string }
      : null,
    manual: (item.otrManualFields as ManualOverrides) ?? null,
    submissionDate: today(),
    hasPod: Boolean(pod),
    // Counts a rate con from EITHER store — see findRatecon. Reading only the key on the
    // Load reported one missing while it sat in a submission, and blocked the invoice.
    hasRateConfirmation: Boolean(ratecon),
  })

  return { readiness, load }
}

async function updateItem(id: string, fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (!entries.length) return
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets = entries.map(([k, v], i) => {
    names[`#f${i}`] = k
    values[`:v${i}`] = v
    return `#f${i} = :v${i}`
  })
  names['#u'] = 'updatedAt'
  values[':u'] = nowIso()
  await ddb.send(
    new UpdateCommand({
      TableName: FACTORING_TABLE,
      Key: { id },
      UpdateExpression: `SET ${sets.join(', ')}, #u = :u`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  )
}

async function s3Bytes(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const bytes = await r.Body!.transformToByteArray()
  return { bytes, contentType: r.ContentType ?? 'application/pdf' }
}

/**
 * Attach the POD and the rate confirmation to an invoice that already exists at OTR.
 *
 * Split out of `submit` so it can be run again. The invoice is created first and the
 * documents follow, which means a document failure leaves a real invoice at OTR with
 * nothing attached — and `submit` refuses to run twice, by design, so there was no way to
 * finish the job without creating a duplicate invoice.
 *
 * Every failure records what OTR actually SAID. "Document upload failed (500)" is not a
 * diagnosis, and throwing the response body away is what made the first one unanswerable.
 */
async function uploadInvoiceDocuments(
  item: Row,
  load: Row,
  invoiceId: number | string,
): Promise<{ uploaded: { pod?: string; rateConfirmation?: string }; errors: string[] }> {
  const client = otr()
  const uploaded: { pod?: string; rateConfirmation?: string } = {}
  const errors: string[] = []

  function describe(label: string, e: unknown): string {
    if (e instanceof OtrError) {
      const body = trim(e.body).slice(0, 400)
      console.error('[otr-actions] document upload rejected', {
        label,
        invoiceId: String(invoiceId),
        status: e.status,
        body: e.body?.slice(0, 2000),
      })
      return `${label}: ${e.message}${body ? ` — ${body}` : ''}`
    }
    const message = e instanceof Error ? e.message : String(e)
    console.error('[otr-actions] document upload failed', { label, invoiceId: String(invoiceId), message })
    return `${label}: ${message}`
  }

  const proNumber = String(item.proNumber ?? '')
  const pod = await enhancedPodForSend(
    await findPod(String(load.id), proNumber),
    String(load.id),
    proNumber,
  )
  const podKey = trim(pod?.enhancedKey) || trim(pod?.originalKey)
  if (podKey) {
    try {
      const { bytes, contentType } = await s3Bytes(podKey)
      await client.uploadDocument({
        invoiceId,
        docType: OTR_DOC_TYPE.POD,
        fileName: `POD-${item.proNumber}.pdf`,
        contentType,
        file: bytes,
      })
      uploaded.pod = podKey
    } catch (e) {
      errors.push(describe('POD', e))
    }
  } else {
    errors.push('POD: nothing on file to send')
  }

  /*
   * Same lookup readiness used, so the queue and the submit agree. Reading only
   * load.rateConfirmKey here meant a rate con sent through the driver app showed as
   * present on the row and then failed to send — "nothing on file" for a document that
   * was on file.
   */
  const rc = await findRatecon(load, String(item.proNumber ?? ''))
  const rcKey = trim(rc?.originalKey)
  if (rcKey) {
    try {
      const { bytes, contentType } = await s3Bytes(rcKey)
      await client.uploadDocument({
        invoiceId,
        docType: OTR_DOC_TYPE.RATE_CONFIRMATION,
        fileName: `RateCon-${item.proNumber}.pdf`,
        contentType,
        file: bytes,
      })
      uploaded.rateConfirmation = rcKey
    } catch (e) {
      errors.push(describe('Rate confirmation', e))
    }
  } else {
    errors.push('Rate confirmation: nothing on file to send')
  }

  return { uploaded, errors }
}

const ok = (data: unknown) => JSON.stringify({ ok: true, data })
const fail = (error: string) => JSON.stringify({ ok: false, error })

export const handler = async (event: { arguments: Args; identity?: { claims?: { email?: string } } }) => {
  const { action } = event.arguments
  const input = parseArgsInput(event.arguments.input)
  const actor = event.identity?.claims?.email ?? 'unknown'

  try {
    switch (action) {
      /** Match the row's PRO to a Load and persist the link. */
      case 'resolve': {
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')
        const load = await findLoadByPro(String(item.proNumber ?? ''))
        if (!load) return fail(`no load found with PRO ${item.proNumber}`)
        await updateItem(String(item.id), { loadId: String(load.id) })
        return ok({ loadId: load.id, customer: load.customer })
      }

      /** Rebuild readiness and cache it on the row for the queue to render. */
      case 'assemble': {
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')
        const { readiness, load } = await buildReadiness(item)
        await updateItem(String(item.id), {
          otrReadiness: readiness,
          loadId: load ? String(load.id) : undefined,
        })
        return ok(readiness)
      }

      /**
       * Record a broker MC, creating the Customer when the load's broker has no
       * directory record yet. The MC is stored on the customer so it is entered
       * once per broker, not once per load.
       */
      case 'setMc': {
        const mc = trim(input.mcNumber)
        if (!/^\d{2,10}$/.test(mc)) return fail('MC number must be 2-10 digits')
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')

        const { load } = await buildReadiness(item)
        if (!load) return fail('resolve the load before setting a broker MC')

        let customer = await getCustomer(load.customerId as string | undefined)
        if (!customer && load.customer) customer = await findCustomerByName(String(load.customer))

        if (customer) {
          await ddb.send(
            new UpdateCommand({
              TableName: CUSTOMER_TABLE,
              Key: { id: customer.id },
              UpdateExpression: 'SET mcNumber = :mc, updatedAt = :u',
              ExpressionAttributeValues: { ':mc': mc, ':u': nowIso() },
            }),
          )
        } else {
          const name = String(load.customer ?? '').trim()
          if (!name) return fail('load has no customer name to create a directory record from')
          customer = {
            id: randomUUID(),
            name,
            normalizedName: normalizeName(name),
            mcNumber: mc,
            /*
             * The name here came off the LOAD, not from the MC. Saying so is the whole
             * point: this record is one person typing an MC next to a name somebody else
             * booked, and nothing has checked that they describe the same company.
             */
            mcNameVerified: false,
            active: true,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          }
          await ddb.send(new PutCommand({ TableName: CUSTOMER_TABLE, Item: customer }))
          // Link the load so the next PRO from this broker resolves directly.
          await ddb.send(
            new UpdateCommand({
              TableName: LOAD_TABLE,
              Key: { id: load.id },
              UpdateExpression: 'SET customerId = :c, updatedAt = :u',
              ExpressionAttributeValues: { ':c': customer.id, ':u': nowIso() },
            }),
          )
        }

        const { readiness } = await buildReadiness(await getFactoringItem(String(item.id)) as Row)
        await updateItem(String(item.id), { otrReadiness: readiness })
        return ok({ customerId: customer.id, mcNumber: mc, readiness })
      }

      /** Ask OTR whether the broker is approved. Never submits. */
      case 'brokerCheck': {
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')
        const { readiness } = await buildReadiness(item)
        const mc = readiness.payload.BrokerMC as string | undefined
        if (!mc) return fail('no broker MC on this row yet')

        const { decision, message, brokerName, raw } = await otr().brokerCheck({ brokerMc: mc })
        /*
         * Logged in full, once per check.
         *
         * Only `message` was ever read from this reply, so what else OTR sends back was
         * never established. The factoring queue wants the broker's NAME above all — an MC
         * is nine digits nobody recognises — and this is the one call that has the MC and
         * runs before an invoice exists.
         */
        console.log('[otr-actions] broker-check reply', { mc, raw })

        /*
         * If OTR named the broker, that name is better than anything we hold: it is the
         * name they will bill under. It goes on the customer record so the next load from
         * the same broker is already right, and it is never allowed to blank a name we
         * already have.
         */
        if (brokerName) {
          const { load } = await buildReadiness(item)
          let customer = await getCustomer(load?.customerId as string | undefined)
          if (!customer && load?.customer) customer = await findCustomerByName(String(load.customer))
          if (customer && trim(customer.name) !== brokerName) {
            await ddb.send(
              new UpdateCommand({
                TableName: CUSTOMER_TABLE,
                Key: { id: customer.id },
                UpdateExpression:
                  'SET #n = :n, normalizedName = :nn, mcNameVerified = :v, updatedAt = :u',
                ExpressionAttributeNames: { '#n': 'name' },
                ExpressionAttributeValues: {
                  ':n': brokerName,
                  ':nn': normalizeName(brokerName),
                  // OTR answering with a name for this MC is the only lookup we have.
                  ':v': true,
                  ':u': nowIso(),
                },
              }),
            )
          }
        }

        await updateItem(String(item.id), {
          brokerMcChecked: mc,
          brokerCheckResult: decision.replace(' ', '_'),
          brokerCheckedAt: nowIso(),
          otrError: null,
        })

        // Re-assemble so the queue picks up a name the check just supplied.
        if (brokerName) {
          const { readiness: fresh } = await buildReadiness(
            (await getFactoringItem(String(item.id))) as Row,
          )
          await updateItem(String(item.id), { otrReadiness: fresh })
        }

        return ok({ decision, message, mcNumber: mc, brokerName })
      }

      /**
       * Create the invoice at OTR, then attach the POD and rate confirmation.
       * Refuses unless every required field and both documents are present, so a
       * half-built invoice can never reach their board.
       */
      case 'submit': {
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')
        if (item.otrInvoiceId) {
          return fail(`already submitted to OTR as invoice ${item.otrInvoiceId}`)
        }

        const { readiness, load } = await buildReadiness(item)
        if (!load) return fail('no load linked to this row')
        const payload = toOtrPayload(readiness)
        if (!payload) {
          const gaps = [...readiness.missingFields, ...readiness.missingDocuments]
          return fail(`not ready to submit — missing: ${gaps.join(', ')}`)
        }
        if (item.brokerCheckResult === 'NOT_APPROVED') {
          return fail('OTR has not approved this broker; submission would be rejected')
        }

        const client = otr()
        const created = await client.createInvoice(payload as unknown as OtrInvoicePayload)

        // Documents are best-effort: the invoice already exists at OTR, so a failed
        // upload must not lose the invoiceId. Retryable on its own afterwards.
        const { uploaded, errors: docErrors } = await uploadInvoiceDocuments(
          item,
          load,
          created.invoiceId,
        )

        await updateItem(String(item.id), {
          otrInvoiceId: String(created.invoiceId),
          otrSubmittedAt: nowIso(),
          otrSubmittedBy: actor,
          otrAmount: Math.round(Number(payload.InvoiceAmount) * 100),
          /*
           * No otrStatus here. "Pending" is one of OTR's OWN statuses, so writing it at
           * submit time put a status in OTR's wording on a row OTR had not spoken about
           * yet — indistinguishable from a real one, and wrong the moment OTR disagreed.
           * The row carries a status only once the hourly sync brings one back.
           */
          otrDocsUploaded: uploaded,
          otrReadiness: readiness,
          status: 'PENDING_WITH_OTR',
          otrError: docErrors.length ? docErrors.join('; ') : null,
        })

        return ok({
          invoiceId: created.invoiceId,
          brokerName: created.brokerName,
          isDuplicate: created.isDuplicate,
          uploaded,
          documentErrors: docErrors,
        })
      }

      /**
       * Send the documents again for an invoice OTR already has.
       *
       * `submit` creates the invoice first and attaches the paperwork after, and it refuses
       * to run twice — correctly, or a retry would mean a second invoice. So a document
       * failure used to leave a real invoice at OTR with nothing on it and no way to finish
       * short of creating a duplicate. This is that way.
       */
      case 'uploadDocs': {
        const item = await getFactoringItem(String(input.id))
        if (!item) return fail('factoring item not found')
        const invoiceId = trim(item.otrInvoiceId)
        if (!invoiceId) return fail('this row has not been submitted to OTR yet')

        const { load } = await buildReadiness(item)
        if (!load) return fail('no load linked to this row')

        const { uploaded, errors } = await uploadInvoiceDocuments(item, load, invoiceId)
        await updateItem(String(item.id), {
          otrDocsUploaded: { ...((item.otrDocsUploaded as Row) ?? {}), ...uploaded },
          otrError: errors.length ? errors.join('; ') : null,
        })
        console.log('[otr-actions] document retry by', actor, { invoiceId, errors })
        return ok({ invoiceId, uploaded, documentErrors: errors })
      }

      /*
       * Two tiny PDFs: one with no byte above 0x7F, one identical but for a run of high
       * bytes after %%EOF. Both are valid single-page documents.
       *
       * OTR rejects our PODs reporting 1,852,054 bytes of a 1,018,923-byte file — what
       * those bytes become after a UTF-8 decode and re-encode. Our logs show the correct
       * size leaving, and matching their documented request exactly did not move the
       * number. This asks the question directly: a file that cannot be changed by a UTF-8
       * round trip against one that must be.
       *
       * If the ASCII one lands and the other comes back with an inflated byte count, the
       * mangling is theirs and the evidence is two files instead of an argument.
       *
       * The document TYPE has to be the one under investigation. Run as OTHER (7) first,
       * both probes came back "Object reference not set to an instance of an object" with
       * no byte count at all — the same thing the rate confirmation (type 3) gets, and
       * nothing like the POD's (type 1) IronPDF complaint. Types 3 and 7 fail before the
       * file is looked at, so sending through them measures nothing about the bytes.
       * Defaults to POD, which is the one path that reaches their PDF reader and reports
       * the size it opened.
       */
      /*
       * Send ONE real document to OTR twice — untouched, and rewritten to pure ASCII — so
       * the fix is judged on their response rather than on our arithmetic. Takes the S3 key
       * of an actual POD or rate confirmation.
       */
      case 'docProbe': {
        const invoiceId = trim(input.invoiceId)
        const key = trim(input.key)
        if (!invoiceId || !key) return fail('docProbe needs an invoiceId and a key')
        const docType = (Number(input.docType) || OTR_DOC_TYPE.POD) as typeof OTR_DOC_TYPE.POD
        const client = otr()
        const { bytes, contentType } = await s3Bytes(key)
        const results: Row[] = []

        for (const asciiSafe of [false, true]) {
          try {
            const r = await client.uploadDocument({
              invoiceId,
              docType,
              fileName: `probe-${asciiSafe ? 'ascii' : 'raw'}.pdf`,
              contentType,
              file: bytes,
              asciiSafe,
            })
            results.push({ asciiSafe, ok: true, message: r.message })
          } catch (e) {
            const body = e instanceof OtrError ? e.body : null
            results.push({
              asciiSafe,
              ok: false,
              status: e instanceof OtrError ? e.status : 0,
              // The size their reader says it opened is the whole experiment.
              reportedBytes: Number(/from (\d+) bytes/.exec(String(body ?? ''))?.[1] ?? 0) || null,
              body: String(body ?? (e instanceof Error ? e.message : e)).slice(0, 300),
            })
          }
        }

        console.log('[otr-actions] doc probe', JSON.stringify({ invoiceId, key, sourceBytes: bytes.length, results }))
        return ok({ invoiceId, key, sourceBytes: bytes.length, results })
      }

      case 'uploadProbe': {
        const invoiceId = trim(input.invoiceId)
        if (!invoiceId) return fail('uploadProbe needs an invoiceId')
        const docType = (Number(input.docType) || OTR_DOC_TYPE.POD) as typeof OTR_DOC_TYPE.POD
        const client = otr()
        const results: Row[] = []

        // A JPEG too: their docs accept images, and every failure so far has been a PDF —
        // the one that got furthest died inside IronPDF, which is their PDF reader.
        for (const probe of [asciiProbePdf(), highByteProbePdf(), jpegProbe()]) {
          const sent = {
            fileName: probe.fileName,
            docType,
            sentBytes: probe.bytes.length,
            highBytes: probe.highBytes,
          }
          try {
            const r = await client.uploadDocument({
              invoiceId,
              docType,
              fileName: probe.fileName,
              contentType: probe.fileName.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf',
              file: probe.bytes,
            })
            results.push({ ...sent, ok: true, message: r.message })
          } catch (e) {
            const body = e instanceof OtrError ? e.body : null
            // Their error quotes the size they opened. That number against sentBytes is
            // the whole experiment.
            const reported = /from (\d+) bytes/.exec(String(body ?? ''))?.[1] ?? null
            results.push({
              ...sent,
              ok: false,
              status: e instanceof OtrError ? e.status : 0,
              reportedBytes: reported ? Number(reported) : null,
              body: String(body ?? (e instanceof Error ? e.message : e)).slice(0, 400),
            })
          }
        }

        console.log('[otr-actions] upload probe', JSON.stringify({ invoiceId, results, by: actor }))
        return ok({ invoiceId, results })
      }

      /** Mirror OTR's current status onto the row so the queue shows their board. */
      case 'syncStatus': {
        const ids: string[] = Array.isArray(input.ids)
          ? (input.ids as string[])
          : input.id
            ? [String(input.id)]
            : []
        const client = otr()
        const results: Row[] = []

        for (const id of ids) {
          const item = await getFactoringItem(id)
          if (!item?.otrInvoiceId) continue
          try {
            const d = await client.getInvoice(String(item.otrInvoiceId))
            /*
             * v2 answers with a status NUMBER, so comparing to the word 'Paid' never
             * matched and nothing was ever marked factored. localStatusFor owns that
             * decision now, in the same module that owns the labels.
             */
            const local = localStatusFor(d.status)
            await updateItem(id, {
              otrStatus: d.status,
              otrScheduleId: d.scheduleId,
              otrStatusSyncedAt: nowIso(),
              status: local,
              otrError: null,
            })
            results.push({ id, status: d.status, scheduleId: d.scheduleId })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            await updateItem(id, { otrError: msg, otrStatusSyncedAt: nowIso() })
            results.push({ id, error: msg })
          }
        }
        return ok({ synced: results })
      }

      default:
        return fail(`unsupported action: ${action}`)
    }
  } catch (e) {
    if (e instanceof OtrError) {
      // Surface OTR's own wording; it names the field or broker at fault.
      console.error('[otr-actions] OTR error', e.status, e.message)
      if (input.id) await updateItem(String(input.id), { otrError: e.message })
      return fail(e.message)
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[otr-actions] failed', msg)
    return fail(msg)
  }
}
