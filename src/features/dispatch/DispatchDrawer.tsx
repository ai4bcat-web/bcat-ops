import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useDispatchUnread } from '@/hooks/useDispatch'
import { DispatchPage } from './DispatchPage'

const KEY = (email: string) => `bcat.dispatch.drawer.${(email || 'anon').toLowerCase()}`

function readOpen(email: string): boolean {
  try { return localStorage.getItem(KEY(email)) !== 'closed' } catch { return true }
}

/**
 * Dispatch beside every page, for anyone who can open it: the same list and threads in a
 * right-hand column, so a driver's text is answered without leaving the calendar. Each
 * person can hide it (remembered on their device) and bring it back from the corner button.
 * Not on the Dispatch page itself, and not on phones, where the page is the better fit.
 */
export function DispatchDrawer({ isDesktop }: { isDesktop: boolean }) {
  const { user, hasPageAccess } = useAuth()
  const location = useLocation()
  const email = user?.email ?? ''
  const allowed = !!user && hasPageAccess('dispatch')
  // Read once per signed-in user: AppLayout keys this component by email, so a different
  // login mounts a fresh drawer with that person's own choice.
  const [open, setOpen] = useState(() => readOpen(email))
  const unread = useDispatchUnread(allowed && !open)
  if (!allowed || !isDesktop || location.pathname.startsWith('/dispatch')) return null

  const set = (next: boolean) => {
    setOpen(next)
    try { localStorage.setItem(KEY(email), next ? 'open' : 'closed') } catch { /* fine */ }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => set(true)}
        title="Show the dispatch drawer"
        // Below the side panels (zIndex 50): when a load drawer is open its scrim covers this
        // button instead of the button sitting on top of the drawer's Edit Load control.
        style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 40, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 999, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}
      >
        <MessageSquare className="size-4" style={{ color: 'var(--ds-blue)' }} /> Dispatch
        {unread ? <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: 'var(--ds-blue)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{unread}</span> : null}
      </button>
    )
  }

  return (
    <aside aria-label="Dispatch" style={{ width: 400, flexShrink: 0, borderLeft: '1px solid var(--ds-border)', background: 'var(--ds-surface)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <DispatchPage compact onHide={() => set(false)} />
    </aside>
  )
}
