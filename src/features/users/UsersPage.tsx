/**
 * Users — roles, teams, claims and page access.
 *
 * Step I opened this page to every ADMIN, not just the owner. Two controls stay the
 * owner's alone — granting/revoking the ADMIN group and deleting an account — and they
 * are disabled here with a plain reason. That is a courtesy, not a boundary: the
 * `userManagement` Lambda refuses them for anybody else regardless, and every refusal it
 * writes (owner demotion, self-demotion, last admin) is shown here word for word rather
 * than guessed at client-side.
 */
import { useState, useEffect } from 'react'
import { errorMessage } from '@/lib/utils/errorMessage'
import {
  Mail, Plus, KeyRound, UserX, UserCheck, ChevronDown, ShieldCheck, Shield,
  Check, Loader2, RefreshCw, AlertTriangle, Users, Trash2, Send, LogOut, Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'
import { Checkbox } from '@/components/ui/checkbox'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/auth/admin'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  resetCognitoPassword, setUserAdmin,
  getUserGroups, setUserPageGroups,
  setUserRole, setUserTeams, setUserClaims, updateUserProfile,
  reinviteUser, forceSignOut, getTmsSettings,
  type CognitoUser, deleteCognitoUser,
} from '@/lib/apiClient'
import { pageOptions } from '@/lib/navItems'
import {
  ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, rolePagesFor,
  CLAIMS, CLAIM_LABELS, isEnforcedClaim, isRoleKey, displayName,
} from '@/lib/roles'
import type { ClaimKey, RoleKey, Team, UserProfileRecord, UserStatus } from '@/types/tms'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const PAGE_OPTIONS = pageOptions()
const TOTAL_PAGES = PAGE_OPTIONS.length

/** Shown after a role change: the token in the user's browser still has the old groups. */
const SIGN_IN_NOTICE = 'New permissions apply the next time they sign in — their current session still carries the old groups.'
const OWNER_ONLY = 'Only the owner can do this'

interface UserRow extends CognitoUser {
  groups: string[]
  profile: UserProfileRecord | null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#1ea8f3', '#a78bfa', '#f59e0b', '#22c55e', '#ec4899', '#14b8a6', '#ef4444', '#3b82f6']
function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function getInitials(name: string): string {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase() || '?'
}

/** The row's role: the profile's if it has one, else the group the pool still carries. */
function roleOf(u: UserRow): RoleKey {
  const fromProfile = u.profile?.role
  if (isRoleKey(fromProfile)) return fromProfile
  const group = u.groups.find((g) => g.startsWith('role-'))?.slice('role-'.length)
  if (isRoleKey(group)) return group
  return u.groups.includes('ADMIN') ? 'ADMIN' : 'NONE'
}

/** PENDING / ACTIVE / INACTIVE, from the profile when there is one. */
function statusOf(u: UserRow): UserStatus {
  if (u.profile?.status) return u.profile.status
  if (u.status === 'FORCE_CHANGE_PASSWORD') return 'PENDING'
  return u.enabled ? 'ACTIVE' : 'INACTIVE'
}

/** Page grants on top of the role — the only ones this page may add or take away. */
function extraPagesOf(u: UserRow, role: RoleKey): string[] {
  const fromRole = new Set(rolePagesFor(role))
  const fromGroups = u.groups.filter((g) => g.startsWith('page-')).map((g) => g.slice('page-'.length))
  const listed = u.profile?.extraPages ?? fromGroups
  return [...new Set(listed)].filter((key) => !fromRole.has(key))
}

function claimsOf(u: UserRow): string[] {
  const fromProfile = u.profile?.claims
  if (fromProfile) return fromProfile
  return u.groups.filter((g) => g.startsWith('claim-')).map((g) => g.slice('claim-'.length))
}

/** The profile a write is about to create when the directory has never seen this user. */
function profileOf(u: UserRow): UserProfileRecord {
  return u.profile ?? { id: u.username, email: u.email, createdBy: '', updatedBy: '', version: 0 }
}

const isUserAdmin = (u: UserRow) => u.groups.includes('ADMIN') || roleOf(u) === 'ADMIN'

async function fetchUsers(): Promise<UserRow[]> {
  const list = await listCognitoUsers()
  // Step I's Lambda joins the profile and the groups onto every row. Against an older
  // deploy the groups are missing, so they are read one by one as before.
  const groups = await Promise.all(
    list.map((u) => (u.groups ? Promise.resolve(u.groups) : getUserGroups(u.username).catch(() => []))),
  )
  return list.map((u, i) => ({ ...u, groups: groups[i], profile: u.profile ?? null }))
}

const STATUS_STYLES: Record<UserStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  INACTIVE: 'bg-slate-100 text-slate-500 border-slate-200',
}

