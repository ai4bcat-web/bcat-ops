/**
 * Shipment documents: the typed index of every file a shipment has, and the rules
 * that decide whether its paperwork is complete.
 *
 * A `ShipmentDocument` row is an index entry, not a second copy. Staff uploads,
 * carrier-portal uploads and generated PDFs put their bytes under
 * `shipment-docs/{shipmentId}/`; a driver-app POD or a legacy rate con becomes a
 * pointer row whose `s3Key` is the key the other store already uses. Nothing is
 * ever copied, and nothing is ever rewritten: regenerating a BOL mints v2 and
 * leaves v1 SUPERSEDED with its bytes intact.
 *
 * Three rules are worth stating once because every caller depends on them:
 *
 * 1. Only an ACTIVE row that is not awaiting or refused review satisfies a
 *    requirement. A carrier-portal upload lands PENDING and counts for nothing
 *    until a person accepts it, which is also what stops the public role from
 *    ever influencing a billing decision. The exception is a page our own driver
 *    filed from the driver app: it counts while it waits (isDriverDocAwaitingReview).
 * 2. A document attached to a BOUNCED or TONU assignment is paperwork about an
 *    attempt that did not happen. It never satisfies the customer's requirements.
 * 3. The rate confirmation is derived, not mirrored. It satisfies RATE_CON when
 *    the carrier actually signed it (`rateConStatus === 'SIGNED'`); merely having
 *    been sent is not paperwork.
 *
 * Imports are relative and type-only where they can be: the shipment, tracking and
 * notifier Lambdas bundle this file by path, so a `@/` alias would break the
 * function build.
 */
import { customerDocsNotRequired, customerFactorsForOtr, isAssetLoad, rateConRequired } from './reviewRequirements'
import { NEVER_BLOCKING_DOC_TYPES } from './releaseGate'
import type {
  CustomerRecord,
  DocGateResult,
  LoadCarrierRecord,
  OrderRecord,
  ShipmentDocumentAudience,
  ShipmentDocumentRecord,
  ShipmentDocumentSection,
  ShipmentDocumentType,
  TmsSettings,
} from '../types/tms'

export type {
  DocGateResult,
  ShipmentDocumentAudience,
  ShipmentDocumentRecord,
  ShipmentDocumentSection,
  ShipmentDocumentType,
} from '../types/tms'

export const SHIPMENT_DOCUMENT_TYPES = [
  'BOL',
  'POD',
  'RATE_CON',
  'CUSTOMER_RATE_CON',
  'LOAD_SUMMARY',
  'LUMPER_RECEIPT',
  'WEIGHT_TICKET',
  'TEMP_LOG',
  'INSPECTION_REPORT',
  'CUSTOMS',
  'PACKING_LIST',
  'CARRIER_INVOICE',
  'INVOICE',
  'PHOTO',
  'OTHER',
] as const satisfies readonly ShipmentDocumentType[]

export const DOCUMENT_TYPE_LABELS: Record<ShipmentDocumentType, string> = {
  BOL: 'Bill of lading',
  POD: 'Proof of delivery',
  RATE_CON: 'Rate confirmation',
  CUSTOMER_RATE_CON: 'Customer rate confirmation',
  LOAD_SUMMARY: 'Load summary',
  LUMPER_RECEIPT: 'Lumper receipt',
  WEIGHT_TICKET: 'Weight ticket',
  TEMP_LOG: 'Temperature log',
  INSPECTION_REPORT: 'Inspection report',
  CUSTOMS: 'Customs paperwork',
  PACKING_LIST: 'Packing list',
  CARRIER_INVOICE: 'Carrier invoice',
  INVOICE: 'Invoice',
  PHOTO: 'Photo',
  OTHER: 'Other',
}

/**
 * Who may receive each type outside the company by default. The carrier's invoice
 * and our load summary are internal: one is a bill we are checking, the other
 * carries both sides' money.
 */
export const DEFAULT_AUDIENCE: Record<ShipmentDocumentType, ShipmentDocumentAudience> = {
  BOL: 'ALL',
  POD: 'ALL',
  RATE_CON: 'CARRIER',
  CUSTOMER_RATE_CON: 'INTERNAL',
  LOAD_SUMMARY: 'INTERNAL',
  LUMPER_RECEIPT: 'ALL',
  WEIGHT_TICKET: 'ALL',
  TEMP_LOG: 'ALL',
  INSPECTION_REPORT: 'ALL',
  CUSTOMS: 'ALL',
  PACKING_LIST: 'ALL',
  CARRIER_INVOICE: 'INTERNAL',
  INVOICE: 'CUSTOMER',
  PHOTO: 'INTERNAL',
  OTHER: 'INTERNAL',
}

