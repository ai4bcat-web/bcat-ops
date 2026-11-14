/**
 * Shipment documents and what hangs off them — step E.
 *
 * A shipment's paperwork is one typed index (`ShipmentDocument`) over bytes that
 * may live anywhere: staff uploads and generated PDFs go under
 * `shipment-docs/{shipmentId}/`, while a driver-app POD is a POINTER row whose
 * `s3Key` is the driver store's own key. Nothing is ever copied, so the driver
 * app stays the record of what a driver actually sent.
 *
 * Two rules shape every function here. First, the required-document gate is a
 * CACHE: `Order.docsMissing` and `LoadCarrier.docsMissing` are re-derived from
 * the rows by `recacheDocGates` and rewritten in the SAME transaction as the row
 * that changed, so a board column can never disagree with the Documents tab.
 * Second, the bytes are never deleted — voiding flips a row to VOID and the
 * object stays, because the bucket grants no delete and a half-removed file is
 * worse than an orphan nobody links to.
 *
 * The router owns authorization and the clients; this module is handed both.
 */
import { UpdateItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { convertStoredPodImage, isPodImage, pdfKeyFor } from '../_shared/podPdf'
import { LOAD_EXTRA_DOC_TYPES, loadExtraDocTypes, validateLoadRequiredDocTypes } from '../../../src/lib/loadRequiredDocs'

import {
  getById,
  isConflict,
  nowIso,
  numberOrNull,
  putItem,
  queryIndex,
  readBundle,
  readStops,
  transact,
  updateItemTx,
  type Bundle,
  type Row,
  type ShipmentStoreDeps,
} from '../_shared/shipmentStore'
import {
  assertEnum,
  assertExpectedUpdatedAt,
  assertString,
  optionalEnum,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import {
  ACCEPTED_CONTENT_TYPES,
  CARRIER_UPLOADABLE_TYPES,
  DEFAULT_AUDIENCE,
  DRIVER_ATTACHABLE_TYPES,
  GENERATED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_GENERATED_BYTES,
  PDF_CONTENT_TYPE,
  SHIPMENT_DOCUMENT_TYPES,
  documentKey,
  documentPrefix,
  driverDocumentId,
  countsAsPresent,
  evaluateDocGate,
  gateLoadIds,
  generatedFilename,
  generatedKey,
  isPointerDocument,
  nextVersion,
  supersede,
} from '../../../src/lib/shipmentDocuments'
import { isCarShipperLoad } from '../../../src/lib/carShipper'
import { loadReleaseGateInput } from '../_shared/releaseGateInput'
import { planPendingCarrierBills, readPendingBillContext, writePendingBill } from '../_shared/pendingCarrierBill'
import { hasGap, isReleasedOrder, reconcileReleasedOrder, type ReconcileFinding } from '../../../src/lib/billingReconcile'
import { evaluateReleaseGate, releaseGateError, type ReleaseGateResult } from '../../../src/lib/releaseGate'
import { factorGapsForLoad, factoringPoNumber, routeEnds, type FactorReadyInput } from '../../../src/lib/factorReadyAtCreate'
import { evaluateLoadReview, loadReviewExtras, loadReviewRefusal, type LoadReviewReason } from '../../../src/lib/loadReview'
import { profitFromFacts, resolveReviewRequirements, type ReviewFacts, type ReviewRequirement } from '../../../src/lib/reviewRequirements'
import {
  isCustomerUnresolved,
  unresolvedCustomerMessage,
  type CustomerResolvable,
} from '../../../src/lib/customerResolution'
import { isVoided } from '../_shared/voided'
// Step P5. The one build-state refusal every downstream action shares.
import { assertBuilt } from './buildGate'
import type {
  DocGateResult,
  CustomerRecord,
  ShipmentStatus,
  LoadCarrierRecord,
  LoadWorkflowStatus,
  ShipmentDocumentAudience,
  ShipmentDocumentRecord,
  TmsSettings,
} from '../../../src/types/tms'
import type { Stop } from '../../../src/types'
import { stopsList } from '../../../src/lib/stopPlace'

/**
 * What this module needs from the router: the shipment store it already built,
 * the S3 and audit plumbing it already holds, and the three tables outside the
 * bundle that the document rules read.
 */
export interface DocumentDeps {
  store: ShipmentStoreDeps
  s3: S3Client
  bucket: string
  customerTable: string
  settingsTable: string
  driverSubmissionTable: string
  driverSubmissionDocTable: string
  writeAudit: (
    entityType: string,
    entityId: string,
    action: string,
    caller: Caller,
    changes: Row,
  ) => Promise<void>
}

const SETTINGS_ID = 'default'
/**
 * The exceptions queue, for the release gate's open-incident count. Read straight
 * from the environment rather than through `DocumentDeps`: the router already
 * holds this grant, and the gate is not something a caller may decline to supply.
 */
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''
/**
 * Step R. The lane fact table, for one fact only: when the POD actually arrived.
 * The POD-collection-timing card on the Brokerage dashboard is the median and 90th
 * percentile of delivery → this stamp, by carrier, and nothing else on the shipment
 * records it. Read from the environment for the same reason as the line above.
 */
const LANE_RATE_SAMPLE_TABLE_NAME = process.env.LANE_RATE_SAMPLE_TABLE_NAME ?? ''
/** Long enough for a browser to PUT a 25 MB scan, short enough that a leaked URL dies. */
const UPLOAD_EXPIRY_SECONDS = 300
const AUDIENCES = ['CUSTOMER', 'CARRIER', 'ALL', 'INTERNAL'] as const satisfies readonly ShipmentDocumentAudience[]
const REVIEW_DECISIONS = ['ACCEPT', 'REJECT'] as const
/** A file name is a label, and a review note is a sentence for the next person. */
const MAX_DOCUMENT_NAME = 200
const MAX_NOTE = 500
/** The two statuses at or past delivery; INVOICING is DELIVERED plus a bill in review. */
const RATEABLE_LOAD_STATUSES: readonly LoadWorkflowStatus[] = ['DELIVERED', 'INVOICING']

/**
 * Stamp the load's lane sample with the moment its POD landed.
 *
 * Conditional on the sample existing and on the field still being empty: the first
 * POD is the one the timing is measured from, and a load that has not delivered yet
 * has no sample to stamp — both are the ordinary case, not a failure. Never fails
 * the document action; a statistics row is not a reason to refuse somebody's POD.
 */
async function stampPodReceived(deps: DocumentDeps, doc: Row): Promise<void> {
  if (!LANE_RATE_SAMPLE_TABLE_NAME) return
  if (doc.type !== 'POD' || doc.status !== 'ACTIVE') return
  // A portal upload nobody has looked at yet is not a POD we have; the release gate
  // does not count it either.
  if (doc.reviewStatus === 'PENDING' || doc.reviewStatus === 'REJECTED') return
  const loadId = optionalString(doc.loadId, 100)
  if (!loadId) return
  const at = optionalString(doc.uploadedAt, 64) ?? optionalString(doc.createdAt, 64) ?? nowIso()
  try {
    await deps.store.db.send(new UpdateItemCommand({
      TableName: LANE_RATE_SAMPLE_TABLE_NAME,
      Key: marshall({ id: `lrs:${loadId}` }),
      UpdateExpression: 'SET podReceivedAt = :at, updatedAt = :now',
      ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(podReceivedAt)',
      ExpressionAttributeValues: { ':at': { S: at }, ':now': { S: nowIso() } },
    }))
  } catch (err) {
    console.warn('[tms-shipment-actions] POD sample stamp skipped:', String(err))
  }
}

// ── Input ────────────────────────────────────────────────────────────────────

function assertDocumentName(value: unknown): string {
  const name = assertString(value, 'name')
  if (name.length > MAX_DOCUMENT_NAME) throw new Error(`name exceeds maximum length of ${MAX_DOCUMENT_NAME}`)
  return name
}

/** `image/jpg` is what several phones send; it is the same bytes as `image/jpeg`. */
function assertDocumentContentType(value: unknown): string {
  const raw = assertString(value, 'contentType').toLowerCase()
  const normalized = raw === 'image/jpg' ? 'image/jpeg' : raw
  if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`contentType must be one of ${ACCEPTED_CONTENT_TYPES.join(', ')}`)
  }
  return normalized
}

function assertDocumentSize(value: unknown): number {
  const size = optionalInteger(value, { min: 1, max: MAX_DOCUMENT_BYTES, label: 'sizeBytes' })
  if (size == null) throw new Error('sizeBytes is required')
  return size
}

