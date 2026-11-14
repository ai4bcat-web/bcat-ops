/**
 * What a shipment's Documents section says about one of its loads: is a POD filed, when did
 * the first one land, and is a rate confirmation filed.
 *
 * The settlement and the driver app read POD and rate-con status from here as well as from
 * the driver/JobsDone stores, so a document filed on the shipment page shows on the
 * settlement too (Ryne, 2026-11-14: "settlements should use the same shipment page as their
 * source"). A document filed for the whole shipment (no loadId) counts for every load of it.
 * A voided, superseded or rejected document does not count; one waiting for review does —
 * it is on file, and a POD the driver sent must not hold their pay while it waits.
 *
 * Pure and import-free: the driver-app Lambda bundles it by relative path.
 */

export interface ShipmentDocLike {
  shipmentId?: string | null
  loadId?: string | null
  type?: string | null
  status?: string | null
  reviewStatus?: string | null
  uploadedAt?: string | null
}

export interface ShipmentDocPresence {
  pod: boolean
  /** Earliest POD upload, ISO, or null. */
  podUploadedAt: string | null
  ratecon: boolean
}

const RATE_CON_TYPES = new Set(['RATE_CON', 'CUSTOMER_RATE_CON'])

function counts(doc: ShipmentDocLike, loadId: string): boolean {
  if ((doc.status ?? 'ACTIVE') !== 'ACTIVE') return false
  if (doc.reviewStatus === 'REJECTED') return false
  return !doc.loadId || doc.loadId === loadId
}

export function shipmentDocPresence(docs: readonly ShipmentDocLike[] | null | undefined, loadId: string): ShipmentDocPresence {
  let pod = false
  let ratecon = false
  let podUploadedAt: string | null = null
  for (const doc of docs ?? []) {
    if (!counts(doc, loadId)) continue
    if (doc.type === 'POD') {
      pod = true
      if (doc.uploadedAt && (!podUploadedAt || doc.uploadedAt < podUploadedAt)) podUploadedAt = doc.uploadedAt
    } else if (RATE_CON_TYPES.has(String(doc.type ?? ''))) {
      ratecon = true
    }
  }
  return { pod, podUploadedAt, ratecon }
}
