import { describe, expect, it } from 'vitest'
import { matchPodDriver, recentLoadsForDriver } from './podDriver'
import type { Driver, Load } from '@/types'

import type { Stop } from '@/types'

const driver = (id: string, name: string, phone: string): Driver => ({ id, name, phone, active: true, createdAt: '', updatedAt: '' })
const load = (id: string, deliveryDriverId: string | null, deliveryAppt: string, pickupDriverId: string | null = null): Load => ({
  id, aljexId: id, tmsId: '', pickupNumber: '', customer: 'C', originCity: '', destinationCity: '',
  pickupAppt: deliveryAppt, deliveryAppt, pickupDriverId, deliveryDriverId, readyToInvoice: false,
  createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
})

const chuck = driver('d1', 'Chuck Best', '+17735550101')
const jason = driver('d2', 'Jason Smith', '+17735550102')

describe('matchPodDriver', () => {
  it('matches on the phone the POD was texted from, however it is formatted', () => {
    expect(matchPodDriver({ senderName: 'chuck', senderContact: '(773) 555-0101' }, [jason, chuck])).toBe(chuck)
  })
  it('prefers a backend mapping over roster phone/name lookup', () => {
    const mapping: PodSenderMapping = {
      clientId: 'c1', phoneDigits: '2247136044', senderName: 'Lalo', driverId: 'd2', updatedBy: '', updatedAt: '',
    }
    // Backend says Lalo's phone -> Jason Smith (d2), even though phone would not match anyone.
    expect(matchPodDriver({ senderName: 'Lalo Cortez', senderContact: '+12247136044' }, [jason, chuck], [mapping])).toBe(jason)
  })
  it('falls back to the registered name when the phone is unknown', () => {
    expect(matchPodDriver({ senderName: 'JASON  SMITH', senderContact: '+15555550199' }, [jason, chuck])).toBe(jason)
  })
  it('refuses a name-only match on a single token (e.g. a bare first name)', () => {
    expect(matchPodDriver({ senderName: 'Jason', senderContact: '+15555550199' }, [jason, chuck])).toBeNull()
    expect(matchPodDriver({ senderName: 'Jason - pics', senderContact: '+15555550199' }, [jason, chuck])).toBeNull()
  })
  it('never guesses when neither phone nor name matches', () => {
    expect(matchPodDriver({ senderName: 'Someone Else', senderContact: '+15555550199' }, [jason, chuck])).toBeNull()
    expect(matchPodDriver({ senderName: '', senderContact: '' }, [jason, chuck])).toBeNull()
  })
  it('treats a mapping with a missing/wrong driver as an unmapped sender', () => {
    const mapping: PodSenderMapping = {
      clientId: 'c1', phoneDigits: '2247136044', senderName: 'Lalo', driverId: 'gone', updatedBy: '', updatedAt: '',
    }
    expect(matchPodDriver({ senderName: 'Lalo Cortez', senderContact: '+12247136044' }, [jason, chuck], [mapping])).toBeNull()
  })
})

describe('recentLoadsForDriver', () => {
  it('lists the driver\'s own loads, most recent delivery first, including pickup-only legs', () => {
    const loads = [
      load('old', 'd1', '2026-09-01T10:00:00Z'),
      load('other', 'd2', '2026-09-28T10:00:00Z'),
      load('new', 'd1', '2026-09-29T10:00:00Z'),
      load('pickup', null, '2026-09-15T10:00:00Z', 'd1'),
    ]
    expect(recentLoadsForDriver(loads, 'd1').map((l) => l.id)).toEqual(['new', 'pickup', 'old'])
    expect(recentLoadsForDriver(loads, 'd1', 1).map((l) => l.id)).toEqual(['new'])
  })

  it('finds a driver on a middle stop, not just first/last legacy fields', () => {
    const middleLoad: Load = {
      id: 'multi', aljexId: 'multi', tmsId: '', pickupNumber: '', customer: 'C',
      originCity: '', destinationCity: '', pickupAppt: '2026-09-01T10:00:00Z', deliveryAppt: '2026-09-05T14:00:00Z',
      pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false,
      createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
      stops: [
        { id: 's1', type: 'pickup', appt: '2026-09-01T10:00:00Z', driverId: 'd2', sequence: 0 },
        { id: 's2', type: 'delivery', appt: '2026-09-03T10:00:00Z', driverId: 'd1', sequence: 1 },
        { id: 's3', type: 'delivery', appt: '2026-09-05T14:00:00Z', driverId: 'd2', sequence: 2 },
      ] as unknown as Stop[],
    }
    expect(recentLoadsForDriver([middleLoad], 'd1').map((l) => l.id)).toEqual(['multi'])
  })
})
