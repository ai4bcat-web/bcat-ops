import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage } from '@/lib/utils/errorMessage'
import { Users, Plus, UserCheck, UserX, RefreshCw, AlertTriangle, ChevronDown, ChevronUp, Loader2, KeyRound, ShieldCheck, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/useAuth'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  resetCognitoPassword, setUserAdmin,
  getUserGroups, setUserPageGroups,
  type CognitoUser,
} from '@/lib/apiClient'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// Controllable pages — must mirror the gated (non-alwaysVisible) nav items in NavBar.tsx
// and the Lambda's PAGE_GROUPS. Intake/Tasks/Compliance are always visible, so not listed.
const PAGE_OPTIONS = [
  { key: 'dashboard',   label: 'Dashboard'   },
  { key: 'calendar',    label: 'Calendar'    },
  { key: 'loads',       label: 'Loads'       },
  { key: 'drivers',     label: 'Drivers'     },
  { key: 'trucks',      label: 'Fleet'       },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'expenses',    label: 'Expenses'    },
  { key: 'schedule',    label: 'Schedules'   },
  { key: 'audit',       label: 'Audit Log'   },
] as const

function StatusBadge({ user }: { user: CognitoUser }) {
  if (user.status === 'FORCE_CHANGE_PASSWORD') {
    return <Badge variant="orange">Invite Pending</Badge>
  }
  if (!user.enabled) {
    return <Badge variant="secondary">Disabled</Badge>
  }
  return <Badge variant="green">Active</Badge>
}