/** `null` clears the field; an absent key leaves it alone, so the two are distinct. */
function patchField(input: Row, key: string, maxLen: number): string | null | undefined {
  if (!(key in input)) return undefined
  return optionalString(input[key], maxLen)
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function getDocument(deps: DocumentDeps, documentId: string): Promise<Row> {
  const doc = await getById(deps.store.db, deps.store.tables.shipmentDocument, documentId)
  if (!doc) throw new Error(`Document not found: ${documentId}`)
  return doc
}

async function getSettings(deps: DocumentDeps): Promise<Row | null> {
  if (!deps.settingsTable) return null
  return getById(deps.store.db, deps.settingsTable, SETTINGS_ID)
}

async function liveBundle(deps: DocumentDeps, shipmentId: string): Promise<Bundle> {
  const bundle = await readBundle(deps.store, shipmentId)
  if (isVoided(bundle.shipment)) {
    throw new Error(`Shipment ${String(bundle.shipment.number ?? shipmentId)} is voided`)
  }
  return bundle
}

/** The shipment every document action ends on, with the row it just wrote. */
async function documentResult(deps: DocumentDeps, shipmentId: string, document: Row): Promise<Row> {
  const bundle = await readBundle(deps.store, shipmentId)
  return { bundle, document }
}

// ── The required-document gate ───────────────────────────────────────────────

type GateCarrier = Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'>

export function customerDocGate(args: {
  bundle: Bundle
  documents: Row[]
  order: Row
  customer: Row | null
  settings: Row | null
}): DocGateResult {
  const orderId = String(args.order.id)
  // Which loads count towards this order is one rule, shared with the Documents tab
  // so the strip, the cached gate and READY_TO_INVOICE can never reach different
  // answers about what an order is still waiting on.
  const loadIds = gateLoadIds(
    args.bundle.loads as unknown as { id: string; orderId?: string | null }[],
    args.bundle.orders as unknown as { id: string }[],
    orderId,
  )
  return evaluateDocGate({
    order: { id: orderId },
    loadIds,
    loadCarriers: args.bundle.loadCarriers as unknown as GateCarrier[],
    documents: args.documents as unknown as ShipmentDocumentRecord[],
    customer: args.customer as Pick<CustomerRecord, 'requiredDocsForInvoice'> | null,
    settings: args.settings as Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes'> | null,
    scope: 'CUSTOMER',
    legacyImported: args.bundle.shipment?.legacyImported === true,
    carShipper: isCarShipperLoad(args.bundle.shipment as { revDivision?: string | null } | null),
    // What this order's loads ask for on top of the customer's list (SET_LOAD_REQUIRED_DOCS).
    extraDocTypes: loadExtraDocTypes(
      (args.bundle.loads as Row[]).filter((load) => loadIds.includes(String(load.id))) as { requiredDocTypes?: string[] | null }[],
    ),
  })
}

/**
 * Every write that keeps the cached gate honest: one Order update per order and
 * one LoadCarrier update per live assignment, derived from the document list the
 * caller is about to commit. Returned rather than sent, so the row that changed
 * and the caches that describe it move in a single transaction or not at all.
 */
export async function recacheDocGates(
  deps: DocumentDeps,
  bundle: Bundle,
  documents: Row[],
  now: string,
): Promise<TransactWriteItem[]> {
  const settings = await getSettings(deps)
  const customerIds = [...new Set(bundle.orders.map((o) => String(o.customerId ?? '')).filter(Boolean))]
  const customers: Record<string, Row> = {}
  for (const id of customerIds) {
    const customer = deps.customerTable ? await getById(deps.store.db, deps.customerTable, id) : null
    if (customer) customers[id] = customer
  }

  const writes: TransactWriteItem[] = []
  for (const order of bundle.orders) {
    const gate = customerDocGate({
      bundle,
      documents,
      order,
      customer: customers[String(order.customerId ?? '')] ?? null,
      settings,
    })
    // The cache is not an edit: `updatedAt` and `version` stay put so a dispatcher
    // holding the order form does not lose their compare-and-swap to an upload.
    writes.push(
      updateItemTx(
        deps.store.tables.order,
        String(order.id),
        { docsRequired: gate.required, docsMissing: gate.missing, docsPresent: gate.present, docsCheckedAt: now },
        null,
      ),
    )
  }

  for (const carrier of bundle.loadCarriers) {
    if (carrier.status !== 'ACTIVE') continue
    const gate = evaluateDocGate({
      loadCarriers: bundle.loadCarriers as unknown as GateCarrier[],
      documents: documents as unknown as ShipmentDocumentRecord[],
      settings: settings as Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes'> | null,
      loadCarrierId: String(carrier.id),
      scope: 'CARRIER',
      legacyImported: bundle.shipment?.legacyImported === true,
    })
    writes.push(
      updateItemTx(deps.store.tables.loadCarrier, String(carrier.id), { docsMissing: gate.missing }, null),
    )
  }
  return writes
}

/** The document list as it will be once `row` lands, for the gate to read. */
function withDocument(documents: Row[], row: Row): Row[] {
  return [...documents.filter((doc) => doc.id !== row.id), row]
}

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * A document may only be filed against this shipment's own order, load,
 * assignment and stop. Anything else would put a customer's paperwork on a
 * shipment they cannot see.
 */
function assertPlacement(
  bundle: Bundle,
  placement: { orderId?: string | null; loadId?: string | null; loadCarrierId?: string | null; stopId?: string | null },
): void {
  if (placement.orderId && !bundle.orders.some((o) => o.id === placement.orderId)) {
    throw new Error(`Order ${placement.orderId} is not on this shipment`)
  }
  if (placement.loadId && !bundle.loads.some((l) => l.id === placement.loadId)) {
    throw new Error(`Load ${placement.loadId} is not on this shipment`)
  }
  if (placement.loadCarrierId && !bundle.loadCarriers.some((c) => c.id === placement.loadCarrierId)) {
    throw new Error(`Assignment ${placement.loadCarrierId} is not on this shipment`)
  }
  if (placement.stopId) {
    const found = bundle.loads.some((load) => readStops(load).some((stop) => stop.id === placement.stopId))
    if (!found) throw new Error(`Stop ${placement.stopId} is not on this shipment`)
  }
}

// ── PREPARE_DOCUMENT_UPLOAD ──────────────────────────────────────────────────

/**
 * Mint the id and the key, and hand back a PUT the browser can use once. The
 * signature pins the content type and the exact length, so the URL cannot be
 * reused to drop anything else in the bucket — and COMMIT_DOCUMENT verifies the
 * same two values against the object that actually landed.
 */
export async function prepareDocumentUpload(deps: DocumentDeps, input: Row): Promise<Row> {
  if (!deps.bucket) throw new Error('Document storage is not configured')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await getById(deps.store.db, deps.store.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (isVoided(shipment)) throw new Error(`Shipment ${String(shipment.number ?? shipmentId)} is voided`)

  assertEnum(input.type, SHIPMENT_DOCUMENT_TYPES, 'type')
  const name = assertDocumentName(input.name)
  const contentType = assertDocumentContentType(input.contentType)
  const sizeBytes = assertDocumentSize(input.sizeBytes)

  const documentId = `sdoc-${randomUUID()}`
  const s3Key = documentKey(shipmentId, documentId, name, contentType)
  // `content-type` sits in the presigner's unsignableHeaders by default, so naming
  // it in signableHeaders is what actually binds it and makes the promise above
  // true; the name has to be lowercase because that is the canonical form the
  // signer compares against, and the browser's `putPresignedFile` sends the
  // matching `Content-Type` header.
  const uploadUrl = await getSignedUrl(
    deps.s3,
    new PutObjectCommand({ Bucket: deps.bucket, Key: s3Key, ContentType: contentType, ContentLength: sizeBytes }),
    { expiresIn: UPLOAD_EXPIRY_SECONDS, signableHeaders: new Set(['content-type']) },
  )

  // Nothing is written and nothing is audited: COMMIT_DOCUMENT records the file.
  return { uploadUrl, s3Key, documentId }
}

// ── COMMIT_DOCUMENT ──────────────────────────────────────────────────────────

export async function commitDocument(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  if (!deps.bucket) throw new Error('Document storage is not configured')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const documentId = assertString(input.documentId, 'documentId')
  const s3Key = assertString(input.s3Key, 's3Key')
  const type = assertEnum(input.type, SHIPMENT_DOCUMENT_TYPES, 'type')
  const name = assertDocumentName(input.name)
  const contentType = assertDocumentContentType(input.contentType)
  const sizeBytes = assertDocumentSize(input.sizeBytes)
  const audience = optionalEnum(input.audience, AUDIENCES, 'audience') ?? DEFAULT_AUDIENCE[type]

  const prefix = documentPrefix(shipmentId)
  if (!s3Key.startsWith(prefix)) throw new Error('That file does not belong to this shipment')

  const bundle = await liveBundle(deps, shipmentId)
  // A client that retries the commit after a dropped response must not end up
  // with the same file listed twice.
  // A photo or screenshot is filed as the PDF made from it (below), so a retried commit finds it under that key.
  const podPdfKey = isPodImage(contentType) ? pdfKeyFor(s3Key) : null
  const already = bundle.documents.find((doc) => doc.s3Key === s3Key || (podPdfKey != null && doc.s3Key === podPdfKey))
  if (already) return { bundle, document: already }

  const orderId = optionalString(input.orderId, 100)
  const loadId = optionalString(input.loadId, 100)
  const loadCarrierId = optionalString(input.loadCarrierId, 100)
  const stopId = optionalString(input.stopId, 100)
  assertPlacement(bundle, { orderId, loadId, loadCarrierId, stopId })

  let head
  try {
    head = await deps.s3.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: s3Key }))
  } catch (err) {
    const errName = err && typeof err === 'object' && 'name' in err ? err.name : undefined
    if (errName === 'NotFound' || errName === 'NoSuchKey') {
      // `new Error(msg, { cause })` needs a newer lib than this function's tsconfig targets.
      const retryable = new Error('The upload has not landed in S3 yet — wait a moment and commit the document again.')
      ;(retryable as Error & { cause?: unknown }).cause = err
      throw retryable
    }
    throw err
  }
  if (head.ContentLength !== sizeBytes) {
    throw new Error(`Document size mismatch: expected ${sizeBytes} bytes, found ${head.ContentLength ?? 0}`)
  }
  if (head.ContentType !== contentType) {
    throw new Error(`Document content type mismatch: expected ${contentType}, found ${head.ContentType ?? 'none'}`)
  }

  // Every document is kept as a PDF: a JPEG or PNG is wrapped on a letter page. The original object stays in S3; a failed
  // conversion files the original as it came.
  const converted = await convertStoredPodImage(deps.s3, deps.bucket, { key: s3Key, contentType, name })

  const now = nowIso()
  const row: Row = {
    id: documentId,
    __typename: 'ShipmentDocument',
    shipmentId,
    orderId,
    loadId,
    loadCarrierId,
    stopId,
    type,
    name: converted?.name ?? name,
    s3Key: converted?.key ?? s3Key,
    contentType: converted?.contentType ?? contentType,
    sizeBytes: converted?.sizeBytes ?? sizeBytes,
    source: 'UPLOAD',
    audience,
    status: 'ACTIVE',
    version: nextVersion(bundle.documents as unknown as ShipmentDocumentRecord[], type, loadId),
    uploadedBy: caller.email,
    uploadedAt: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  await transact(
    deps.store.db,
    [
      putItem(deps.store.tables.shipmentDocument, row),
      ...(await recacheDocGates(deps, bundle, withDocument(bundle.documents, row), now)),
    ],
    'document',
  )
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'COMMIT_DOCUMENT', caller, {
    shipmentId, type, name, s3Key, orderId, loadId, loadCarrierId,
  })
  // Step R. A POD is the one document the dashboard times; stamp the lane sample.
  await stampPodReceived(deps, row)
  return documentResult(deps, shipmentId, row)
}

