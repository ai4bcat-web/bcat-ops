/**
 * Evidence bookkeeping for a dispute.
 *
 * One AWSJSON array on `AmazonDispute` holds three kinds of files:
 *   - files the driver uploaded through the public portal (CONFIRMATION + PHOTO, written
 *     under dispute-proofs/ and NOT writable by staff)
 *   - files staff upload when creating/editing a manual dispute (CONFIRMATION + PHOTO,
 *     written under dispute-staff-proofs/; staff can replace or remove their own)
 *   - the Amazon reply screenshots staff add from /disputes (AMAZON_RESPONSE, under
 *     dispute-responses/).
 *
 * Every staff save rewrites the whole array, so the split lives here: a response edit must
 * never drop the driver's proof, which is the only copy tying the claim to the trip.
 */
import { MAX_DISPUTE_FILE_BYTES, fileContentType, PDF_TYPE } from '@/lib/disputeFiles'
import type { DisputeEvidence } from '@/types/dispute'

export { MAX_DISPUTE_FILE_BYTES, fileContentType }

/** SVG is excluded: staff open evidence from a signed S3 URL, where a scripted SVG runs. */
const IMAGE_TYPE = /^image\/(?!svg)[a-z0-9.+-]+$/
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff']

/** All non-response evidence: portal driver uploads plus staff manual proofs. */
export function driverEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind !== 'AMAZON_RESPONSE')
}

/** Driver portal uploads only (dispute-proofs/). Read-only for staff. */
export function portalDriverEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind !== 'AMAZON_RESPONSE' && e.s3Key.startsWith('dispute-proofs/'))
}

/** Staff manual proof uploads only (dispute-staff-proofs/). Staff can replace/remove. */
export function staffProofEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind !== 'AMAZON_RESPONSE' && e.s3Key.startsWith('dispute-staff-proofs/'))
}

export function responseEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind === 'AMAZON_RESPONSE')
}

/**
 * The array to persist after a staff response edit: the non-response evidence exactly as
 * it was, followed by the response screenshots that survived the edit plus any new ones.
 */
export function mergeDisputeEvidence(
  existing: DisputeEvidence[] | null | undefined,
  nextResponses: DisputeEvidence[],
): DisputeEvidence[] {
  return [...driverEvidence(existing), ...nextResponses]
}

export function isImageEvidence(item: DisputeEvidence): boolean {
  if (IMAGE_TYPE.test(item.contentType?.toLowerCase() ?? '')) return true
  const ext = item.s3Key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.includes(ext)
}

export function isPdfEvidence(item: DisputeEvidence): boolean {
  return item.contentType?.toLowerCase() === PDF_TYPE || item.s3Key.toLowerCase().endsWith('.pdf')
}

/** HEIC/HEIF come straight off an iPhone and no browser renders them in an <img>. */
export function isBrowserRenderable(item: DisputeEvidence): boolean {
  if (isPdfEvidence(item)) return false
  if (!isImageEvidence(item)) return false
  const ext = item.s3Key.split('.').pop()?.toLowerCase() ?? ''
  const type = item.contentType?.toLowerCase() ?? ''
  return !/hei[cf]/.test(`${ext} ${type}`)
}

export function evidenceSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** A download filename that stays unique when two files share a name. */
export function evidenceFileName(item: DisputeEvidence): string {
  return item.fileName?.trim() || item.s3Key.split('/').pop() || 'evidence'
}

/**
 * Why a staff-picked file can't be attached, or null when it is fine. Some platforms hand
 * back an empty `type` for HEIC and for files dragged out of desktop apps, so the name
 * extension decides when the browser couldn't — the same fallback the portal Lambda uses.
 */
export function responseFileRejection(file: { name?: string; type: string; size: number }): string | null {
  const type = file.type.toLowerCase()
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? ''
  const knownType = IMAGE_TYPE.test(type) || type === PDF_TYPE
  const knownExtension = !type && (IMAGE_EXTENSIONS.includes(ext) || ext === 'pdf')
  if (!knownType && !knownExtension) {
    return 'Attach a screenshot (PNG, JPG, HEIC…) or a PDF of Amazon’s reply.'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > MAX_DISPUTE_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`
  }
  return null
}

/** Confirmation file for a staff-created manual dispute: image or PDF, 10 MB max. */
export function staffConfirmationRejection(file: { name?: string; type: string; size: number }): string | null {
  const type = file.type.toLowerCase()
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? ''
  const knownType = IMAGE_TYPE.test(type) || type === PDF_TYPE
  const knownExtension = !type && (IMAGE_EXTENSIONS.includes(ext) || ext === 'pdf')
  if (!knownType && !knownExtension) {
    return 'Attach a screenshot (PNG, JPG, HEIC…) or a PDF of the trip confirmation.'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > MAX_DISPUTE_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`
  }
  return null
}

/** Supporting photo for a staff-created manual dispute: image only, 10 MB max. */
export function staffPhotoRejection(file: { name?: string; type: string; size: number }): string | null {
  const type = file.type.toLowerCase()
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? ''
  const knownType = IMAGE_TYPE.test(type)
  const knownExtension = !type && IMAGE_EXTENSIONS.includes(ext)
  if (!knownType && !knownExtension) {
    return 'Attach an image (PNG, JPG, HEIC…).'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > MAX_DISPUTE_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`
  }
  return null
}
