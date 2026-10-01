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

export const MAX_SCAN_PAGES = 12
export const SCAN_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
export const SCAN_ACCEPTED_TYPES_STRING = SCAN_ACCEPTED_TYPES.join(',')

export class DriverApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'DriverApiError'
  }
}

/**
 * Thrown when a submission was created on the server but a later step (page upload or
 * complete) failed. The caller can retry with `resumeFromId` to avoid creating a duplicate
 * submission for the same scan.
 */
export class ResumableDriverApiError extends DriverApiError {
  submissionId: string
  kind: SubmissionKind

  constructor(status: number, message: string, submissionId: string, kind: SubmissionKind) {
    super(status, message)
    this.submissionId = submissionId
    this.kind = kind
    this.name = 'ResumableDriverApiError'
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

/**
 * Per-trip factoring readiness the server computes from the Load and its linked Customer /
 * Location rows. Mirrors FactoringFields in amplify/functions/driver-app-api/settlement.ts.
 */
export interface FactoringFields {
  invoiceNo: string | null
  poNumber: string | null
  brokerMc: string | null
  invoiceAmount: number | null
  invoiceDate: string | null
  fromCity: string | null
  fromState: string | null
  fromZip: string | null
  toCity: string | null
  toState: string | null
  toZip: string | null
  podPresent: boolean
  rateconPresent: boolean
  /** True when any required field or document is missing. */
  blocked: boolean
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
  factoring?: FactoringFields | null
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

interface CreateSubmissionResponse {
  submissionId: string
  uploads: UploadTarget[]
}

interface UploadListResponse {
  uploads: UploadTarget[]
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
        : 'Something went wrong on our side. Please try again in a minute.'
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
  // Drivers see this text verbatim, so it names the page they can see on screen — never the
  // generated file name or the HTTP status.
  if (!res.ok) {
    throw new DriverApiError(
      res.status,
      `Page ${target.pageNumber} did not finish sending. Check your signal and try again.`,
    )
  }
}

function pageMeta(pages: PendingPage[]) {
  return pages.map((p) => ({ fileName: p.fileName, contentType: p.contentType, byteSize: p.byteSize }))
}

function completeSubmission(submissionId: string, kind: SubmissionKind): Promise<unknown> {
  return request(`/submissions/${encodeURIComponent(submissionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
  })
}

function wrapWithResume(
  err: unknown,
  submissionId: string,
  kind: SubmissionKind,
): ResumableDriverApiError | DriverApiError {
  if (err instanceof ResumableDriverApiError) return err
  if (err instanceof DriverApiError) {
    return new ResumableDriverApiError(err.status, err.message, submissionId, kind)
  }
  // A raw network/DOM error message ("Failed to fetch", "Load failed") means nothing to a
  // driver, so it never reaches the screen.
  return new ResumableDriverApiError(
    0,
    'Your phone lost the connection before we finished. Try again when you have signal.',
    submissionId,
    kind,
  )
}

/**
 * Reserves a new submission (or re-opens an existing one for resume) and returns fresh
 * presigned upload targets. This is the lower-level primitive used by submitRatecon and
 * submitStandalonePod.
 */
export async function createSubmission(input: {
  kind: SubmissionKind
  pages: PendingPage[]
  referenceNumber?: string
  note?: string
  resumeFromId?: string
}): Promise<CreateSubmissionResponse> {
  if (input.resumeFromId) {
    const out = await request<UploadListResponse>(
      `/submissions/${encodeURIComponent(input.resumeFromId)}/uploads?kind=${encodeURIComponent(input.kind)}`,
    )
    return { submissionId: input.resumeFromId, uploads: out.uploads }
  }

  const out = await request<CreateSubmissionResponse>('/submissions', {
    method: 'POST',
    body: JSON.stringify({
      kind: input.kind,
      referenceNumber: input.referenceNumber,
      note: input.note,
      pages: pageMeta(input.pages),
    }),
  })
  return out
}

/**
 * Creates a submission from a scanned rate confirmation: reserve → upload every page → complete.
 * `complete` is what fires the email and the Slack post, so it runs only after S3 has the bytes.
 *
 * If a page upload fails, the error carries the created `submissionId` so the caller can retry
 * with `resumeFromId` instead of creating a second submission for the same scan.
 */
export async function submitRatecon(input: {
  pages: PendingPage[]
  referenceNumber?: string
  note?: string
  resumeFromId?: string
}): Promise<string> {
  const { submissionId, uploads } = await createSubmission({ kind: 'RATECON', ...input })
  try {
    await Promise.all(uploads.map((t, i) => putPage(t, input.pages[i])))
    await completeSubmission(submissionId, 'RATECON')
  } catch (err) {
    throw wrapWithResume(err, submissionId, 'RATECON')
  }
  return submissionId
}

/**
 * Creates a brand-new POD submission for a load the driver could not find in their list.
 * The submission is identified by a reference/load number the driver enters.
 */
export async function submitStandalonePod(input: {
  pages: PendingPage[]
  referenceNumber?: string
  note?: string
  resumeFromId?: string
}): Promise<string> {
  const { submissionId, uploads } = await createSubmission({ kind: 'POD', ...input })
  try {
    await Promise.all(uploads.map((t, i) => putPage(t, input.pages[i])))
    await completeSubmission(submissionId, 'POD')
  } catch (err) {
    throw wrapWithResume(err, submissionId, 'POD')
  }
  return submissionId
}

/** Adds POD pages to an existing submission; the server replies into the same email + Slack thread. */
export async function submitPod(
  submissionId: string,
  pages: PendingPage[],
  { resume = false }: { resume?: boolean } = {},
): Promise<void> {
  let uploads: UploadTarget[]

  if (resume) {
    const out = await request<UploadListResponse>(
      `/submissions/${encodeURIComponent(submissionId)}/uploads?kind=POD`,
    )
    uploads = out.uploads
  } else {
    const out = await request<UploadListResponse>(
      `/submissions/${encodeURIComponent(submissionId)}/pod`,
      { method: 'POST', body: JSON.stringify({ pages: pageMeta(pages) }) },
    )
    uploads = out.uploads
  }

  try {
    await Promise.all(uploads.map((t, i) => putPage(t, pages[i])))
    await completeSubmission(submissionId, 'POD')
  } catch (err) {
    throw wrapWithResume(err, submissionId, 'POD')
  }
}
