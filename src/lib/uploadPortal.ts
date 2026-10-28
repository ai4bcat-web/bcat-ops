/**
 * The carrier upload portal view.
 *
 * A carrier holding an upload link is outside the company. The view it gets is
 * built here, from a shape (`CarrierUploadView`) that has no field for the
 * customer, the money, the references or anybody else's documents — so there is
 * nothing to forget to strip. It answers exactly three questions: which load is
 * this, what do you still need from me, and what have I already sent.
 *
 * Imports are relative and type-only where they can be: the public tracking-api
 * Lambda bundles this file by path, so a `@/` alias would break the function build.
 */
import type {
  CarrierUploadView,
  LoadCarrierRecord,
  ShipmentDocumentRecord,
  ShipmentDocumentType,
  TrackingLinkRecord,
  UploadNeededType,
  UploadPortalStop,
  UploadPortalUpload,
} from '../types/tms'
import type { Stop } from '../types/index'
import {
  ACCEPTED_CONTENT_TYPES,
  CARRIER_UPLOADABLE_TYPES,
  DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES,
  DOCUMENT_TYPE_LABELS,
  MAX_PORTAL_BYTES,
  countsAsPresent,
  normalizeRequiredDocTypes,
} from './shipmentDocuments'
import { splitCityState } from './locationAutoSave'

export interface CarrierUploadViewInput {
  link: Pick<TrackingLinkRecord, 'id' | 'expiresAt' | 'neededTypes'>
  load: { loadNumber?: string | null; aljexId?: string | null; stops?: Stop[] | null }
  loadCarrier: Pick<LoadCarrierRecord, 'id' | 'carrierName'>
  /** Every document on the shipment; this function picks out the carrier's own. */
  documents: readonly ShipmentDocumentRecord[]
  brokerName: string
  contactPhone?: string | null
  nowIso: string
}

/**
 * What the carrier sees. `needed` is the snapshot the link was minted with, so
 * changing the org setting later never silently changes what a carrier already in
 * the middle of uploading was asked for; `uploads` is only what this link itself
 * sent, including rows still waiting to be reviewed, so the driver can tell that
 * the file landed without learning anything about our paperwork.
 */
export function carrierUploadView(input: CarrierUploadViewInput): CarrierUploadView {
  const requested = normalizeRequiredDocTypes(input.link.neededTypes).types
  const needTypes: ShipmentDocumentType[] =
    requested.length > 0 ? requested : [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES]

  const mine = input.documents.filter((doc) => doc.loadCarrierId === input.loadCarrier.id)

  const needed: UploadNeededType[] = needTypes.map((type) => ({
    type,
    label: DOCUMENT_TYPE_LABELS[type] ?? type,
    // Satisfied by anything of that type on this assignment that is not refused —
    // a file waiting for review has arrived as far as the carrier is concerned.
    satisfied: mine.some(
      (doc) => doc.type === type && doc.status === 'ACTIVE' && doc.reviewStatus !== 'REJECTED',
    ),
  }))

  const uploads: UploadPortalUpload[] = mine
    .filter((doc) => doc.uploadLinkId === input.link.id && doc.status !== 'VOID')
    .map((doc) => ({
      id: doc.id,
      type: doc.type,
      name: doc.name,
      sizeBytes: doc.sizeBytes,
      uploadedAt: doc.uploadedAt,
      reviewStatus: doc.reviewStatus ?? 'PENDING',
    }))
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))

  const stops: UploadPortalStop[] = (input.load.stops ?? []).map((stop) => {
    const place = splitCityState(stop.city)
    return {
      type: stop.type,
      name: stop.name ?? null,
      city: place.city,
      state: place.state,
      appt: stop.appt ?? null,
    }
  })

  return {
    broker: { name: input.brokerName },
    loadNumber: input.load.loadNumber ?? input.load.aljexId ?? '',
    carrierName: input.loadCarrier.carrierName ?? null,
    stops,
    needed,
    uploads,
    expiresAt: input.link.expiresAt,
    acceptedTypes: [...ACCEPTED_CONTENT_TYPES],
    maxBytes: MAX_PORTAL_BYTES,
    contactPhone: input.contactPhone ?? null,
    generatedAt: input.nowIso,
  }
}

/** A link that has run out of time, been revoked, or is not an upload link at all. */
export function uploadLinkUsable(
  link: Pick<TrackingLinkRecord, 'kind' | 'status' | 'expiresAt'> | null | undefined,
  nowIso: string,
): boolean {
  if (!link) return false
  if (link.kind !== 'CARRIER_UPLOAD') return false
  if (link.status !== 'ACTIVE') return false
  return new Date(link.expiresAt).getTime() > new Date(nowIso).getTime()
}

/** What the portal is allowed to accept, as the public Lambda checks it. */
export function portalUploadAllowed(
  type: string,
  contentType: string,
  sizeBytes: number,
): { ok: true } | { ok: false; reason: string } {
  if (!(CARRIER_UPLOADABLE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'That document type cannot be uploaded here.' }
  }
  if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return { ok: false, reason: 'Please send a PDF, JPG or PNG.' }
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_PORTAL_BYTES) {
    return { ok: false, reason: `Files must be smaller than ${Math.round(MAX_PORTAL_BYTES / (1024 * 1024))} MB.` }
  }
  return { ok: true }
}

/** Which of this assignment's requested types still have nothing against them. */
export function outstandingCarrierTypes(
  neededTypes: readonly (string | null | undefined)[] | null | undefined,
  documents: readonly ShipmentDocumentRecord[],
  loadCarrierId: string,
): ShipmentDocumentType[] {
  const requested = normalizeRequiredDocTypes(neededTypes).types
  const types = requested.length > 0 ? requested : [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES]
  return types.filter(
    (type) =>
      !documents.some(
        (doc) => doc.loadCarrierId === loadCarrierId && doc.type === type && countsAsPresent(doc),
      ),
  )
}
