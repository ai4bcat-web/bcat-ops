// Public truck tracking: the page behind a truck's permanent link.
// URL priority: VITE_TRACKING_API_URL env var → amplify_outputs.json custom.trackingApiUrl.
import outputs from '../../amplify_outputs.json'
import type {
  CarrierTrackingView, CarrierUploadView, CustomerTrackingView, ShipmentDocumentType,
} from '../types/tms'

export type { CarrierTrackingView, CarrierUploadView, CustomerTrackingView }

const envUrl: string | undefined =
  typeof import.meta.env.VITE_TRACKING_API_URL === 'string' ? import.meta.env.VITE_TRACKING_API_URL : undefined
const rawOutputs = outputs as { custom?: { trackingApiUrl?: unknown } | undefined }
const customUrl: string | undefined =
  typeof rawOutputs.custom?.trackingApiUrl === 'string' ? rawOutputs.custom.trackingApiUrl : undefined
export const TRACKING_API_URL = (envUrl ?? customUrl ?? '').replace(/\/+$/, '')

export interface TrackingView {
  unit: string
  driver: string | null
  position: { lat: number; lon: number; description: string | null; locatedAt: string } | null
  load: { pro: string | null; lane: string; eta: { at: string; basis: 'motive' | 'appt' } | null } | null
  generatedAt: string
}

export class TrackingError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export async function fetchTracking(code: string): Promise<TrackingView> {
  if (!TRACKING_API_URL) throw new TrackingError(0, 'Tracking is not configured')
  const res = await fetch(`${TRACKING_API_URL}/t/${encodeURIComponent(code)}`, { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new TrackingError(res.status, body.error ?? 'Could not load tracking')
  return body as unknown as TrackingView
}

/**
 * The two tokenised Step D links. The token is the whole credential, so nothing else
 * is sent and the server's own wording — expired, too imprecise, too soon — is what
 * the page shows.
 */
async function linkFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!TRACKING_API_URL) throw new TrackingError(0, 'Tracking is not configured')
  const res = await fetch(`${TRACKING_API_URL}${path}`, { cache: 'no-store', ...init })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new TrackingError(res.status, body.error ?? 'Could not load tracking')
  return body as unknown as T
}

export async function fetchCustomerTracking(token: string): Promise<CustomerTrackingView> {
  return linkFetch<CustomerTrackingView>(`/s/${encodeURIComponent(token)}`)
}

export async function fetchCarrierTracking(token: string): Promise<CarrierTrackingView> {
  return linkFetch<CarrierTrackingView>(`/l/${encodeURIComponent(token)}`)
}

/** One tap of the driver's page. 409 means the fix is too coarse, 429 means too soon. */
export async function postTrackingPing(
  token: string,
  fix: { lat: number; lng: number; accuracyM: number | null },
): Promise<{ ok: true; at: string }> {
  return linkFetch<{ ok: true; at: string }>(`/l/${encodeURIComponent(token)}/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fix),
  })
}

/**
 * The carrier upload portal, step E's third tokenised link. Three calls in order: read
 * what the load still needs, ask for a presigned PUT, send the bytes with
 * `putPresignedFile`, then commit so the file becomes a document somebody can review.
 * Nothing but the token identifies the caller, and nothing about the customer or the
 * money is in the view at all.
 */
export async function fetchCarrierUpload(token: string): Promise<CarrierUploadView> {
  return linkFetch<CarrierUploadView>(`/u/${encodeURIComponent(token)}`)
}

/** The file the carrier picked, as both the sign and the commit call describe it. */
export interface PortalUploadMeta {
  type: ShipmentDocumentType
  name: string
  contentType: string
  sizeBytes: number
}

/** A presigned PUT pinned to that type and length. 429 means the link is full. */
export interface PortalUploadTicket {
  uploadUrl: string
  s3Key: string
  documentId: string
}

export async function requestUpload(token: string, meta: PortalUploadMeta): Promise<PortalUploadTicket> {
  return linkFetch<PortalUploadTicket>(`/u/${encodeURIComponent(token)}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  })
}

/**
 * Records the file as a document pending review. A 409 means the bytes have not
 * landed in S3 yet — retryable, unlike the 400s. Answers with the row it wrote, not a
 * view, so the page re-fetches `fetchCarrierUpload` to refresh its checklist.
 */
export async function commitUpload(
  token: string,
  meta: PortalUploadMeta & { documentId: string; s3Key: string },
): Promise<{ ok: true; documentId: string; uploadedAt?: string }> {
  return linkFetch<{ ok: true; documentId: string; uploadedAt?: string }>(`/u/${encodeURIComponent(token)}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  })
}

/** A fresh, unguessable code: 12 characters from an alphabet with no look-alikes. */
export function newTrackingCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** The link the office hands out: our own domain, never Motive's. */
export function trackingLinkFor(code: string, origin: string = window.location.origin): string {
  return `${origin}/track/${code}`
}