function UserRow({
  user,
  index,
  onToggle,
  onReset,
  togglingId,
  resettingId,
}: {
  user: CognitoUser
  index: number
  onToggle: (u: CognitoUser) => Promise<void>
  onReset: (u: CognitoUser) => Promise<void>
  togglingId: string | null
  resettingId: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [groups, setGroups] = useState<string[] | null>(null)
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [savingGroups, setSavingGroups] = useState(false)
  const [togglingAdmin, setTogglingAdmin] = useState(false)

  const handleExpand = async () => {
    if (!expanded && groups === null) {
      setLoadingGroups(true)
      try {
        const g = await getUserGroups(user.username)
        setGroups(g)
      } catch {
        setGroups([])
      } finally {
        setLoadingGroups(false)
      }
    }
    setExpanded((v) => !v)
  }

  const togglePage = async (pageKey: string) => {
    if (groups === null) return
    const next = groups.includes(`page-${pageKey}`)
      ? groups.filter((g) => g !== `page-${pageKey}`)
      : [...groups, `page-${pageKey}`]
    setGroups(next)
    setSavingGroups(true)
    try {
      const pageGroups = next.filter((g) => g.startsWith('page-')).map((g) => g.replace('page-', ''))
      await setUserPageGroups(user.username, pageGroups)
    } catch {
      toast.error('Failed to update permissions')
      setGroups(groups)
    } finally {
      setSavingGroups(false)
    }
  }

  const isAdmin = groups?.includes('ADMIN') ?? false
  const isToggling = togglingId === user.username
  const isResetting = resettingId === user.username

  const handleAdminToggle = async () => {
    if (!groups) return
    setTogglingAdmin(true)
    const next = !isAdmin
    try {
      await setUserAdmin(user.username, next)
      setGroups(next ? [...groups, 'ADMIN'] : groups.filter((g) => g !== 'ADMIN'))
      toast.success(next ? `${user.email} is now an admin` : `Admin removed from ${user.email}`)
    } catch {
      toast.error('Failed to update admin status')
    } finally {
      setTogglingAdmin(false)
    }
  }

  return (
    <div style={index !== 0 ? { borderTop: '1px solid var(--ds-border)' } : {}}>
      {/* Main row */}
      <div className="flex items-center gap-3 px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {user.email ?? user.username ?? '—'}
            </span>
            {user.email === 'ryne@bcatcorp.com' && (
              <Badge variant="secondary" className="bg-sky-50 text-sky-700 border-sky-200 gap-1 shrink-0">
                <ShieldCheck className="size-3" />
                Admin
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge user={user} />
            {user.createdAt && (
              <span className="text-xs text-muted-foreground">
                Added {new Date(user.createdAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Reset password */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => onReset(user)}
                disabled={isResetting || !user.enabled}
              >
                {isResetting
                  ? <Loader2 className="size-3 animate-spin" />
                  : <KeyRound className="size-3" />}
                Reset PW
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send password reset email</TooltipContent>
          </Tooltip>

          {/* Enable / Disable */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-8 gap-1.5 text-xs',
                  user.enabled
                    ? 'text-destructive border-destructive/30 hover:bg-destructive/5'
                    : 'text-emerald-700 border-emerald-300 hover:bg-emerald-50',
                )}
                onClick={() => onToggle(user)}
                disabled={isToggling}
              >
                {isToggling ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : user.enabled ? (
                  <UserX className="size-3" />
                ) : (
                  <UserCheck className="size-3" />
                )}
                {user.enabled ? 'Disable' : 'Enable'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{user.enabled ? 'Disable this user' : 'Re-enable this user'}</TooltipContent>
          </Tooltip>

          {/* Permissions expand */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground"
                onClick={handleExpand}
              >
                {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Page permissions</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Permissions panel */}
      {expanded && (
        <div style={{ padding: '0 24px 16px', background: 'var(--ds-bg)', borderTop: '1px solid var(--ds-border)' }}>
          <div className="pt-3">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Page Access
              </p>
              {savingGroups && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </div>
            {loadingGroups ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : isAdmin ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-emerald-700 font-medium">Admin — full access to all pages</p>
                <button
                  onClick={handleAdminToggle}
                  disabled={togglingAdmin}
                  className="text-[11px] text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                >
                  {togglingAdmin ? <Loader2 className="size-3 animate-spin" /> : <Shield className="size-3" />}
                  Remove admin
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {PAGE_OPTIONS.map(({ key, label }) => {
                  const active = groups?.includes(`page-${key}`) ?? false
                  return (
                    <button
                      key={key}
                      onClick={() => togglePage(key)}
                      disabled={savingGroups}
                      style={{
                        height: 28, padding: '0 12px', fontSize: 12, fontWeight: 600,
                        borderRadius: 999, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                        background: active ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
                        color: active ? 'var(--ds-blue)' : 'var(--ds-t3)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex items-center justify-between mt-2.5">
              <p className="text-[11px] text-muted-foreground">
                Click a page to toggle access. Changes save instantly.
              </p>
              <button
                onClick={handleAdminToggle}
                disabled={togglingAdmin || groups === null}
                className="text-[11px] text-sky-600 hover:text-sky-800 transition-colors flex items-center gap-1 shrink-0"
              >
                {togglingAdmin ? <Loader2 className="size-3 animate-spin" /> : <Shield className="size-3" />}
                Make admin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function UsersPage() {
  // Only the owner (ryne@bcatcorp.com) may view or manage users. Other admins are redirected.
  const { loading: authLoading, isOwner } = useAuth()
  const navigate = useNavigate()
  const [users, setUsers] = useState<CognitoUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rawError, setRawError] = useState<unknown>(null)
  const [newEmail, setNewEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  // Page access chosen at invite time (bare keys, e.g. 'dashboard'); empty = none yet.
  const [invitePages, setInvitePages] = useState<string[]>([])
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const toggleInvitePage = (key: string) =>
    setInvitePages((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  // Client-side access gate — redirect non-owners immediately.
  // Server-side enforcement is handled independently in the Lambda.
  useEffect(() => {
    if (!authLoading && !isOwner) {
      toast.error("You don't have access to that page.")
      navigate('/dashboard', { replace: true })
    }
  }, [authLoading, isOwner, navigate])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    setRawError(null)
    try {
      const list = await listCognitoUsers()
      setUsers(Array.isArray(list) ? list : [])
    } catch (err: unknown) {
      console.error('[users] fetch failed', {
        error: err,
        errorMessage: errorMessage(err),
      })
      setRawError(err)
      setError(errorMessage(err))
      toast.error(`Failed to load users: ${errorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOwner) loadUsers()
  }, [isOwner, loadUsers])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = newEmail.trim()
    if (!email) return
    setCreating(true)
    try {
      await createCognitoUser(email)
      // Apply the chosen access immediately. A new Cognito user's username === their email.
      try {
        if (inviteAdmin) {
          await setUserAdmin(email, true)
        } else if (invitePages.length > 0) {
          await setUserPageGroups(email, invitePages)
        }
      } catch (permErr: unknown) {
        toast.error(`User invited, but setting permissions failed: ${errorMessage(permErr)}`)
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

  const handleToggle = async (user: CognitoUser) => {
    setTogglingId(user.username)
    try {
      if (user.enabled) {
        await disableCognitoUser(user.username)
        toast.success(`${user.email} disabled`)
      } else {
        await enableCognitoUser(user.username)
        toast.success(`${user.email} enabled`)
      }
      await loadUsers()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleReset = async (user: CognitoUser) => {
    if (!confirm(`Send a password reset email to ${user.email}?`)) return
    setResettingId(user.username)
    try {
      await resetCognitoPassword(user.username)
      toast.success(`Password reset email sent to ${user.email}`)
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setResettingId(null)
    }
  }

  // Never flash real UI for non-owners while the redirect is in flight
  if (authLoading || !isOwner) return null

  const activeCount   = users.filter((u) => u.enabled && u.status !== 'FORCE_CHANGE_PASSWORD').length
  const pendingCount  = users.filter((u) => u.status === 'FORCE_CHANGE_PASSWORD').length
  const disabledCount = users.filter((u) => !u.enabled).length

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div className="flex items-center justify-between px-8 pt-5 pb-3">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">User Management</h1>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={loadUsers}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {/* KPI strip */}
        <div className="flex items-center gap-3 px-8 pb-4 overflow-x-auto">
          <div className="ds-kpi">
            <div className="ds-kpi-label">Total Users</div>
            <div className="ds-kpi-value">{users.length}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Active</div>
            <div className="ds-kpi-value green">{activeCount}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Invite Pending</div>
            <div className="ds-kpi-value amber">{pendingCount}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Disabled</div>
            <div className="ds-kpi-value">{disabledCount}</div>
          </div>
        </div>
      </div>

      <div className="space-y-6 max-w-3xl" style={{ padding: 32 }}>

        {/* Invite form */}
        <div className="space-y-4" style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', padding: 24 }}>
          <div>
            <h2 className="text-base font-semibold text-foreground">Invite New User</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              They'll receive an email with a temporary password to log in.
            </p>
          </div>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="flex items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email Address
                </Label>
                <Input
                  type="email"
                  placeholder="driver@bcatcorp.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="h-9"
                  required
                  disabled={creating}
                />
              </div>
              <Button type="submit" size="lg" className="gap-1.5" disabled={creating || !newEmail.trim()}>
                <Plus className="size-4" />
                {creating ? 'Sending…' : 'Send Invite'}
              </Button>
            </div>

            {/* Page access for the invited user — applied right after the invite is created */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Page Access
              </Label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setInviteAdmin((v) => !v)}
                  style={{
                    height: 28, padding: '0 12px', fontSize: 12, fontWeight: 600,
                    borderRadius: 999, border: `1px solid ${inviteAdmin ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                    background: inviteAdmin ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
                    color: inviteAdmin ? 'var(--ds-blue)' : 'var(--ds-t3)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  Admin — all pages
                </button>
                {!inviteAdmin && PAGE_OPTIONS.map(({ key, label }) => {
                  const active = invitePages.includes(key)
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleInvitePage(key)}
                      style={{
                        height: 28, padding: '0 12px', fontSize: 12, fontWeight: 600,
                        borderRadius: 999, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                        background: active ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
                        color: active ? 'var(--ds-blue)' : 'var(--ds-t3)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {inviteAdmin
                  ? 'Full access to every page.'
                  : invitePages.length > 0
                    ? `${invitePages.length} page${invitePages.length !== 1 ? 's' : ''} selected. Intake, Tasks & Compliance are visible to everyone.`
                    : 'Pick the pages this user can see (you can also change this later from the list below).'}
              </p>
            </div>
          </form>
        </div>

        <Separator />

        {/* User list */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">
            All Users {!loading && <span className="text-muted-foreground font-normal text-sm">({users.length})</span>}
          </h2>

          {error && (
            <div className="rounded-xl border border-destructive/30 bg-red-50 px-5 py-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="size-4 text-destructive shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-destructive font-medium">Failed to load users</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{error}</p>
                </div>
                <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={loadUsers}>
                  Retry
                </Button>
              </div>
              {import.meta.env.DEV && (
                <details className="mt-3 text-xs text-slate-500">
                  <summary className="cursor-pointer select-none font-medium">Error details (dev only)</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all bg-white/70 border border-slate-200 p-3 rounded text-[11px] leading-relaxed">
                    {JSON.stringify(rawError, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading users…
            </div>
          ) : !error && users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Users className="size-8 opacity-20" />
              <p className="text-sm">No users found.</p>
            </div>
          ) : !error ? (
            <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
              {users.map((u, i) => (
                <UserRow
                  key={u.username ?? i}
                  user={u}
                  index={i}
                  onToggle={handleToggle}
                  onReset={handleReset}
                  togglingId={togglingId}
                  resettingId={resettingId}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
