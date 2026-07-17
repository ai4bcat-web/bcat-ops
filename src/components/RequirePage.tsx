import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { NAV_ITEMS } from '@/lib/navItems'

/**
 * Route-level access control. `hasPageAccess` is the SAME allowlist the sidebar uses,
 * so a page hidden from the nav is now also unreachable by direct URL / back-door.
 *
 * A user who lands on a page they can't open is redirected to the first page they
 * CAN open (by nav order) — which avoids redirect loops since that target always
 * passes its own guard. If they can open nothing, they get a plain "no access" panel.
 */
function firstAccessiblePath(hasPageAccess: (k: string) => boolean): string | null {
  return NAV_ITEMS.find((i) => hasPageAccess(i.pageKey))?.to ?? null
}

function NoAccess() {
  const { logout, user } = useAuth()
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ds-bg)', padding: 24 }}>
      <div style={{ maxWidth: 380, textAlign: 'center', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '32px 28px' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)' }}>No page access</div>
        <p style={{ fontSize: 13, color: 'var(--ds-t3)', marginTop: 8, lineHeight: 1.5 }}>
          {user?.email ? `${user.email} isn't` : "You aren't"} granted access to any pages yet. Ask an admin to grant access on the Users page.
        </p>
        <button
          onClick={() => logout()}
          style={{ marginTop: 18, height: 34, padding: '0 16px', borderRadius: 8, border: '1px solid var(--ds-border-strong)', background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/** Guards a route by page permission (the nav `pageKey`). */
export function RequirePage({ page, children }: { page: string; children: ReactNode }) {
  const { hasPageAccess } = useAuth()
  if (hasPageAccess(page)) return <>{children}</>
  const fallback = firstAccessiblePath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}

/** Guards an owner-only route (e.g. Users management). */
export function RequireOwner({ children }: { children: ReactNode }) {
  const { isOwner, hasPageAccess } = useAuth()
  if (isOwner) return <>{children}</>
  const fallback = firstAccessiblePath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}

/** Sends "/" to the first page the user can open. */
export function LandingRedirect() {
  const { hasPageAccess } = useAuth()
  const fallback = firstAccessiblePath(hasPageAccess)
  return fallback ? <Navigate to={fallback} replace /> : <NoAccess />
}
