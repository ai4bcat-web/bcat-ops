// @vitest-environment jsdom
/**
 * A badge key wired into the nav config that nothing answers renders as no badge at all,
 * forever — it fails silently. This walks every `badgeKey` the config declares and requires
 * the resolver to answer each one.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const auth = vi.hoisted(() => ({ hasPageAccess: (_key: string) => true }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))
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
const intake = vi.hoisted(() => ({ count: vi.fn(async () => 2), spot: vi.fn(async () => ({ new: 2, needsInfo: 1, needsAttention: 1 })) }))
const timeOff = vi.hoisted(() => ({ rows: vi.fn(async () => [{ status: 'PENDING' }, { status: 'PENDING' }, { status: 'APPROVED' }, { status: null }, { status: 'DENIED' }]) }))
vi.mock('@/lib/apiClient', () => ({ countOpenIntakeLoads: intake.count, spotAction: intake.spot, listDriverAvailabilities: timeOff.rows }))
vi.mock('@/lib/loadReview', () => ({ loadReviewCount: () => 4 }))
vi.mock('@/features/tms/carrierSales/carrierSalesQueue', () => ({ needsCoverCount: () => 5 }))

import { useShellBadgeCounts } from './useShellBadgeCounts'
import { NAV_ITEMS } from '@/lib/navItems'
import { PINNED_ITEMS } from '@/lib/navSections'
import { LIFECYCLE_TABS } from '@/lib/lifecycleTabs'
import type { ShipmentListRow } from '@/hooks/useShipments'

const shipments = [
  { id: 's1', status: 'OPEN', voidedAt: null, dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT' },
  { id: 's2', status: 'OPEN', voidedAt: '2026-01-01', dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT' },
] as unknown as ShipmentListRow[]

const args = { shipments }


describe('useShellBadgeCounts', () => {
  it('answers every badgeKey the nav config and the lifecycle strip declare', async () => {
    const declared = new Set<string>()
    for (const item of [...PINNED_ITEMS, ...NAV_ITEMS]) {
      if (item.badgeKey) declared.add(item.badgeKey)
      for (const child of item.children ?? []) if (child.badgeKey) declared.add(child.badgeKey)
    }
    for (const tab of LIFECYCLE_TABS) if (tab.badgeKey) declared.add(tab.badgeKey)
    expect(declared.size).toBeGreaterThan(5)
    const { result } = renderHook(() => useShellBadgeCounts(args))
    // The open-intake count is a polled read, so it lands a tick after the first paint.
    await waitFor(() => expect(result.current.spotNew).toBe(3))
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

  it('badges Time Off with the days drivers asked off that nobody has answered yet (pending only)', async () => {
    const { result } = renderHook(() => useShellBadgeCounts({ shipments: [] }))
    await waitFor(() => expect(result.current.timeOff).toBe(2))
  })

  it('shows no Time Off badge to someone without the page, and none when nothing is pending', async () => {
    auth.hasPageAccess = (key) => key !== 'timeOff'
    try {
      const { result } = renderHook(() => useShellBadgeCounts({ shipments: [] }))
      await waitFor(() => expect(result.current.intakeLoads).toBe(2))
      expect('timeOff' in result.current).toBe(false)
    } finally { auth.hasPageAccess = () => true }
    timeOff.rows.mockResolvedValueOnce([{ status: 'APPROVED' }] as never)
    const { result } = renderHook(() => useShellBadgeCounts({ shipments: [] }))
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    expect('timeOff' in result.current).toBe(false)
  })

  it('sums the parent rows from their children', async () => {
    const { result } = renderHook(() => useShellBadgeCounts(args))
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    // checkCalls 1 + documentReview 1.
    expect(result.current.loadTracking).toBe(2)
    // arToInvoice 1 + apToReview 1.
    expect(result.current.accounting).toBe(2)
  })

  it('hides Load Review and Carrier Sales counts from a user without the grants', async () => {
    auth.hasPageAccess = (key) => key === 'quotes'
    try {
      const { result } = renderHook(() => useShellBadgeCounts(args))
      await waitFor(() => expect(result.current.quotesToReply).toBe(3))
      expect('loadReview' in result.current).toBe(false)
      expect('carrierSales' in result.current).toBe(false)
    } finally {
      auth.hasPageAccess = () => true
    }
  })
})