// ── SAVE_GENERATED_DOCUMENT ──────────────────────────────────────────────────

/**
 * A BOL, load summary or rate confirmation the browser rendered. Each save is a
 * new version: the previous ACTIVE one of that type on that load becomes
 * SUPERSEDED and the new row points back at it, so what was sent last month is
 * still readable next to what is current.
 */
export async function saveGeneratedDocument(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  if (!deps.bucket) throw new Error('Document storage is not configured')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const type = assertEnum(input.type, GENERATED_DOCUMENT_TYPES, 'type')
  const pdfBase64 = assertString(input.pdfBase64, 'pdfBase64')
  const loadId = optionalString(input.loadId, 100)
  const loadCarrierId = optionalString(input.loadCarrierId, 100)
  const stopId = optionalString(input.stopId, 100)
  const rated = input.rated === true
  const referenceSuffix = optionalString(input.referenceSuffix, 20)
  if (referenceSuffix && !/^[A-Za-z0-9-]{1,20}$/.test(referenceSuffix)) {
    throw new Error('referenceSuffix may hold only letters, digits and dashes')
  }
  if (type !== 'BOL' && (stopId || rated)) {
    throw new Error('Only a bill of lading can be scoped to a stop or marked rated')
  }

  const bundle = await liveBundle(deps, shipmentId)
  const status = String(bundle.shipment.status ?? 'DRAFT')
  // A bill of lading may exist on the DRAFT shipment right after Create; the other paperwork may not.
  if (status === 'CANCELED' || (status === 'DRAFT' && type !== 'BOL')) {
    throw new Error('A draft or canceled shipment has no paperwork to generate')
  }
  assertPlacement(bundle, { loadId, loadCarrierId, stopId })
  if (stopId && loadId) {
    const own = bundle.loads.find((l) => l.id === loadId)
    if (!own || !readStops(own).some((stop) => stop.id === stopId)) {
      throw new Error(`Stop ${stopId} is not on load ${loadId}`)
    }
  }

  const assignment = loadCarrierId
    ? bundle.loadCarriers.find((c) => c.id === loadCarrierId) ?? null
    : bundle.loadCarriers.find((c) => c.loadId === loadId && c.status === 'ACTIVE') ?? null
  if (type === 'RATE_CON' && (!assignment || assignment.status !== 'ACTIVE')) {
    throw new Error('A rate confirmation needs the carrier that is currently on the load')
  }

  const bytes = Buffer.from(pdfBase64, 'base64')
  if (bytes.length === 0) throw new Error('pdfBase64 is not a readable document')
  if (bytes.length > MAX_GENERATED_BYTES) throw new Error('That document is too large to save')

  const documents = bundle.documents as unknown as ShipmentDocumentRecord[]
  // A BOL is versioned per slot (stop / carrier / rated copy); every other type keeps (type, load).
  const slot = type === 'BOL' ? { stopId, loadCarrierId, rated } : undefined
  const version = nextVersion(documents, type, loadId, slot)
  const previous = supersede(documents, { type, loadId, ...slot })
  const load = loadId ? bundle.loads.find((l) => l.id === loadId) ?? null : null
  const baseReference = String(load?.loadNumber ?? bundle.shipment.number ?? shipmentId)
  const reference = referenceSuffix ? `${baseReference}-${referenceSuffix}` : baseReference

  const documentId = `sdoc-${randomUUID()}`
  const s3Key = generatedKey(shipmentId, documentId, type, reference, version)
  await deps.s3.send(
    new PutObjectCommand({ Bucket: deps.bucket, Key: s3Key, Body: bytes, ContentType: PDF_CONTENT_TYPE }),
  )

  const now = nowIso()
  const row: Row = {
    id: documentId,
    __typename: 'ShipmentDocument',
    shipmentId,
    orderId: null,
    loadId,
    loadCarrierId: assignment && type === 'RATE_CON' ? String(assignment.id) : loadCarrierId,
    stopId,
    type,
    name: optionalString(input.filename, MAX_DOCUMENT_NAME) ?? generatedFilename(type, reference, version),
    s3Key,
    contentType: PDF_CONTENT_TYPE,
    sizeBytes: bytes.length,
    source: 'GENERATED',
    audience: rated ? 'CUSTOMER' : DEFAULT_AUDIENCE[type],
    status: 'ACTIVE',
    version,
    supersedesId: previous ? previous.id : null,
    uploadedBy: caller.email,
    uploadedAt: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  const retired = bundle.documents.map((doc) =>
    previous && doc.id === previous.id ? { ...doc, status: 'SUPERSEDED' } : doc,
  )
  await transact(
    deps.store.db,
    [
      putItem(deps.store.tables.shipmentDocument, row),
      ...(previous
        ? [
            updateItemTx(
              deps.store.tables.shipmentDocument,
              previous.id,
              { status: 'SUPERSEDED', updatedAt: now },
              null,
            ),
          ]
        : []),
      ...(await recacheDocGates(deps, bundle, withDocument(retired, row), now)),
    ],
    'document',
  )
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'SAVE_GENERATED_DOCUMENT', caller, {
    shipmentId, type, loadId, version, s3Key, supersedesId: row.supersedesId, stopId, loadCarrierId, rated,
  })
  return documentResult(deps, shipmentId, row)
}

// ── ATTACH_DRIVER_DOC ────────────────────────────────────────────────────────

