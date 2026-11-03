/**
 * The shell every `/tms/*` page renders inside.
 *
 * The sidebar is the same `buildNavSections` the legacy rail uses, so a page appears in
 * both places or neither. The Shipments item lists the saved views this user is allowed
 * to see; `TmsShell` turns them into `/tms/shipments/view/<slug>` links.
 */
import { useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TmsShell, type TmsLiveChild } from '@/features/tms/TmsShell'
import { useOwnershipDivisions, useShipmentViews } from '@/features/tms/useShipmentViews'
import { buildNavSections, companyOptions, TMS_PAGE_KEY, tmsBreadcrumb } from '@/lib/navSections'
import { MOVEMENT_STATUSES } from '@/lib/brokerageCharts'
import { boardStatusOf, viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { useAuth } from '@/hooks/useAuth'
import { useCheckCallWorklist } from '@/hooks/useCheckCallWorklist'
import { useShipments, type ShipmentListRow } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import type { UserProfileRecord } from '@/types/tms'

/** The board status facets that mean a load is still in a rep's working queue. */
const WORKING_BOARD_STATUSES = ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED']

function isWorking(row: ShipmentListRow): boolean {
  return WORKING_BOARD_STATUSES.includes(boardStatusOf({ status: row.status, voidedAt: row.voidedAt }))
}

function profileForRep(
  repId: string,
  staffById: Record<string, UserProfileRecord>,
  staff: UserProfileRecord[],
): UserProfileRecord | undefined {
  return staffById[repId] ?? staff.find((p) => p.email === repId)
}

/**
 * Sidebar badge counts for the TMS rail.
 *
 * The legacy `NavBar` has its own resolver wired to the old BCAT Ops chrome; this one
 * lives here so the MVMNT rail can count the same records without being coupled to the
 * legacy badge machinery. That lets Step P ship the My queue / Team queue counts under
 * `/tms/*` while the rest of the app keeps its existing rail untouched.
 */
function useTmsBadgeCounts(
  shipments: ShipmentListRow[],
  userId: string,
  staffById: Record<string, UserProfileRecord>,
  staff: UserProfileRecord[],
  myTeamKeys: string[],
): Record<string, number> {
  return useMemo(() => {
    const myTeam = new Set(myTeamKeys)
    let myQueue = 0
    let teamQueue = 0
    for (const row of shipments) {
      if (!isWorking(row)) continue
      const repId = row.dispatcherAssignedId
      if (!repId) continue
      const profile = profileForRep(repId, staffById, staff)
      const repTeamKeys = profile?.teamKeys ?? []
      if (repId === userId || profile?.id === userId || profile?.email === userId) {
        myQueue++
      }
      if (repTeamKeys.some((k) => myTeam.has(k))) {
        teamQueue++
      }
    }
    return { myQueue, teamQueue }
  }, [shipments, userId, staffById, staff, myTeamKeys])
}

export function TmsLayout() {
  const { user, isOwner, isAdmin, hasPageAccess, logout } = useAuth()
  const { divisions } = useOwnershipDivisions()
  const { views } = useShipmentViews()
  const { shipments } = useShipments({ kind: 'all' })
  const staff = useStaff(user?.email)
  const { me, byId } = staff
  const location = useLocation()
  const navigate = useNavigate()

  const { pinned, sections } = useMemo(
    () => buildNavSections({ divisions, hasPageAccess, isOwner, isAdmin }),
    [divisions, hasPageAccess, isOwner, isAdmin],
  )

  // The sidebar lists exactly the views the Shipments page will let this person open,
  // so it builds its caller the same way the board does — the role off the `role-*`
  // group and the divisions off the profile. Anything less and the rail offers a link
  // to a view the page then refuses to show. The default view is left out: it is the
  // Active Shipments row itself, and listing it twice invites the question of which
  // one is the board.
  const shipmentViews = useMemo(
    () => viewsVisibleTo(views, viewCallerOf({
      groups: user?.groups,
      divisions: me?.divisions,
      isOwner,
      isAdmin,
    }))
      .filter((view) => !view.isDefault)
      .map((view) => ({ slug: view.slug, name: view.name })),
    [views, user?.groups, me?.divisions, isOwner, isAdmin],
  )

  const userId = user?.email ?? user?.userId ?? ''
  const teamCounts = useTmsBadgeCounts(
    shipments,
    userId,
    byId,
    staff.staff,
    me?.teamKeys ?? [],
  )

  // "Tracking" is the loads moving right now, the same definition the dashboard's Tracked
  // metric uses. The rail lists the six most recently updated ones.
  const { trackedCount, trackedLoads } = useMemo(() => {
    const moving = shipments.filter(
      (row) => row.loadStatus != null && MOVEMENT_STATUSES.includes(row.loadStatus) && !row.voidedAt,
    )
    const live: TmsLiveChild[] = [...moving]
      .sort((a, b) => (b.lastUpdateAt ?? '').localeCompare(a.lastUpdateAt ?? ''))
      .slice(0, 6)
      .map((row) => ({ id: row.id, label: row.number, sub: row.customerName ?? null, to: `/tms/shipments/${row.id}` }))
    return { trackedCount: moving.length, trackedLoads: live }
  }, [shipments])
  const badgeCounts = useMemo(() => ({ ...teamCounts, tracking: trackedCount }), [teamCounts, trackedCount])

  // The bell's number is the check-call worklist's due count: one `checkCallState`
  // function behind the legacy rail, the Check calls page and the notifier.
  const { dueCount } = useCheckCallWorklist({
    enabled: isOwner || isAdmin || hasPageAccess('loads') || hasPageAccess(TMS_PAGE_KEY),
  })
  const companies = useMemo(() => companyOptions(sections, divisions), [sections, divisions])

  const email = user?.email ?? ''
  return (
    <TmsShell
      pinned={pinned}
      sections={sections}
      activePath={location.pathname}
      breadcrumb={tmsBreadcrumb(location.pathname, shipmentViews)}
      user={{ initial: (email.trim()[0] ?? 'U').toUpperCase(), email, name: me?.name ?? null }}
      shipmentViews={shipmentViews}
      badgeCounts={badgeCounts}
      companies={companies}
      notificationCount={dueCount}
      trackedLoads={trackedLoads}
      onLogout={() => { void logout() }}
      onSearch={(q) => navigate(`/tms/shipments?q=${encodeURIComponent(q)}`)}
    >
      <Outlet />
    </TmsShell>
  )
}
