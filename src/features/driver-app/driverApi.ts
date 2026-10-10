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
/*
 * What the file picker offers: any image, plus PDF.
 *
 * It used to name four formats, which on an iPhone greyed out the driver's own camera roll
 * — photos there are HEIC — while the Files app handed the same file through anyway. A
 * driver should never be told their photo of a signed POD is the wrong kind of photo.
 *
 * Anything an image is, we take. prepareFile downscales what the browser can decode and
 * sends the rest as it came, and the server cleans PODs after the fact.
 */
export const SCAN_ACCEPT_ATTRIBUTE = 'image/*,application/pdf'

/** True for a file this app will carry: any image, or a PDF. */
export function isAcceptedScanFile(contentType: string, fileName = ''): boolean {
  const type = (contentType || '').toLowerCase()
  if (type.startsWith('image/')) return true
  if (type === 'application/pdf') return true
  // A file picked from some Android file managers arrives with no type at all.
  return /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(fileName)
}

export const SCAN_ACCEPTED_TYPES_STRING = SCAN_ACCEPT_ATTRIBUTE

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

/** MISC: photos or other paperwork from a stop — kept as taken, never merged. */
export type SubmissionKind = 'RATECON' | 'POD' | 'MISC'
export type SubmissionStatus = 'NEW' | 'NOTIFIED' | 'LINKED' | 'ARCHIVED'

export interface DriverProfile {
  driverId: string
  name: string
  email: string
  payGroup: string
  /** Which page this driver gets. See src/lib/driverProgram.ts. */
  program: 'SETTLEMENT' | 'PAPERWORK'
  active: boolean
  /*
   * The driver's own truck's next PM, or null when no truck is assigned.
   *
   * Optional as well as nullable because the app is a PWA: a cached bundle can meet an API
   * that predates the field. Absent and null both mean "show nothing".
   */
  pm?: DriverPm | null
  /** The truck the driver is in, or null until they pick one. Optional: older API. */
  truck?: DriverTruck | null
  /** The dispatch number to call or text, E.164; null until Dispatch is set up. Optional: older API. */
  dispatchPhone?: string | null
  /** Hours tab on? Ivan's fleet by default; staff can override on the driver file. Optional: older API. */
  timeClock?: boolean | null
}

export interface DriverTruck {
  id: string
  unitNumber: string
}

export interface TruckChoice extends DriverTruck {
  /** Has a Motive gateway — picking it is what puts the ELD logs on this driver's name. */
  eld: boolean
  /** Who is in it now, if anyone. */
  holder: string | null
  yours: boolean
}

export async function fetchTrucks(): Promise<TruckChoice[]> {
  const out = await request<{ trucks: TruckChoice[] }>('/trucks')
  return out.trucks
}

/** I am in this truck today. */
export async function selectTruck(truckId: string): Promise<{ truck: DriverTruck }> {
  return request('/me/truck', { method: 'POST', body: JSON.stringify({ truckId }) })
}

/** Mirrors pmStatus() in src/lib/pmDue.ts, plus the truck's unit number. */
export interface DriverPm {
  state: 'OVERDUE' | 'DUE_SOON' | 'OK' | 'UNKNOWN'
  nextDueAt: number | null
  remaining: number | null
  currentOdometer: number | null
  lastPmMileage: number | null
  lastPmDate: string | null
  /** Already phrased for a driver by the API; the app shows it verbatim. */
  label: string
  truckNumber: string | null
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
  /** Rate per mile, not the freight. */
  rate?: number | null
  /** Gross freight on the load, dollars. Optional only so a fixture or an older API still types. */
  freight?: number | null
  amount: number
  /** False when listed but not paid on this check. Older APIs omit it; treat missing as on-check. */
  onThisCheck?: boolean
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
  /** Σ freight on this check — the desktop's "Freight total". */
  grossPay: number
  /** Σ driver share on this check. Optional: an older API does not send it. */
  driverAmount?: number
  payPercent?: number
  /** Σ freight held off this check, so the footer can say what it excludes. */
  heldFreight?: number
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
  /** True once the cleanup produced a readable copy; that copy is what the url serves. */
  enhanced?: boolean
  scanStatus?: string | null
}