/**
 * List a driver-app document on the shipment. The bytes are not copied: the row
 * points at the driver store's key, and its deterministic id means a second
 * press, a retry or the backfill can never list the same file twice.
 */
/**
 * ATTACH_INVOICE_DOC — the invoice the accounting post just generated shows up on its shipment as a document (type INVOICE,
 * customer audience). Called by tms-finance-actions after it stores the PDF; the bytes already sit under invoices/*, so this only
 * writes the pointer row (id `inv:<invoiceId>`): a re-render points the same row at the new file as the next version, and voiding the
 * invoice marks the row VOID. Idempotent.
 */
export async function attachInvoiceDoc(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const orderId = optionalString(input.orderId, 100)
  const documentId = `inv:${invoiceId}`
  const bundle = await readBundle(deps.store, shipmentId)
  const existing = bundle.documents.find((doc) => doc.id === documentId) as unknown as Row | undefined
  const now = nowIso()

  if (input.void === true) {
    if (!existing || existing.status === 'VOID') return { document: existing ?? null }
    const voided: Row = { ...existing, status: 'VOID', voidedAt: now, voidedBy: caller.email, voidReason: 'Invoice voided', updatedAt: now }
    await transact(deps.store.db, [putItem(deps.store.tables.shipmentDocument, voided, false)], 'invoice document void')
    return { document: voided }
  }

  const s3Key = assertString(input.s3Key, 's3Key')
  if (!s3Key.startsWith('invoices/')) throw new Error('An invoice document must point at the invoices/ folder')
  const number = optionalString(input.number, 60) ?? invoiceId
  const row: Row = {
    id: documentId,
    __typename: 'ShipmentDocument',
    shipmentId,
    ...(orderId ? { orderId } : {}),
    type: 'INVOICE',
    name: `Invoice ${number}.pdf`.slice(0, MAX_DOCUMENT_NAME),
    s3Key,
    contentType: PDF_CONTENT_TYPE,
    sizeBytes: numberOrNull(input.sizeBytes) ?? 0,
    source: 'GENERATED',
    sourceRef: invoiceId,
    audience: 'CUSTOMER',
    status: 'ACTIVE',
    version: existing ? (numberOrNull(existing.version) ?? 1) + 1 : 1,
    uploadedBy: caller.email,
    uploadedAt: now,
    createdBy: existing ? String(existing.createdBy ?? caller.email) : caller.email,
    createdAt: existing ? String(existing.createdAt ?? now) : now,
    updatedAt: now,
  }
  await transact(deps.store.db, [putItem(deps.store.tables.shipmentDocument, row, false)], 'invoice document')
  return { document: row }
}

export async function attachDriverDoc(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const loadId = assertString(input.loadId, 'loadId')
  const submissionDocId = assertString(input.submissionDocId, 'submissionDocId')
  const type = assertEnum(input.type, DRIVER_ATTACHABLE_TYPES, 'type')

  const bundle = await liveBundle(deps, shipmentId)
  assertPlacement(bundle, { loadId })

  const documentId = driverDocumentId(submissionDocId)
  const already = bundle.documents.find((doc) => doc.id === documentId)
  if (already) return { bundle, document: already }

  if (!deps.driverSubmissionDocTable || !deps.driverSubmissionTable) {
    throw new Error('The driver document store is not configured')
  }
  const submissionDoc = await getById(deps.store.db, deps.driverSubmissionDocTable, submissionDocId)
  if (!submissionDoc) throw new Error(`Driver document not found: ${submissionDocId}`)
  const submissionId = assertString(submissionDoc.submissionId, 'submissionId')
  const submission = await getById(deps.store.db, deps.driverSubmissionTable, submissionId)
  if (!submission) throw new Error(`Driver submission not found: ${submissionId}`)
  if (String(submission.loadId ?? '') !== loadId) {
    throw new Error('That driver submission was filed against a different load')
  }
  if (type === 'POD' && submission.podReviewStatus === 'NEEDS_REPLACEMENT') {
    throw new Error('That POD was sent back to the driver for a replacement; it cannot be filed')
  }

  // The merged PDF is the version everything downstream uses; the enhanced page is
  // the next best, and the original is what certainly exists.
  const combined = optionalString(submission.combinedPodKey, 1024)
  const s3Key = combined ?? optionalString(submissionDoc.enhancedKey, 1024) ?? assertString(submissionDoc.s3Key, 's3Key')
  // Every page of a merged submission resolves to the same combined PDF, so the
  // second page must hand back the row the first one filed rather than list the one
  // file again — which is also how the backfill files a merged POD.
  const sameFile = bundle.documents.find((doc) => doc.status === 'ACTIVE' && doc.s3Key === s3Key)
  if (sameFile) return { bundle, document: sameFile }
  const now = nowIso()
  const row: Row = {
    id: documentId,
    __typename: 'ShipmentDocument',
    shipmentId,
    loadId,
    type,
    name: optionalString(submissionDoc.fileName, MAX_DOCUMENT_NAME) ?? `${type.toLowerCase()}-${submissionDocId}`,
    s3Key,
    contentType: combined ? PDF_CONTENT_TYPE : optionalString(submissionDoc.contentType, 120) ?? PDF_CONTENT_TYPE,
    // The merged PDF's length is not recorded on the submission, and a pointer row
    // is never re-uploaded, so there is nothing honest to put here but zero.
    sizeBytes: combined ? 0 : numberOrNull(submissionDoc.byteSize) ?? 0,
    source: 'DRIVER_APP',
    sourceRef: submissionId,
    audience: 'ALL',
    status: 'ACTIVE',
    version: nextVersion(bundle.documents as unknown as ShipmentDocumentRecord[], type, loadId),
    // A POD our own review approved is accepted by construction; leaving reviewStatus
    // unset keeps it out of the sparse review queue. A page filed automatically from the driver app
    // (`pending`) waits for a reviewer instead: it shows in Documents but does not count until accepted.
    ...(input.pending === true ? { reviewStatus: 'PENDING' } : {}),
    uploadedBy: `driver:${String(submissionDoc.driverId ?? '')}`,
    uploadedAt: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await transact(
      deps.store.db,
      [
        putItem(deps.store.tables.shipmentDocument, row),
        ...(await recacheDocGates(deps, bundle, withDocument(bundle.documents, row), now)),
      ],
      'document',
    )
  } catch (err) {
    // Two people pressing Attach at once is not a failure: whoever lost reads the
    // row the winner wrote.
    if (!isConflict(err)) throw err
    const raced = await getById(deps.store.db, deps.store.tables.shipmentDocument, documentId)
    if (!raced) throw err
    return documentResult(deps, shipmentId, raced)
  }
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'ATTACH_DRIVER_DOC', caller, {
    shipmentId, loadId, submissionDocId, submissionId, type, s3Key,
  })
  if (input.pending !== true) await stampPodReceived(deps, row)
  return documentResult(deps, shipmentId, row)
}

// ── REVIEW_DOCUMENT ──────────────────────────────────────────────────────────

/**
 * Accept or refuse something a carrier sent through the upload link. Only an
 * accepted row satisfies a requirement, so this is the moment a portal upload
 * starts counting — and accepting may correct the type, because a carrier
 * labelling their invoice "POD" is the common case.
 */
export async function reviewDocument(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const documentId = assertString(input.documentId, 'documentId')
  const decision = assertEnum(input.decision, REVIEW_DECISIONS, 'decision')
  const note = optionalString(input.note, MAX_NOTE)
  const audience = optionalEnum(input.audience, AUDIENCES, 'audience')
  const retype = optionalEnum(input.type, CARRIER_UPLOADABLE_TYPES, 'type')

  const doc = await getDocument(deps, documentId)
  // Accepting a row that is no longer on the shipment would recache every gate
  // against paperwork nobody can see.
  if (doc.status !== 'ACTIVE') throw new Error('Only an active document can be accepted or refused')
  if (doc.reviewStatus !== 'PENDING') {
    throw new Error('Only a document waiting for review can be accepted or refused')
  }
  if (decision === 'REJECT' && retype) throw new Error('A refused document is not retyped')

  const shipmentId = String(doc.shipmentId)
  const bundle = await liveBundle(deps, shipmentId)
  const now = nowIso()
  const patch: Row = {
    reviewStatus: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
    reviewedAt: now,
    reviewedBy: caller.email,
    reviewNote: note,
    updatedAt: now,
  }
  if (decision === 'ACCEPT' && retype) patch.type = retype
  if (audience) patch.audience = audience
  const next = { ...doc, ...patch }

  await transact(
    deps.store.db,
    [
      updateItemTx(deps.store.tables.shipmentDocument, documentId, patch, null),
      ...(await recacheDocGates(deps, bundle, withDocument(bundle.documents, next), now)),
    ],
    'document',
  )
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'REVIEW_DOCUMENT', caller, {
    shipmentId, decision, type: patch.type ?? doc.type, note,
  })
  // An accepted POD is the moment the paperwork is ours, so the timing starts here
  // for anything that arrived through the carrier portal and waited for review.
  await stampPodReceived(deps, next)
  return documentResult(deps, shipmentId, next)
}

