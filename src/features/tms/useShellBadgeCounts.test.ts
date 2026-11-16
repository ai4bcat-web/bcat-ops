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
vi.mock('@/hooks/useCheckCallWorklist', () => ({ useCheckCallWorklist: () => ({
  dueCount: 2,
  // One due on a load still in operations, one on a load already in Load Review.
  rows: [{ state: 'DUE', load: { id: 'l1' } }, { state: 'OVERDUE', load: { id: 'l3' } }, { state: 'SCHEDULED', load: { id: 'l1' } }],
}) }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({
  pendingCount: 2,
  documents: [{ shipmentId: 's1' }, { shipmentId: 's3', orderId: 'o3' }],
}) }))
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
import { lifecycleRows as trackingLifecycleRows } from '@/features/shipments/workstations/tracking/trackingTable'

const shipments = [
  { id: 's1', status: 'OPEN', voidedAt: null, loadIds: ['l1'], orderIds: ['o1'], dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT', rateConSentAt: '2026-11-10T12:00:00Z' },
  { id: 's2', status: 'OPEN', voidedAt: '2026-01-01', dispatcherAssignedId: 'rep@bcatcorp.com', loadStatus: 'IN_TRANSIT' },
  // Delivered and pushed into Load Review: it has left operations, so nothing on it is Tracking work.
  { id: 's3', status: 'DELIVERED', voidedAt: null, loadIds: ['l3'], orderIds: ['o3'], loadReviewPushedAt: '2026-11-13T21:07:26Z' },
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
    // The Track badge is the loads in tracking: s1 only (s2 is voided, s3 is in Load Review).
    expect(result.current.loadTracking).toBe(1)
    // Its attention count: only work on loads still in operations, s1's due check call + s1's document.
    expect(result.current.loadTrackingDue).toBe(2)
    // arToInvoice 1 + apToReview 1.
    expect(result.current.accounting).toBe(2)
  })

  it('badges Track with exactly the rows the Track page lists under Active', async () => {
    const rows = [
      ...shipments,
      // Delivered, POD still due: Tracking keeps it until the POD is on file.
      { id: 's4', status: 'DELIVERED', voidedAt: null, loadIds: ['l4'], orderIds: ['o4'], rateConSentAt: '2026-11-10T12:00:00Z', docsMissing: ['POD'] },
      // No rate con sent: the page hides it by default, so the badge does too.
      { id: 's5', status: 'OPEN', voidedAt: null, loadIds: ['l5'], orderIds: ['o5'], loadStatus: 'IN_TRANSIT' },
    ] as unknown as ShipmentListRow[]
    const { result } = renderHook(() => useShellBadgeCounts({ shipments: rows }))
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    expect(result.current.loadTracking).toBe(trackingLifecycleRows(rows as never, 'active', false).length)
    expect(result.current.loadTracking).toBe(2)
  })

  it('badges View with the board\'s Active count (voided rows left out)', async () => {
    const { result } = renderHook(() => useShellBadgeCounts(args))
    await waitFor(() => expect(result.current.intakeLoads).toBe(2))
    expect(result.current.activeShipments).toBe(1)
  })

  it('hides Load Review and Carrier Sales counts from a user without the grants', async () => {
    auth.hasPageAccess = (key) => key === 'quotes'
    try {
      const { result } = renderHook(() => useShellBadgeCounts(args))
      await waitFor(() => expect(result.current.quotesToReply).toBe(3))
      expect('loadReview' in result.current).toBe(false)
      expect('carrierSales' in result.current).toBe(false)
      expect('activeShipments' in result.current).toBe(false)
    } finally {
      auth.hasPageAccess = () => true
    }
  })
})
