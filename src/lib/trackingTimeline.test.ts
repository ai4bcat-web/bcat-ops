import { describe, it, expect } from 'vitest'
import { buildTimeline, lastKnownPosition, thinPositions, trackingWindow } from './trackingTimeline'
import type { TrackPosition } from './trackingTimeline'
import type { LoadCheckCallRecord, TrackingLinkRecord } from '../types/tms'

function checkCall(at: string, over: Partial<LoadCheckCallRecord> = {}): LoadCheckCallRecord {
  return {
    id: `cc-${at}`,
    loadId: 'load-1',
    shipmentId: 'shp-1',
    at,
    type: 'LOCATION_UPDATE',
    source: 'MANUAL',
    createdBy: 'rep@example.com',
    ...over,
  }
}

function link(sentAt: string): TrackingLinkRecord {
  return {
    id: 'TOKEN',
    kind: 'CARRIER_PING',
    shipmentId: 'shp-1',
    status: 'ACTIVE',
    expiresAt: '2026-03-05T00:00:00.000Z',
    sentAt,
    createdBy: 'rep@example.com',
  }
}

function fix(locatedAt: string, over: Partial<TrackPosition> = {}): TrackPosition {
  return { truckId: 'truck-1', lat: 41.5, lon: -88.1, locatedAt, ...over }
}

describe('trackingWindow', () => {
  it('starts at dispatch and ends two hours after delivery', () => {
    const window = trackingWindow(
      { pickupAppt: '2026-03-02T12:00:00.000Z', deliveredAt: '2026-03-03T10:00:00.000Z' },
      { dispatchedAt: '2026-03-02T06:00:00.000Z' },
      '2026-03-04T00:00:00.000Z',
    )
    expect(window).toEqual({ from: '2026-03-02T06:00:00.000Z', to: '2026-03-03T12:00:00.000Z' })
  })

  it('falls back to two hours before the pickup, and runs to now while undelivered', () => {
    const window = trackingWindow(
      { pickupAppt: '2026-03-02T12:00:00.000Z' },
      null,
      '2026-03-02T15:00:00.000Z',
    )
    expect(window).toEqual({ from: '2026-03-02T10:00:00.000Z', to: '2026-03-02T15:00:00.000Z' })
  })
})

describe('thinPositions', () => {
  it('keeps the first fix, one per gap, and every start and stop', () => {
    const positions = [
      fix('2026-03-02T12:00:00.000Z', { motion: 'MOVING' }),
      fix('2026-03-02T12:05:00.000Z', { motion: 'MOVING' }),
      fix('2026-03-02T12:10:00.000Z', { motion: 'STATIONARY' }),
      fix('2026-03-02T12:12:00.000Z', { motion: 'STATIONARY' }),
      fix('2026-03-02T12:20:00.000Z', { motion: 'MOVING' }),
      fix('2026-03-02T12:40:00.000Z', { motion: 'MOVING' }),
    ]
    expect(thinPositions(positions, 15).map((p) => p.locatedAt)).toEqual([
      '2026-03-02T12:00:00.000Z',
      '2026-03-02T12:10:00.000Z',
      '2026-03-02T12:20:00.000Z',
      '2026-03-02T12:40:00.000Z',
    ])
  })

  it('reads motion from the speed when Motive did not report it', () => {
    const positions = [
      fix('2026-03-02T12:00:00.000Z', { speed: 55 }),
      fix('2026-03-02T12:02:00.000Z', { speed: 0 }),
      fix('2026-03-02T12:04:00.000Z', { speed: 0 }),
    ]
    expect(thinPositions(positions, 15).map((p) => p.locatedAt)).toEqual([
      '2026-03-02T12:00:00.000Z',
      '2026-03-02T12:02:00.000Z',
    ])
  })
})

describe('buildTimeline', () => {
  it('runs newest first, and a reported fact outranks a machine at the same instant', () => {
    const at = '2026-03-02T12:00:00.000Z'
    const items = buildTimeline({
      checkCalls: [checkCall('2026-03-02T09:00:00.000Z'), checkCall(at)],
      positions: [fix(at), fix('2026-03-02T15:00:00.000Z')],
      links: [link(at)],
    })
    expect(items.map((i) => [i.at, i.kind])).toEqual([
      ['2026-03-02T15:00:00.000Z', 'position'],
      [at, 'check_call'],
      [at, 'link'],
      [at, 'position'],
      ['2026-03-02T09:00:00.000Z', 'check_call'],
    ])
  })

  it('drops what happened outside the load, edges included', () => {
    const items = buildTimeline({
      checkCalls: [
        checkCall('2026-03-02T05:59:59.000Z'),
        checkCall('2026-03-02T06:00:00.000Z'),
        checkCall('2026-03-03T12:00:00.000Z'),
        checkCall('2026-03-03T12:00:01.000Z'),
      ],
      window: { from: '2026-03-02T06:00:00.000Z', to: '2026-03-03T12:00:00.000Z' },
    })
    expect(items.map((i) => i.at)).toEqual([
      '2026-03-03T12:00:00.000Z',
      '2026-03-02T06:00:00.000Z',
    ])
  })
})

describe('lastKnownPosition', () => {
  it('takes the newest fix whatever reported it', () => {
    const ping = checkCall('2026-03-02T13:00:00.000Z', {
      type: 'TRACKING_PING',
      source: 'LINK',
      lat: 40.1,
      lng: -87.2,
      city: 'Joliet',
      state: 'IL',
    })
    const items = buildTimeline({ checkCalls: [ping], positions: [fix('2026-03-02T12:00:00.000Z')] })
    expect(lastKnownPosition(items)).toEqual({
      at: '2026-03-02T13:00:00.000Z',
      lat: 40.1,
      lng: -87.2,
      description: 'Joliet, IL',
      source: 'LINK',
    })

    const later = buildTimeline({ checkCalls: [ping], positions: [fix('2026-03-02T14:00:00.000Z')] })
    expect(lastKnownPosition(later)?.source).toBe('MOTIVE')
  })

  it('ignores check calls that carry no coordinates', () => {
    const items = buildTimeline({ checkCalls: [checkCall('2026-03-02T13:00:00.000Z', { city: 'Joliet' })] })
    expect(lastKnownPosition(items)).toBeNull()
  })
})
