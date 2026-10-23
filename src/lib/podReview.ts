/**
 * The PODs page review queue: what a POD from the driver apps needs before it counts.
 *
 * Three things decide whether a broker pays on a POD, and each one was found out weeks
 * late, by the broker:
 *
 *  - it is the right delivery — the addresses are the rate confirmation's,
 *  - it is all there — "Page 1 of 2" means two pages, both sent,
 *  - it can be read.
 *
 * A person confirms each one. The automated read (amplify/functions/pod-actions/podCheck.ts)
 * and the per-page legibility score from the scanner are advice shown beside the boxes,
 * never a decision. A POD that is genuinely one page, or otherwise unusual, is explained in
 * the notes, which also land on the load.
 */
import type { DriverSubmissionDocRecord, DriverSubmissionRecord, SubmissionWithDocs } from './driverSubmissionsClient'
import type { Driver } from '@/types'

export type PodReviewStatus = 'PENDING' | 'APPROVED' | 'NEEDS_REPLACEMENT'
export type CheckVerdict = 'PASS' | 'FAIL' | 'UNCLEAR'
export type PodCheckStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'

/** Mirrors PodCheckResult in amplify/functions/pod-actions/podCheck.ts. */
export interface PodCheckResult {
  checkedAt: string
  model: string
  addresses: {
    verdict: CheckVerdict
    pod: { shipper: string; consignee: string }
    rateCon: { pickup: string; delivery: string }
    fromLoadStops: boolean
    notes: string
  }
  pages: { verdict: CheckVerdict; markers: string; statedTotal: number | null; received: number; notes: string }
  legibility: { verdict: CheckVerdict; notes: string }
  signed: CheckVerdict
  summary: string
}

/** What the reviewer ticked. */
export interface PodReviewChecks {
  addresses: boolean
  allPages: boolean
  legible: boolean
}

export interface PodReviewFields {
  podReviewStatus?: string | null
  podReviewNote?: string | null
  podReviewedBy?: string | null
  podReviewedAt?: string | null
  podReviewChecks?: string | null
  podReplacementRequestedAt?: string | null
  podReplacementMessage?: string | null
  podCheckStatus?: string | null
  podCheck?: string | null
  podCheckedAt?: string | null
  podCheckError?: string | null
}

export type ReviewSubmission = SubmissionWithDocs & PodReviewFields

export const EMPTY_CHECKS: PodReviewChecks = { addresses: false, allPages: false, legible: false }

/**
 * A POD a driver sent from their app — the Ivan driver app or the owner operator app, which
 * both file as PWA. Office uploads and texts to dispatch (STAFF) and emailed paperwork are
 * not what this queue is for: someone in the office already looked at those.
 */
export function isDriverAppPod(sub: Pick<SubmissionWithDocs, 'source' | 'docs'>): boolean {
  const fromApp = !sub.source || sub.source === 'PWA'
  return fromApp && sub.docs.some((d) => d.kind === 'POD')
}

export function reviewStatusOf(sub: PodReviewFields): PodReviewStatus {
  const s = sub.podReviewStatus
  return s === 'APPROVED' || s === 'NEEDS_REPLACEMENT' ? s : 'PENDING'
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function parseCheck(sub: PodReviewFields): PodCheckResult | null {
  return parse<PodCheckResult>(sub.podCheck)
}

export function parseChecks(sub: PodReviewFields): PodReviewChecks {
  const c = parse<Partial<PodReviewChecks>>(sub.podReviewChecks)
  return { addresses: c?.addresses === true, allPages: c?.allPages === true, legible: c?.legible === true }
}

export function podPages(sub: Pick<SubmissionWithDocs, 'docs'>): DriverSubmissionDocRecord[] {
  return sub.docs
    .filter((d) => d.kind === 'POD')
    .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || String(a.uploadedAt).localeCompare(String(b.uploadedAt)))
}

const LEGIBILITY_RANK = { UNREADABLE: 0, LOW: 1, UNKNOWN: 2, OK: 3 } as const

