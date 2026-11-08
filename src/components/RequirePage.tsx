import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { NAV_ITEMS } from '@/lib/navItems'
import { flatNavDefs } from '@/lib/navSections'
import { LIFECYCLE_TABS } from '@/lib/lifecycleTabs'
import { pathIsDormant } from '@/lib/dormantPages'

/**
 * Route-level access control. `hasPageAccess` is the SAME allowlist the sidebar uses,
 * so a page hidden from the nav is now also unreachable by direct URL / back-door.
 *
 * A user who lands on a page they can't open is redirected to the first page they
 * CAN open (by nav order) — which avoids redirect loops since that target always
 * passes its own guard. If they can open nothing, they get a plain "no access" panel.
 *
 * The TMS pages come first: `/tms/*` is where a brokerage user lives, and every one of
 * those routes accepts its original page key OR `tms`. Pinned items (Shipments) are
 * included so a shared-loads grant still has a landing target.
 */
// The lifecycle tabs (Quote, Build, View, Book, Track, Review) left the sidebar: a user granted only one of those pages still needs a landing target.
const ALL_ITEMS = [...flatNavDefs(), ...LIFECYCLE_TABS.map((t) => ({ pageKey: t.pageKey, to: t.to })), ...NAV_ITEMS]

/** A page whose tables are not deployed yet is a landing of last resort: it shows an empty state, so a person who can open anything else lands there first. Admin-only rows never open on a page grant, so they are never a landing. */
function firstAccessiblePath(hasPageAccess: (k: string) => boolean): string | null {
  const open = ALL_ITEMS.filter((i) => hasPageAccess(i.pageKey) && !('adminOnly' in i && i.adminOnly))
  return (open.find((i) => !pathIsDormant(i.to)) ?? open[0])?.to ?? null
}

/**
 * Where "/" (and the "no access to this page" fallback) sends a user, in order: the Dashboard
 * for anyone holding its grant (the owner and ADMIN hold every grant), the Shipments board for a
 * `tms` user, the Fleet Manager Dashboard for a fleet manager; everyone else lands on the first
 * page they can open in nav order. Every target passes its own guard for a user who reached it
 * here, so the redirect cannot loop.
 */
const LANDING_PRIORITY = [
  { key: 'dashboard', to: '/dashboard' },
  { key: 'tms', to: '/tms/shipments' },
  { key: 'fleetManagerDashboard', to: '/fleet-dashboard' },
]

function preferredLandingPath(hasPageAccess: (k: string) => boolean): string | null {
  for (const { key, to } of LANDING_PRIORITY) {
    if (hasPageAccess(key) && !pathIsDormant(to)) return to
  }
  return firstAccessiblePath(hasPageAccess)
}

/**
 * Shown only to a user who may open nothing at all. It renders under the TMS shell and
 * on the legacy BCAT Ops routes alike, so every colour is a `--tms-*` token.
 */
function NoAccess() {
  const { logout, user } = useAuth()
  const surface = 'var(--tms-card)'
  const border = 'var(--tms-border)'
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--tms-bg)', padding: 24 }}>
      <div style={{ maxWidth: 380, textAlign: 'center', background: surface, border: `1px solid ${border}`, borderRadius: 'var(--tms-radius-card)', boxShadow: 'var(--tms-shadow-pop)', padding: '32px 28px' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--tms-text)' }}>No page access</div>
        <p style={{ fontSize: 13, color: 'var(--tms-muted)', marginTop: 8, lineHeight: 1.5 }}>
          {user?.email ? `${user.email} isn't` : "You aren't"} granted access to any pages yet. Ask an admin to grant access on the Users page.
        </p>
        <button
          onClick={() => logout()}
          style={{ marginTop: 18, height: 34, padding: '0 16px', borderRadius: 4, border: `1px solid ${border}`, background: surface, color: 'var(--tms-text)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/**
 * Guards a route by page permission (the nav `pageKey`). A list of keys opens the page
 * for anybody holding ANY of them — the `/tms/*` routes pass their original key and
 * `tms`, so one Brokerage grant replaces fifteen page grants.
 */
export function RequirePage({ page, children }: { page: string | string[]; children: ReactNode }) {
  const { hasPageAccess } = useAuth()
  const keys = typeof page === 'string' ? [page] : page
  if (keys.some(hasPageAccess)) return <>{children}</>
  const fallback = preferredLandingPath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}

/** Guards an owner-only route (e.g. Users management). */
export function RequireOwner({ children }: { children: ReactNode }) {
  const { isOwner, hasPageAccess } = useAuth()
  if (isOwner) return <>{children}</>
  const fallback = preferredLandingPath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}

/**
 * Guards an admin route (Step I: the Users page).
 *
 * An admin may manage people; only the owner may grant ADMIN or delete an
 * account, and the page disables those two controls for everybody else. The
 * server refuses them regardless — `userManagement` keeps its own owner gate,
 * and this guard is the courtesy, not the boundary.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin, isOwner, hasPageAccess } = useAuth()
  if (isOwner || isAdmin) return <>{children}</>
  const fallback = preferredLandingPath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}

/** Sends "/" and `/tms` to the user's landing page (see `LANDING_PRIORITY`). */
export function LandingRedirect() {
  const { hasPageAccess } = useAuth()
  const fallback = preferredLandingPath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}
