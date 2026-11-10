import { describe, expect, it } from 'vitest'
import { newestPod, activePods } from '@/lib/podPreview'
import type { ShipmentDocumentRecord } from '@/types/tms'

const doc = (over: Partial<ShipmentDocumentRecord>) => ({ id: 'd', type: 'POD', name: 'p.pdf', s3Key: 'k', contentType: 'application/pdf', status: 'ACTIVE', uploadedAt: '2026-11-01T00:00:00Z', ...over }) as ShipmentDocumentRecord

describe('newestPod', () => {
  it('picks the newest active POD and ignores other types, superseded and voided rows', () => {
    const docs = [
      doc({ id: 'old', uploadedAt: '2026-11-01T00:00:00Z' }),
      doc({ id: 'new', uploadedAt: '2026-11-05T00:00:00Z' }),
      doc({ id: 'bol', type: 'BOL', uploadedAt: '2026-11-09T00:00:00Z' }),
      doc({ id: 'sup', status: 'SUPERSEDED', uploadedAt: '2026-11-08T00:00:00Z' }),
      doc({ id: 'void', voidedAt: '2026-11-08T00:00:00Z', uploadedAt: '2026-11-09T00:00:00Z' }),
    ]
    expect(newestPod(docs)?.id).toBe('new')
    expect(newestPod([])).toBeNull()
  })
})

describe('activePods', () => {
  it('lists every active page oldest first, including ones waiting for review, never refused or voided', () => {
    const docs = [
      doc({ id: 'p2', uploadedAt: '2026-11-05T00:00:00Z', reviewStatus: 'PENDING' }),
      doc({ id: 'p1', uploadedAt: '2026-11-04T00:00:00Z' }),
      doc({ id: 'no', reviewStatus: 'REJECTED' }),
      doc({ id: 'gone', status: 'SUPERSEDED' }),
    ]
    expect(activePods(docs).map((d) => d.id)).toEqual(['p1', 'p2'])
  })
})
