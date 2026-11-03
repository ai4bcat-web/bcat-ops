/**
 * The one staff shell: every authenticated page renders inside it — `/tms/*` pages in page
 * scroll, the legacy BCAT Ops pages in `fill` mode.
 *
 * The sidebar is `buildNavSections`, so a page appears in the rail or not at all. The Shipments item lists the saved views this user is allowed
 * to see; `TmsShell` turns them into `/tms/shipments/view/<slug>` links.
 */
import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TmsShell, type TmsLiveChild } from '@/features/tms/TmsShell'
import { useOwnershipDivisions, useShipmentViews } from '@/features/tms/useShipmentViews'
import { buildNavSections, companyOptions, tmsBreadcrumb } from '@/lib/navSections'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { useAuth } from '@/hooks/useAuth'
import { NotificationsDrawer } from '@/features/tms/notifications/NotificationsDrawer'
import { useNotifications } from '@/features/tms/notifications/useNotifications'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { personName } from '@/lib/roles'
import { useAppStore } from '@/store/useAppStore'
import { DispatchDrawer } from '@/features/dispatch/DispatchDrawer'
import { useShellBadgeCounts, movingShipments } from '@/features/tms/useShellBadgeCounts'

function LegacyRuntime() {
  const { user } = useAuth()
  const initializeData = useAppStore((s) => s.initializeData)
  useEffect(() => {
    if (user?.email) initializeData(user.email)
  }, [user?.email, initializeData])
  return null
}

/** Dispatch beside every legacy page, for those who can open it; hideable per person. */
function LegacyAside() {
  const { user } = useAuth()
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 901px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 901px)')
    const onChange = () => setIsDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return <DispatchDrawer key={user?.email ?? 'anon'} isDesktop={isDesktop} />
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
  const badgeCounts = useShellBadgeCounts({
    shipments,
    userId,
    staffById: byId,
    staff: staff.staff,
    myTeamKeys: me?.teamKeys ?? [],
  })

  // "Tracking" is the loads moving right now, the same definition the dashboard's Tracked
  // metric uses. The rail lists the six most recently updated ones.
  const trackedLoads = useMemo<TmsLiveChild[]>(
    () =>
      [...movingShipments(shipments)]
        .sort((a, b) => (b.lastUpdateAt ?? '').localeCompare(a.lastUpdateAt ?? ''))
        .slice(0, 6)
        .map((row) => ({ id: row.id, label: row.number, sub: row.customerName ?? null, to: `/tms/shipments/${row.id}` })),
    [shipments],
  )

  // The bell's number is everything the notification drawer lists for this person.
  const { groups: notificationGroups, count: notificationCount } = useNotifications(shipments)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const companies = useMemo(() => companyOptions(sections, divisions), [sections, divisions])

  const email = user?.email ?? ''
  // Every route that is not under /tms is a legacy page: same shell, but the content area is
  // a fixed-height host (the pages scroll themselves) with the dispatch column beside it.
  const legacy = !location.pathname.startsWith('/tms')
  const initial = personName({ name: me?.name, email }, 'Team member').charAt(0).toUpperCase()
  return (
    <TmsShell
      pinned={pinned}
      sections={sections}
      activePath={location.pathname}
      breadcrumb={tmsBreadcrumb(location.pathname, shipmentViews)}
      user={{ initial, email, name: me?.name ?? null }}
      shipmentViews={shipmentViews}
      badgeCounts={badgeCounts}
      companies={companies}
      notificationCount={notificationCount}
      onOpenNotifications={() => setNotificationsOpen(true)}
      notificationsOpen={notificationsOpen}
      trackedLoads={trackedLoads}
      onLogout={() => { void logout() }}
      onSearch={(q) => navigate(`/tms/shipments?q=${encodeURIComponent(q)}`)}
      fill={legacy}
      aside={legacy ? <LegacyAside /> : undefined}
    >
      {legacy ? (
        <>
          <LegacyRuntime />
          <div className="tms-legacy-host">
            <Outlet />
          </div>
        </>
      ) : (
        <Outlet />
      )}
      <NotificationsDrawer open={notificationsOpen} onOpenChange={setNotificationsOpen} groups={notificationGroups} />
    </TmsShell>
  )
}
