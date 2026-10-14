import { describe, it, expect } from 'vitest'
import { pickPodLoad, autoFilePod, prosInText, type AutoPodStore } from './dispatchAutoPod'
import type { Load } from '../../../src/types'

const load = (id: string, pro: string, deliveryAppt: string, driverId = 'd1', extra: Record<string, unknown> = {}) =>
  ({ id, aljexId: pro, stops: [
    { id: `${id}-p`, type: 'pickup', sequence: 0, driverId, appt: deliveryAppt, departedAt: deliveryAppt },
    { id: `${id}-d`, type: 'delivery', sequence: 1, driverId, appt: deliveryAppt, ...extra },
  ] }) as unknown as Load
const NOW = '2026-10-14T20:00:00.000Z'   // 3 PM Chicago, Oct 14

describe('pickPodLoad', () => {
  it("takes the driver's one open delivery of the last two days", () => {
    const today = load('a', '14617', '2026-10-14T16:00:00Z')
    const lastWeek = load('b', '14550', '2026-10-07T16:00:00Z')
    const pick = pickPodLoad([today, lastWeek], [today, lastWeek], '', NOW)
    expect(pick).toMatchObject({ kind: 'one', how: 'only' })
    expect((pick as { load: Load }).load.id).toBe('a')
  })
  it('takes the load whose PRO the driver typed, even with several open', () => {
    const a = load('a', '14617', '2026-10-14T16:00:00Z'); const b = load('b', '14696', '2026-10-14T18:00:00Z')
    expect(pickPodLoad([a, b], [a, b], 'POD for 14696', NOW)).toMatchObject({ kind: 'one', how: 'pro', load: { id: 'b' } })
    expect(prosInText('pod 14696 and 14617')).toEqual(['14696', '14617'])
  })
  it('guesses nothing when several are open and no PRO is named, or none is open', () => {
    const a = load('a', '14617', '2026-10-14T16:00:00Z'); const b = load('b', '14696', '2026-10-14T18:00:00Z')
    expect(pickPodLoad([a, b], [a, b], 'here you go', NOW)).toMatchObject({ kind: 'many' })
    expect(pickPodLoad([], [a, b], '', NOW)).toEqual({ kind: 'none' })
    expect(pickPodLoad([load('c', '14550', '2026-10-07T16:00:00Z')], [], '', NOW)).toEqual({ kind: 'none' })
  })
})

describe('autoFilePod', () => {
  const fake = (loads: Load[], podded: string[] = []) => {
    const filed: unknown[] = []; const marked: string[] = []
    const store: AutoPodStore = {
      loadsForDriver: async () => loads,
      hasPod: async (l) => podded.includes(l.id),
      fileSubmission: async (i) => { filed.push(i); return { submissionId: 's1' } },
      markDelivered: async (l) => { marked.push(l.id) },
    }
    return { store, filed, marked }
  }
  it('files the picture on the one open load and marks it delivered', async () => {
    const a = load('a', '14617', '2026-10-14T16:00:00Z')
    const { store, filed, marked } = fake([a])
    const r = await autoFilePod(store, { id: 'd1', name: 'Eulalio' }, { body: '', media: [{ key: 'k', contentType: 'image/jpeg' }], at: NOW })
    expect(r).toMatchObject({ filed: true, pro: '14617', how: 'only', delivered: true })
    expect(filed).toHaveLength(1)
    expect(marked).toEqual(['a'])
  })
  it('skips a load that already has a POD, and does nothing for a text with no picture or no driver', async () => {
    const a = load('a', '14617', '2026-10-14T16:00:00Z')
    const { store, filed } = fake([a], ['a'])
    expect(await autoFilePod(store, { id: 'd1', name: 'E' }, { body: '', media: [{ key: 'k', contentType: 'image/jpeg' }], at: NOW })).toEqual({ filed: false, reason: 'none' })
    expect(await autoFilePod(store, { id: 'd1', name: 'E' }, { body: 'hi', media: null, at: NOW })).toEqual({ filed: false, reason: 'no-media' })
    expect(await autoFilePod(store, null, { body: '', media: [{ key: 'k', contentType: 'image/jpeg' }], at: NOW })).toEqual({ filed: false, reason: 'no-driver' })
    expect(filed).toHaveLength(0)
  })
})