/**
 * The finished document per kind — the merged PDF where one exists, otherwise the single
 * page that is standing in for it until the merge runs. This is what a driver previews:
 * a POD is one document, not a pile of photos, and the office only ever sends the one.
 */
export interface SubmissionDocument {
  kind: SubmissionKind
  /** Pass to fetchDocUrl. `combined-POD` addresses the merged PDF. */
  docId: string
  pageCount: number
  enhanced: boolean
  contentType: string
  combined: boolean
}

export interface SubmissionSummary {
  id: string
  status: SubmissionStatus
  referenceNumber?: string | null
  note?: string | null
  loadId?: string | null
  /** Where a MISC submission was taken. */
  stopId?: string | null
  stopLabel?: string | null
  createdAt: string
  notifiedAt?: string | null
  docs: SubmissionDoc[]
  documents?: SubmissionDocument[]
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

/**
 * The driver an admin is viewing as, or null for an ordinary driver session.
 *
 * Set from the staff app, which then supplies a STAFF token instead of a driver one. The
 * API only consults the staff pool when this header is present, only accepts an admin, and
 * refuses every write — so this is a request to LOOK, and the server treats it as one
 * regardless of what the client believes.
 */
let impersonatingDriverId: string | null = null

export function setDriverImpersonation(driverId: string | null): void {
  impersonatingDriverId = driverId
}

export function isImpersonating(): boolean {
  return impersonatingDriverId !== null
}

/** Every driver route is authenticated — there is deliberately no unauthenticated path. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DRIVER_API_URL) throw new DriverApiError(0, 'Driver API is not configured')
  const token = await getToken()
  // A missing token now usually means we could not reach Cognito to refresh, not
  // that the session is dead — a genuinely rejected session shows the sign-in
  // screen instead of ever reaching here.
  if (!token) throw new DriverApiError(401, "Couldn't verify your session. Check your connection and try again.")
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
  if (impersonatingDriverId) headers['x-bcat-impersonate-driver'] = impersonatingDriverId
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

/* ── Hours of service (Ivan only, read-only) ──────────────────────────────────
 * Mirrors src/lib/motiveHos.ts. Read-only on purpose: duty status is a federal record and
 * the FMCSA requires edits to go through the certified ELD, so the app shows what Motive
 * holds and sends the driver to Motive to change it.
 */

export interface HosSegment {
  type: string
  startAt: string
  endAt: string | null
  location: string | null
}

export interface HosDay {
  date: string
  drivingSeconds: number
  onDutySeconds: number
  offDutySeconds: number
  sleeperSeconds: number
  workedSeconds: number
  totalMiles: number | null
  vehicleNumbers: string[]
  firstOnDutyAt: string | null
  lastOffDutyAt: string | null
  segments: HosSegment[]
}

export interface HosResponse {
  date: string
  linked: boolean
  day: HosDay | null
  /** Why there is nothing to show, when linked is false. */
  reason?: string
}

/** This driver's duty status for one day. `date` is YYYY-MM-DD. */
export function fetchHosDay(date: string): Promise<HosResponse> {
  return request<HosResponse>(`/motive/day?date=${encodeURIComponent(date)}`)
}

/* ── Time clock (Ivan only) ───────────────────────────────────────────────── */

export interface TimeClockRow {
  id: string
  driverId: string
  workDate: string
  kind: 'WORK' | 'HOLIDAY' | 'PTO'
  clockInAt?: string | null
  clockOutAt?: string | null
  minutes?: number | null
  note?: string | null
  source?: 'DRIVER' | 'STAFF' | null
  correctedBy?: string | null
  correctedAt?: string | null
  originalMinutes?: number | null
}

export interface TimeClockDay {
  date: string
  workedMinutes: number
  holidayMinutes: number
  ptoMinutes: number
  totalMinutes: number
  open: boolean
  rows: TimeClockRow[]
}

export interface TimeClockWeek {
  weekStart: string
  weekEnd: string
  days: TimeClockDay[]
  workedMinutes: number
  holidayMinutes: number
  ptoMinutes: number
  totalMinutes: number
  open: boolean
}

export interface OvernightLoadRow {
  id: string
  reference: string
  origin: string | null
  destination: string | null
  deliveredOn: string | null
  /** CENTS. */
  rateCents: number | null
}

export interface OvernightPeriod {
  weekStart: string
  loads: OvernightLoadRow[]
  /** What the period's overnight runs earned, in CENTS. Gross — nothing is deducted. */
  grossCents: number
}

export interface TimeClockResponse {
  today: string
  week: TimeClockWeek
  /** Recent week starts, newest first. */
  weeks: string[]
  openShift: TimeClockRow | null
  ptoEligible: boolean
  /** True when staff are viewing a driver's app. Punching is refused server-side. */
  readOnly?: boolean
  /** The pay period's overnight runs. Absent on an API that predates them. */
  overnight?: OvernightPeriod
}

export function fetchTimeClock(weekStart?: string): Promise<TimeClockResponse> {
  const q = weekStart ? `?week=${encodeURIComponent(weekStart)}` : ''
  return request<TimeClockResponse>(`/timeclock${q}`)
}

export function punchTimeClock(
  action: 'IN' | 'OUT' | 'HOLIDAY' | 'PTO',
  opts: { date?: string; note?: string } = {},
): Promise<{ ok: boolean; openShift?: TimeClockRow | null; alreadyOpen?: boolean }> {
  return request('/timeclock/punch', { method: 'POST', body: JSON.stringify({ action, ...opts }) })
}

/* ── Ivan paperwork ────────────────────────────────────────────────────────────
 * Mirrors amplify/functions/driver-app-api/paperwork.ts. Note what is NOT here: no
 * rate, no amount, no deductions, no check. The payload has no money in it.
 */

export interface PaperworkStop {
  id: string
  type: string
  sequence: number
  name: string | null
  street?: string | null
  city: string | null
  state: string | null
  zip?: string | null
  appt: string | null
  apptType: string | null
  apptEnd: string | null
  /** Chicago calendar day of the appointment, YYYY-MM-DD. */
  date: string | null
  /** The directory record behind the stop: hours, dock notes, what drivers said. */
  location?: {
    id: string
    hours: string | null
    dockNotes: string | null
    notes: string | null
    driverNotes: Array<{ at: string; by: string; text: string }>
  } | null
  /** The driver flagged detention here — two hours or more past the appointment. */
  detention: boolean
  /** This stop is the viewing driver's to work. */
  yours: boolean
  arrivedAt: string | null
  departedAt: string | null
  /** Expected arrival once the pickup is departed: from the truck (motive) or the appointment. */
  etaAt: string | null
  etaBasis: 'motive' | 'appt' | null
}

export type PodLegibility = 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'

export interface PaperworkPod {
  present: boolean
  pages: number
  legibility: PodLegibility
  notes: string | null
}

/** Whether the run needs records of duty status — the 150 air-mile rule. */
export interface PaperworkEld {
  status: 'NOT_REQUIRED' | 'REQUIRED' | 'UNKNOWN'
  required: boolean
  farthestMiles: number | null
  farthestCity: string | null
  /** Already phrased for a driver by the API; the app shows it verbatim. */
  label: string
}

export interface PaperworkLoad {
  id: string
  reference: string
  /** The customer's PO — the load's "TMS ID / PO". */
  poNumber?: string | null
  pickupNumber?: string | null
  customer: string | null
  deliveryAppt: string | null
  pickupAppt: string | null
  origin: string | null
  destination: string | null
  miles: number | null
  trailerNumber: string | null
  commodity: string | null
  weight: number | null
  pieces: number | null
  notes: string | null
  status: string | null
  stops: PaperworkStop[]
  pod: PaperworkPod
  /*
   * Optional because the app is a PWA: a cached bundle can meet an API that predates this
   * field, and a new bundle can be served a response from one. Absent is treated as "we
   * don't know", never as "no logs needed".
   */
  eld?: PaperworkEld
  /** An overnight run — to or from Iowa. */
  overnight?: boolean
  /*
   * The rate in CENTS, and only ever on an overnight run.
   *
   * The single exception to this payload carrying no money: Ivan drivers are not settled a
   * percentage, so every other load reaches the app without a rate at all.
   */
  rateCents?: number | null
}

export interface Paperwork {
  weekStart: string
  /** The Chicago calendar day the API considers today — what the day sheet is built on. */
  today?: string
  loads: PaperworkLoad[]
  loadCount: number
  podsMissing: number
  podsIllegible: number
  eldRequired?: number
  overnightCount?: number
  /** What the period's overnight runs earned, in CENTS. */
  overnightCents?: number
}

export interface PaperworkWeek {
  weekStart: string
  loadCount: number
  podsMissing: number
  podsIllegible: number
  eldRequired?: number
  overnightCount?: number
  overnightCents?: number
}

export async function fetchPaperworkWeeks(): Promise<PaperworkWeek[]> {
  const out = await request<{ weeks: PaperworkWeek[] }>('/paperwork/weeks')
  return out.weeks
}

export async function fetchPaperwork(weekStart: string): Promise<Paperwork> {
  return request<Paperwork>(`/paperwork?week=${encodeURIComponent(weekStart)}`)
}

export type StopEvent = 'ARRIVED' | 'DEPARTED'

/** On site at / departed one of the driver's stops. Returns the stamp and any ETA it set. */
export async function recordStopEvent(input: { loadId: string; stopId: string; event: StopEvent }): Promise<{
  at: string
  eta: { stopId: string; etaAt: string; basis: 'motive' | 'appt' } | null
}> {
  return request('/paperwork/stop-event', { method: 'POST', body: JSON.stringify(input) })
}

export interface DriverMaintenanceTask {
  id: string
  title: string
  priority: 'high' | 'med' | 'low'
  status: 'upcoming' | 'complete'
  notes: string | null
  dueDate: string | null
  completedDate: string | null
  createdAt: string
  reportedByMe: boolean
}

/** The maintenance tasks open on the driver's truck, theirs and the shop's. */
export async function listMaintenanceTasks(): Promise<{ truck: DriverTruck | null; tasks: DriverMaintenanceTask[] }> {
  return request('/maintenance-tasks')
}

/** Report a problem with the truck. Becomes a task on the unit for the shop. */
export async function reportMaintenanceTask(input: { title: string; notes?: string; priority?: 'high' | 'med' | 'low'; truckId?: string }): Promise<{
  task: { id: string; title: string; priority: string; status: string; createdAt: string; truck: DriverTruck }
}> {
  return request('/maintenance-tasks', { method: 'POST', body: JSON.stringify(input) })
}

/** Leave a note about a place for the next driver and the office. */
export async function addLocationNote(input: { loadId: string; locationId: string; text: string }): Promise<{
  note: { at: string; by: string; text: string }
}> {
  return request('/paperwork/location-note', { method: 'POST', body: JSON.stringify(input) })
}

/** Flag or clear detention at one stop. The in/out times go on the BOL, not here. */
export async function setStopDetention(input: {
  loadId: string
  stopId: string
  detention: boolean
}): Promise<void> {
  await request('/paperwork/detention', { method: 'POST', body: JSON.stringify(input) })
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

/**
 * Take a POD or rate confirmation back off a submission.
 *
 * The pages stop counting immediately — a removed POD puts the load back on hold — so the
 * app asks before calling this. The files themselves stay in storage; the office can still
 * find what was sent if the wrong one was taken off.
 */
export async function removeSubmissionDocs(
  submissionId: string,
  kind: SubmissionKind,
): Promise<void> {
  await request(
    `/submissions/${encodeURIComponent(submissionId)}/docs?kind=${kind}`,
    { method: 'DELETE' },
  )
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
  stopId?: string
  stopLabel?: string
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
      stopId: input.stopId,
      stopLabel: input.stopLabel,
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
  const { pages } = input
  const { submissionId, uploads } = await createSubmission({ kind: 'RATECON', ...input, pages })
  try {
    await Promise.all(uploads.map((t, i) => putPage(t, pages[i])))
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
  const { pages } = input
  const { submissionId, uploads } = await createSubmission({ kind: 'POD', ...input, pages })
  try {
    await Promise.all(uploads.map((t, i) => putPage(t, pages[i])))
    await completeSubmission(submissionId, 'POD')
  } catch (err) {
    throw wrapWithResume(err, submissionId, 'POD')
  }
  return submissionId
}

/**
 * Photos or other paperwork from a stop: a seal, a damaged pallet, a gate pass, a scale
 * ticket. Each upload is its own submission, kept as taken, announced once in Slack.
 */
export async function submitMisc(input: {
  pages: PendingPage[]
  referenceNumber?: string
  note?: string
  stopId?: string
  stopLabel?: string
  resumeFromId?: string
}): Promise<string> {
  const { pages } = input
  const { submissionId, uploads } = await createSubmission({ kind: 'MISC', ...input, pages })
  try {
    await Promise.all(uploads.map((t, i) => putPage(t, pages[i])))
    await completeSubmission(submissionId, 'MISC')
  } catch (err) {
    throw wrapWithResume(err, submissionId, 'MISC')
  }
  return submissionId
}

/** Adds POD pages to an existing submission; the server replies into the same email + Slack thread. */
export async function submitPod(
  submissionId: string,
  inputPages: PendingPage[],
  { resume = false }: { resume?: boolean } = {},
): Promise<void> {
  let uploads: UploadTarget[]
  /*
   * Pages go up as they were captured, one file each.
   *
   * They used to be merged into a PDF here first, which handed the server a PDF and left
   * the scan cleanup with nothing to work on — every upload came back ORIGINAL_ONLY. The
   * server cleans each page and merges them afterwards, in that order.
   */
  const pages = inputPages

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

// ── Current load, recent loads, and attaching a POD ──────────────────────────

/** What the PWA shows on the load card. Mirrors GET /loads/current. */
export interface CurrentLoad {
  id: string
  proNumber: string
  lane: string
  originCity: string | null
  destinationCity: string | null
  pickupAppt: string | null
  deliveryAppt: string | null
  customer: string | null
  /** Documents the load still owes before it can be invoiced. */
  hasRateConfirmation: boolean
  hasPod: boolean
}

/** The driver's open load, or null when they have nothing running. */
export async function fetchCurrentLoad(): Promise<CurrentLoad | null> {
  const out = await request<{ load: CurrentLoad | null }>('/loads/current')
  return out.load
}

/** One of the driver's loads, as offered in the attach picker. */
export interface RecentLoad {
  id: string
  proNumber: string
  lane: string
  customer: string | null
  deliveryAppt: string | null
}

/**
 * The driver's loads from the last month, newest first. Wider than the current load on
 * purpose: a POD sent on Friday may only be attached on Monday.
 */
export async function fetchRecentLoads(): Promise<RecentLoad[]> {
  const out = await request<{ loads: RecentLoad[] }>('/loads/recent')
  return out.loads ?? []
}

/**
 * Attach a POD the driver already sent to one of their loads.
 *
 * This is what makes the POD count against that load, which is what releases the
 * load's pay. The server checks that both the submission and the load are theirs.
 */
export function attachSubmissionToLoad(
  submissionId: string,
  loadId: string,
): Promise<{ submissionId: string; loadId: string; proNumber: string }> {
  return request(`/submissions/${encodeURIComponent(submissionId)}/attach`, {
    method: 'POST',
    body: JSON.stringify({ loadId }),
  })
}
