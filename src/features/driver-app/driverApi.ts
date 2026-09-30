// Driver PWA client. Talks to the driver-app-api Lambda Function URL.
// URL priority: VITE_DRIVER_API_URL env var → amplify_outputs.json custom.driverApiUrl.
//
// This is the ONLY module in the driver app allowed to call fetch(). Everything the driver
// sees comes through here, and every request carries the driver's own id token — the server
// resolves which driver they are from that token and never from anything we send.
import outputs from '../../../amplify_outputs.json'

const envUrl: string | undefined =
  typeof import.meta.env.VITE_DRIVER_API_URL === 'string'
    ? import.meta.env.VITE_DRIVER_API_URL
    : undefined

const rawOutputs = outputs as {
  custom?: { driverApiUrl?: unknown; driverUserPoolId?: unknown; driverUserPoolClientId?: unknown }
}
const customUrl: string | undefined =
  typeof rawOutputs.custom?.driverApiUrl === 'string' ? rawOutputs.custom.driverApiUrl : undefined

export const DRIVER_API_URL = envUrl ?? customUrl ?? ''
export const driverApiAvailable = !!DRIVER_API_URL

export const DRIVER_USER_POOL_ID: string =
  typeof rawOutputs.custom?.driverUserPoolId === 'string' ? rawOutputs.custom.driverUserPoolId : ''
export const DRIVER_USER_POOL_CLIENT_ID: string =
  typeof rawOutputs.custom?.driverUserPoolClientId === 'string'
    ? rawOutputs.custom.driverUserPoolClientId
    : ''

export class DriverApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'DriverApiError'
  }
}

// ── Wire types ───────────────────────────────────────────────────────────────

export type SubmissionKind = 'RATECON' | 'POD'
export type SubmissionStatus = 'NEW' | 'NOTIFIED' | 'LINKED' | 'ARCHIVED'

export interface DriverProfile {
  driverId: string
  name: string
  email: string
  payGroup: string
  active: boolean
}

export interface SettlementTrip {
  id: string
  date: string
  loadId?: string | null
  origin?: string | null
  destination?: string | null
  miles?: number | null
  rate?: number | null
  amount: number
}

export interface SettlementLine {
  label: string
  amount: number
}

export interface Settlement {
  weekStart: string
  weekLabel: string
  trips: SettlementTrip[]
  grossPay: number
  deductions: SettlementLine[]
  credits: SettlementLine[]
  debits: SettlementLine[]
  checkAmount: number
}

export interface SettlementWeek {
  weekStart: string
  gross: number
  net: number
  tripCount: number
}

export interface SubmissionDoc {
  id: string
  kind: SubmissionKind
  fileName: string
  contentType: string
  pageNumber: number
  uploadedAt: string
}

export interface SubmissionSummary {
  id: string
  status: SubmissionStatus
  referenceNumber?: string | null
  note?: string | null
  loadId?: string | null
  createdAt: string
  notifiedAt?: string | null
  docs: SubmissionDoc[]
}

/** One page the driver captured, ready to hand to the server for a presigned PUT. */
export interface PendingPage {
  fileName: string
  contentType: string
  byteSize: number
  blob: Blob
}

interface UploadTarget {
  pageNumber: number
  url: string
  s3Key: string
}

// ── Session plumbing ─────────────────────────────────────────────────────────

/**
 * Supplies a fresh id token. DriverAuthProvider installs this at startup so the API module
 * never has to know how tokens are stored or refreshed.
 */
type TokenSupplier = () => Promise<string | null>

let getToken: TokenSupplier = async () => null

export function setDriverTokenSupplier(supplier: TokenSupplier): void {
  getToken = supplier
}

/** Every driver route is authenticated — there is deliberately no unauthenticated path. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DRIVER_API_URL) throw new DriverApiError(0, 'Driver API is not configured')
  const token = await getToken()
  if (!token) throw new DriverApiError(401, 'Your session expired. Sign in again.')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
  const res = await fetch(`${DRIVER_API_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${res.status})`
    throw new DriverApiError(res.status, message)
  }
  return body as T
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function fetchMe(): Promise<DriverProfile> {
  return request<DriverProfile>('/me')
}

export async function fetchSettlementWeeks(): Promise<SettlementWeek[]> {
  const out = await request<{ weeks: SettlementWeek[] }>('/settlement/weeks')
  return out.weeks
}

export function fetchSettlement(weekStart: string): Promise<Settlement> {
  return request<Settlement>(`/settlement?week=${encodeURIComponent(weekStart)}`)
}

export async function fetchSubmissions(): Promise<SubmissionSummary[]> {
  const out = await request<{ submissions: SubmissionSummary[] }>('/submissions')
  return out.submissions
}

export async function fetchDocUrl(submissionId: string, docId: string): Promise<string> {
  const out = await request<{ url: string }>(
    `/submissions/${encodeURIComponent(submissionId)}/doc/${encodeURIComponent(docId)}/url`,
  )
  return out.url
}

/** PUTs one page straight to S3 with the presigned URL the server just handed us. */
async function putPage(target: UploadTarget, page: PendingPage): Promise<void> {
  const res = await fetch(target.url, {
    method: 'PUT',
    headers: { 'content-type': page.contentType },
    body: page.blob,
  })
  if (!res.ok) throw new DriverApiError(res.status, `Upload failed for ${page.fileName}`)
}

function pageMeta(pages: PendingPage[]) {
  return pages.map((p) => ({ fileName: p.fileName, contentType: p.contentType, byteSize: p.byteSize }))
}

/**
 * Creates a submission from a scanned rate confirmation: reserve → upload every page → complete.
 * `complete` is what fires the email and the Slack post, so it runs only after S3 has the bytes.
 */
export async function submitRatecon(input: {
  pages: PendingPage[]
  referenceNumber?: string
  note?: string
}): Promise<string> {
  const created = await request<{ submissionId: string; uploads: UploadTarget[] }>('/submissions', {
    method: 'POST',
    body: JSON.stringify({
      referenceNumber: input.referenceNumber,
      note: input.note,
      pages: pageMeta(input.pages),
    }),
  })
  await Promise.all(created.uploads.map((t, i) => putPage(t, input.pages[i])))
  await request(`/submissions/${encodeURIComponent(created.submissionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'RATECON' }),
  })
  return created.submissionId
}

/** Adds POD pages to an existing submission; the server replies into the same email + Slack thread. */
export async function submitPod(submissionId: string, pages: PendingPage[]): Promise<void> {
  const created = await request<{ uploads: UploadTarget[] }>(
    `/submissions/${encodeURIComponent(submissionId)}/pod`,
    { method: 'POST', body: JSON.stringify({ pages: pageMeta(pages) }) },
  )
  await Promise.all(created.uploads.map((t, i) => putPage(t, pages[i])))
  await request(`/submissions/${encodeURIComponent(submissionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'POD' }),
  })
}
