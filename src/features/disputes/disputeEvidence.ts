/**
 * Evidence bookkeeping for a dispute.
 *
 * One AWSJSON array on `AmazonDispute` holds two very different things: the files the
 * driver uploaded through the public portal (CONFIRMATION + PHOTO, written under
 * dispute-proofs/ and NOT writable by staff) and the Amazon reply screenshots staff add
 * from /disputes (AMAZON_RESPONSE, under dispute-responses/). Every staff save rewrites
 * the whole array, so the split lives here: a response edit must never drop the driver's
 * proof, which is the only copy tying the claim to the trip.
 */
import type { DisputeEvidence } from '@/types/dispute'

/** Same ceiling the public portal Lambda enforces on driver uploads. */
export const MAX_RESPONSE_FILE_BYTES = 10 * 1024 * 1024

/** SVG is excluded: staff open evidence from a signed S3 URL, where a scripted SVG runs. */
const IMAGE_TYPE = /^image\/(?!svg)[a-z0-9.+-]+$/
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff']
const PDF_TYPE = 'application/pdf'

export function driverEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind !== 'AMAZON_RESPONSE')
}

export function responseEvidence(evidence?: DisputeEvidence[] | null): DisputeEvidence[] {
  return (evidence ?? []).filter((e) => e.kind === 'AMAZON_RESPONSE')
}

/**
 * The array to persist after a staff response edit: the driver's files exactly as they
 * were, followed by the response screenshots that survived the edit plus any new ones.
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
    return 'Attach a screenshot (PNG, JPG, HEIC\u2026) or a PDF of Amazon\u2019s reply.'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > MAX_RESPONSE_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`
  }
  return null
}
