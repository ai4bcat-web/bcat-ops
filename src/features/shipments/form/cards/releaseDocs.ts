/**
 * The "Required for release" checklist (Step AR, Documents card). INFO only: nothing here ever
 * blocks Create. The list follows the Load Review rules: the customer's invoice documents
 * (`requiredDocsForInvoice`, else the org default), the
 * rate confirmation, and POD whenever the customer's / org's Load Review requirements include
 * "POD received". A document counts once it is on the shipment (or, on create, queued).
 */
import { loadExtraDocTypes } from '@/lib/loadRequiredDocs'
import { resolveReviewRequirements } from '@/lib/reviewRequirements'
import { SHIPMENT_DOCUMENT_TYPES, countsAsPresent, requiredDocTypesFor, type ShipmentDocumentType } from '@/lib/shipmentDocuments'
import type { CustomerRecord, ShipmentBundle, TmsSettings } from '@/types/tms'
import type { QueuedFile } from '../model'

export interface ReleaseDocItem {
  type: ShipmentDocumentType
  /** The customer's / org's lists ask for it. A BOL is always listed; when nothing requires it, it is optional. */
  required: boolean
  /** On the shipment already. */
  present: boolean
  /** Not on the shipment yet but a queued file of this type will be written on Create. */
  queued: boolean
  /** BOL only: the newest ACTIVE generated BOL's version (null when the BOL on file was uploaded). */
  generatedVersion: number | null
  /** BOL only: the newest ACTIVE generated BOL predates the last edit of the shipment. */
  stale: boolean
}

export function releaseDocItems(i: {
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice' | 'reviewRequirements'> | null
  settings: Pick<TmsSettings, 'defaultRequiredDocs' | 'reviewRequirements'> | null
  bundle: Pick<ShipmentBundle, 'documents' | 'loadCarriers'> & { loads?: ShipmentBundle['loads']; shipment?: Pick<ShipmentBundle['shipment'], 'updatedAt'> } | null
  queued: readonly QueuedFile[]
}): ReleaseDocItem[] {
  const wanted = new Set<ShipmentDocumentType>(['RATE_CON'])
  for (const t of requiredDocTypesFor(i.customer, i.settings).types) wanted.add(t)
  // What this load asks for on top of the customer's list (Documents required for this load).
  for (const t of loadExtraDocTypes(i.bundle?.loads ?? [])) wanted.add(t)
  // The carrier's invoice is not needed to release a load: it is the carrier's bill, paid through accounts payable, and our own invoice
  // is generated when accounting posts the batch (it then appears here as a document).
  if (resolveReviewRequirements(i.customer?.reviewRequirements, i.settings?.reviewRequirements).includes('podReceived')) wanted.add('POD')

  const have = new Set<ShipmentDocumentType>()
  for (const d of i.bundle?.documents ?? []) if (countsAsPresent(d)) have.add(d.type)
  if ((i.bundle?.loadCarriers ?? []).some((lc) => lc.status === 'ACTIVE' && lc.rateConStatus === 'SIGNED')) have.add('RATE_CON')
  const queued = new Set(i.queued.map((q) => q.type))

  const generated = (i.bundle?.documents ?? [])
    .filter((d) => d.type === 'BOL' && d.source === 'GENERATED' && countsAsPresent(d))
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))
    .at(-1)
  const updatedAt = i.bundle?.shipment?.updatedAt
  const wantedBol = wanted.has('BOL')
  return SHIPMENT_DOCUMENT_TYPES.filter((t) => t === 'BOL' || wanted.has(t)).map((type) => ({
    type,
    required: type === 'BOL' ? wantedBol : true,
    present: have.has(type),
    queued: !have.has(type) && queued.has(type),
    generatedVersion: type === 'BOL' && generated ? generated.version : null,
    stale: type === 'BOL' && generated != null && Boolean(updatedAt && generated.uploadedAt < updatedAt),
  }))
}