/** What a carrier may send us through the public upload link, and nothing else. */
export const CARRIER_UPLOADABLE_TYPES = [
  'POD',
  'CARRIER_INVOICE',
  'LUMPER_RECEIPT',
  'WEIGHT_TICKET',
  'OTHER',
] as const satisfies readonly ShipmentDocumentType[]

/** What staff may generate in the browser and save as a shipment document. */
export const GENERATED_DOCUMENT_TYPES = [
  'BOL',
  'LOAD_SUMMARY',
  'RATE_CON',
] as const satisfies readonly ShipmentDocumentType[]

/** What a driver-app document may be attached to a shipment as. */
export const DRIVER_ATTACHABLE_TYPES = ['POD', 'RATE_CON', 'PHOTO', 'OTHER'] as const satisfies readonly ShipmentDocumentType[]

export const PDF_CONTENT_TYPE = 'application/pdf'

export const ACCEPTED_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const

/** 25 MB for staff, 15 MB through the public link — a phone photo of a POD is ~5 MB. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
export const MAX_PORTAL_BYTES = 15 * 1024 * 1024
/** How many files one upload link may ever receive before dispatch has to be called. */
export const MAX_UPLOADS_PER_LINK = 20
/** Generated PDFs are text; the rate-con ceiling already in use is plenty. */
export const MAX_GENERATED_BYTES = 10 * 1024 * 1024

export const DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES = [
  'POD',
  'CARRIER_INVOICE',
] as const satisfies readonly ShipmentDocumentType[]

export const DEFAULT_UPLOAD_LINK_EXPIRY_DAYS = 30
export const MIN_UPLOAD_LINK_EXPIRY_DAYS = 1
export const MAX_UPLOAD_LINK_EXPIRY_DAYS = 180

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

export function isShipmentDocumentType(value: unknown): value is ShipmentDocumentType {
  return typeof value === 'string' && (SHIPMENT_DOCUMENT_TYPES as readonly string[]).includes(value)
}

/**
 * What people actually typed into the free-text required-docs fields before step E
 * gave them a vocabulary. Anything not recognised is kept verbatim and reported, so
 * a customer's instruction is never silently dropped — it simply cannot gate.
 */
const REQUIRED_DOC_ALIASES: Record<string, ShipmentDocumentType> = {
  POD: 'POD',
  'PROOF OF DELIVERY': 'POD',
  'SIGNED POD': 'POD',
  'DELIVERY RECEIPT': 'POD',
  BOL: 'BOL',
  'BILL OF LADING': 'BOL',
  'SIGNED BOL': 'BOL',
  'RATE CON': 'RATE_CON',
  RATECON: 'RATE_CON',
  RATE_CON: 'RATE_CON',
  'RATE CONFIRMATION': 'RATE_CON',
  'CUSTOMER RATE CONFIRMATION': 'CUSTOMER_RATE_CON',
  CUSTOMER_RATE_CON: 'CUSTOMER_RATE_CON',
  'LOAD SUMMARY': 'LOAD_SUMMARY',
  LOAD_SUMMARY: 'LOAD_SUMMARY',
  LUMPER: 'LUMPER_RECEIPT',
  'LUMPER RECEIPT': 'LUMPER_RECEIPT',
  LUMPER_RECEIPT: 'LUMPER_RECEIPT',
  'WEIGHT TICKET': 'WEIGHT_TICKET',
  WEIGHT_TICKET: 'WEIGHT_TICKET',
  SCALE: 'WEIGHT_TICKET',
  'SCALE TICKET': 'WEIGHT_TICKET',
  'TEMP LOG': 'TEMP_LOG',
  TEMP_LOG: 'TEMP_LOG',
  'TEMPERATURE LOG': 'TEMP_LOG',
  'REEFER DOWNLOAD': 'TEMP_LOG',
  'INSPECTION REPORT': 'INSPECTION_REPORT',
  INSPECTION_REPORT: 'INSPECTION_REPORT',
  CUSTOMS: 'CUSTOMS',
  'CUSTOMS PAPERWORK': 'CUSTOMS',
  'PACKING LIST': 'PACKING_LIST',
  PACKING_LIST: 'PACKING_LIST',
  'CARRIER INVOICE': 'CARRIER_INVOICE',
  CARRIER_INVOICE: 'CARRIER_INVOICE',
  INVOICE: 'INVOICE',
  PHOTO: 'PHOTO',
  PHOTOS: 'PHOTO',
  OTHER: 'OTHER',
}