function StatusPill({ status }: { status: UserStatus }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border', STATUS_STYLES[status])}>
      {status === 'ACTIVE' && <span className="size-1.5 rounded-full bg-emerald-500" />}
      {status === 'PENDING' ? 'Pending' : status === 'ACTIVE' ? 'Active' : 'Inactive'}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{children}</p>
}

// ── User card (expandable) ────────────────────────────────────────────────────

interface UserCardProps {
  user: UserRow
  teams: Team[]
  callerIsOwner: boolean
  roleChangedHere: boolean
  onRole: (u: UserRow, role: RoleKey) => void
  onToggleTeam: (u: UserRow, teamKey: string) => void
  onManager: (u: UserRow, managerId: string) => void
  onToggleClaim: (u: UserRow, claim: ClaimKey) => void
  onTogglePage: (u: UserRow, pageKey: string) => void
  onToggleAdmin: (u: UserRow, makeAdmin: boolean) => Promise<void>
  onReset: (u: UserRow) => Promise<void>
  onReinvite: (u: UserRow) => Promise<void>
  onSignOut: (u: UserRow) => Promise<void>
  onToggleEnabled: (u: UserRow) => Promise<void>
  onDelete: (u: UserRow) => Promise<void>
  busyAdminId: string | null
  resettingId: string | null
  togglingId: string | null
  savingPermissions: boolean
}

