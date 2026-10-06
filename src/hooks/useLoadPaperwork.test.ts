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
    expect(paperworkFor(index, load()).pod.has).toBe(true)
  })

  it('finds a POD linked only by the PRO the driver typed', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: null, referenceNumber: '14517', hasPodDoc: true }],
    })
    expect(paperworkFor(index, load()).pod.has).toBe(true)
  })

  it('finds a JobsDone POD', () => {
    const index = buildPodIndex({ jobsdoneLoadIds: ['l1'], submissions: [] })
    expect(paperworkFor(index, load()).pod.has).toBe(true)
  })

  it('finds a rate con on the Load itself', () => {
    // Uploaded in the drawer, or attached from the Slack tender on Build load.
    const index = buildPodIndex({ jobsdoneLoadIds: [], submissions: [], rateconLoadIds: ['l1'] })
    expect(paperworkFor(index, load()).ratecon.has).toBe(true)
  })

  it('finds a rate con a driver sent', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: false, hasRateconDoc: true }],
    })
    expect(paperworkFor(index, load()).ratecon.has).toBe(true)
  })

  it('is red when nothing is on file', () => {
    const index = buildPodIndex({ jobsdoneLoadIds: [], submissions: [] })
    expect(paperworkFor(index, load())).toEqual({
      pod: { has: false, ref: null }, ratecon: { has: false, ref: null },
    })
  })

  it('does not claim another load’s paperwork', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'other', referenceNumber: '99999', hasPodDoc: true }],
    })
    expect(paperworkFor(index, load()).pod.has).toBe(false)
  })

  it('is UNKNOWN, not red, before the index has loaded', () => {
    /*
     * Red is a claim that nothing was sent. Making that claim because a query has not
     * answered yet is how somebody ends up chasing a driver for a POD they already
     * submitted — which is the exact complaint this column exists to end.
     */
    expect(paperworkFor(null, load())).toEqual({
      pod: { has: null, ref: null }, ratecon: { has: null, ref: null },
    })
  })
})

/**
 * Knowing the paperwork exists is half an answer; the grid's tick is a button, so the
 * index has to say WHERE the document is as well as whether it is there.
 */
describe('paperworkFor — where the document actually is', () => {
  it('points a rate con at the key on the Load row', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [], submissions: [],
      rateconLoadIds: ['l1'], rateconKeys: [['l1', 'rate-confirms/l1/rc.pdf']],
    })
    expect(paperworkFor(index, load()).ratecon.ref).toEqual({ kind: 's3', key: 'rate-confirms/l1/rc.pdf' })
  })

  it('points a JobsDone POD at its document id, not an S3 key', () => {
    // Those live under pods/, a prefix no browser credential can read — they are opened
    // by id through the Lambda, which presigns them server-side.
    const index = buildPodIndex({
      jobsdoneLoadIds: ['l1'], submissions: [], jobsdonePodIds: [['l1', 'pod-9']],
    })
    expect(paperworkFor(index, load()).pod.ref).toEqual({ kind: 'podDocument', id: 'pod-9' })
  })

  it('points a driver POD at the merged PDF', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: true, podKey: 'driver-docs/d/s/POD/combined.pdf' }],
    })
    expect(paperworkFor(index, load()).pod.ref).toEqual({ kind: 's3', key: 'driver-docs/d/s/POD/combined.pdf' })
  })

  it('finds it by the PRO the driver typed when no loadId was linked', () => {
    const index = buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: [{ loadId: null, referenceNumber: 'PRO 14517', hasPodDoc: true, podKey: 'driver-docs/x/y/POD/1.jpg' }],
    })
    expect(paperworkFor(index, load()).pod.ref).toEqual({ kind: 's3', key: 'driver-docs/x/y/POD/1.jpg' })
  })

  it('lets the Load row win over a submission matched only by PRO', () => {
    // The office uploaded that one against THIS load; a typed reference is the weaker claim.
    const index = buildPodIndex({
      jobsdoneLoadIds: [], rateconLoadIds: ['l1'], rateconKeys: [['l1', 'rate-confirms/l1/official.pdf']],
      submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: false, hasRateconDoc: true, rateconKey: 'driver-docs/d/s/RATECON/1.jpg' }],
    })
    expect(paperworkFor(index, load()).ratecon.ref).toEqual({ kind: 's3', key: 'rate-confirms/l1/official.pdf' })
  })

  it('still ticks green when a store knows it exists but not where', () => {
    // has and ref are separate on purpose: "on file, open the load to view it" is the
    // honest answer, and downgrading it to a red cross would be a lie.
    const index = buildPodIndex({
      jobsdoneLoadIds: [], submissions: [{ loadId: 'l1', referenceNumber: '14517', hasPodDoc: true }],
    })
    const cell = paperworkFor(index, load()).pod
    expect(cell.has).toBe(true)
    expect(cell.ref).toBeNull()
  })
})