export interface NormalizedRequiredDocs {
  types: ShipmentDocumentType[]
  unrecognised: string[]
}

/**
 * Turn whatever is stored in `requiredDocsForInvoice` / `defaultRequiredDocs` into
 * the typed vocabulary, preserving order and dropping duplicates.
 */
export function normalizeRequiredDocTypes(values: readonly (string | null | undefined)[] | null | undefined): NormalizedRequiredDocs {
  const types: ShipmentDocumentType[] = []
  const unrecognised: string[] = []
  for (const raw of values ?? []) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toUpperCase().replace(/[-\s]+/g, ' ').replace(/\s*\/\s*/g, '/')
    const mapped = REQUIRED_DOC_ALIASES[key] ?? REQUIRED_DOC_ALIASES[key.replace(/ /g, '_')]
    if (mapped) {
      if (!types.includes(mapped)) types.push(mapped)
    } else if (!unrecognised.includes(trimmed)) {
      unrecognised.push(trimmed)
    }
  }
  return { types, unrecognised }
}

/**
 * The customer's list *replaces* the org default when it is set. A union would mean
 * a customer could never ask for less than the org asks for, and "this one bills on
 * the BOL alone" is a real arrangement.
 */
export function requiredDocTypesFor(
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null | undefined,
  settings: Pick<TmsSettings, 'defaultRequiredDocs'> | null | undefined,
): NormalizedRequiredDocs {
  const own = normalizeRequiredDocTypes(customer?.requiredDocsForInvoice)
  if (own.types.length > 0 || own.unrecognised.length > 0) return own
  return normalizeRequiredDocTypes(settings?.defaultRequiredDocs)
}

/** Which block of the Documents tab a row belongs in. */
export function documentSection(
  doc: Pick<ShipmentDocumentRecord, 'orderId' | 'loadCarrierId'>,
): ShipmentDocumentSection {
  if (doc.loadCarrierId) return 'CARRIER'
  if (doc.orderId) return 'CUSTOMER'
  return 'SHIPMENT'
}

function cleanFileBase(name: string): string {
  const basePart = name.split(/[\\/]/).pop() ?? name
  const cleaned = basePart.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  const base = (cleaned || 'document').replace(/\.[^.]+$/, '').slice(0, 120)
  return base || 'document'
}

/**
 * `shipment-docs/{shipmentId}/{documentId}-{safeName}.{ext}` — the document id is in
 * the key, so the row and its bytes identify each other and a commit can refuse a
 * key that belongs to another shipment.
 */
export function documentKey(
  shipmentId: string,
  documentId: string,
  name: string,
  contentType: string,
): string {
  const ext = CONTENT_TYPE_EXTENSIONS[contentType] ?? 'bin'
  return `shipment-docs/${shipmentId}/${documentId}-${cleanFileBase(name)}.${ext}`
}

export function documentPrefix(shipmentId: string): string {
  return `shipment-docs/${shipmentId}/`
}

/** Generated files name themselves after what they are, so a download is readable. */
export function generatedKey(
  shipmentId: string,
  documentId: string,
  type: ShipmentDocumentType,
  reference: string,
  version: number,
): string {
  const base = cleanFileBase(`${type.toLowerCase()}-${reference}-v${version}`)
  return `shipment-docs/${shipmentId}/${documentId}-${base}.pdf`
}

export function generatedFilename(type: ShipmentDocumentType, reference: string, version: number): string {
  return `${cleanFileBase(`${type.toLowerCase()}-${reference}-v${version}`)}.pdf`
}

/**
 * The extra keys of a generated document's slot. Omit the whole object and the slot is
 * (type, load) as it always was; pass it (even `{}`) and a row only shares the slot when
 * stop, carrier and rated-ness all match, with undefined = null. A rated BOL is stored
 * with audience CUSTOMER, so that is how a stored row says it is rated.
 */
export interface DocumentSlot {
  stopId?: string | null
  loadCarrierId?: string | null
  rated?: boolean
}

