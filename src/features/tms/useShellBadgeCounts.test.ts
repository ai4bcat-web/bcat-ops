// @vitest-environment jsdom
/**
 * A badge key wired into the nav config that nothing answers renders as no badge at all,
 * forever — it fails silently. This walks every `badgeKey` the config declares and requires
 * the resolver to answer each one.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => true }) }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [{ id: 'l1' }] }) }))
vi.mock('@/lib/apptQueue', () => ({ apptQueueCount: () => 2 }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (s: { maintenanceTasks: unknown[] }) => unknown) =>
    select({ maintenanceTasks: [{ status: 'upcoming' }, { status: 'done' }] }),
}))
vi.mock('@/lib/intake', () => ({ ACTIVE_STATUSES: new Set(['NEW']) }))
vi.mock('@/hooks/useIntakeItems', () => ({ useIntakeItems: () => ({ items: [{ status: 'NEW' }, { status: 'DONE' }] }) }))
vi.mock('@/hooks/useReviewQueue', () => ({ useReviewQueue: () => ({ pendingCount: 1 }) }))
vi.mock('@/hooks/useTruckDocAlerts', () => ({ useTruckDocAlerts: () => ({ outOfDateCount: 1 }) }))
vi.mock('@/hooks/useDispatch', () => ({ useDispatchUnread: () => 1 }))
vi.mock('@/hooks/useCheckCallWorklist', () => ({ useCheckCallWorklist: () => ({ dueCount: 1 }) }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({ pendingCount: 1 }) }))
vi.mock('@/hooks/useArToInvoiceCount', () => ({ useArToInvoiceCount: () => 1 }))
vi.mock('@/hooks/useApToReviewCount', () => ({ useApToReviewCount: () => 1 }))
vi.mock('@/hooks/useQuotesToReplyCount', () => ({ useQuotesToReplyCount: () => 3 }))
const intake = vi.hoisted(() => ({ count: vi.fn(async () => 2) }))
vi.mock('@/lib/apiClient', () => ({ countOpenIntakeLoads: intake.count }))
vi.mock('@/lib/brokerageCharts', () => ({ MOVEMENT_STATUSES: ['IN_TRANSIT'] }))

import { useShellBadgeCounts, movingShipments } from './useShellBadgeCounts'
import { NAV_ITEMS } from '@/lib/navItems'
import { PINNED_ITEMS, TMS_ITEMS } from '@/lib/navSections'
import type { ShipmentListRow } from '@/hooks/useShipments'

const shipments = [
  { id: 's1', status: 'OPEN', voidedAt: null, dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT' },
  { id: 's2', status: 'OPEN', voidedAt: '2026-01-01', dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT' },
] as unknown as ShipmentListRow[]

const args = { shipments }

describe('useShellBadgeCounts', () => {
  it('answers every badgeKey the nav config declares', async () => {
    const declared = new Set<string>()
    for (const item of [...PINNED_ITEMS, ...TMS_ITEMS, ...NAV_ITEMS]) {
      if (item.badgeKey) declared.add(item.badgeKey)
      for (const child of item.children ?? []) if (child.badgeKey) declared.add(child.badgeKey)
    }
    expect(declared.size).toBeGreaterThan(5)
    const { result } = renderHook(() => useShellBadgeCounts(args))
    // The open-intake count is a polled read, so it lands a tick after the first paint.
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    const unanswered = [...declared].filter((key) => !result.current[key])
    expect(unanswered).toEqual([])
  })

  it('carries the real counts and drops zero ones', async () => {
    const { result } = renderHook(() => useShellBadgeCounts({ shipments: [] }))
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    expect(result.current.quotesToReply).toBe(3)
    expect(result.current.maintenance).toBe(1)
    expect(result.current.intake).toBe(1)
    expect('myQueue' in result.current || 'teamQueue' in result.current).toBe(false)
    expect('tracking' in result.current).toBe(false)
  })

  it('counts a voided load out of Tracking', () => {
    expect(movingShipments(shipments).map((s) => s.id)).toEqual(['s1'])
  })
})
