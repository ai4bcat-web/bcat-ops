/**
 * The shell every `/tms/*` page renders inside.
 *
 * The sidebar is the same `buildNavSections` the legacy rail uses, so a page appears in
 * both places or neither. The Shipments item lists the saved views this user is allowed
 * to see; `TmsShell` turns them into `/tms/shipments/view/<slug>` links.
 */
import { useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TmsShell } from '@/features/tms/TmsShell'
import { useOwnershipDivisions, useShipmentViews } from '@/features/tms/useShipmentViews'
import { buildNavSections, tmsPageTitle } from '@/lib/navSections'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { useAuth } from '@/hooks/useAuth'
import { useStaff } from '@/hooks/useStaff'

export function TmsLayout() {
  const { user, isOwner, isAdmin, hasPageAccess } = useAuth()
  const { divisions } = useOwnershipDivisions()
  const { views } = useShipmentViews()
  const { me } = useStaff(user?.email)
  const location = useLocation()
  const navigate = useNavigate()

  const { pinned, sections } = useMemo(
    () => buildNavSections({ divisions, hasPageAccess, isOwner, isAdmin }),
    [divisions, hasPageAccess, isOwner, isAdmin],
  )

  // The sidebar lists exactly the views the Shipments page will let this person open,
  // so it builds its caller the same way the board does — the role off the `role-*`
  // group and the divisions off the profile. Anything less and the rail offers a link
  // to a view the page then refuses to show.
  const shipmentViews = useMemo(
    () => viewsVisibleTo(views, viewCallerOf({
      groups: user?.groups,
      divisions: me?.divisions,
      isOwner,
      isAdmin,
    })).map((view) => ({ slug: view.slug, name: view.name })),
    [views, user?.groups, me?.divisions, isOwner, isAdmin],
  )

  const email = user?.email ?? ''
  return (
    <TmsShell
      pinned={pinned}
      sections={sections}
      activePath={location.pathname}
      pageTitle={tmsPageTitle(location.pathname)}
      user={{ initial: (email.trim()[0] ?? 'U').toUpperCase(), email }}
      shipmentViews={shipmentViews}
      onSearch={(q) => navigate(`/tms/shipments?q=${encodeURIComponent(q)}`)}
    >
      <Outlet />
    </TmsShell>
  )
}
