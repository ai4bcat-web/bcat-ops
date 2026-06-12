import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage } from '@/lib/utils/errorMessage'
import {
  Mail, Plus, KeyRound, UserX, UserCheck, ChevronDown, ShieldCheck, Shield,
  Check, Loader2, RefreshCw, AlertTriangle, Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'
import { useAuth } from '@/hooks/useAuth'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  resetCognitoPassword, setUserAdmin,
  getUserGroups, setUserPageGroups,
  type CognitoUser,
} from '@/lib/apiClient'
import { PERMISSION_PAGES } from '@/lib/navItems'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const PAGE_OPTIONS = PERMISSION_PAGES
const TOTAL_PAGES = PAGE_OPTIONS.length

type UserWithGroups = CognitoUser & { groups: string[] }

// ── Helpers ─────────────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#1ea8f3', '#a78bfa', '#f59e0b', '#22c55e', '#ec4899', '#14b8a6', '#ef4444', '#3b82f6']
function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

// Cognito users have no name attribute — derive a friendly name from the email local part.
function displayName(u: CognitoUser): string {
  const local = (u.email ?? u.username ?? '').split('@')[0]
  if (!local) return u.username ?? '—'
  return local.split(/[._-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
function getInitials(name: string): string {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}
function formatAdded(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

const isUserAdmin = (u: UserWithGroups) => u.groups.includes('ADMIN')
const pageGroupCount = (u: UserWithGroups) => u.groups.filter((g) => g.startsWith('page-')).length

function StatusPill({ user }: { user: CognitoUser }) {
  if (user.status === 'FORCE_CHANGE_PASSWORD') {
    return <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">Invite pending</span>
  }
  if (!user.enabled) {
    return <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">Disabled</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
      <span className="size-1.5 rounded-full bg-emerald-500" />Active
    </span>
  )
}

// ── User card (expandable) ────────────────────────────────────────────────────

interface UserCardProps {
  user: UserWithGroups
  onTogglePage: (u: UserWithGroups, pageKey: string) => void
  onToggleAdmin: (u: UserWithGroups, makeAdmin: boolean) => Promise<void>
  onReset: (u: UserWithGroups) => Promise<void>
  onToggleEnabled: (u: UserWithGroups) => Promise<void>
  busyAdminId: string | null
  resettingId: string | null
  togglingId: string | null
}

function UserCard({ user, onTogglePage, onToggleAdmin, onReset, onToggleEnabled, busyAdminId, resettingId, togglingId }: UserCardProps) {
  const [expanded, setExpanded] = useState(false)
  const admin = isUserAdmin(user)
  const name = displayName(user)
  const color = avatarColor(user.email ?? user.username ?? '')
  const count = pageGroupCount(user)
  const access = admin ? 'Full access' : count === 0 ? 'Unrestricted' : `${count}/${TOTAL_PAGES} pages`
  const isResetting = resettingId === user.username
  const isToggling = togglingId === user.username
  const isAdminBusy = busyAdminId === user.username

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4">
        {/* Avatar + live dot */}
        <div className="relative shrink-0">
          <Avatar initials={getInitials(name)} size="lg" style={{ background: color, color: '#fff' }} />
          {user.enabled && (
            <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-500 ring-2 ring-white" title="Active" />
          )}
        </div>

        {/* Name + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{name}</span>
            {admin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border bg-violet-50 text-violet-700 border-violet-200 shrink-0">
                <ShieldCheck className="size-3" />Admin
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {user.email}{user.createdAt && <span className="text-muted-foreground/60"> · Added {formatAdded(user.createdAt)}</span>}
          </div>
        </div>

        {/* Access summary */}
        <div className="hidden md:block shrink-0 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Access</div>
          <div className={cn('text-xs mt-0.5', count > 0 && !admin ? 'font-mono text-foreground' : 'text-muted-foreground')}>{access}</div>
        </div>

        {/* Status */}
        <div className="shrink-0"><StatusPill user={user} /></div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => onReset(user)} disabled={isResetting || !user.enabled}>
            {isResetting ? <Loader2 className="size-3 animate-spin" /> : <KeyRound className="size-3" />}Reset
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn('h-8 gap-1.5 text-xs', user.enabled ? 'text-destructive border-destructive/30 hover:bg-destructive/5' : 'text-emerald-700 border-emerald-300 hover:bg-emerald-50')}
            onClick={() => onToggleEnabled(user)}
            disabled={isToggling}
          >
            {isToggling ? <Loader2 className="size-3 animate-spin" /> : user.enabled ? <UserX className="size-3" /> : <UserCheck className="size-3" />}
            {user.enabled ? 'Disable' : 'Enable'}
          </Button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 transition-colors"
            aria-label="Toggle permissions"
          >
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ background: 'var(--ds-bg)', borderTop: '1px solid var(--ds-border)', padding: '16px 20px' }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Page Access</p>
            <button
              onClick={() => onToggleAdmin(user, !admin)}
              disabled={isAdminBusy}
              className={cn('inline-flex items-center gap-1 text-[11px] font-medium transition-colors', admin ? 'text-muted-foreground hover:text-destructive' : 'text-violet-600 hover:text-violet-800')}
            >
              {isAdminBusy ? <Loader2 className="size-3 animate-spin" /> : <Shield className="size-3" />}
              {admin ? 'Remove admin' : 'Make admin'}
            </button>
          </div>

          {admin ? (
            <div className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3">
              <ShieldCheck className="size-4 text-violet-600 shrink-0" />
              <span className="text-sm font-medium text-violet-700">Full access to all pages</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {PAGE_OPTIONS.map(({ key, label }) => {
                  const on = user.groups.includes(`page-${key}`)
                  return (
                    <button
                      key={key}
                      onClick={() => onTogglePage(user, key)}
                      className={cn(
                        'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border text-xs font-medium transition-all',
                        on ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {on && <Check className="size-3.5 shrink-0" />}{label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground mt-3">
                Click a page to toggle · changes save instantly. No pages selected = full access.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UsersPage() {
  // Only the owner (ryne@bcatcorp.com) may view or manage users. Other admins are redirected.
  const { loading: authLoading, isOwner } = useAuth()
  const navigate = useNavigate()
  const [users, setUsers] = useState<UserWithGroups[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [invitePages, setInvitePages] = useState<string[]>([])
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [busyAdminId, setBusyAdminId] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !isOwner) {
      toast.error("You don't have access to that page.")
      navigate('/dashboard', { replace: true })
    }
  }, [authLoading, isOwner, navigate])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listCognitoUsers()
      // Load each user's groups so the header can show admin/access without expanding.
      const groups = await Promise.all(list.map((u) => getUserGroups(u.username).catch(() => [])))
      setUsers(list.map((u, i) => ({ ...u, groups: groups[i] })))
    } catch (err: unknown) {
      console.error('[users] fetch failed', err)
      setError(errorMessage(err))
      toast.error(`Failed to load users: ${errorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOwner) loadUsers()
  }, [isOwner, loadUsers])

  const toggleInvitePage = (key: string) =>
    setInvitePages((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = newEmail.trim()
    if (!email) return
    setCreating(true)
    try {
      await createCognitoUser(email)
      try {
        if (inviteAdmin) await setUserAdmin(email, true)
        else if (invitePages.length > 0) await setUserPageGroups(email, invitePages)
      } catch (permErr: unknown) {
        toast.error(`User invited, but setting access failed: ${errorMessage(permErr)}`)
      }
      toast.success(`Invite sent to ${email}`)
      setNewEmail('')
      setInvitePages([])
      setInviteAdmin(false)
      await loadUsers()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  // Optimistic page-permission toggle → updateUserPermissions (setUserPageGroups).
  const handleTogglePage = (u: UserWithGroups, pageKey: string) => {
    const grp = `page-${pageKey}`
    const before = u.groups
    const next = before.includes(grp) ? before.filter((g) => g !== grp) : [...before, grp]
    setUsers((prev) => prev.map((x) => (x.username === u.username ? { ...x, groups: next } : x)))
    const pages = next.filter((g) => g.startsWith('page-')).map((g) => g.replace('page-', ''))
    setUserPageGroups(u.username, pages).catch((err: unknown) => {
      toast.error(`Failed to update permissions: ${errorMessage(err)}`)
      setUsers((prev) => prev.map((x) => (x.username === u.username ? { ...x, groups: before } : x)))
    })
  }

  const handleToggleAdmin = async (u: UserWithGroups, makeAdmin: boolean) => {
    setBusyAdminId(u.username)
    const before = u.groups
    const next = makeAdmin ? [...before.filter((g) => g !== 'ADMIN'), 'ADMIN'] : before.filter((g) => g !== 'ADMIN')
    setUsers((prev) => prev.map((x) => (x.username === u.username ? { ...x, groups: next } : x)))
    try {
      await setUserAdmin(u.username, makeAdmin)
      toast.success(makeAdmin ? `${u.email} is now an admin` : `Admin removed from ${u.email}`)
    } catch (err: unknown) {
      toast.error(`Failed to update admin: ${errorMessage(err)}`)
      setUsers((prev) => prev.map((x) => (x.username === u.username ? { ...x, groups: before } : x)))
    } finally {
      setBusyAdminId(null)
    }
  }

  const handleReset = async (u: UserWithGroups) => {
    if (!confirm(`Send a password reset email to ${u.email}?`)) return
    setResettingId(u.username)
    try {
      await resetCognitoPassword(u.username)
      toast.success(`Password reset email sent to ${u.email}`)
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setResettingId(null)
    }
  }

  const handleToggleEnabled = async (u: UserWithGroups) => {
    setTogglingId(u.username)
    try {
      if (u.enabled) {
        await disableCognitoUser(u.username)
        toast.success(`${u.email} disabled`)
      } else {
        await enableCognitoUser(u.username)
        toast.success(`${u.email} enabled`)
      }
      await loadUsers()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  // Never flash real UI for non-owners while the redirect is in flight
  if (authLoading || !isOwner) return null

  const total       = users.length
  const activeCount = users.filter((u) => u.enabled).length
  const adminCount  = users.filter(isUserAdmin).length
  const disabled    = users.filter((u) => !u.enabled).length

  const KPIS = [
    { label: 'Total Users', value: total,       color: '#1ea8f3' },
    { label: 'Active',      value: activeCount,  color: '#22c55e' },
    { label: 'Admins',      value: adminCount,   color: '#a78bfa' },
    { label: 'Disabled',    value: disabled,     color: 'var(--ds-t3)' },
  ]

  const segStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, height: 32, borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 12.5, fontWeight: active ? 600 : 500,
    background: active ? '#fff' : 'transparent',
    color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
    boxShadow: active ? 'var(--sh-sm)' : 'none',
    transition: 'all 0.15s',
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div className="flex items-center justify-between px-8 pt-5 pb-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">User Management</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Workspace members · roles · access</p>
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={loadUsers} disabled={loading}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />Refresh
          </Button>
        </div>
      </div>

      <div style={{ padding: 32 }}>
        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {KPIS.map((k) => (
            <div key={k.label} style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: '0.03em', textTransform: 'uppercase' }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* 2-column grid: sticky invite + user list */}
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, alignItems: 'start' }}>

          {/* Invite card */}
          <div style={{ position: 'sticky', top: 24 }}>
            <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: 22 }}>
              <h2 className="text-base font-semibold text-foreground">Invite New User</h2>
              <p className="text-xs text-muted-foreground mt-0.5 mb-4">They'll receive an email with a temporary password.</p>

              <form onSubmit={handleCreate} className="flex flex-col gap-4">
                {/* Email */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Address</label>
                  <div className="relative">
                    <Mail className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <input
                      type="email"
                      placeholder="driver@bcatcorp.com"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      required
                      disabled={creating}
                      style={{ width: '100%', height: 38, paddingLeft: 36, paddingRight: 12, boxSizing: 'border-box', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 13, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none' }}
                    />
                  </div>
                </div>

                {/* Access level segmented toggle */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Access Level</label>
                  <div style={{ display: 'flex', gap: 3, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3 }}>
                    <button type="button" onClick={() => setInviteAdmin(false)} style={segStyle(!inviteAdmin)}>Custom pages</button>
                    <button type="button" onClick={() => setInviteAdmin(true)} style={segStyle(inviteAdmin)}>Admin — all</button>
                  </div>
                </div>

                {/* Page chips (custom only) */}
                {!inviteAdmin && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pages</label>
                    <div className="flex flex-wrap gap-1.5">
                      {PAGE_OPTIONS.map(({ key, label }) => {
                        const on = invitePages.includes(key)
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleInvitePage(key)}
                            className={cn(
                              'inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs font-medium transition-all',
                              on ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                            )}
                          >
                            {on && <Check className="size-3 shrink-0" />}{label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">Leave empty for full access.</p>
                  </div>
                )}

                <Button type="submit" className="gap-1.5 mt-1" disabled={creating || !newEmail.trim()}>
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {creating ? 'Sending…' : 'Send Invite'}
                </Button>
              </form>
            </div>
          </div>

          {/* User list */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              All Users {!loading && <span className="text-muted-foreground font-normal">({users.length})</span>}
            </h2>

            {error && (
              <div className="rounded-xl border border-destructive/30 bg-red-50 px-5 py-4 flex items-center gap-3">
                <AlertTriangle className="size-4 text-destructive shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-destructive font-medium">Failed to load users</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{error}</p>
                </div>
                <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={loadUsers}>Retry</Button>
              </div>
            )}

            {loading ? (
              <div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading users…
              </div>
            ) : !error && users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                <Users className="size-8 opacity-20" />
                <p className="text-sm">No users found.</p>
              </div>
            ) : !error ? (
              users.map((u) => (
                <UserCard
                  key={u.username}
                  user={u}
                  onTogglePage={handleTogglePage}
                  onToggleAdmin={handleToggleAdmin}
                  onReset={handleReset}
                  onToggleEnabled={handleToggleEnabled}
                  busyAdminId={busyAdminId}
                  resettingId={resettingId}
                  togglingId={togglingId}
                />
              ))
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
