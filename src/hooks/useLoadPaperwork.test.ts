/**
 * Which loads show a green tick. The case that keeps biting is a POD an owner operator
 * already sent from their own app: it lives in a different store from the JobsDone ones,
 * and reading fewer than all three stores is what made it look missing.
 */
import { describe, it, expect } from 'vitest'
import { buildPodIndex } from '@/lib/podPresence'
import { paperworkFor } from './useLoadPaperwork'
import type { Load } from '@/types'

const load = (over: Partial<Load> = {}): Load =>
  ({ id: 'l1', aljexId: '14517', ...over }) as Load

describe('paperworkFor', () => {
  it('finds a POD a driver sent, linked by loadId', () => {
    // Chad's PODs: a DriverSubmission carrying a POD page, linked to the load.
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: true }],
    })
    expect(paperworkFor(index, load()).pod).toBe(true)
  })

  it('finds a POD linked only by the PRO the driver typed', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: null, referenceNumber: '14517', hasPodDoc: true }],
    })
    expect(paperworkFor(index, load()).pod).toBe(true)
  })

  it('finds a JobsDone POD', () => {
    const index = buildPodIndex({ jobsdoneLoadIds: ['l1'], submissions: [] })
    expect(paperworkFor(index, load()).pod).toBe(true)
  })

  it('finds a rate con on the Load itself', () => {
    // Uploaded in the drawer, or attached from the Slack tender on Build load.
    const index = buildPodIndex({ jobsdoneLoadIds: [], submissions: [], rateconLoadIds: ['l1'] })
    expect(paperworkFor(index, load()).ratecon).toBe(true)
  })

  it('finds a rate con a driver sent', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: false, hasRateconDoc: true }],
    })
    expect(paperworkFor(index, load()).ratecon).toBe(true)
  })

  it('is red when nothing is on file', () => {
    const index = buildPodIndex({ jobsdoneLoadIds: [], submissions: [] })
    expect(paperworkFor(index, load())).toEqual({ pod: false, ratecon: false })
  })

  it('does not claim another load’s paperwork', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'other', referenceNumber: '99999', hasPodDoc: true }],
    })
    expect(paperworkFor(index, load()).pod).toBe(false)
  })

  it('is UNKNOWN, not red, before the index has loaded', () => {
    /*
     * Red is a claim that nothing was sent. Making that claim because a query has not
     * answered yet is how somebody ends up chasing a driver for a POD they already
     * submitted — which is the exact complaint this column exists to end.
     */
    expect(paperworkFor(null, load())).toEqual({ pod: null, ratecon: null })
  })
})
