// @vitest-environment jsdom
/**
 * Before the schema stages deploy, the shell's counts for the missing tables must be 0 and must
 * not read them, whatever the sub-hooks answer; the production counts keep working.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/modelAvailability', () => ({
  modelAvailable: () => false,
  modelsAvailable: () => false,
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => true }) }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [{ id: 'l1' }] }) }))
vi.mock('@/lib/apptQueue', () => ({ apptQueueCount: () => 2 }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (s: { maintenanceTasks: unknown[] }) => unknown) => select({ maintenanceTasks: [{ status: 'upcoming' }] }),
}))
vi.mock('@/lib/intake', () => ({ ACTIVE_STATUSES: new Set(['NEW']) }))
vi.mock('@/hooks/useIntakeItems', () => ({ useIntakeItems: () => ({ items: [{ status: 'NEW' }] }) }))
vi.mock('@/hooks/useReviewQueue', () => ({ useReviewQueue: () => ({ pendingCount: 1 }) }))
vi.mock('@/hooks/useTruckDocAlerts', () => ({ useTruckDocAlerts: () => ({ outOfDateCount: 1 }) }))
vi.mock('@/hooks/useDispatch', () => ({ useDispatchUnread: () => 1 }))
const worklist = vi.hoisted(() => ({ opts: [] as unknown[] }))
vi.mock('@/hooks/useCheckCallWorklist', () => ({ useCheckCallWorklist: (o: unknown) => { worklist.opts.push(o); return { dueCount: 1 } } }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({ pendingCount: 1 }) }))
vi.mock('@/hooks/useArToInvoiceCount', () => ({ useArToInvoiceCount: () => 1 }))
vi.mock('@/hooks/useApToReviewCount', () => ({ useApToReviewCount: () => 1 }))
vi.mock('@/hooks/useQuotesToReplyCount', () => ({ useQuotesToReplyCount: () => 3 }))
const reads = vi.hoisted(() => ({ intake: vi.fn(async () => 2), spot: vi.fn(async () => ({ new: 2, needsInfo: 1, needsAttention: 1 })) }))
vi.mock('@/lib/apiClient', () => ({ countOpenIntakeLoads: reads.intake, spotAction: reads.spot, listDriverAvailabilities: async () => [] }))
vi.mock('@/lib/loadReview', () => ({ loadReviewCount: () => 4 }))
vi.mock('@/features/tms/carrierSales/carrierSalesQueue', () => ({ needsCoverCount: () => 5 }))

import { useShellBadgeCounts } from './useShellBadgeCounts'

describe('useShellBadgeCounts with the stage 1-3 tables missing', () => {
  it('answers 0 (no badge) for every count that reads them, and keeps the production counts', async () => {
    const { result } = renderHook(() => useShellBadgeCounts({ shipments: [] }))
    await Promise.resolve()
    for (const key of ['intakeLoads', 'spotNew', 'quotesToReply', 'arToInvoice', 'apToReview', 'accounting', 'checkCalls', 'documentReview', 'loadTracking', 'loadReview', 'carrierSales']) {
      expect(result.current[key], key).toBeUndefined()
    }
    expect(result.current).toMatchObject({ loads: 1, maintenance: 1, intake: 1, appts: 2, review: 1, truckDocs: 1, dispatch: 1 })
  })

  it('does not even read the missing tables', async () => {
    renderHook(() => useShellBadgeCounts({ shipments: [] }))
    await Promise.resolve()
    expect(reads.intake).not.toHaveBeenCalled()
    expect(reads.spot).not.toHaveBeenCalled()
    expect(worklist.opts.every((o) => (o as { enabled: boolean }).enabled === false)).toBe(true)
  })
})