// ── SET_LOAD_REQUIRED_DOCS ───────────────────────────────────────────────────

/**
 * Set the documents one load needs on top of the customer's list (POD and, with an outside
 * carrier, the rate confirmation are defaults and are not stored here). The load's extras and
 * the cached order gate move in one transaction, so the board's Docs column and Load review
 * show the new requirement straight away. An empty list clears the extras.
 */
export async function setLoadRequiredDocs(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const loadId = assertString(input.loadId, 'loadId')
  const requiredDocTypes = validateLoadRequiredDocTypes(input.requiredDocTypes)

  const bundle = await liveBundle(deps, shipmentId)
  const load = bundle.loads.find((l) => String(l.id) === loadId)
  if (!load) throw new Error('That load is not on this shipment')
  const before = LOAD_EXTRA_DOC_TYPES.filter((t) => ((load.requiredDocTypes as string[] | null | undefined) ?? []).includes(t))
  if (before.length === requiredDocTypes.length && before.every((t, i) => t === requiredDocTypes[i])) {
    return { bundle, unchanged: true }
  }

  const now = nowIso()
  const nextBundle: Bundle = {
    ...bundle,
    loads: bundle.loads.map((l) => (String(l.id) === loadId ? { ...l, requiredDocTypes } : l)),
  }
  await transact(
    deps.store.db,
    [
      updateItemTx(
        deps.store.tables.load,
        loadId,
        { requiredDocTypes: requiredDocTypes.length > 0 ? requiredDocTypes : null, updatedAt: now, updatedBy: caller.email },
        null,
      ),
      ...(await recacheDocGates(deps, nextBundle, bundle.documents, now)),
    ],
    'load',
  )
  await deps.writeAudit('LOAD', loadId, 'SET_LOAD_REQUIRED_DOCS', caller, {
    shipmentId, before, after: requiredDocTypes,
  })
  return { bundle: await readBundle(deps.store, shipmentId) }
}

// ── UPDATE_DOCUMENT ──────────────────────────────────────────────────────────

/**
 * Correct a filed document: its label, its type, who may receive it, and which
 * section it belongs in. A pointer row cannot be renamed or retyped — its bytes
 * and its name belong to the driver app — and a generated row may only change
 * audience, because its name and type describe what we rendered.
 */
export async function updateDocument(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const documentId = assertString(input.documentId, 'documentId')
  const doc = await getDocument(deps, documentId)
  if (doc.status !== 'ACTIVE') throw new Error('Only an active document can be edited')

  const name = patchField(input, 'name', MAX_DOCUMENT_NAME)
  const type = optionalEnum(input.type, SHIPMENT_DOCUMENT_TYPES, 'type')
  const audience = optionalEnum(input.audience, AUDIENCES, 'audience')
  const orderId = patchField(input, 'orderId', 100)
  const loadCarrierId = patchField(input, 'loadCarrierId', 100)

  if (isPointerDocument(doc as unknown as ShipmentDocumentRecord) && (name !== undefined || type)) {
    throw new Error('A driver-app or legacy document is renamed where it lives, not here')
  }
  if (doc.source === 'GENERATED' && (name !== undefined || type || orderId !== undefined || loadCarrierId !== undefined)) {
    throw new Error('A generated document may only change who it may be sent to')
  }
  if (name === null) throw new Error('name cannot be empty')

  const shipmentId = String(doc.shipmentId)
  const bundle = await liveBundle(deps, shipmentId)
  assertPlacement(bundle, { orderId, loadCarrierId })
  if (type && type !== doc.type) {
    const refusal = billedPaperworkRefusal(bundle, doc)
    if (refusal) throw new Error(refusal)
  }

  const now = nowIso()
  const patch: Row = { updatedBy: caller.email, updatedAt: now }
  if (name !== undefined) patch.name = name
  if (type) patch.type = type
  if (audience) patch.audience = audience
  if (orderId !== undefined) patch.orderId = orderId
  if (loadCarrierId !== undefined) patch.loadCarrierId = loadCarrierId
  const next = { ...doc, ...patch }

  // Audience alone changes nothing the gate counts, so it costs no extra writes.
  const sectionMoved = orderId !== undefined || loadCarrierId !== undefined
  const writes: TransactWriteItem[] = [updateItemTx(deps.store.tables.shipmentDocument, documentId, patch, null)]
  if (sectionMoved || type) {
    writes.push(...(await recacheDocGates(deps, bundle, withDocument(bundle.documents, next), now)))
  }
  await transact(deps.store.db, writes, 'document')
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'UPDATE_DOCUMENT', caller, {
    shipmentId, name: patch.name, type: patch.type, fromType: type && type !== doc.type ? doc.type : undefined,
    audience: patch.audience, orderId, loadCarrierId,
  })
  // A file retyped into a POD is the POD from now on: the lane timing sample counts it like an upload.
  if (type === 'POD' && doc.type !== 'POD') await stampPodReceived(deps, next)
  return documentResult(deps, shipmentId, next)
}

// ── VOID_DOCUMENT ────────────────────────────────────────────────────────────

/** The paperwork an invoice is billed and factored on. */
const BILLED_ON_TYPES = new Set(['POD', 'RATE_CON'])

/**
 * Once an order is invoiced, its POD and rate confirmation have gone out with the invoice
 * (to the customer, or to OTR with the factoring submission). Taking one off the shipment, or
 * retyping it into something else, would leave BCAT showing a load billed on paperwork it no
 * longer has. A replacement upload is still allowed; it supersedes nothing that went out.
 */
export function billedPaperworkRefusal(bundle: Pick<Bundle, 'orders'>, doc: Row): string | null {
  if (!BILLED_ON_TYPES.has(String(doc.type))) return null
  const invoiced = bundle.orders.some((o) => o.invoiceId || o.arStatus === 'UNPAID' || o.arStatus === 'PAID')
  if (!invoiced) return null
  return 'This load is already invoiced, and this document went out with the invoice. Upload a corrected copy instead of removing or retyping it.'
}

/**
 * Take a document off the shipment. The row survives as VOID and the S3 object is
 * kept: the bucket grants no delete, and a file somebody emailed out last week
 * should still be findable after it was filed by mistake.
 */
export async function voidDocument(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const documentId = assertString(input.documentId, 'documentId')
  const reason = assertString(input.reason, 'reason')
  if (reason.length > MAX_NOTE) throw new Error(`reason exceeds maximum length of ${MAX_NOTE}`)

  const doc = await getDocument(deps, documentId)
  if (doc.status === 'VOID') throw new Error('That document is already void')

  const settings = await getSettings(deps)
  const adminOnly = settings?.documentDeleteAdminOnly === true
  if (!caller.isAdmin && (adminOnly || caller.email !== doc.uploadedBy)) {
    throw new Error('Forbidden: VOID_DOCUMENT requires owner, ADMIN, or the person who filed the document')
  }

  const shipmentId = String(doc.shipmentId)
  const bundle = await liveBundle(deps, shipmentId)
  const refusal = billedPaperworkRefusal(bundle, doc)
  if (refusal) throw new Error(refusal)
  const now = nowIso()
  const patch: Row = {
    status: 'VOID',
    voidedAt: now,
    voidedBy: caller.email,
    voidReason: reason,
    updatedBy: caller.email,
    updatedAt: now,
  }
  // The review worklist is the sparse reviewStatus index and does not filter on
  // status, so a junk upload voided while still PENDING would sit in the queue and
  // in the sidebar badge forever unless voiding also closes its review.
  if (doc.reviewStatus === 'PENDING') patch.reviewStatus = 'REJECTED'
  const next = { ...doc, ...patch }

  await transact(
    deps.store.db,
    [
      updateItemTx(deps.store.tables.shipmentDocument, documentId, patch, null),
      ...(await recacheDocGates(deps, bundle, withDocument(bundle.documents, next), now)),
    ],
    'document',
  )
  await deps.writeAudit('SHIPMENT_DOCUMENT', documentId, 'VOID_DOCUMENT', caller, {
    shipmentId, type: doc.type, name: doc.name, s3Key: doc.s3Key, reason,
  })
  return documentResult(deps, shipmentId, next)
}