/** The worst page decides: one unreadable page makes the POD unreadable. */
export function worstPageLegibility(
  pages: Pick<DriverSubmissionDocRecord, 'legibility' | 'legibilityNotes' | 'pageNumber'>[],
): { level: 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'; notes: string | null } {
  let worst: { level: 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'; notes: string | null } = { level: 'UNKNOWN', notes: null }
  let seen = false
  for (const p of pages) {
    const level = p.legibility ?? 'UNKNOWN'
    if (!seen || LEGIBILITY_RANK[level] < LEGIBILITY_RANK[worst.level]) {
      worst = { level, notes: p.legibilityNotes ? `Page ${p.pageNumber ?? '?'}: ${p.legibilityNotes}` : null }
      seen = true
    }
  }
  return worst
}

/**
 * Approve only when every box is ticked, or a note says why one is not.
 *
 * "Only page 1 of 2 exists, the receiver never printed page 2" is a legitimate POD; an
 * unticked box with nothing written is a review that was not done.
 */
export function approvalBlocker(checks: PodReviewChecks, note: string): string | null {
  const missing = [
    !checks.addresses && 'addresses match the rate confirmation',
    !checks.allPages && 'all pages are here',
    !checks.legible && 'it is legible',
  ].filter(Boolean) as string[]
  if (missing.length === 0) return null
  if (note.trim()) return null
  return `Confirm that ${missing.join(', ')} — or write a note explaining why it is fine anyway.`
}

/** The text a driver gets when asked for a better POD. Reasons come from the unticked boxes. */
export function replacementText(input: {
  driverName: string
  pro: string | null
  checks: PodReviewChecks
  note: string
  check: PodCheckResult | null
}): string {
  const reasons: string[] = []
  if (!input.checks.addresses) reasons.push('it does not look like the paperwork for this load')
  if (!input.checks.allPages) {
    const total = input.check?.pages.statedTotal
    const got = input.check?.pages.received
    reasons.push(total && got != null && got < total ? `we only have ${got} of ${total} pages` : 'pages are missing')
  }
  if (!input.checks.legible) reasons.push('it is hard to read')
  const first = input.driverName.trim().split(/\s+/)[0] || 'there'
  const load = input.pro ? `PRO ${input.pro}` : 'your last load'
  const why = reasons.length ? ` — ${reasons.join(', ')}` : ''
  const extra = input.note.trim() ? ` ${input.note.trim()}` : ''
  return `Hi ${first}, we need a new POD for ${load}${why}.${extra} Please rescan every page in good light in the app and send it again. Thanks!`
}

/** Ivan's own drivers or an owner operator — the two apps PODs arrive from. */
export function appLabel(driver: Pick<Driver, 'driverType'> | null | undefined): 'Owner operator app' | 'Ivan driver app' {
  return driver?.driverType === 'OWNER_OPERATOR' ? 'Owner operator app' : 'Ivan driver app'
}

/** The PRO a submission is for: the load's, or what the driver typed. */
export function proOf(sub: Pick<DriverSubmissionRecord, 'referenceNumber'>, load: { aljexId?: string | null } | null | undefined): string | null {
  return (load?.aljexId ?? '').trim() || (sub.referenceNumber ?? '').trim() || null
}

/** Pages line for the queue: "2 pages", or "1 of 2 pages" when the paperwork says more. */
export function pagesLabel(received: number, check: PodCheckResult | null): string {
  const total = check?.pages.statedTotal
  if (total && total > received) return `${received} of ${total} pages`
  return `${received} page${received === 1 ? '' : 's'}`
}

/**
 * A later POD for the same load replaces this one: once the driver has resent, the old
 * request is answered and the new submission is what needs review.
 */
export function supersededBy<T extends Pick<ReviewSubmission, 'id' | 'createdAt' | 'loadId' | 'referenceNumber'>>(
  sub: T,
  all: T[],
): T | null {
  const key = (s: T) => (s.loadId ?? '').trim() || `pro:${(s.referenceNumber ?? '').replace(/\D/g, '')}`
  const mine = key(sub)
  if (mine === 'pro:') return null
  return all
    .filter((o) => o.id !== sub.id && key(o) === mine && String(o.createdAt) > String(sub.createdAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null
}
