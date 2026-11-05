/**
 * The "Required for release" checklist (Step AR, Documents card). INFO only: nothing here ever
 * blocks Create. The list follows the Load Review rules: the customer's invoice documents
 * (`requiredDocsForInvoice`, else the org default), the carrier paperwork the org asks for, the
 * rate confirmation, and POD whenever the customer's / org's Load Review requirements include
 * "POD received". A document counts once it is on the shipment (or, on create, queued).
 */
import { resolveReviewRequirements } from '@/lib/reviewRequirements'
import {
  DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES, SHIPMENT_DOCUMENT_TYPES, countsAsPresent, normalizeRequiredDocTypes,
  requiredDocTypesFor, type ShipmentDocumentType,
} from '@/lib/shipmentDocuments'
import type { CustomerRecord, ShipmentBundle, TmsSettings } from '@/types/tms'
import type { QueuedFile } from '../model'

export interface ReleaseDocItem {
  type: ShipmentDocumentType
  /** On the shipment already. */
  present: boolean
  /** Not on the shipment yet but a queued file of this type will be written on Create. */
  queued: boolean
}

export function releaseDocItems(i: {
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice' | 'reviewRequirements'> | null
  settings: Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes' | 'reviewRequirements'> | null
  bundle: Pick<ShipmentBundle, 'documents' | 'loadCarriers'> | null
  queued: readonly QueuedFile[]
}): ReleaseDocItem[] {
  const wanted = new Set<ShipmentDocumentType>(['RATE_CON'])
  for (const t of requiredDocTypesFor(i.customer, i.settings).types) wanted.add(t)
  const carrier = normalizeRequiredDocTypes(i.settings?.requiredCarrierUploadTypes ?? [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES])
  for (const t of carrier.types) wanted.add(t)
  if (resolveReviewRequirements(i.customer?.reviewRequirements, i.settings?.reviewRequirements).includes('podReceived')) wanted.add('POD')

  const have = new Set<ShipmentDocumentType>()
  for (const d of i.bundle?.documents ?? []) if (countsAsPresent(d)) have.add(d.type)
  if ((i.bundle?.loadCarriers ?? []).some((lc) => lc.status === 'ACTIVE' && lc.rateConStatus === 'SIGNED')) have.add('RATE_CON')
  const queued = new Set(i.queued.map((q) => q.type))

  return SHIPMENT_DOCUMENT_TYPES.filter((t) => wanted.has(t)).map((type) => ({
    type, present: have.has(type), queued: !have.has(type) && queued.has(type),
  }))
}
