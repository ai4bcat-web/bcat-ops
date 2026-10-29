/**
 * Users — roles, teams, claims and page access.
 *
 * Step I opened this page to every ADMIN, not just the owner. Two controls stay the
 * owner's alone — granting/revoking the ADMIN group and deleting an account — and they
 * are disabled here with a plain reason. That is a courtesy, not a boundary: the
 * `userManagement` Lambda refuses them for anybody else regardless, and every refusal it
 * writes (owner demotion, self-demotion, last admin) is shown here word for word rather
 * than guessed at client-side.
 *
 * Step R re-skinned it onto the MVMNT kit as the Users tab of My Brokerage, so it is a
 * *body*: `BrokeragePage` owns the h1 and the tab strip. Nothing about who may do what
 * changed.
 */
import { useState, useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { errorMessage } from '@/lib/utils/errorMessage'
import {
  Plus, KeyRound, UserX, UserCheck, ChevronDown, ShieldCheck, Shield,
  Check, Loader2, RefreshCw, AlertTriangle, Users, Trash2, Send, LogOut, Info,
} from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/auth/admin'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  resetCognitoPassword, setUserAdmin,
  getUserGroups, setUserPageGroups,
  setUserRole, setUserTeams, setUserDivisions, setUserClaims, updateUserProfile,
  reinviteUser, forceSignOut, getTmsSettings, listOwnershipDivisions,
  type CognitoUser, deleteCognitoUser,
} from '@/lib/apiClient'
import { pageOptions } from '@/lib/navItems'
import {
  ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, rolePagesFor,
  CLAIMS, CLAIM_LABELS, isEnforcedClaim, isRoleKey, displayName,
} from '@/lib/roles'
import type { ClaimKey, OwnershipDivisionRecord, RoleKey, Team, UserProfileRecord, UserStatus } from '@/types/tms'
import { toast } from 'sonner'

const PAGE_OPTIONS = pageOptions()
const TOTAL_PAGES = PAGE_OPTIONS.length

/** Shown after a role change: the token in the user's browser still has the old groups. */
const SIGN_IN_NOTICE = 'New permissions apply the next time they sign in — their current session still carries the old groups.'
const OWNER_ONLY = 'Only the owner can do this'

interface UserRow extends CognitoUser {
  groups: string[]
  profile: UserProfileRecord | null
}

// ── Shared styles (theme tokens only — this page lives in the dark shell) ─────