function sameSlot(
  doc: Pick<ShipmentDocumentRecord, 'type' | 'stopId' | 'loadCarrierId' | 'audience'>,
  slot: DocumentSlot | undefined,
): boolean {
  if (!slot) return true
  if ((doc.stopId ?? null) !== (slot.stopId ?? null)) return false
  if ((doc.loadCarrierId ?? null) !== (slot.loadCarrierId ?? null)) return false
  if (doc.type === 'BOL' && (doc.audience === 'CUSTOMER') !== (slot.rated === true)) return false
  return true
}

/**
 * Versions count per shipment + type + load (+ slot), so a two-leg shipment's two BOLs
 * are both v1 rather than v1 and v2 of one document, and so are two delivery stops'.
 */
export function nextVersion(
  docs: readonly Pick<ShipmentDocumentRecord, 'type' | 'loadId' | 'version' | 'stopId' | 'loadCarrierId' | 'audience'>[],
  type: ShipmentDocumentType,
  loadId: string | null | undefined,
  slot?: DocumentSlot,
): number {
  let max = 0
  for (const doc of docs) {
    if (doc.type !== type) continue
    if ((doc.loadId ?? null) !== (loadId ?? null)) continue
    if (!sameSlot(doc, slot)) continue
    if (typeof doc.version === 'number' && doc.version > max) max = doc.version
  }
  return max + 1
}

/**
 * The row a new generated document replaces: the current ACTIVE one of the same type
 * on the same load and slot. At most one, because every generation supersedes its
 * predecessor.
 */
export function supersede<
  T extends Pick<ShipmentDocumentRecord, 'id' | 'type' | 'loadId' | 'status' | 'stopId' | 'loadCarrierId' | 'audience'>,
>(
  docs: readonly T[],
  next: Pick<ShipmentDocumentRecord, 'type' | 'loadId'> & DocumentSlot,
): T | null {
  const slot: DocumentSlot | undefined =
    'stopId' in next || 'loadCarrierId' in next || 'rated' in next
      ? { stopId: next.stopId, loadCarrierId: next.loadCarrierId, rated: next.rated }
      : undefined
  for (const doc of docs) {
    if (doc.status !== 'ACTIVE') continue
    if (doc.type !== next.type) continue
    if ((doc.loadId ?? null) !== (next.loadId ?? null)) continue
    if (!sameSlot(doc, slot)) continue
    return doc
  }
  return null
}

/**
 * A POD (or any page) one of our own drivers filed from the driver app, still waiting for someone to accept it.
 * It is received paperwork (Ryne 2026-11-16: "Ivan Drivers should be uploading them so they should all be in there"):
 * it counts as on file everywhere, is shown as "Driver sent · review", and Move to billing accepts it.
 */
export function isDriverDocAwaitingReview(
  doc: Pick<ShipmentDocumentRecord, 'status' | 'reviewStatus'> & { source?: string | null },
): boolean {
  return doc.status === 'ACTIVE' && doc.reviewStatus === 'PENDING' && doc.source === 'DRIVER_APP'
}

/**
 * An ACTIVE row that nobody refused and nobody is still reviewing, except our own drivers' pages (see above).
 * A carrier-portal upload still counts for nothing until a person accepts it.
 */
export function countsAsPresent(
  doc: Pick<ShipmentDocumentRecord, 'status' | 'reviewStatus'> & { source?: string | null },
): boolean {
  if (doc.status !== 'ACTIVE') return false
  if (doc.reviewStatus === 'REJECTED') return false
  return doc.reviewStatus !== 'PENDING' || doc.source === 'DRIVER_APP'
}

export type DocGateScope = 'CUSTOMER' | 'CARRIER'

