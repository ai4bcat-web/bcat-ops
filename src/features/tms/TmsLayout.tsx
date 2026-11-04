/**
 * The one staff shell: every authenticated page renders inside it — `/tms/*` pages in page
 * scroll, the legacy BCAT Ops pages in `fill` mode.
 *
 * The sidebar is `buildNavSections`, so a page appears in the rail or not at all.
 */
import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TmsShell } from '@/features/tms/TmsShell'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { buildNavSections, companyOptions, tmsBreadcrumb } from '@/lib/navSections'
import { useAuth } from '@/hooks/useAuth'
import { NotificationsDrawer } from '@/features/tms/notifications/NotificationsDrawer'
import { useNotifications } from '@/features/tms/notifications/useNotifications'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { personName } from '@/lib/roles'
import { useAppStore } from '@/store/useAppStore'
import { DispatchDrawer } from '@/features/dispatch/DispatchDrawer'
import { useShellBadgeCounts } from '@/features/tms/useShellBadgeCounts'

/** The list pages that run edge to edge on an icon rail (Shipments Active / All / Intake, Load Tracking). */
const DENSE_PATHS = new Set(['/tms/shipments', '/tms/shipments/intake', '/tms/tracking', '/tms/shipments/new'])

/** Those pages plus the create / edit shipment form (`/tms/shipments/new`, `/tms/shipments/:id/edit`). */
function isDensePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '')
  return DENSE_PATHS.has(path) || /^\/tms\/shipments\/[^/]+\/edit$/.test(path)
}

function LegacyRuntime() {
  const { user } = useAuth()
  const initializeData = useAppStore((s) => s.initializeData)
  useEffect(() => {
    if (user?.email) initializeData(user.email)
  }, [user?.email, initializeData])
  return null
}

/** /tms pages skip the legacy runtime, but the bell and the review cards read the fleet roster from the store. */
function TmsReferenceData() {
  const loadReferenceData = useAppStore((s) => s.loadReferenceData)
  useEffect(() => { void loadReferenceData() }, [loadReferenceData])
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
  const { shipments } = useShipments({ kind: 'working' })
  const { me } = useStaff(user?.email)
  const location = useLocation()
  const navigate = useNavigate()

  const { pinned, sections, businesses } = useMemo(
    () => buildNavSections({ divisions, hasPageAccess, isOwner, isAdmin }),
    [divisions, hasPageAccess, isOwner, isAdmin],
  )

  const badgeCounts = useShellBadgeCounts({ shipments })
  // The bell's number is everything the notification drawer lists for this person.
  const { groups: notificationGroups, count: notificationCount } = useNotifications(shipments)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const companies = useMemo(() => companyOptions(businesses, divisions), [businesses, divisions])

  const email = user?.email ?? ''
  // Every route that is not under /tms is a legacy page: same shell, but the content area is
  // a fixed-height host (the pages scroll themselves) with the dispatch column beside it.
  const legacy = !location.pathname.startsWith('/tms')
  const dense = isDensePath(location.pathname)
  const initial = personName({ name: me?.name, email }, 'Team member').charAt(0).toUpperCase()
  return (
    <TmsShell
      pinned={pinned}
      sections={sections}
      activePath={location.pathname}
      activeSearch={location.search}
      breadcrumb={tmsBreadcrumb(location.pathname)}
      user={{ initial, email, name: me?.name ?? null }}
      badgeCounts={badgeCounts}
      companies={companies}
      notificationCount={notificationCount}
      onOpenNotifications={() => setNotificationsOpen(true)}
      notificationsOpen={notificationsOpen}
      onLogout={() => { void logout() }}
      onSearch={(q) => navigate(`/tms/shipments?q=${encodeURIComponent(q)}`)}
      fill={legacy}
      dense={dense}
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
        <>
          <TmsReferenceData />
          <Outlet />
        </>
      )}
      <NotificationsDrawer open={notificationsOpen} onOpenChange={setNotificationsOpen} groups={notificationGroups} />
    </TmsShell>
  )
}
