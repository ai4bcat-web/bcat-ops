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
import { randomUUID } from 'crypto'
import {
  assembleOtrInvoice,
  toOtrPayload,
  type ManualOverrides,
  type RateConExtract,
  type OtrReadiness,
} from '../../../src/lib/otrInvoice'
import { normalizeName } from '../../../src/lib/tmsDirectory'
import { normalizePro } from '../../../src/lib/podPresence'
import {
  OtrClient,
  OtrError,
  OTR_DOC_TYPE,
  OTR_STAGING_BASE,
  type OtrInvoicePayload,
} from '../_shared/otrClient'

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
const BUCKET = process.env.BUCKET_NAME!

function otr(): OtrClient {
  return new OtrClient({
    baseUrl: process.env.OTR_BASE_URL || OTR_STAGING_BASE,
    subscriptionKey: process.env.OTR_SUBSCRIPTION_KEY!,
    username: process.env.OTR_USERNAME!,
    password: process.env.OTR_PASSWORD!,
  })
}

type Row = Record<string, unknown>

interface Args {
  action: string
  input?: string // JSON
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
  if (!SUBMISSION_TABLE || !SUBMISSION_DOC_TABLE) return null
  const wantedPro = normalizePro(proNumber)

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
    .filter((sub) => trim(sub.combinedPodKey))
    .sort((a, b) => String(b.combinedAt ?? '').localeCompare(String(a.combinedAt ?? '')))[0]
  if (withCombined) {
    return {
      id: withCombined.id,
      loadId,
      fileName: `POD-${proNumber || String(withCombined.id).slice(-6)}.pdf`,
      contentType: 'application/pdf',
      originalKey: trim(withCombined.combinedPodKey),
      createdAt: withCombined.combinedAt,
    }
  }

  const ids = new Set(mine.map((sub) => String(sub.id)))
  const docs = (await scanAllRows(SUBMISSION_DOC_TABLE)).filter(
    (d) => d.kind === 'POD' && ids.has(String(d.submissionId)) && trim(d.s3Key),
  )
  if (!docs.length) return null

  // Newest page wins. A multi-page POD is already combined into one PDF on the way in.
  docs.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))
  const doc = docs[0]
  return {
    id: doc.id,
    loadId,
    fileName: doc.fileName ?? `POD-${proNumber}.pdf`,
    contentType: doc.contentType,
    originalKey: doc.s3Key,
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

/** A POD for this load from either store. JobsDone first, since a human linked it there. */
async function findPod(loadId: string, proNumber = ''): Promise<Row | null> {
  return (await findJobsdonePod(loadId)) ?? (await findSubmittedPod(loadId, proNumber))
}

/**
 * Exported for findPod.test.ts only. Which store a POD comes from decides whether an
 * invoice can be created at all, and that is worth testing directly rather than through
 * the whole submit action.
 */
export const __testFindPod = findPod

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
    return {
      readiness: assembleOtrInvoice({
        load: {},
        manual: (item.otrManualFields as ManualOverrides) ?? null,
        submissionDate: today(),
      }),
      load: null,
    }
  }

  const { origin, destination } = endpointStops(load)
  const [customer, originLoc, destLoc, pod] = await Promise.all([
    getCustomer(load.customerId as string | undefined),
    getLocation(origin?.locationId as string | undefined),
    getLocation(destination?.locationId as string | undefined),
    findPod(String(load.id), String(item.proNumber ?? '')),
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
    customerMcNumber: resolvedCustomer?.mcNumber as string | undefined,
    // The broker behind the MC, for the queue's customer column. Falls back inside
    // assembleOtrInvoice to the load's own customer string, marked unconfirmed.
    customerName: resolvedCustomer?.name as string | undefined,
    originLocation: originLoc
      ? { city: originLoc.city as string, state: originLoc.state as string, zip: originLoc.zip as string }
      : null,
    destinationLocation: destLoc
      ? { city: destLoc.city as string, state: destLoc.state as string, zip: destLoc.zip as string }
      : null,
    manual: (item.otrManualFields as ManualOverrides) ?? null,
    submissionDate: today(),
    hasPod: Boolean(pod),
    hasRateConfirmation: Boolean(trim(load.rateConfirmKey)),
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

const ok = (data: unknown) => JSON.stringify({ ok: true, data })
const fail = (error: string) => JSON.stringify({ ok: false, error })

export const handler = async (event: { arguments: Args; identity?: { claims?: { email?: string } } }) => {
  const { action } = event.arguments
  const input = event.arguments.input ? (JSON.parse(event.arguments.input) as Row) : {}
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
                UpdateExpression: 'SET #n = :n, normalizedName = :nn, updatedAt = :u',
                ExpressionAttributeNames: { '#n': 'name' },
                ExpressionAttributeValues: {
                  ':n': brokerName,
                  ':nn': normalizeName(brokerName),
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

        // Documents are best-effort: the invoice already exists at OTR, so a
        // failed upload must not lose the invoiceId. Record what landed.
        const uploaded: { pod?: string; rateConfirmation?: string } = {}
        const docErrors: string[] = []

        const pod = await findPod(String(load.id), String(item.proNumber ?? ''))
        const podKey = trim(pod?.enhancedKey) || trim(pod?.originalKey)
        if (podKey) {
          try {
            const { bytes, contentType } = await s3Bytes(podKey)
            await client.uploadDocument({
              invoiceId: created.invoiceId,
              docType: OTR_DOC_TYPE.POD,
              fileName: String(pod?.fileName ?? `POD-${item.proNumber}.pdf`),
              contentType,
              file: bytes,
            })
            uploaded.pod = podKey
          } catch (e) {
            docErrors.push(`POD: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        const rcKey = trim(load.rateConfirmKey)
        if (rcKey) {
          try {
            const { bytes, contentType } = await s3Bytes(rcKey)
            await client.uploadDocument({
              invoiceId: created.invoiceId,
              docType: OTR_DOC_TYPE.RATE_CONFIRMATION,
              fileName: `RateCon-${item.proNumber}.pdf`,
              contentType,
              file: bytes,
            })
            uploaded.rateConfirmation = rcKey
          } catch (e) {
            docErrors.push(`Rate confirmation: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        await updateItem(String(item.id), {
          otrInvoiceId: String(created.invoiceId),
          otrSubmittedAt: nowIso(),
          otrSubmittedBy: actor,
          otrAmount: Math.round(Number(payload.InvoiceAmount) * 100),
          otrStatus: 'Pending',
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
            // OTR's "Paid" is the terminal state; reflect it on the local status.
            const local = d.status === 'Paid' ? 'FACTORED' : 'PENDING_WITH_OTR'
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