function UserCard({
  user, teams, callerIsOwner, roleChangedHere,
  onRole, onToggleTeam, onManager, onToggleClaim, onTogglePage, onToggleAdmin,
  onReset, onReinvite, onSignOut, onToggleEnabled, onDelete,
  busyAdminId, resettingId, togglingId, savingPermissions,
}: UserCardProps) {
  const [expanded, setExpanded] = useState(false)
  const admin = isUserAdmin(user)
  const name = displayName({ email: user.email, name: user.profile?.name, username: user.username })
  const color = avatarColor(user.email ?? user.username ?? '')
  const role = roleOf(user)
  const status = statusOf(user)
  const rolePages = rolePagesFor(role)
  const extraPages = extraPagesOf(user, role)
  const claims = claimsOf(user)
  const teamKeys = user.profile?.teamKeys ?? []
  const isTargetOwner = user.email?.toLowerCase().trim() === OWNER_EMAIL
  const openPages = isTargetOwner || admin
  const grantedCount = rolePages.length + extraPages.length
  const access = openPages ? 'Full access' : grantedCount === 0 ? 'No pages' : `${grantedCount}/${TOTAL_PAGES} pages`
  const isResetting = resettingId === user.username
  const isToggling = togglingId === user.username
  const isAdminBusy = busyAdminId === user.username

  return (
    <div data-testid="user-card" style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="relative shrink-0">
          <Avatar initials={getInitials(name)} size="lg" style={{ background: color, color: '#fff' }} />
          {user.enabled && (
            <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-500 ring-2 ring-white" title="Active" />
          )}
        </div>

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
            {user.email}
            <span className="text-muted-foreground/60"> · {ROLE_LABELS[role]}</span>
          </div>
        </div>

        <div className="hidden md:block shrink-0 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Access</div>
          <div className={cn('text-xs mt-0.5', grantedCount > 0 && !openPages ? 'font-mono text-foreground' : 'text-muted-foreground')}>{access}</div>
        </div>

        <div className="shrink-0"><StatusPill status={status} /></div>

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
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs text-destructive border-destructive/30 hover:bg-destructive/5"
            onClick={() => onDelete(user)}
            disabled={isToggling || !callerIsOwner}
            title={callerIsOwner
              ? 'Remove this user entirely — sign-in, groups and page access'
              : OWNER_ONLY}
          >
            <Trash2 className="size-3" />Delete
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
        <div style={{ background: 'var(--ds-bg)', borderTop: '1px solid var(--ds-border)', padding: '16px 20px' }} className="space-y-5">

          {/* Role */}
          <div>
            <SectionLabel>Role</SectionLabel>
            <div className="flex flex-wrap items-center gap-3">
              <select
                aria-label={`Role for ${user.email}`}
                value={role}
                disabled={savingPermissions}
                onChange={(e) => onRole(user, e.target.value as RoleKey)}
                className="h-9 rounded-md border border-input bg-white px-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ROLES.map((key) => (
                  <option key={key} value={key}>{ROLE_LABELS[key]}</option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
            </div>
            {roleChangedHere && (
              <p className="mt-2 inline-flex items-start gap-1.5 text-[11px] text-amber-700">
                <Info className="size-3.5 shrink-0 mt-px" />{SIGN_IN_NOTICE}
              </p>
            )}
          </div>

          {/* Teams */}
          <div>
            <SectionLabel>Teams</SectionLabel>
            {teams.length === 0 ? (
              <p className="text-xs text-muted-foreground">No teams yet — add them in Settings → Teams.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {teams.filter((t) => t.active !== false).map((team) => {
                  const on = teamKeys.includes(team.key)
                  return (
                    <button
                      key={team.key}
                      type="button"
                      aria-pressed={on}
                      disabled={savingPermissions}
                      onClick={() => onToggleTeam(user, team.key)}
                      className={cn(
                        'inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed',
                        on ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {on && <Check className="size-3 shrink-0" />}{team.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Manager */}
          <div>
            <SectionLabel>Manager</SectionLabel>
            <div className="max-w-sm">
              <RepPicker
                value={user.profile?.managerId ?? ''}
                onChange={(id) => onManager(user, id)}
                placeholder="No manager"
                disabled={savingPermissions}
              />
            </div>
          </div>

          {/* Claims */}
          <div>
            <SectionLabel>Additional permissions</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {CLAIMS.map((claim) => {
                const on = claims.includes(claim)
                const enforced = isEnforcedClaim(claim)
                return (
                  <label key={claim} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <Checkbox
                      aria-label={CLAIM_LABELS[claim]}
                      checked={on}
                      disabled={savingPermissions}
                      onCheckedChange={() => onToggleClaim(user, claim)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-slate-700">{CLAIM_LABELS[claim]}</span>
                      <span className={cn('text-[10px] font-semibold uppercase tracking-wide', enforced ? 'text-emerald-700' : 'text-slate-400')}>
                        {enforced ? 'enforced' : 'recorded'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              A recorded claim is a record of who may do something, not a restriction — only the enforced ones are refused by the server.
            </p>
          </div>

          {/* Page access */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Page access</p>
              {!isTargetOwner && (
                <button
                  onClick={() => onToggleAdmin(user, !admin)}
                  disabled={isAdminBusy || savingPermissions || !callerIsOwner}
                  title={callerIsOwner ? undefined : OWNER_ONLY}
                  className={cn(
                    'inline-flex items-center gap-1 text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                    admin ? 'text-muted-foreground hover:text-destructive' : 'text-violet-600 hover:text-violet-800',
                  )}
                >
                  {isAdminBusy ? <Loader2 className="size-3 animate-spin" /> : <Shield className="size-3" />}
                  {admin ? 'Remove admin' : 'Make admin'}
                </button>
              )}
            </div>

            {openPages ? (
              <div className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3">
                <ShieldCheck className="size-4 text-violet-600 shrink-0" />
                <span className="text-sm font-medium text-violet-700">
                  {isTargetOwner ? 'Owner — full access to all pages' : 'Admin — full access to all pages'}
                </span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {PAGE_OPTIONS.map(({ key, label }) => {
                    const fromRole = rolePages.includes(key)
                    const on = fromRole || extraPages.includes(key)
                    return (
                      <button
                        key={key}
                        data-testid="user-page-toggle"
                        onClick={() => onTogglePage(user, key)}
                        disabled={savingPermissions || fromRole}
                        title={fromRole ? `Granted by the ${ROLE_LABELS[role]} role — change the role to remove it` : undefined}
                        className={cn(
                          'flex items-center justify-between gap-1.5 h-9 px-3 rounded-lg border text-xs font-medium transition-all disabled:cursor-not-allowed',
                          fromRole
                            ? 'bg-violet-50 border-violet-200 text-violet-700 opacity-90'
                            : on
                              ? 'bg-blue-50 border-blue-300 text-blue-700 disabled:opacity-60'
                              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 disabled:opacity-60',
                        )}
                      >
                        <span className="inline-flex items-center gap-1.5 truncate">
                          {on && <Check className="size-3.5 shrink-0" />}{label}
                        </span>
                        <span className="text-[9px] font-semibold uppercase tracking-wide opacity-70 shrink-0">
                          {fromRole ? 'from role' : on ? 'extra' : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Pages marked <span className="font-semibold">from role</span> come with {ROLE_LABELS[role]} and cannot be
                  unticked here — change the role instead. Everything else is an extra grant and saves instantly.
                </p>
              </>
            )}
          </div>

          {/* Account actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => onReinvite(user)} disabled={isToggling}>
              <Send className="size-3" />Reinvite
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => onSignOut(user)} disabled={isToggling}>
              <LogOut className="size-3" />Force sign-out
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Force sign-out drops every session, so a role change takes effect at once.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UsersPage() {
  const { loading: authLoading, isOwner } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<RoleKey>('NONE')
  const [inviteTeams, setInviteTeams] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [busyAdminId, setBusyAdminId] = useState<string | null>(null)
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [roleChanged, setRoleChanged] = useState<string[]>([])

  const refreshUsers = async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await fetchUsers())
    } catch (err: unknown) {
      console.error('[users] refresh failed', err)
      const msg = errorMessage(err)
      setError(msg)
      toast.error(`Failed to load users: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let canceled = false
    fetchUsers()
      .then((list) => {
        if (canceled) return
        setUsers(list)
        setError(null)
      })
      .catch((err: unknown) => {
        if (canceled) return
        console.error('[users] fetch failed', err)
        const msg = errorMessage(err)
        setError(msg)
        toast.error(`Failed to load users: ${msg}`)
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })
    return () => { canceled = true }
  }, [])

  // Teams live in TmsSettings; the picker needs them, the page does not die without them.
  useEffect(() => {
    let canceled = false
    getTmsSettings()
      .then((settings) => { if (!canceled) setTeams(settings?.teams ?? []) })
      .catch((err: unknown) => { console.warn('[users] teams unavailable', err) })
    return () => { canceled = true }
  }, [])

  const patchRow = (username: string, patch: (row: UserRow) => UserRow) =>
    setUsers((prev) => prev.map((x) => (x.username === username ? patch(x) : x)))

  /**
   * Optimistic write with rollback behind the one global lock: a second mutation while a
   * save is in flight could only race it, and the refusal text the Lambda returns is
   * shown exactly as written.
   */
  const save = async (u: UserRow, next: UserRow, run: () => Promise<void>, done: string): Promise<boolean> => {
    if (savingPermissions) return false
    const before = u
    setSavingPermissions(true)
    patchRow(u.username, () => next)
    try {
      await run()
      toast.success(done)
      return true
    } catch (err: unknown) {
      toast.error(errorMessage(err))
      patchRow(u.username, () => before)
      return false
    } finally {
      setSavingPermissions(false)
    }
  }

  const handleRole = (u: UserRow, role: RoleKey) => {
    if (role === roleOf(u)) return
    const next: UserRow = { ...u, profile: { ...profileOf(u), role } }
    void save(u, next, () => setUserRole(u.username, role), `${u.email} is now ${ROLE_LABELS[role]}`)
      .then((ok) => {
        if (ok) setRoleChanged((prev) => (prev.includes(u.username) ? prev : [...prev, u.username]))
      })
  }

  const handleToggleTeam = (u: UserRow, teamKey: string) => {
    const current = u.profile?.teamKeys ?? []
    const teamKeys = current.includes(teamKey) ? current.filter((k) => k !== teamKey) : [...current, teamKey]
    const next: UserRow = { ...u, profile: { ...profileOf(u), teamKeys } }
    void save(u, next, () => setUserTeams(u.username, teamKeys), `Teams updated for ${u.email}`)
  }

  const handleManager = (u: UserRow, managerId: string) => {
    if (managerId && managerId.toLowerCase() === u.username.toLowerCase()) {
      toast.error('A user cannot be their own manager.')
      return
    }
    const next: UserRow = { ...u, profile: { ...profileOf(u), managerId } }
    void save(u, next, () => updateUserProfile(u.username, { managerId }), `Manager updated for ${u.email}`)
  }

  const handleToggleClaim = (u: UserRow, claim: ClaimKey) => {
    const current = claimsOf(u)
    const claims = current.includes(claim) ? current.filter((c) => c !== claim) : [...current, claim]
    const next: UserRow = { ...u, profile: { ...profileOf(u), claims } }
    void save(u, next, () => setUserClaims(u.username, claims), `Permissions updated for ${u.email}`)
  }

  /**
   * Only the extra grants travel: the Lambda rebuilds the role's own pages from the
   * profile, so a page the role gives cannot be revoked by this call.
   */
  const handleTogglePage = (u: UserRow, pageKey: string) => {
    const role = roleOf(u)
    if (rolePagesFor(role).includes(pageKey)) return
    const current = extraPagesOf(u, role)
    const extraPages = current.includes(pageKey) ? current.filter((k) => k !== pageKey) : [...current, pageKey]
    const groups = [
      ...u.groups.filter((g) => !g.startsWith('page-')),
      ...rolePagesFor(role).map((k) => `page-${k}`),
      ...extraPages.map((k) => `page-${k}`),
    ]
    const next: UserRow = { ...u, groups, profile: { ...profileOf(u), extraPages } }
    void save(u, next, () => setUserPageGroups(u.username, extraPages), `Updated page access for ${u.email}`)
  }

  const handleToggleAdmin = async (u: UserRow, makeAdmin: boolean) => {
    if (savingPermissions) return
    setBusyAdminId(u.username)
    const groups = makeAdmin ? [...u.groups.filter((g) => g !== 'ADMIN'), 'ADMIN'] : u.groups.filter((g) => g !== 'ADMIN')
    await save(u, { ...u, groups }, () => setUserAdmin(u.username, makeAdmin),
      makeAdmin ? `${u.email} is now an admin` : `Admin removed from ${u.email}`)
    setBusyAdminId(null)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = newEmail.trim()
    if (!email) return
    setCreating(true)
    try {
      await createCognitoUser(email, { role: inviteRole, teamKeys: inviteTeams })
      toast.success(`Invite sent to ${email}`)
      setNewEmail('')
      setInviteRole('NONE')
      setInviteTeams([])
      await refreshUsers()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const handleReset = async (u: UserRow) => {
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

  const handleReinvite = async (u: UserRow) => {
    setTogglingId(u.username)
    try {
      await reinviteUser(u.username)
      toast.success(`Invite re-sent to ${u.email}`)
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleSignOut = async (u: UserRow) => {
    setTogglingId(u.username)
    try {
      await forceSignOut(u.username)
      toast.success(`${u.email} signed out everywhere`)
      setRoleChanged((prev) => prev.filter((name) => name !== u.username))
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleToggleEnabled = async (u: UserRow) => {
    setTogglingId(u.username)
    try {
      if (u.enabled) {
        await disableCognitoUser(u.username)
        toast.success(`${u.email} disabled`)
      } else {
        await enableCognitoUser(u.username)
        toast.success(`${u.email} enabled`)
      }
      await refreshUsers()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async (u: UserRow) => {
    if (!window.confirm(`Delete ${u.email} entirely?\n\nThey can no longer sign in and their page access is gone. Loads, notes and uploads they made keep their name. This cannot be undone — disable instead if they might be back.`)) return
    setTogglingId(u.username)
    try {
      await deleteCognitoUser(u.username)
      toast.success(`${u.email} deleted`)
      setUsers((prev) => prev.filter((x) => x.username !== u.username))
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  if (authLoading) return null

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

  const activeTeams = teams.filter((t) => t.active !== false)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div className="flex items-center justify-between px-8 pt-5 pb-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">User Management</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Workspace members · roles · teams · access</p>
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={refreshUsers} disabled={loading}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />Refresh
          </Button>
        </div>
      </div>

      <div style={{ padding: 32 }}>
        {!isOwner && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
            <Shield className="size-4 text-slate-400 shrink-0" />
            <span className="text-xs text-slate-600">
              Granting admin and deleting an account are the owner's — everything else on this page is yours.
            </span>
          </div>
        )}

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
                  <label htmlFor="invite-email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Address</label>
                  <div className="relative">
                    <Mail className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <input
                      id="invite-email"
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

                {/* Role */}
                <div className="space-y-1.5">
                  <label htmlFor="invite-role" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Role</label>
                  <select
                    id="invite-role"
                    value={inviteRole}
                    disabled={creating}
                    onChange={(e) => setInviteRole(e.target.value as RoleKey)}
                    className="h-9 w-full rounded-md border border-input bg-white px-2 text-sm disabled:opacity-50"
                  >
                    {ROLES.map((key) => (
                      <option key={key} value={key}>{ROLE_LABELS[key]}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">{ROLE_DESCRIPTIONS[inviteRole]}</p>
                </div>

                {/* Teams */}
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Teams</span>
                  {activeTeams.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No teams yet — add them in Settings → Teams.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {activeTeams.map((team) => {
                        const on = inviteTeams.includes(team.key)
                        return (
                          <button
                            key={team.key}
                            type="button"
                            aria-pressed={on}
                            disabled={creating}
                            onClick={() => setInviteTeams((prev) => (on ? prev.filter((k) => k !== team.key) : [...prev, team.key]))}
                            className={cn(
                              'inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs font-medium transition-all disabled:opacity-60',
                              on ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                            )}
                          >
                            {on && <Check className="size-3 shrink-0" />}{team.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                <p className="text-[11px] text-muted-foreground">
                  The role decides the pages. Extra pages and permissions are granted on the user's card once they appear.
                </p>

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
                <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={refreshUsers}>Retry</Button>
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
                  teams={teams}
                  callerIsOwner={isOwner}
                  roleChangedHere={roleChanged.includes(u.username)}
                  onRole={handleRole}
                  onToggleTeam={handleToggleTeam}
                  onManager={handleManager}
                  onToggleClaim={handleToggleClaim}
                  onTogglePage={handleTogglePage}
                  onToggleAdmin={handleToggleAdmin}
                  onReset={handleReset}
                  onReinvite={handleReinvite}
                  onSignOut={handleSignOut}
                  onToggleEnabled={handleToggleEnabled}
                  onDelete={handleDelete}
                  busyAdminId={busyAdminId}
                  resettingId={resettingId}
                  togglingId={togglingId}
                  savingPermissions={savingPermissions}
                />
              ))
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
