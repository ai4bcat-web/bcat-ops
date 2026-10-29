/**
 * The document matrix behind the Documents workstation: for one shipment, which
 * paperwork the customer's rules require, and which of that is already in hand.
 *
 * None of the rules live here. What is required comes from the release gate's own
 * `requiredDocTypesForRelease` (the customer's list, the never-optional BOL and POD,
 * and the rate confirmation once an outside carrier is on the load); what counts as
 * present comes from `presentDocTypes`, the same function the Documents tab and the
 * server gate use, so a chip and READY_TO_INVOICE can never disagree. This module only
 * turns those two answers into rows of chips and finds the filed document a satisfied
 * chip should name.
 */
import { requiredDocTypesForRelease, type ReleaseGateLeg } from '@/lib/releaseGate'
import {
  countsAsPresent,
  DOCUMENT_TYPE_LABELS,
  gateLoadIds,
  presentDocTypes,
  requiredDocTypesFor,
  type PresentDocTypesInput,
} from '@/lib/shipmentDocuments'
import type {
  CustomerRecord,
  LoadCarrierRecord,
  OrderRecord,
  ShipmentDocumentRecord,
  ShipmentDocumentSource,
  ShipmentLoad,
  TmsSettings,
} from '@/types/tms'

/** Where a filed document came from, worded for a chip's hover text. */
export const DOCUMENT_SOURCE_LABELS: Record<ShipmentDocumentSource, string> = {
  UPLOAD: 'uploaded by staff',
  CARRIER_PORTAL: 'sent by the carrier',
  GENERATED: 'generated here',
  DRIVER_APP: 'from the driver app',
  LEGACY: 'carried over from the old system',
}

export interface DocumentMatrixChip {
  type: string
  label: string
  present: boolean
  /** The newest filed document satisfying the type, when one is on file. */
  doc: ShipmentDocumentRecord | null
  /**
   * The rate confirmation is paperwork once the carrier signs the packet, even when
   * no file row carries the type — the chip is solid but names no document.
   */
  derivedFromSignedRateCon: boolean
}

export interface DocumentMatrixInput {
  documents: readonly ShipmentDocumentRecord[]
  loads: readonly Pick<ShipmentLoad, 'id' | 'orderId'>[]
  orders: readonly Pick<OrderRecord, 'id'>[]
  loadCarriers: readonly Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'>[]
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null | undefined
  settings: Pick<TmsSettings, 'defaultRequiredDocs'> | null | undefined
}

export interface DocumentMatrix {
  chips: DocumentMatrixChip[]
  /** Customer instructions outside the typed vocabulary — reported, never gated on. */
  unrecognised: string[]
  missingCount: number
}

/** The document a satisfied chip names: the newest one the gate would count. */
function newestPresentDoc(
  docs: readonly ShipmentDocumentRecord[],
  type: string,
  scope: Omit<PresentDocTypesInput, 'documents'>,
): ShipmentDocumentRecord | null {
  let best: ShipmentDocumentRecord | null = null
  for (const doc of docs) {
    if (doc.type !== type || !countsAsPresent(doc)) continue
    if (!presentDocTypes({ ...scope, documents: [doc] }).includes(doc.type)) continue
    if (!best || doc.uploadedAt > best.uploadedAt) best = doc
  }
  return best
}

export function documentMatrix(input: DocumentMatrixInput): DocumentMatrix {
  const orderId = input.orders[0]?.id ?? null
  // Every carrier assignment is a carrier leg for the gate's RATE_CON rule; the
  // status decides whether it counts.
  const legs: ReleaseGateLeg[] = input.loadCarriers.map((lc) => ({
    kind: 'CARRIER',
    status: lc.status,
    rateConStatus: lc.rateConStatus ?? null,
  }))
  const customerRule = requiredDocTypesFor(input.customer, input.settings)
  const required = requiredDocTypesForRelease(customerRule.types, legs)
  const present = new Set<string>(
    presentDocTypes({
      documents: input.documents,
      loadCarriers: input.loadCarriers,
      orderId,
      loadIds: orderId ? gateLoadIds(input.loads, input.orders, orderId) : [],
      scope: 'CUSTOMER',
    }),
  )

  // Disable the derived packet proof while locating a filed document: a signed
  // packet must not make a bounced assignment's unrelated file look current.
  const fileScope: Omit<PresentDocTypesInput, 'documents'> = {
    scope: 'CUSTOMER', orderId,
    loadIds: orderId ? gateLoadIds(input.loads, input.orders, orderId) : [],
    loadCarriers: input.loadCarriers.map((lc) => ({ ...lc, rateConStatus: null })),
  }
  const chips = required.map((type) => {
    const doc = newestPresentDoc(input.documents, type, fileScope)
    return {
      type,
      label: (DOCUMENT_TYPE_LABELS as Record<string, string>)[type] ?? type,
      present: present.has(type),
      doc,
      derivedFromSignedRateCon: type === 'RATE_CON' && present.has('RATE_CON') && !doc,
    }
  })
  return {
    chips,
    unrecognised: customerRule.unrecognised,
    missingCount: chips.filter((chip) => !chip.present).length,
  }
}

/** KB below a megabyte: "0.1 MB" tells a reviewer nothing about a 90 KB photo. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