const CARD: CSSProperties = {
  border: '1px solid var(--tms-border)',
  borderRadius: 'var(--tms-radius)',
  background: 'var(--tms-card)',
  overflow: 'hidden',
}
const SUB_PANEL: CSSProperties = {
  borderTop: '1px solid var(--tms-border)',
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
}
const PILL: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
  borderRadius: 999, border: '1px solid var(--tms-border)', background: 'transparent',
  color: 'var(--tms-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
}
const PILL_ON: CSSProperties = {
  ...PILL, borderColor: 'var(--tms-primary)', color: 'var(--tms-primary)',
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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

const STATUS_TONES: Record<UserStatus, TmsTone> = {
  PENDING: 'orange',
  ACTIVE: 'green',
  INACTIVE: 'gray',
}
const STATUS_LABELS: Record<UserStatus, string> = {
  PENDING: 'Pending',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      className="tms-field-label"
      style={{ margin: '0 0 8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}
    >
      {children}
    </p>
  )
}

// ── User card (expandable) ────────────────────────────────────────────────────

interface UserCardProps {
  user: UserRow
  teams: Team[]
  divisions: OwnershipDivisionRecord[]
  callerIsOwner: boolean
  roleChangedHere: boolean
  onRole: (u: UserRow, role: RoleKey) => void
  onToggleTeam: (u: UserRow, teamKey: string) => void
  onToggleDivision: (u: UserRow, code: string) => void
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
  user, teams, divisions, callerIsOwner, roleChangedHere,
  onRole, onToggleTeam, onToggleDivision, onManager, onToggleClaim, onTogglePage, onToggleAdmin,
  onReset, onReinvite, onSignOut, onToggleEnabled, onDelete,
  busyAdminId, resettingId, togglingId, savingPermissions,
}: UserCardProps) {
  const [expanded, setExpanded] = useState(false)
  const admin = isUserAdmin(user)
  const name = displayName({ email: user.email, name: user.profile?.name, username: user.username })
  const role = roleOf(user)
  const status = statusOf(user)
  const rolePages = rolePagesFor(role)
  const extraPages = extraPagesOf(user, role)
  const claims = claimsOf(user)
  const teamKeys = user.profile?.teamKeys ?? []
  const divisionCodes = user.profile?.divisions ?? []
  const isTargetOwner = user.email?.toLowerCase().trim() === OWNER_EMAIL
  const openPages = isTargetOwner || admin
  const grantedCount = rolePages.length + extraPages.length
  const access = openPages ? 'Full access' : grantedCount === 0 ? 'No pages' : `${grantedCount}/${TOTAL_PAGES} pages`
  const isResetting = resettingId === user.username
  const isToggling = togglingId === user.username
  const isAdminBusy = busyAdminId === user.username

  return (
    <div data-testid="user-card" style={CARD}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px' }}>
        <span
          aria-hidden="true"
          style={{
            width: 36, height: 36, borderRadius: 999, flex: '0 0 auto',
            background: 'var(--tms-primary)', color: 'var(--tms-on-primary)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 600,
          }}
        >
          {getInitials(name)}
        </span>

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
            {admin && <TmsBadge tone="purple">Admin</TmsBadge>}
          </div>
          <div className="tms-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {user.email} · {ROLE_LABELS[role]}
          </div>
        </div>

        <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
          <div className="tms-field-label" style={{ textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600 }}>Access</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>{access}</div>
        </div>

        <TmsBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</TmsBadge>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
          <TmsButton size="sm" onClick={() => onReset(user)} disabled={isResetting || !user.enabled}>
            {isResetting ? <Loader2 size={13} /> : <KeyRound size={13} />}Reset
          </TmsButton>
          <TmsButton
            size="sm"
            variant={user.enabled ? 'destructive' : 'secondary'}
            onClick={() => onToggleEnabled(user)}
            disabled={isToggling}
          >
            {isToggling ? <Loader2 size={13} /> : user.enabled ? <UserX size={13} /> : <UserCheck size={13} />}
            {user.enabled ? 'Disable' : 'Enable'}
          </TmsButton>
          <TmsButton
            size="sm"
            variant="destructive"
            onClick={() => onDelete(user)}
            disabled={isToggling || !callerIsOwner}
            title={callerIsOwner
              ? 'Remove this user entirely — sign-in, groups and page access'
              : OWNER_ONLY}
          >
            <Trash2 size={13} />Delete
          </TmsButton>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="tms-icon-btn tms-icon-btn-plain"
            aria-label="Toggle permissions"
          >
            <ChevronDown size={16} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={SUB_PANEL}>

          {/* Role */}
          <div>
            <SectionLabel>Role</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <TmsSelect
                aria-label={`Role for ${user.email}`}
                value={role}
                disabled={savingPermissions}
                onChange={(e) => onRole(user, e.target.value as RoleKey)}
                style={{ width: 'auto' }}
              >
                {ROLES.map((key) => (
                  <option key={key} value={key}>{ROLE_LABELS[key]}</option>
                ))}
              </TmsSelect>
              <span className="tms-muted" style={{ fontSize: 12 }}>{ROLE_DESCRIPTIONS[role]}</span>
            </div>
            {roleChangedHere && (
              <p style={{ margin: '8px 0 0', display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: 'var(--tms-badge-orange)' }}>
                <Info size={14} style={{ flex: '0 0 auto', marginTop: 1 }} />{SIGN_IN_NOTICE}
              </p>
            )}
          </div>

          {/* Teams */}
          <div>
            <SectionLabel>Teams</SectionLabel>
            {teams.length === 0 ? (
              <p className="tms-field-hint" style={{ margin: 0 }}>No teams yet — add them in Settings → Teams.</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {teams.filter((t) => t.active !== false).map((team) => {
                  const on = teamKeys.includes(team.key)
                  return (
                    <button
                      key={team.key}
                      type="button"
                      aria-pressed={on}
                      disabled={savingPermissions}
                      onClick={() => onToggleTeam(user, team.key)}
                      style={on ? PILL_ON : PILL}
                    >
                      {on && <Check size={12} />}{team.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Divisions */}
          <div>
            <SectionLabel>Divisions</SectionLabel>
            <p className="tms-field-hint" style={{ margin: '0 0 8px' }}>
              The businesses this person works in. A saved Shipment view that names divisions is
              offered only to the people who work in one of them.
            </p>
            {divisions.length === 0 ? (
              <p className="tms-field-hint" style={{ margin: 0 }}>No divisions yet — add them in My Brokerage → Divisions.</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {divisions.map((division) => {
                  const on = divisionCodes.includes(division.code)
                  return (
                    <button
                      key={division.code}
                      type="button"
                      aria-pressed={on}
                      disabled={savingPermissions}
                      onClick={() => onToggleDivision(user, division.code)}
                      style={on ? PILL_ON : PILL}
                    >
                      {on && <Check size={12} />}{division.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Manager */}
          <div>
            <SectionLabel>Manager</SectionLabel>
            <div style={{ maxWidth: 384 }}>
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
            <div className="tms-grid tms-grid-3">
              {CLAIMS.map((claim) => {
                const on = claims.includes(claim)
                const enforced = isEnforcedClaim(claim)
                return (
                  <label
                    key={claim}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                      border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: '8px 10px',
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={CLAIM_LABELS[claim]}
                      checked={on}
                      disabled={savingPermissions}
                      onChange={() => onToggleClaim(user, claim)}
                      style={{ accentColor: 'var(--tms-primary)', width: 15, height: 15, marginTop: 2, flex: '0 0 auto' }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12 }}>{CLAIM_LABELS[claim]}</span>
                      <span
                        className={enforced ? undefined : 'tms-muted'}
                        style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: enforced ? 'var(--tms-badge-green)' : undefined }}
                      >
                        {enforced ? 'enforced' : 'recorded'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="tms-field-hint" style={{ margin: '8px 0 0' }}>
              A recorded claim is a record of who may do something, not a restriction — only the enforced ones are refused by the server.
            </p>
          </div>

          {/* Page access */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <SectionLabel>Page access</SectionLabel>
              {!isTargetOwner && (
                <button
                  type="button"
                  onClick={() => onToggleAdmin(user, !admin)}
                  disabled={isAdminBusy || savingPermissions || !callerIsOwner}
                  title={callerIsOwner ? undefined : OWNER_ONLY}
                  className="tms-btn tms-btn-ghost tms-btn-sm"
                >
                  {isAdminBusy ? <Loader2 size={12} /> : <Shield size={12} />}
                  {admin ? 'Remove admin' : 'Make admin'}
                </button>
              )}
            </div>

            {openPages ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: '10px 14px' }}>
                <ShieldCheck size={16} style={{ color: 'var(--tms-badge-purple)', flex: '0 0 auto' }} />
                <span style={{ fontSize: 14, fontWeight: 500 }}>
                  {isTargetOwner ? 'Owner — full access to all pages' : 'Admin — full access to all pages'}
                </span>
              </div>
            ) : (
              <>
                <div className="tms-grid tms-grid-4">
                  {PAGE_OPTIONS.map(({ key, label }) => {
                    const fromRole = rolePages.includes(key)
                    const on = fromRole || extraPages.includes(key)
                    return (
                      <button
                        key={key}
                        type="button"
                        data-testid="user-page-toggle"
                        onClick={() => onTogglePage(user, key)}
                        disabled={savingPermissions || fromRole}
                        title={fromRole ? `Granted by the ${ROLE_LABELS[role]} role — change the role to remove it` : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                          height: 36, padding: '0 10px', borderRadius: 'var(--tms-radius)',
                          border: `1px solid ${on ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                          background: 'transparent',
                          color: on ? 'var(--tms-primary)' : 'var(--tms-muted)',
                          fontSize: 12, fontWeight: 500,
                          cursor: fromRole ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {on && <Check size={13} style={{ flex: '0 0 auto' }} />}{label}
                        </span>
                        <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', opacity: 0.7, flex: '0 0 auto' }}>
                          {fromRole ? 'from role' : on ? 'extra' : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="tms-field-hint" style={{ margin: '8px 0 0' }}>
                  Pages marked <strong>from role</strong> come with {ROLE_LABELS[role]} and cannot be
                  unticked here — change the role instead. Everything else is an extra grant and saves instantly.
                </p>
              </>
            )}
          </div>

          {/* Account actions */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--tms-border)', paddingTop: 12 }}>
            <TmsButton size="sm" onClick={() => onReinvite(user)} disabled={isToggling}>
              <Send size={13} />Reinvite
            </TmsButton>
            <TmsButton size="sm" onClick={() => onSignOut(user)} disabled={isToggling}>
              <LogOut size={13} />Force sign-out
            </TmsButton>
            <span className="tms-field-hint">
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
  const [divisions, setDivisions] = useState<OwnershipDivisionRecord[]>([])
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

  // The same taxonomy the Divisions page writes; only the live ones can be assigned, and
  // an archived business already on a profile is left alone rather than silently dropped.
  useEffect(() => {
    let canceled = false
    listOwnershipDivisions()
      .then((rows) => {
        if (canceled) return
        setDivisions(rows.filter((d) => d.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)))
      })
      .catch((err: unknown) => { console.warn('[users] divisions unavailable', err) })
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

  const handleToggleDivision = (u: UserRow, code: string) => {
    const current = u.profile?.divisions ?? []
    const codes = current.includes(code) ? current.filter((c) => c !== code) : [...current, code]
    const next: UserRow = { ...u, profile: { ...profileOf(u), divisions: codes } }
    void save(u, next, () => setUserDivisions(u.username, codes), `Divisions updated for ${u.email}`)
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

  const KPIS = [
    { label: 'Total Users', value: users.length },
    { label: 'Active', value: users.filter((u) => u.enabled).length },
    { label: 'Admins', value: users.filter(isUserAdmin).length },
    { label: 'Disabled', value: users.filter((u) => !u.enabled).length },
  ]

  const activeTeams = teams.filter((t) => t.active !== false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <p className="tms-field-hint" style={{ margin: 0 }}>Workspace members · roles · teams · access</p>
        <TmsButton size="sm" onClick={refreshUsers} disabled={loading}>
          <RefreshCw size={14} />Refresh
        </TmsButton>
      </div>

      {!isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: '8px 14px' }}>
          <Shield size={16} className="tms-muted" style={{ flex: '0 0 auto' }} />
          <span className="tms-muted" style={{ fontSize: 12 }}>
            Granting admin and deleting an account are the owner&rsquo;s — everything else on this page is yours.
          </span>
        </div>
      )}

      <div className="tms-grid tms-grid-4">
        {KPIS.map((k) => (
          <TmsCard key={k.label}>
            <div className="tms-field-label" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
          </TmsCard>
        ))}
      </div>

      <div className="tms-grid" style={{ gridTemplateColumns: '360px minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        {/* Invite card */}
        <TmsCard title="Invite New User">
          <p className="tms-field-hint" style={{ margin: '0 0 12px' }}>They&rsquo;ll receive an email with a temporary password.</p>

          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TmsField label="Email Address" htmlFor="invite-email">
              <TmsInput
                id="invite-email"
                type="email"
                placeholder="driver@bcatcorp.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
                disabled={creating}
              />
            </TmsField>

            <TmsField label="Role" htmlFor="invite-role" hint={ROLE_DESCRIPTIONS[inviteRole]}>
              <TmsSelect
                id="invite-role"
                value={inviteRole}
                disabled={creating}
                onChange={(e) => setInviteRole(e.target.value as RoleKey)}
              >
                {ROLES.map((key) => (
                  <option key={key} value={key}>{ROLE_LABELS[key]}</option>
                ))}
              </TmsSelect>
            </TmsField>

            <div>
              <SectionLabel>Teams</SectionLabel>
              {activeTeams.length === 0 ? (
                <p className="tms-field-hint" style={{ margin: 0 }}>No teams yet — add them in Settings → Teams.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {activeTeams.map((team) => {
                    const on = inviteTeams.includes(team.key)
                    return (
                      <button
                        key={team.key}
                        type="button"
                        aria-pressed={on}
                        disabled={creating}
                        onClick={() => setInviteTeams((prev) => (on ? prev.filter((k) => k !== team.key) : [...prev, team.key]))}
                        style={on ? PILL_ON : PILL}
                      >
                        {on && <Check size={12} />}{team.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <p className="tms-field-hint" style={{ margin: 0 }}>
              The role decides the pages. Extra pages and permissions are granted on the user&rsquo;s card once they appear.
            </p>

            <div>
              <TmsButton type="submit" variant="primary" disabled={creating || !newEmail.trim()}>
                {creating ? <Loader2 size={15} /> : <Plus size={15} />}
                {creating ? 'Sending…' : 'Send Invite'}
              </TmsButton>
            </div>
          </form>
        </TmsCard>

        {/* User list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            All Users {!loading && <span className="tms-muted" style={{ fontWeight: 400 }}>({users.length})</span>}
          </h2>

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--tms-badge-red)', borderRadius: 'var(--tms-radius)', padding: '14px 18px' }}>
              <AlertTriangle size={16} style={{ color: 'var(--tms-badge-red)', flex: '0 0 auto' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--tms-badge-red)' }}>Failed to load users</p>
                <p className="tms-field-hint" style={{ margin: '2px 0 0' }}>{error}</p>
              </div>
              <TmsButton size="sm" onClick={refreshUsers}>Retry</TmsButton>
            </div>
          )}

          {loading ? (
            <div className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '40px 0', fontSize: 14 }}>
              <Loader2 size={16} /> Loading users…
            </div>
          ) : !error && users.length === 0 ? (
            <div className="tms-muted" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 0', gap: 8 }}>
              <Users size={32} style={{ opacity: 0.3 }} />
              <p style={{ margin: 0, fontSize: 14 }}>No users found.</p>
            </div>
          ) : !error ? (
            users.map((u) => (
              <UserCard
                key={u.username}
                user={u}
                teams={teams}
                divisions={divisions}
                callerIsOwner={isOwner}
                roleChangedHere={roleChanged.includes(u.username)}
                onRole={handleRole}
                onToggleTeam={handleToggleTeam}
                onToggleDivision={handleToggleDivision}
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
  )
}