/** The refusal for a release that did not come through Load Review (single READY_TO_INVOICE, SET_AR_STATUS UNBILLED). */
export const LOAD_REVIEW_ONLY_MESSAGE = 'Release happens in Load Review: push this shipment to Load Review and release it there'

// ── READY_TO_INVOICE ─────────────────────────────────────────────────────────

/**
 * The release gate: move an order from DOCS_NEEDED to UNBILLED once the shipment
 * has actually delivered, the paperwork the customer bills on is in hand, the
 * references they pay against are filled, the cost of the move is recorded and
 * nothing is still open on it. `evaluateReleaseGate` is the whole rule, shared
 * with every finance path, and there is no override: an admin flag that admits a
 * missing POD is a gate that does not exist.
 *
 * The cached `docsRequired` / `docsMissing` are still written here, because the
 * board column and the Documents tab read them.
 */
export async function readyToInvoice(
  deps: DocumentDeps,
  input: Row,
  caller: Caller,
  options: { batch?: boolean } = {},
): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const order = await getById(deps.store.db, deps.store.tables.order, orderId)
  if (!order) throw new Error(`Order not found: ${orderId}`)
  // Step R cutover. Refused before anything else, and keyed on the customer link
  // alone — never on status. The backfill sets a shipment's status from its stop
  // clock, so an unresolved order can arrive already DELIVERED and would otherwise
  // sail through to AR, where the customer lookup dies on an id that was never
  // there. This is checked BEFORE the release gate and never instead of it.
  if (isCustomerUnresolved(order as unknown as CustomerResolvable)) {
    throw new Error(unresolvedCustomerMessage(order as unknown as CustomerResolvable, 'releasing it to accounting'))
  }
  const shipmentId = String(order.shipmentId)
  const bundle = await readBundle(deps.store, shipmentId)

  // Step P5. Nothing downstream accepts a shipment that is still Building — a
  // load missing its bill-to or its revenue division has no business reaching
  // accounting, and the Needs: list says exactly what is missing.
  assertBuilt(bundle.shipment)

  if (order.arStatus !== 'DOCS_NEEDED') {
    throw new Error(`That order is already ${String(order.arStatus ?? 'unset')}, not waiting on documents`)
  }

  const settings = await getSettings(deps)
  const customerId = String(order.customerId ?? '')
  const customer = customerId && deps.customerTable
    ? await getById(deps.store.db, deps.customerTable, customerId)
    : null

  const release = await computeReleaseGate(deps, order, bundle, customer, settings)
  const review = reviewPayload(input.review)
  if (review) {
    // Load Review adds three refusals the gate does not own. A gate failure and an
    // extras failure are one error so the reviewer sees everything at once.
    const extras = reviewExtras(bundle, order, customer, settings)
    if (!release.ok || extras.length > 0) throw loadReviewRefusal([...release.missing, ...extras])
  } else if (!release.ok) {
    throw releaseGateError(release.missing)
  }
  // Load Review is the single gate into billing. The gate above speaks first (a load
  // that is not ready hears exactly why), then a release with no Load Review marker
  // is refused. Exempt: imported Aljex history (`legacyImported`, set only by the
  // import engine), which has no review to go through. Already-released / invoiced
  // orders never get here (they stop at the arStatus check), and there is no
  // ADMIN bypass: an admin releases from Load Review like everybody else.
  if (!review && bundle.shipment.legacyImported !== true) throw new Error(LOAD_REVIEW_ONLY_MESSAGE)

  const gate = customerDocGate({ bundle, documents: bundle.documents, order, customer, settings })
  const now = nowIso()
  // The carrier's AP record is made by the move itself, before the order leaves review: if it cannot
  // be written, nothing is released and a second press picks up where this one stopped.
  const apRecords = bundle.shipment.legacyImported === true
    ? { created: [], skipped: [] }
    : await createCarrierApRecords(deps, bundle, settings, now, caller)
  const patch: Row = {
    arStatus: 'UNBILLED',
    arStatusChangedAt: now,
    readyToInvoiceAt: now,
    docsRequired: gate.required,
    docsMissing: gate.missing,
    docsPresent: gate.present,
    docsCheckedAt: now,
    updatedBy: caller.email,
    updatedAt: now,
    version: (numberOrNull(order.version) ?? 1) + 1,
  }

  await transact(
    deps.store.db,
    [updateItemTx(deps.store.tables.order, orderId, patch, expectedUpdatedAt)],
    'order',
  )
  if (review) {
    const verdict = evaluateLoadReview({
      row: {
        id: shipmentId,
        number: String(bundle.shipment.number ?? shipmentId),
        status: bundle.shipment.status as ShipmentStatus,
        orderRevenueCents: numberOrNull(order.revenueCents),
        costCents: bundle.financials.reduce((sum, row) => sum + (numberOrNull(row.costCents) ?? 0), 0),
        pendingDocReviewCount: bundle.documents.filter((doc) => doc.status !== 'VOID' && doc.reviewStatus === 'PENDING').length,
      },
      gate: release,
      extras: [],
      customerUnresolved: false,
    })
    const checks = { salesRep: true, revDivision: true, details: true, charges: true, documents: true }
    const audited = { source: review.source, checks, warnings: verdict.warnings, batch: options.batch === true }
    await deps.writeAudit('ORDER', orderId, 'READY_TO_INVOICE', caller, { missing: gate.missing, review: audited })
    await deps.writeAudit('SHIPMENT', shipmentId, 'LOAD_REVIEW_RELEASED', caller, {
      orderId, checks, warnings: verdict.warnings, batch: options.batch === true,
    })
  } else {
    await deps.writeAudit('ORDER', orderId, 'READY_TO_INVOICE', caller, { missing: gate.missing })
  }
  return { bundle: await readBundle(deps.store, shipmentId), gate, releaseGate: release, apRecords }
}

/** What moving a load to billing did about the carrier's AP record, for the toast and the audit. */
export interface CarrierApRecordsResult {
  created: { loadCarrierId: string; billId: string; carrierName: string; grossCents: number }[]
  skipped: { loadCarrierId: string; carrierName: string; kind: 'ALREADY_BILLED' | 'NOT_BILLABLE'; reasons: string[] }[]
}

/**
 * One pending CarrierBill per outside-carrier leg that has none yet (see `_shared/pendingCarrierBill`).
 * A leg that cannot be billed (no charge lines, carrier not in the directory) is reported, never refused:
 * the release gate already owns the refusals that should stop a release.
 */
async function createCarrierApRecords(
  deps: DocumentDeps,
  bundle: Bundle,
  settings: Row | null,
  now: string,
  caller: Caller,
): Promise<CarrierApRecordsResult> {
  const tables = {
    carrier: process.env.CARRIER_TABLE_NAME ?? '',
    carrierPaymentMethod: process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME ?? '',
    carrierBill: process.env.CARRIER_BILL_TABLE_NAME ?? '',
    loadCarrier: deps.store.tables.loadCarrier,
  }
  const result: CarrierApRecordsResult = { created: [], skipped: [] }
  const hasCarrierLeg = bundle.loadCarriers.some((lc) => lc.kind === 'CARRIER' && lc.status === 'ACTIVE')
  if (!hasCarrierLeg) return result
  if (!tables.carrierBill || !tables.carrier || !tables.carrierPaymentMethod) {
    throw new Error('The carrier AP record could not be created: AP tables are not configured on this function')
  }
  const { carriersById, methodsByCarrierId } = await readPendingBillContext(deps.store.db, tables, bundle.loadCarriers)
  const plan = planPendingCarrierBills({
    shipment: bundle.shipment,
    loads: bundle.loads,
    loadCarriers: bundle.loadCarriers,
    charges: bundle.charges,
    carriersById,
    methodsByCarrierId,
    settings,
    today: now.slice(0, 10),
    now,
    actorEmail: caller.email,
  })
  result.skipped.push(...plan.skipped)
  for (const item of plan.create) {
    try {
      const wrote = await writePendingBill(deps.store.db, tables, item, now, caller.email)
      if (wrote) {
        result.created.push({ loadCarrierId: item.loadCarrierId, billId: item.bill.id, carrierName: item.carrierName, grossCents: item.grossCents })
        await deps.writeAudit('CARRIER_BILL', item.bill.id, 'RECORD_BILL_PENDING', caller, {
          loadCarrierId: item.loadCarrierId, shipmentId: item.bill.shipmentId, carrierId: item.bill.carrierId,
          grossCents: item.bill.grossCents, netCents: item.bill.netCents, datesPending: item.bill.datesPending === true,
          ...(item.bill.datesPending === true ? {} : { billDate: item.bill.billDate, dueAt: item.bill.dueAt, termsDays: item.bill.termsDays }),
        })
      } else {
        result.skipped.push({ loadCarrierId: item.loadCarrierId, carrierName: item.carrierName, kind: 'ALREADY_BILLED', reasons: [] })
      }
    } catch (err) {
      const failure = new Error(
        `The AP record for ${item.carrierName} could not be created, so nothing was released: ${err instanceof Error ? err.message : String(err)}`,
      )
      ;(failure as Error & { cause?: unknown }).cause = err
      throw failure
    }
  }
  return result
}

