import { describe, it, expect } from 'vitest'
import { nudgeFor } from './dispatchNudge'
import type { DispatchConversation } from '../../../src/lib/dispatch'

const now = Date.parse('2026-10-10T17:00:00Z')
const c = (over: Partial<DispatchConversation>): DispatchConversation => ({ id: 'c', phone: '+18475550100', driverName: 'Jason Smith', status: 'OPEN', lastDirection: 'IN', lastKind: 'SMS', unreadCount: 1, lastMessageAt: '2026-10-10T16:45:00Z', lastPreview: 'Gate is closed', assignedTo: 'jenny@bcatcorp.com', assignedBackup: 'dennis@bcatcorp.com', ...over })

describe('nudgeFor', () => {
  it('pings the primary after ten unanswered minutes, once', () => {
    const p = nudgeFor(c({}), null, now)
    expect(p).toMatchObject({ stage: 1, to: 'jenny@bcatcorp.com', forAt: '2026-10-10T16:45:00Z' })
    expect(p?.text).toContain('Jason Smith')
    expect(p?.text).toContain('15 min')
    expect(p?.text).toContain('Gate is closed')
    // Already pinged for this message: nothing until the backup window.
    expect(nudgeFor(c({ nudgedFor: '2026-10-10T16:45:00Z', nudgeStage: 1 }), null, now)).toBeNull()
  })
  it('escalates to the backup after twenty minutes', () => {
    const p = nudgeFor(c({ lastMessageAt: '2026-10-10T16:38:00Z', nudgedFor: '2026-10-10T16:38:00Z', nudgeStage: 1 }), null, now)
    expect(p).toMatchObject({ stage: 2, to: 'dennis@bcatcorp.com' })
    expect(nudgeFor(c({ lastMessageAt: '2026-10-10T16:38:00Z', nudgedFor: '2026-10-10T16:38:00Z', nudgeStage: 2 }), null, now)).toBeNull()
  })
  it('falls back to the driver file’s dispatchers when the conversation has none', () => {
    const p = nudgeFor(c({ assignedTo: null, assignedBackup: null }), { id: 'd', name: 'Jason', phone: '+1', dispatcherPrimary: 'ruben@bcatcorp.com', dispatcherBackup: 'dennis@bcatcorp.com' }, now)
    expect(p?.to).toBe('ruben@bcatcorp.com')
    expect(nudgeFor(c({ assignedTo: null, assignedBackup: null }), null, now)).toBeNull()
  })
  it('stays quiet when answered, read, too fresh, archived, outbound, or a status update', () => {
    expect(nudgeFor(c({ unreadCount: 0 }), null, now)).toBeNull()
    expect(nudgeFor(c({ lastMessageAt: '2026-10-10T16:55:00Z' }), null, now)).toBeNull()
    expect(nudgeFor(c({ status: 'ARCHIVED' }), null, now)).toBeNull()
    expect(nudgeFor(c({ lastDirection: 'OUT' }), null, now)).toBeNull()
    expect(nudgeFor(c({ lastKind: 'STATUS' }), null, now)).toBeNull()
  })
  it('a new message restarts the ladder', () => {
    const p = nudgeFor(c({ lastMessageAt: '2026-10-10T16:45:00Z', nudgedFor: '2026-10-10T15:00:00Z', nudgeStage: 2 }), null, now)
    expect(p?.stage).toBe(1)
  })
})
