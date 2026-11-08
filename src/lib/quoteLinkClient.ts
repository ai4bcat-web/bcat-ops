// The public quote link: the page a customer or a carrier opens from an e-mail.
//
// Nothing here may touch Cognito. The page that imports it is served outside the auth
// shell, so `apiClient`, `aws-amplify/data` and `aws-amplify/auth` are all off limits —
// importing any of them drags the Amplify client into the public bundle and makes an
// unauthenticated visitor's first paint depend on a session they do not have.
//
// URL priority matches `trackingClient.ts`, because it is the same Function URL:
// VITE_TRACKING_API_URL env var → amplify_outputs.json custom.trackingApiUrl.
import outputs from '../../amplify_outputs.json'
import type { QuotePublicView, QuoteResponseKind, QuoteStatus, QuoteLostReason } from '../types/tms'

export type { QuotePublicView, QuoteResponseKind }

const envUrl: string | undefined =
  typeof import.meta.env.VITE_TRACKING_API_URL === 'string' ? import.meta.env.VITE_TRACKING_API_URL : undefined
const rawOutputs = outputs as { custom?: { trackingApiUrl?: unknown } | undefined }
const customUrl: string | undefined =
  typeof rawOutputs.custom?.trackingApiUrl === 'string' ? rawOutputs.custom.trackingApiUrl : undefined
const QUOTE_API_URL = (envUrl ?? customUrl ?? '').replace(/\/+$/, '')

/**
 * Whether this build knows where to ask. False on a front end deployed before the
 * tracking API's output existed — the page then says so instead of spinning.
 */
export function quoteLinkAvailable(): boolean {
  return QUOTE_API_URL !== ''
}

/**
 * The server's own status, carried so the page can tell the three endings apart: 404 is
 * a dead link, 410 is "already answered", 429 is too many reads of the same link.
 */
export class QuoteLinkError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function quoteFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!QUOTE_API_URL) throw new QuoteLinkError(0, 'This quote link is not configured')
  let res: Response
  try {
    res = await fetch(`${QUOTE_API_URL}${path}`, { cache: 'no-store', ...init })
  } catch {
    // A dropped connection is not a verdict about the quote: say so in those words
    // rather than letting the page render "no longer active" over a flaky network.
    throw new QuoteLinkError(0, 'Could not reach us just now — check your connection and try again')
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new QuoteLinkError(res.status, body.error ?? 'Could not load this quote')
  return body as unknown as T
}

/** The quote as the other side is allowed to see it — never the row itself. */
export async function fetchQuoteLink(token: string): Promise<QuotePublicView> {
  return quoteFetch<QuotePublicView>(`/q/${encodeURIComponent(token)}`)
}

/**
 * One answer per round. The token is spent by the write, so a second press of the same
 * button comes back 410 — which is the truth, and what the page must say.
 *
 * `amountCents` is required by COUNTER and by a carrier's QUOTE; `reason` by DECLINE.
 * The server enforces both; sending the wrong shape is a 400 with its own wording.
 */
export interface QuoteLinkResponse {
  action: 'ACCEPT' | 'COUNTER' | 'DECLINE' | 'QUOTE' | 'PASS'
  amountCents?: number
  reason?: QuoteLostReason
  message?: string
  name: string
  email: string
}

export async function respondToQuote(
  token: string,
  body: QuoteLinkResponse,
): Promise<{ ok: true; status: QuoteStatus; response: QuoteResponseKind }> {
  return quoteFetch<{ ok: true; status: QuoteStatus; response: QuoteResponseKind }>(
    `/q/${encodeURIComponent(token)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

/**
 * The link the office copies out of a quote row, when SES was denied or the customer
 * wants it pasted somewhere else. Same shape the Lambda builds from `PORTAL_ORIGIN`,
 * so a copied link and a sent one are the same link.
 */
export function quoteLinkFor(token: string, origin: string = window.location.origin): string {
  return `${origin}/quote/${token}`
}
