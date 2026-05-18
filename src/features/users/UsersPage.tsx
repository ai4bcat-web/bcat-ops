import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Plus, UserCheck, UserX, RefreshCw, AlertTriangle, ChevronDown, ChevronUp, Loader2, KeyRound, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/useAuth'
import { isAdminEmail } from '@/lib/auth/admin'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  resetCognitoPassword,
  getUserGroups, setUserPageGroups,
  type CognitoUser,
} from '@/lib/apiClient'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const PAGE_OPTIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'calendar',  label: 'Calendar'  },
  { key: 'loads',     label: 'Loads'     },
  { key: 'drivers',   label: 'Drivers'   },
  { key: 'trucks',    label: 'Trucks'    },
  { key: 'expenses',  label: 'Expenses'  },
  { key: 'schedule',  label: 'Schedules' },
  { key: 'audit',     label: 'Audit Log' },
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

  return (
    <div className={cn(index !== 0 && 'border-t border-slate-100')}>
      {/* Main row */}
      <div className="flex items-center gap-3 px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {user.email ?? user.username ?? '—'}
            </span>
            {isAdminEmail(user.email) && (
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
        <div className="px-6 pb-4 bg-slate-50/60 border-t border-slate-100">
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
              <p className="text-xs text-emerald-700 font-medium">Admin — full access to all pages</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {PAGE_OPTIONS.map(({ key, label }) => {
                  const active = groups?.includes(`page-${key}`) ?? false
                  return (
                    <button
                      key={key}
                      onClick={() => togglePage(key)}
                      disabled={savingGroups}
                      className={cn(
                        'h-7 px-3 text-xs font-semibold rounded-full border transition-all',
                        active
                          ? 'bg-sky-50 border-sky-200 text-sky-700'
                          : 'bg-white border-slate-200 text-slate-500 hover:text-slate-800 hover:border-slate-300',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-2.5">
              Click a page to toggle access. Changes save instantly.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export function UsersPage() {
  const { loading: authLoading, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [users, setUsers] = useState<CognitoUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)

  // Client-side access gate — redirect non-admins immediately.
  // Server-side enforcement is handled independently in the Lambda.
  useEffect(() => {
    if (!authLoading && !isAdmin) {
      toast.error("You don't have access to that page.")
      navigate('/dashboard', { replace: true })
    }
  }, [authLoading, isAdmin, navigate])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listCognitoUsers()
      setUsers(Array.isArray(list) ? list : [])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(`Failed to load users: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) loadUsers()
  }, [isAdmin, loadUsers])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newEmail.trim()) return
    setCreating(true)
    try {
      await createCognitoUser(newEmail.trim())
      toast.success(`Invite sent to ${newEmail}`)
      setNewEmail('')
      await loadUsers()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to send invite')
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
      toast.error(err instanceof Error ? err.message : 'Failed to update user')
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
      toast.error(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setResettingId(null)
    }
  }

  // Never flash real UI for non-admins while the redirect is in flight
  if (authLoading || !isAdmin) return null

  const activeCount   = users.filter((u) => u.enabled && u.status !== 'FORCE_CHANGE_PASSWORD').length
  const pendingCount  = users.filter((u) => u.status === 'FORCE_CHANGE_PASSWORD').length
  const disabledCount = users.filter((u) => !u.enabled).length

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
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

      <div className="p-8 space-y-6 max-w-3xl">

        {/* Invite form */}
        <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Invite New User</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              They'll receive an email with a temporary password to log in.
            </p>
          </div>
          <form onSubmit={handleCreate} className="flex items-end gap-3">
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
          </form>
        </div>

        <Separator />

        {/* User list */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">
            All Users {!loading && <span className="text-muted-foreground font-normal text-sm">({users.length})</span>}
          </h2>

          {error && (
            <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-red-50 px-5 py-4">
              <AlertTriangle className="size-4 text-destructive shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-destructive font-medium">Failed to load users</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{error}</p>
              </div>
              <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={loadUsers}>
                Retry
              </Button>
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
            <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
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