// ── RECONCILE_BILLING ────────────────────────────────────────────────────────

const IDX_ORDERS_BY_AR_STATUS = 'ordersByArStatusAndArStatusChangedAt'
/** Released orders read per check; the page asks again after a fix. */
const MAX_RECONCILE_ORDERS = 400

export interface BillingGap extends ReconcileFinding {
  orderId: string
  shipmentId: string
  shipmentNumber: string | null
  customerName: string | null
  releasedAt: string | null
  arStatus: string | null
}

/** The AP half of one shipment's check: what the pending-bill plan would still create or cannot bill. */
async function apPlanFor(deps: DocumentDeps, bundle: Bundle, settings: Row | null) {
  const hasCarrierLeg = bundle.loadCarriers.some((lc) => lc.kind === 'CARRIER' && lc.status === 'ACTIVE')
  if (!hasCarrierLeg) return { create: [], unbillable: [] }
  const tables = {
    carrier: process.env.CARRIER_TABLE_NAME ?? '',
    carrierPaymentMethod: process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME ?? '',
    carrierBill: process.env.CARRIER_BILL_TABLE_NAME ?? '',
    loadCarrier: deps.store.tables.loadCarrier,
  }
  const { carriersById, methodsByCarrierId } = await readPendingBillContext(deps.store.db, tables, bundle.loadCarriers)
  const now = nowIso()
  const plan = planPendingCarrierBills({
    shipment: bundle.shipment, loads: bundle.loads, loadCarriers: bundle.loadCarriers, charges: bundle.charges,
    carriersById, methodsByCarrierId, settings, today: now.slice(0, 10), now, actorEmail: 'system:reconcile',
  })
  return {
    create: plan.create.filter((p) => p.grossCents > 0).map((p) => ({ loadCarrierId: p.loadCarrierId, carrierName: p.carrierName, grossCents: p.grossCents })),
    unbillable: plan.skipped.filter((s) => s.kind === 'NOT_BILLABLE').map((s) => ({ loadCarrierId: s.loadCarrierId, carrierName: s.carrierName, reasons: s.reasons })),
  }
}

async function gapFor(deps: DocumentDeps, order: Row, settings: Row | null): Promise<BillingGap | null> {
  const shipmentId = String(order.shipmentId ?? '')
  if (!shipmentId) return null
  const bundle = await readBundle(deps.store, shipmentId)
  if (bundle.shipment.legacyImported === true || isVoided(bundle.shipment)) return null
  const ap = await apPlanFor(deps, bundle, settings)
  const finding = reconcileReleasedOrder({
    order: {
      id: String(order.id),
      arStatus: order.arStatus == null ? null : String(order.arStatus),
      invoiceId: typeof order.invoiceId === 'string' ? order.invoiceId : null,
      readyToInvoiceAt: typeof order.readyToInvoiceAt === 'string' ? order.readyToInvoiceAt : null,
    },
    apToCreate: ap.create,
    apUnbillable: ap.unbillable,
  })
  if (!hasGap(finding)) return null
  return {
    ...finding,
    orderId: String(order.id),
    shipmentId,
    shipmentNumber: bundle.shipment.number == null ? null : String(bundle.shipment.number),
    customerName: typeof order.customerName === 'string' ? order.customerName : null,
    releasedAt: typeof order.readyToInvoiceAt === 'string' ? order.readyToInvoiceAt : null,
    arStatus: order.arStatus == null ? null : String(order.arStatus),
  }
}

/**
 * Read-only: every order released through Load Review that is missing from AR (released but
 * neither waiting to invoice nor invoiced) or from AP (an outside carrier with pay and no bill).
 * With `createMissingFor: orderId`, first creates that shipment's missing AP records with the
 * same idempotent writer the release uses, then answers for that order alone.
 */
export async function reconcileBilling(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const settings = await getSettings(deps)
  const createFor = optionalString(input.createMissingFor, 200)
  if (createFor) {
    const order = await getById(deps.store.db, deps.store.tables.order, createFor)
    if (!order) throw new Error(`Order not found: ${createFor}`)
    if (!isReleasedOrder(order as never)) throw new Error('That order has not been moved to billing from Load Review')
    const bundle = await readBundle(deps.store, String(order.shipmentId))
    if (bundle.shipment.legacyImported === true) throw new Error('Imported history has no AP record to create')
    const apRecords = await createCarrierApRecords(deps, bundle, settings, nowIso(), caller)
    await deps.writeAudit('ORDER', createFor, 'RECONCILE_CREATE_AP', caller, { created: apRecords.created, skipped: apRecords.skipped })
    const gap = await gapFor(deps, order, settings)
    return { apRecords, gaps: gap ? [gap] : [], checked: 1 }
  }

  const orders: Row[] = []
  for (const status of ['UNBILLED', 'UNPAID', 'PAID']) {
    const rows = await queryIndex(deps.store.db, deps.store.tables.order, IDX_ORDERS_BY_AR_STATUS, 'arStatus', status)
    orders.push(...rows.filter((o) => isReleasedOrder(o as never)))
  }
  orders.sort((a, b) => String(b.readyToInvoiceAt).localeCompare(String(a.readyToInvoiceAt)))
  const checked = orders.slice(0, MAX_RECONCILE_ORDERS)
  const gaps: BillingGap[] = []
  for (const order of checked) {
    const gap = await gapFor(deps, order, settings)
    if (gap) gaps.push(gap)
  }
  if (gaps.length > 0) {
    // A released load missing from AR or AP is money nobody will collect or pay: say so in the log too.
    console.warn('[reconcile-billing] released loads missing from AR/AP', JSON.stringify(gaps.map((g) => ({
      orderId: g.orderId, shipment: g.shipmentNumber, arMissing: g.arMissing, apMissing: g.apMissing.length, apUnbillable: g.apUnbillable.length,
    }))))
  }
  return { gaps, checked: checked.length, truncated: orders.length > checked.length }
}

/**
 * The one place the release gate's input is built, shared by the release itself and
 * by REVIEW_LOAD so the drawer's verdict and the server's refusal cannot drift.
 */
export async function computeReleaseGate(
  deps: DocumentDeps,
  order: Row,
  bundle: Bundle,
  customer: Row | null,
  settings: Row | null,
): Promise<ReleaseGateResult> {
  return evaluateReleaseGate(
    await loadReleaseGateInput(
      {
        db: deps.store.db,
        tables: {
          ...deps.store.tables,
          customer: deps.customerTable,
          settings: deps.settingsTable,
          loadCheckCall: LOAD_CHECK_CALL_TABLE_NAME,
        },
      },
      {
        shipmentId: String(bundle.shipment.id),
        orderId: String(order.id),
        shipment: bundle.shipment,
        order,
        orders: bundle.orders,
        loads: bundle.loads,
        loadCarriers: bundle.loadCarriers,
        documents: bundle.documents,
        customer,
        settings,
      },
    ),
  )
}

/** The customer's Load Review list, then the org default, then the built-in seven. */
function reviewRequirementsFor(customer: Row | null, settings: Row | null): ReviewRequirement[] {
  return resolveReviewRequirements(
    Array.isArray(customer?.reviewRequirements) ? (customer.reviewRequirements as string[]) : null,
    Array.isArray(settings?.reviewRequirements) ? (settings.reviewRequirements as string[]) : null,
  )
}

/** What the requirements are checked against, read from the rows this Lambda holds. */
function reviewFacts(bundle: Bundle, order: Row): ReviewFacts {
  const references = Array.isArray(order.references) ? (order.references as Row[]) : []
  const revenueCents = numberOrNull(order.revenueCents)
  const expenseCents = bundle.financials.reduce((sum, row) => sum + (numberOrNull(row.costCents) ?? 0), 0)
  const shipment = bundle.shipment
  return {
    revDivision: typeof shipment.revDivision === 'string' ? shipment.revDivision : null,
    salesRepId: typeof shipment.salesRepId === 'string' ? shipment.salesRepId : null,
    referenceNumber: references.map((ref) => (typeof ref?.value === 'string' ? ref.value : '')).find((value) => value.trim().length > 0) ?? null,
    podReceived: bundle.documents.some((doc) => doc.type === 'POD' && countsAsPresent(doc as unknown as ShipmentDocumentRecord)),
    revenueCents,
    expenseCents,
    profitCents: profitFromFacts(revenueCents, expenseCents),
  }
}

