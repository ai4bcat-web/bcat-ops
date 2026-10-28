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
 *    ever influencing a billing decision.
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
export const DRIVER_ATTACHABLE_TYPES = ['POD', 'PHOTO', 'OTHER'] as const satisfies readonly ShipmentDocumentType[]

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
 * Versions count per shipment + type + load, so a two-leg shipment's two BOLs are
 * both v1 rather than v1 and v2 of one document.
 */
export function nextVersion(
  docs: readonly Pick<ShipmentDocumentRecord, 'type' | 'loadId' | 'version'>[],
  type: ShipmentDocumentType,
  loadId: string | null | undefined,
): number {
  let max = 0
  for (const doc of docs) {
    if (doc.type !== type) continue
    if ((doc.loadId ?? null) !== (loadId ?? null)) continue
    if (typeof doc.version === 'number' && doc.version > max) max = doc.version
  }
  return max + 1
}

/**
 * The row a new generated document replaces: the current ACTIVE one of the same type
 * on the same load. At most one, because every generation supersedes its predecessor.
 */
export function supersede<T extends Pick<ShipmentDocumentRecord, 'id' | 'type' | 'loadId' | 'status'>>(
  docs: readonly T[],
  next: Pick<ShipmentDocumentRecord, 'type' | 'loadId'>,
): T | null {
  for (const doc of docs) {
    if (doc.status !== 'ACTIVE') continue
    if (doc.type !== next.type) continue
    if ((doc.loadId ?? null) !== (next.loadId ?? null)) continue
    return doc
  }
  return null
}

/** An ACTIVE row that nobody is still reviewing and nobody refused. */
export function countsAsPresent(
  doc: Pick<ShipmentDocumentRecord, 'status' | 'reviewStatus'>,
): boolean {
  if (doc.status !== 'ACTIVE') return false
  return doc.reviewStatus !== 'PENDING' && doc.reviewStatus !== 'REJECTED'
}

export type DocGateScope = 'CUSTOMER' | 'CARRIER'

export interface PresentDocTypesInput {
  documents: readonly ShipmentDocumentRecord[]
  loadCarriers: readonly Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'>[]
  orderId?: string | null
  loadIds?: readonly string[] | null
  /** CARRIER scope looks at exactly one assignment, by id. */
  loadCarrierId?: string | null
  scope: DocGateScope
}

/**
 * Which document types this scope actually has in hand. Customer scope accepts a row
 * attached to the order, to one of its loads, or to an ACTIVE assignment on one of
 * its loads — a POD the carrier sent through the portal is still the POD the
 * customer's invoice needs. Rows on a BOUNCED or TONU assignment are excluded.
 */
export function presentDocTypes(input: PresentDocTypesInput): ShipmentDocumentType[] {
  const activeCarrierIds = new Set(
    input.loadCarriers.filter((lc) => lc.status === 'ACTIVE').map((lc) => lc.id),
  )
  const loadIds = new Set(input.loadIds ?? [])
  const present = new Set<ShipmentDocumentType>()

  for (const doc of input.documents) {
    if (!countsAsPresent(doc)) continue
    if (input.scope === 'CARRIER') {
      if (!input.loadCarrierId || doc.loadCarrierId !== input.loadCarrierId) continue
    } else {
      const onOrder = input.orderId != null && doc.orderId === input.orderId
      const onLoad = doc.loadId != null && loadIds.has(doc.loadId)
      const onAssignment = doc.loadCarrierId != null && activeCarrierIds.has(doc.loadCarrierId)
      if (doc.loadCarrierId != null && !activeCarrierIds.has(doc.loadCarrierId)) continue
      if (!onOrder && !onLoad && !onAssignment) continue
    }
    present.add(doc.type)
  }

  // The rate confirmation lives in the carrier packet, not here. It is paperwork
  // once the carrier signed it; having sent it is not.
  const signedScope =
    input.scope === 'CARRIER'
      ? input.loadCarriers.filter((lc) => lc.id === input.loadCarrierId)
      : input.loadCarriers.filter((lc) => lc.status === 'ACTIVE')
  if (signedScope.some((lc) => lc.rateConStatus === 'SIGNED')) present.add('RATE_CON')

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
  loadCarriers: readonly Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'>[]
  documents: readonly ShipmentDocumentRecord[]
  customer?: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null
  settings?: Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes'> | null
  scope: DocGateScope
  /** CARRIER scope: the assignment being evaluated. */
  loadCarrierId?: string | null
}

/**
 * What this scope still needs. CUSTOMER scope is the Ready-to-invoice gate; CARRIER
 * scope is the paperwork we want before paying a carrier, which step E records and
 * step G will act on. Nothing here blocks delivery: delivery is a fact about the
 * truck, paperwork is a fact about billing.
 */
export function evaluateDocGate(input: DocGateInput): DocGateResult {
  const { types: required, unrecognised } =
    input.scope === 'CARRIER'
      ? normalizeRequiredDocTypes(
          input.settings?.requiredCarrierUploadTypes ?? [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES],
        )
      : requiredDocTypesFor(input.customer, input.settings)

  const present = presentDocTypes({
    documents: input.documents,
    loadCarriers: input.loadCarriers,
    orderId: input.order?.id ?? null,
    loadIds: input.loadIds ?? null,
    loadCarrierId: input.loadCarrierId ?? null,
    scope: input.scope,
  })

  const missing = required.filter((type) => !present.includes(type))
  return { required, present, missing, ready: missing.length === 0, unrecognised }
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

export function legacyRateConDocumentId(loadId: string): string {
  return `rck:${loadId}`
}
