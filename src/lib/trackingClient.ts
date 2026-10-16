// Public truck tracking: the page behind a truck's permanent link.
// URL priority: VITE_TRACKING_API_URL env var → amplify_outputs.json custom.trackingApiUrl.
import outputs from '../../amplify_outputs.json'

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