export interface PresentDocTypesInput {
  documents: readonly ShipmentDocumentRecord[]
  loadCarriers: readonly (Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'> & { kind?: LoadCarrierRecord['kind'] })[]
  orderId?: string | null
  loadIds?: readonly string[] | null
  /** CARRIER scope looks at exactly one assignment, by id. */
  loadCarrierId?: string | null
  scope: DocGateScope
  /** CUSTOMER scope on an own-fleet (ASSETS) load: the outside rate confirmation rules apply (ownFleetOutsideRateCon). */
  ownFleet?: boolean | null
  /**
   * CUSTOMER scope: the shipment has exactly one order, so a file filed on the shipment itself (no order, load or
   * assignment: the editor's POD / Rate confirmation boxes and intake attachments) is that order's paperwork.
   */
  soleOrder?: boolean | null
  /** The order's loads' `rateConfirmKey`s: on an own-fleet load, an uploaded customer tender is the outside rate con. */
  loadRateConKeys?: readonly (string | null | undefined)[] | null
}

/**
 * Which document types this scope actually has in hand. Customer scope accepts a row
 * attached to the order, to one of its loads, or to an ACTIVE assignment on one of
 * its loads — a POD the carrier sent through the portal is still the POD the
 * customer's invoice needs. Rows on a BOUNCED or TONU assignment are excluded.
 */
/** The rows this scope may count: the order's, its loads', and its ACTIVE assignments' (or one assignment's, CARRIER scope). */
function scopedDocuments(input: PresentDocTypesInput): ShipmentDocumentRecord[] {
  const activeCarrierIds = new Set(
    input.loadCarriers.filter((lc) => lc.status === 'ACTIVE').map((lc) => lc.id),
  )
  const loadIds = new Set(input.loadIds ?? [])
  return input.documents.filter((doc) => {
    if (input.scope === 'CARRIER') return Boolean(input.loadCarrierId) && doc.loadCarrierId === input.loadCarrierId
    const onOrder = input.orderId != null && doc.orderId === input.orderId
    const onLoad = doc.loadId != null && loadIds.has(doc.loadId)
    const onAssignment = doc.loadCarrierId != null && activeCarrierIds.has(doc.loadCarrierId)
    if (doc.loadCarrierId != null && !activeCarrierIds.has(doc.loadCarrierId)) return false
    const onShipmentOnly = input.soleOrder === true && doc.orderId == null && doc.loadId == null && doc.loadCarrierId == null
    return onOrder || onLoad || onAssignment || onShipmentOnly
  })
}

/**
 * The types this scope has ONLY as driver-app pages still waiting for review: on file, shown as
 * "Driver sent · review" until someone accepts one (or Move to billing does).
 */
export function driverReviewDocTypes(input: PresentDocTypesInput): ShipmentDocumentType[] {
  const docs = scopedDocuments(input)
  const settled = new Set(docs.filter((d) => countsAsPresent(d) && !isDriverDocAwaitingReview(d)).map((d) => d.type))
  const waiting = new Set(docs.filter((d) => isDriverDocAwaitingReview(d) && !settled.has(d.type)).map((d) => d.type))
  return SHIPMENT_DOCUMENT_TYPES.filter((type) => waiting.has(type))
}

export function presentDocTypes(input: PresentDocTypesInput): ShipmentDocumentType[] {
  const present = new Set<ShipmentDocumentType>()
  for (const doc of scopedDocuments(input)) {
    if (countsAsPresent(doc)) present.add(doc.type)
  }

  // The rate confirmation the customer's invoice (and OTR) needs is the customer's or broker's own (Ryne 2026-11-16).
  // A filed customer rate confirmation, or the tender attached to the load, is it, on any load: the board's RC cell
  // has always read the tender this way, and the gate, the board and the shipment's box now agree (14938).
  if (input.scope !== 'CARRIER') {
    if (present.has('CUSTOMER_RATE_CON')) present.add('RATE_CON')
    if ((input.loadRateConKeys ?? []).some(isOutsideRateConKey)) present.add('RATE_CON')
  }

  // The rate confirmation lives in the carrier packet, not here. It is paperwork
  // once the carrier signed it; having sent it is not.
  const signedScope =
    input.scope === 'CARRIER'
      ? input.loadCarriers.filter((lc) => lc.id === input.loadCarrierId)
      : input.loadCarriers.filter((lc) => lc.status === 'ACTIVE')
  // Two or more outside carriers on the load: every one must have signed, and a
  // filed RATE_CON (or one signature) never waives another carrier's.
  const outside = signedScope.filter((lc) => lc.kind !== 'OWN_ASSET')
  if (input.scope !== 'CARRIER' && outside.length >= 2) {
    present.delete('RATE_CON')
    if (outside.every((lc) => lc.rateConStatus === 'SIGNED')) present.add('RATE_CON')
  } else if ((input.scope === 'CARRIER' ? signedScope : outside).some((lc) => lc.rateConStatus === 'SIGNED')) {
    // Our own truck "signing" our own rate con is not paperwork from outside: only a carrier's signature counts here.
    present.add('RATE_CON')
  }

  return SHIPMENT_DOCUMENT_TYPES.filter((type) => present.has(type))
}

/**
 * Which of a shipment's loads count towards one order's gate.
 *
 * A load that names its order is unambiguous. A load that names none is only
 * attributable when the shipment has exactly one order — on a multi-order
 * shipment an unattributed load's paperwork must satisfy nobody, because
 * crediting it to every order would let one BOL clear two invoices. Shared by
 * the Lambda and the Documents tab so the strip and READY_TO_INVOICE can never
 * reach different answers.
 */
export function gateLoadIds(
  loads: readonly { id: string; orderId?: string | null }[],
  orders: readonly { id: string }[],
  orderId: string,
): string[] {
  const soleOrder = orders.length === 1
  return loads.filter((load) => (soleOrder && load.orderId == null) || load.orderId === orderId).map((load) => load.id)
}

export interface DocGateInput {
  order?: Pick<OrderRecord, 'id'> | null
  loadIds?: readonly string[] | null
  loadCarriers: readonly (Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'> & { kind?: LoadCarrierRecord['kind'] })[]
  documents: readonly ShipmentDocumentRecord[]
  customer?: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null
  settings?: Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes'> | null
  scope: DocGateScope
  /** CARRIER scope: the assignment being evaluated. */
  loadCarrierId?: string | null
  /**
   * Imported Aljex history (DECIDED-5): its paperwork stays in the Aljex archive, so
   * the gate reads as satisfied in both scopes. The caller passes the shipment's flag.
   */
  legacyImported?: boolean | null
  /**
   * CUSTOMER scope: documents the order's loads ask for on top of the customer's list
   * (`Load.requiredDocTypes`, see loadRequiredDocs.ts). Added as written.
   */
  extraDocTypes?: readonly string[] | null
  /** CUSTOMER scope: an own-fleet (ASSETS) load, so the outside rate confirmation rules apply (see presentDocTypes). */
  ownFleet?: boolean | null
  /** CUSTOMER scope: the order's loads' `rateConfirmKey`s (the tender attached from intake or the Loads drawer). */
  loadRateConKeys?: readonly (string | null | undefined)[] | null
  /** CUSTOMER scope: the shipment has one order, so shipment-level files count for it (see PresentDocTypesInput). */
  soleOrder?: boolean | null
  /**
   * CUSTOMER scope: a car-shipping load (isCarShipperLoad). Every other load needs the rate
   * confirmation, own-fleet ones included (the office files it), so it is added unless this is true.
   */
  carShipper?: boolean | null
}

/**
 * What this scope still needs. CUSTOMER scope is the Ready-to-invoice gate; CARRIER
 * scope is the paperwork we want before paying a carrier, which step E records and
 * step G will act on. Nothing here blocks delivery: delivery is a fact about the
 * truck, paperwork is a fact about billing.
 */
export function evaluateDocGate(input: DocGateInput): DocGateResult {
  if (input.legacyImported === true) {
    // Nothing is required of imported Aljex history, but what IS on file still shows as on file (board POD / RC cells).
    const presence: PresentDocTypesInput = {
      documents: input.documents, loadCarriers: input.loadCarriers, orderId: input.order?.id ?? null, loadIds: input.loadIds ?? null,
      loadCarrierId: input.loadCarrierId ?? null, scope: input.scope, ownFleet: input.ownFleet ?? null,
      loadRateConKeys: input.loadRateConKeys ?? null, soleOrder: input.soleOrder ?? null,
    }
    const present = presentDocTypes(presence)
    return { required: [], present, missing: [], ready: true, unrecognised: [], legacy: true, pendingReview: driverReviewDocTypes(presence).filter((t) => present.includes(t)) }
  }
  const { types: required, unrecognised } =
    input.scope === 'CARRIER'
      ? normalizeRequiredDocTypes(
          input.settings?.requiredCarrierUploadTypes ?? [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES],
        )
      : requiredDocTypesFor(input.customer, input.settings)
  // The customer gate follows the release gate: a BOL on the customer's list or the org default is
  // optional and never holds an invoice. Per-load extras (`Load.requiredDocTypes`) are explicit and block as written.
  const gated = input.scope === 'CARRIER' ? required : required.filter((type) => !NEVER_BLOCKING_DOC_TYPES.includes(type))
  if (input.scope !== 'CARRIER') {
    // The outside rate confirmation follows the one rule (rateConRequired): asset loads and factored customers need it,
    // brokered loads for a customer that does not factor, car shipping and waiving customers do not.
    const needsRateCon = rateConRequired({
      asset: input.ownFleet === true,
      carShipper: input.carShipper === true,
      customerFactors: customerFactorsForOtr(input.customer as { billingMethod?: string | null; factored?: boolean | null } | null | undefined),
      customerWaivesRateCon: customerDocsNotRequired(
        input.customer as { reviewRequirements?: string[] | null } | null | undefined,
        input.settings as { reviewRequirements?: string[] | null } | null | undefined,
      ).includes('RATE_CON'),
    })
    if (needsRateCon && !gated.includes('RATE_CON')) gated.push('RATE_CON')
    // A brokered load for a customer that does not factor owes no rate confirmation, even when its list names one. Car
    // shipping keeps the older behaviour (nothing added, an explicit list stands).
    if (!needsRateCon && input.carShipper !== true && gated.includes('RATE_CON') && !(input.extraDocTypes ?? []).includes('RATE_CON')) gated.splice(gated.indexOf('RATE_CON'), 1)
    // POD / RC the customer does not need to invoice (its Load Review list), like the release gate.
    const notRequired = customerDocsNotRequired(
      input.customer as { reviewRequirements?: string[] | null } | null | undefined,
      input.settings as { reviewRequirements?: string[] | null } | null | undefined,
    )
    for (let i = gated.length - 1; i >= 0; i--) if ((notRequired as string[]).includes(gated[i])) gated.splice(i, 1)
    for (const type of normalizeRequiredDocTypes(input.extraDocTypes ?? []).types) {
      if (!gated.includes(type)) gated.push(type)
    }
  }

  const present = presentDocTypes({
    documents: input.documents,
    loadCarriers: input.loadCarriers,
    orderId: input.order?.id ?? null,
    loadIds: input.loadIds ?? null,
    loadCarrierId: input.loadCarrierId ?? null,
    scope: input.scope,
    ownFleet: input.ownFleet ?? null,
    loadRateConKeys: input.loadRateConKeys ?? null,
    soleOrder: input.soleOrder ?? null,
  })

  const missing = gated.filter((type) => !present.includes(type))
  const pendingReview = driverReviewDocTypes({
    documents: input.documents,
    loadCarriers: input.loadCarriers,
    orderId: input.order?.id ?? null,
    loadIds: input.loadIds ?? null,
    loadCarrierId: input.loadCarrierId ?? null,
    scope: input.scope,
    soleOrder: input.soleOrder ?? null,
  }).filter((type) => present.includes(type))
  return { required: gated, present, missing, ready: missing.length === 0, unrecognised, pendingReview }
}

/**
 * Whether a document may be e-mailed to this kind of recipient. INTERNAL never
 * leaves; a customer's paperwork never goes to a carrier and the carrier's never
 * goes to the customer.
 */
export function canEmailTo(
  doc: Pick<ShipmentDocumentRecord, 'audience' | 'status' | 'reviewStatus'>,
  recipientKind: 'CUSTOMER' | 'CARRIER',
): boolean {
  if (doc.status !== 'ACTIVE') return false
  if (doc.reviewStatus === 'PENDING' || doc.reviewStatus === 'REJECTED') return false
  if (doc.audience === 'INTERNAL') return false
  if (doc.audience === 'ALL') return true
  return doc.audience === recipientKind
}

/** A pointer row's bytes live in another store, so it cannot be renamed or retyped. */
export function isPointerDocument(doc: Pick<ShipmentDocumentRecord, 'source'>): boolean {
  return doc.source === 'DRIVER_APP' || doc.source === 'LEGACY'
}

/** The deterministic ids that make a backfill or a stream retry idempotent. */
export function driverDocumentId(submissionDocId: string): string {
  return `drv:${submissionDocId}`
}

/**
 * A `Load.rateConfirmKey` that is an outside rate confirmation: one uploaded or attached from an intake e-mail
 * (`rate-confirms/<loadId>/…`). The confirmations BCAT generates for a carrier live under `rate-confirms/carrier/`
 * and are never the customer's.
 */
export function isOutsideRateConKey(key: string | null | undefined): boolean {
  const k = typeof key === 'string' ? key.trim() : ''
  return k.length > 0 && !k.startsWith('rate-confirms/carrier/')
}

/** An asset load (isAssetLoad): ASSETS, or our own trucks / Ivan Cartage on a live assignment. */
export function isOwnFleetLoad(
  shipment: { revDivision?: string | null } | null | undefined,
  loadCarriers: readonly { status?: string | null; kind?: string | null; carrierName?: string | null }[] = [],
): boolean {
  const active = loadCarriers.filter((lc) => lc.status === 'ACTIVE')
  return isAssetLoad({
    revDivision: shipment?.revDivision ?? null,
    legKinds: active.map((lc) => lc.kind ?? null),
    carrierNames: active.map((lc) => lc.carrierName ?? null),
  })
}

/**
 * Where an asset load's outside rate confirmation is (Ryne 2026-11-16), as the Documents box shows it and the gate counts
 * it: filed RATE_CON / CUSTOMER_RATE_CON rows, and the tender on the load (`Load.rateConfirmKey`, attached from the intake
 * e-mail or the Loads drawer). One function, so the editor's box, the gate, the board and Load Review never disagree.
 */
export function assetRateConTenders(
  loads: readonly { id: string; rateConfirmKey?: string | null; voidedAt?: string | null; deletedAt?: string | null }[],
): { loadId: string; key: string }[] {
  return loads
    .filter((load) => !load.voidedAt && !load.deletedAt && isOutsideRateConKey(load.rateConfirmKey))
    .map((load) => ({ loadId: load.id, key: String(load.rateConfirmKey).trim() }))
}

/** What a shipment's POD or rate-confirmation box says: the same presence rule the order gate (and the board's cache) uses. */
export type ShipmentDocPresence = 'PRESENT' | 'REVIEW' | 'MISSING'

/**
 * ONE answer to "is this document on file?" for the shipment editor's POD / Rate confirmation boxes, computed with
 * presentDocTypes / driverReviewDocTypes exactly as evaluateDocGate does for each order, so the box, the order gate
 * and the board cell (which reads the gate's cached present / pendingReview) cannot disagree (Ryne 2026-11-16, 14938).
 * Across the shipment's orders: on file when any order has it; REVIEW when the only copy is a driver page awaiting review.
 */
export function shipmentDocPresence(
  args: {
    documents: readonly ShipmentDocumentRecord[]
    orders: readonly { id: string }[]
    loads: readonly { id: string; orderId?: string | null; rateConfirmKey?: string | null }[]
    loadCarriers: readonly (Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'> & { kind?: LoadCarrierRecord['kind']; carrierName?: string | null })[]
    shipment?: { revDivision?: string | null } | null
  },
  docType: ShipmentDocumentType,
): ShipmentDocPresence {
  const ownFleet = isOwnFleetLoad(args.shipment ?? null, args.loadCarriers)
  const orderIds = args.orders.length > 0 ? args.orders.map((o) => o.id) : [null]
  let present = false
  let settled = false
  for (const orderId of orderIds) {
    const loadIds = orderId == null ? args.loads.map((l) => l.id) : gateLoadIds(args.loads, args.orders, orderId)
    const input: PresentDocTypesInput = {
      documents: args.documents,
      loadCarriers: args.loadCarriers,
      orderId,
      loadIds,
      scope: 'CUSTOMER',
      ownFleet,
      loadRateConKeys: args.loads.filter((l) => loadIds.includes(l.id)).map((l) => l.rateConfirmKey ?? null),
      soleOrder: args.orders.length <= 1,
    }
    if (!presentDocTypes(input).includes(docType)) continue
    present = true
    if (!driverReviewDocTypes(input).includes(docType)) settled = true
  }
  if (!present) return 'MISSING'
  return settled ? 'PRESENT' : 'REVIEW'
}

export function legacyRateConDocumentId(loadId: string): string {
  return `rck:${loadId}`
}

/**
 * The type a file's name points at, for the generic drop area: "POD 14657.pdf" is a POD,
 * "RateConf_4010854523.pdf" a rate confirmation. Null when the name says nothing, and the
 * picked type stands. Only the two documents billing turns on are guessed; a wrong guess on
 * anything else costs more than it saves.
 */
export function suggestDocumentType(fileName: string): ShipmentDocumentType | null {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '')
  const words = base.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const squashed = words.replace(/ /g, '')
  if (/\b(pod|pods)\b/.test(words) || squashed.includes('proofofdelivery') || /^pod\d/.test(squashed)) return 'POD'
  if (squashed.includes('rateconf') || squashed.includes('ratecon') || /\brc\b/.test(words) || squashed.includes('loadconfirmation')
    || squashed.includes('carrierconfirmation')) return 'RATE_CON'
  return null
}

/** Documents the POD and rate confirmation boxes hold; everything else is "Other documents". */
export const SLOT_DOCUMENT_TYPES: readonly ShipmentDocumentType[] = ['POD', 'RATE_CON']
