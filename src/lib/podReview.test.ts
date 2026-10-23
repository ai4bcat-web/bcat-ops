import { describe, it, expect } from 'vitest'
import {
  approvalBlocker,
  isDriverAppPod,
  pagesLabel,
  parseChecks,
  replacementText,
  reviewStatusOf,
  supersededBy,
  worstPageLegibility,
  type PodCheckResult,
} from './podReview'

const doc = (kind: 'POD' | 'RATECON') => ({ id: 'x', submissionId: 's', driverId: 'd', kind, s3Key: 'k', uploadedAt: '' })

describe('podReview', () => {
  it('queues PODs from the driver apps only', () => {
    expect(isDriverAppPod({ source: 'PWA', docs: [doc('POD')] })).toBe(true)
    expect(isDriverAppPod({ source: null, docs: [doc('POD')] })).toBe(true)
    expect(isDriverAppPod({ source: 'STAFF', docs: [doc('POD')] })).toBe(false)
    expect(isDriverAppPod({ source: 'PWA', docs: [doc('RATECON')] })).toBe(false)
  })

  it('treats anything unrecognised as still to review', () => {
    expect(reviewStatusOf({})).toBe('PENDING')
    expect(reviewStatusOf({ podReviewStatus: 'APPROVED' })).toBe('APPROVED')
    expect(reviewStatusOf({ podReviewStatus: 'weird' })).toBe('PENDING')
    expect(parseChecks({ podReviewChecks: 'not json' })).toEqual({ addresses: false, allPages: false, legible: false })
  })

  it('needs every box, or a note saying why not', () => {
    const all = { addresses: true, allPages: true, legible: true }
    expect(approvalBlocker(all, '')).toBeNull()
    expect(approvalBlocker({ ...all, allPages: false }, '')).toMatch(/all pages are here/)
    expect(approvalBlocker({ ...all, allPages: false }, 'Only one page exists')).toBeNull()
  })

  it('lets the worst page decide legibility', () => {
    expect(worstPageLegibility([
      { legibility: 'OK', pageNumber: 1 },
      { legibility: 'UNREADABLE', legibilityNotes: 'too dark', pageNumber: 2 },
    ])).toEqual({ level: 'UNREADABLE', notes: 'Page 2: too dark' })
    expect(worstPageLegibility([]).level).toBe('UNKNOWN')
  })

  it('says how many pages are missing when the paperwork says how many there are', () => {
    const check = { pages: { statedTotal: 2, received: 1 } } as PodCheckResult
    expect(pagesLabel(1, check)).toBe('1 of 2 pages')
    expect(pagesLabel(2, null)).toBe('2 pages')
    expect(replacementText({
      driverName: 'Ivan Driver', pro: '14729', note: '',
      checks: { addresses: true, allPages: false, legible: false }, check,
    })).toBe('Hi Ivan, we need a new POD for PRO 14729 — we only have 1 of 2 pages, it is hard to read. Please rescan every page in good light in the app and send it again. Thanks!')
  })

  it('knows when the driver has already resent', () => {
    const a = { id: 'a', createdAt: '2026-10-20T10:00:00Z', loadId: 'l1', referenceNumber: null }
    const b = { id: 'b', createdAt: '2026-10-21T10:00:00Z', loadId: 'l1', referenceNumber: null }
    const other = { id: 'c', createdAt: '2026-10-22T10:00:00Z', loadId: 'l2', referenceNumber: null }
    expect(supersededBy(a, [a, b, other])?.id).toBe('b')
    expect(supersededBy(b, [a, b, other])).toBeNull()
  })
})