/** The review extras, typed from the raw rows. Imported history is exempt inside the lib. */
function reviewExtras(bundle: Bundle, order: Row, customer: Row | null, settings: Row | null, gateOwnsPod = true): LoadReviewReason[] {
  return [
    ...loadReviewExtras({
      shipment: { legacyImported: bundle.shipment.legacyImported === true },
      facts: reviewFacts(bundle, order),
      // The release gate already refuses on a missing POD (with its own sentence); a push has no gate.
      requirements: reviewRequirementsFor(customer, settings).filter((key) => !gateOwnsPod || key !== 'podReceived'),
    }),
    ...factorReviewReasons(bundle, order, customer),
  ]
}

/**
 * Ryne 2026-11-14: a factored load does not go into Load Review, nor out of it, until it carries what OTR needs from
 * booking (src/lib/factorReadyAtCreate). The push and the review release both read this list, so an automatic push after a
 * driver's status update simply does not happen yet; the status update itself is never refused. Imported history is exempt.
 */
function factorReviewReasons(bundle: Bundle, order: Row, customer: Row | null): LoadReviewReason[] {
  if (bundle.shipment.legacyImported === true) return []
  const orderId = String(order.id ?? '')
  const stops: Stop[] = []
  for (const load of bundle.loads) {
    if (load.voidedAt || load.deletedAt) continue
    if (load.orderId != null && orderId && String(load.orderId) !== orderId) continue
    for (const stop of stopsList<Stop>(load.stops)) stops.push(stop)
  }
  const gaps = factorGapsForLoad({
    customer: customer as unknown as FactorReadyInput['customer'],
    poNumber: factoringPoNumber(
      order.references as Parameters<typeof factoringPoNumber>[0],
      bundle.loads.find((l) => !l.voidedAt && !l.deletedAt && (l.orderId == null || !orderId || String(l.orderId) === orderId))?.tmsId as string | null | undefined,
    ),
    customerRateCents: numberOrNull(order.revenueCents),
    ...routeEnds(stops),
  })
  return gaps.map((gap) => ({
    code: `FACTOR_${gap.code}`,
    message: gap.message,
    check: 'details' as const,
    action: { kind: 'OPEN_TAB' as const, tab: gap.code.startsWith('PICKUP') || gap.code.startsWith('DELIVERY') ? 'stops' as const : 'overview' as const },
  }))
}

/** The sentence a push is refused with while the shipment has not fully delivered; null once it has. */
export function notDeliveredReason(bundle: Pick<Bundle, 'shipment' | 'loads'>): string | null {
  if (bundle.shipment.status === 'DELIVERED') return null
  const loads = bundle.loads.filter((load) => !load.voidedAt && !load.deletedAt)
  const delivered = loads.filter((load) => RATEABLE_LOAD_STATUSES.includes(load.status as LoadWorkflowStatus)).length
  const progress = loads.length > 1 ? ` — ${delivered} of ${loads.length} loads delivered` : ''
  return `Only delivered loads can go to Load review${progress}`
}

/**
 * PUSH_TO_LOAD_REVIEW's verdict for one shipment: the same requirement list and the same
 * extras REVIEW_LOAD and the review release read, plus the states that make a push
 * meaningless. `reasons` empty means the push may proceed.
 */
export async function pushToReviewVerdict(deps: DocumentDeps, shipmentId: string): Promise<{ shipment: Row; reasons: string[] }> {
  const bundle = await readBundle(deps.store, shipmentId)
  const shipment = bundle.shipment
  if (shipment.voidedAt || shipment.deletedAt) return { shipment, reasons: ['Voided shipment'] }
  if (shipment.status === 'CANCELED') return { shipment, reasons: ['Canceled shipment'] }
  const order = bundle.orders[0]
  if (!order) return { shipment, reasons: ['Shipment has no order to review'] }
  if (order.arStatus !== 'DOCS_NEEDED') return { shipment, reasons: [`Already released (${String(order.arStatus ?? 'unset')})`] }
  // Ryne 2026-11-12: only a delivered load goes to Load Review. The shipment status rolls up the least-advanced load, so DELIVERED
  // means every load (every stop) delivered. The status, never a timestamp: legacy and imported history can be DELIVERED with no stamps.
  const notDelivered = notDeliveredReason(bundle)
  if (notDelivered) return { shipment, reasons: [notDelivered] }
  const settings = await getSettings(deps)
  const customerId = String(order.customerId ?? '')
  const customer = customerId && deps.customerTable ? await getById(deps.store.db, deps.customerTable, customerId) : null
  const reasons: string[] = []
  if (isCustomerUnresolved(order as unknown as CustomerResolvable)) {
    reasons.push(unresolvedCustomerMessage(order as unknown as CustomerResolvable, 'pushing it to Load Review'))
  }
  reasons.push(...reviewExtras(bundle, order, customer, settings, false).map((item) => item.message))
  return { shipment, reasons }
}

/** Only the literal `{ source: 'LOAD_REVIEW' }` counts; anything else is an ordinary release. */
function reviewPayload(value: unknown): { source: 'LOAD_REVIEW' } | null {
  if (value == null || typeof value !== 'object') return null
  return (value as Row).source === 'LOAD_REVIEW' ? { source: 'LOAD_REVIEW' } : null
}

/**
 * REVIEW_LOAD — read-only. The same gate verdict READY_TO_INVOICE would reach plus
 * the three review extras, from rows this Lambda reads itself, so a reviewer who
 * holds no finance grant sees exactly what the release would refuse on. No writes,
 * no audit. An order that is already released still answers (with its `arStatus`).
 */
export async function reviewLoad(deps: DocumentDeps, input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const bundle = await readBundle(deps.store, shipmentId)
  const order = bundle.orders[0]
  if (!order) throw new Error('Shipment has no order to review')

  const settings = await getSettings(deps)
  const customerId = String(order.customerId ?? '')
  const customer = customerId && deps.customerTable
    ? await getById(deps.store.db, deps.customerTable, customerId)
    : null
  const releaseGate = await computeReleaseGate(deps, order, bundle, customer, settings)
  const extras = reviewExtras(bundle, order, customer, settings)
  return {
    shipmentId,
    orderId: String(order.id),
    orderUpdatedAt: order.updatedAt ?? null,
    arStatus: order.arStatus ?? null,
    releaseGate,
    extras,
    salesRepId: bundle.shipment.salesRepId ?? null,
    revDivision: bundle.shipment.revDivision ?? null,
    revSubdivision: bundle.shipment.revSubdivision ?? null,
    legacyImported: bundle.shipment.legacyImported === true,
    pendingDocReviewCount: bundle.documents.filter((doc) => doc.status !== 'VOID' && doc.reviewStatus === 'PENDING').length,
  }
}

// ── RATE_CARRIER ─────────────────────────────────────────────────────────────

/**
 * How the carrier actually did, recorded once the load is off the road. It lives
 * on the assignment rather than the directory row, because a carrier that was
 * excellent in March and late in June is two facts, not an average.
 */
export async function rateCarrier(deps: DocumentDeps, input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const stars = optionalInteger(input.stars, { min: 1, max: 5, label: 'stars' })
  if (stars == null) throw new Error('stars is required')
  const note = optionalString(input.note, MAX_NOTE)

  const carrier = await getById(deps.store.db, deps.store.tables.loadCarrier, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.kind !== 'CARRIER') throw new Error('Only a booked carrier is rated; an own-fleet assignment is not')

  const load = await getById(deps.store.db, deps.store.tables.load, String(carrier.loadId))
  if (!load) throw new Error(`Load not found: ${String(carrier.loadId)}`)
  if (!RATEABLE_LOAD_STATUSES.includes(String(load.status) as LoadWorkflowStatus)) {
    throw new Error('A carrier is rated once their load has delivered')
  }

  const now = nowIso()
  await transact(
    deps.store.db,
    [
      updateItemTx(
        deps.store.tables.loadCarrier,
        loadCarrierId,
        { ratingStars: stars, ratingNote: note, ratedAt: now, ratedBy: caller.email, updatedBy: caller.email, updatedAt: now },
        null,
      ),
    ],
    'carrier rating',
  )
  await deps.writeAudit('LOAD_CARRIER', loadCarrierId, 'RATE_CARRIER', caller, {
    loadId: carrier.loadId, stars, note,
  })
  return readBundle(deps.store, String(carrier.shipmentId)) as unknown as Row
}
