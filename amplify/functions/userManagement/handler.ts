/**
 * userManagement Lambda — the one writer of staff logins and what they may do.
 *
 * Step I makes a role DATA: the `UserProfile` row is the record, and the Cognito
 * groups are a projection of it (`groupsForProfile`). No Lambda reads this table to
 * authorize anybody — every `authorize()` in the TMS keeps reading `cognito:groups`
 * off the token, so the groups written here are the whole enforcement surface.
 *
 * The gate is two-tier: any ADMIN may run the user actions, but granting ADMIN
 * (`setAdmin`, `setRole` to `ADMIN`) and deleting a login stay with the owner, so an
 * admin can never mint a peer or erase the person above them.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminDeleteUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AdminGetUserCommand,
  CreateGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'crypto'
import {
  CLAIMS,
  ROLES,
  groupsForProfile,
  isClaimKey,
  isRoleKey,
  lockoutCheck,
  reconcileGroups,
  rolePagesFor,
} from '../../../src/lib/roles'
import type { RoleKey, UserProfileRecord, UserStatus } from '../../../src/types/tms'

const cognito = new CognitoIdentityProviderClient({})
const dynamo = new DynamoDBClient({})
// Use env var if set; fall back to known production pool.
// `||` (not `??`) so an empty string also triggers the fallback.
const USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-1_IbPKPNJC9'
const USER_PROFILE_TABLE_NAME = process.env.USER_PROFILE_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''

// Page permissions are NOT hardcoded — any well-formed `page-*` group is accepted and
// created on demand, so a new page added to the frontend nav works without redeploying.
const PAGE_GROUP_RE = /^page-[A-Za-z0-9_-]+$/

const ADMIN_GROUP = 'ADMIN'
const DEFAULT_GROUP = 'DISPATCHER'  // auto-assigned to new invited users
/** Never taken away by a reconcile: it grants nothing and everybody has it. */
const KEEP_GROUPS = [DEFAULT_GROUP]

// Only this account may manage users. Must match OWNER_EMAIL in src/lib/auth/admin.ts.
const OWNER_EMAIL = 'ryne@bcatcorp.com'

const FORBIDDEN_NOT_ADMIN = 'Forbidden: managing users requires owner or ADMIN.'
/** Promoting to ADMIN hands out the ADMIN group, so only the owner may do it. */
const FORBIDDEN_GRANT_ADMIN = 'Forbidden: only the owner may grant the ADMIN role.'
const OWNER_ONLY_ACTIONS: Record<string, string> = {
  setAdmin: 'Forbidden: only the owner may grant or revoke admin.',
  delete: 'Forbidden: only the owner may delete a user.',
}

const MAX_TEXT = 200

type Row = Record<string, unknown>

interface Args {
  action:
    | 'list' | 'create' | 'disable' | 'enable' | 'delete' | 'getGroups' | 'setPageGroups'
    | 'resetPassword' | 'setAdmin'
    | 'setRole' | 'setTeams' | 'setClaims' | 'updateProfile' | 'reinvite' | 'forceSignOut'
  email?: string
  username?: string
  pages?: string    // JSON string: string[]
  isAdmin?: boolean // used by setAdmin action
  role?: string     // used by setRole action
  input?: string    // JSON string: everything else an action needs
}

// AppSync Cognito User Pools identity shape
interface AppSyncIdentity {
  sub: string
  username: string
  claims: { email?: string; [key: string]: unknown }
}

// ── Input helpers ────────────────────────────────────────────────────────────

function parseInput(raw: string | null | undefined): Row {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Row
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return [...new Set(value.map(stringOrNull).filter((v): v is string => v !== null))]
}

/**
 * `undefined` to leave a field alone, `null` to clear it (the update REMOVEs it rather
 * than storing a null), otherwise the trimmed value.
 */
function optionalText(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_TEXT) throw new Error(`${label} is too long (max ${MAX_TEXT} characters)`)
  return trimmed ? trimmed : null
}

function nowIso(): string {
  return new Date().toISOString()
}

function requireUsername(value: string | null | undefined): string {
  const username = stringOrNull(value)
  if (!username) throw new Error('username is required')
  return username
}

// ── Cognito helpers ──────────────────────────────────────────────────────────

// Ensure a Cognito group exists (no-op if already exists)
async function ensureGroup(name: string) {
  try {
    await cognito.send(new CreateGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: name }))
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'GroupExistsException') throw e
  }
}

interface CognitoUser {
  username: string
  email?: string
  status?: string
  enabled?: boolean
  createdAt?: string
}

async function listCognitoUsers(): Promise<CognitoUser[]> {
  // Wrap in try-catch so IAM/SDK errors surface as a descriptive message
  // in the UI error box rather than a generic "null response."
  let result
  try {
    result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID }))
  } catch (err: unknown) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[list] Cognito error:', msg, '| pool:', USER_POOL_ID)
    // ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly.
    const error = new Error(`ListUsers failed (pool=${USER_POOL_ID}): ${msg}`)
    ;(error as Error & { cause?: unknown }).cause = err
    throw error
  }
  return (result.Users ?? []).map((u) => ({
    username: u.Username ?? '',
    email: u.Attributes?.find((a) => a.Name === 'email')?.Value,
    status: u.UserStatus,
    enabled: u.Enabled,
    createdAt: u.UserCreateDate?.toISOString(),
  }))
}

async function listGroups(username: string): Promise<string[]> {
  const result = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }))
  return (result.Groups ?? []).map((g) => g.GroupName ?? '').filter(Boolean)
}

async function applyGroupChanges(username: string, add: string[], remove: string[]): Promise<void> {
  for (const group of add) await ensureGroup(group)
  await Promise.all([
    ...add.map((group) => cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID, Username: username, GroupName: group,
    }))),
    ...remove.map(async (group) => {
      try {
        await cognito.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID, Username: username, GroupName: group,
        }))
      } catch (e: unknown) {
        const name = e instanceof Error ? e.name : ''
        if (name !== 'UserNotFoundException') console.warn('[userManagement] remove group warning:', String(e))
      }
    }),
  ])
}

/** The groups the profile implies, minus whatever `keep` protects. */
async function syncGroups(
  username: string,
  profile: Pick<UserProfileRecord, 'role' | 'claims' | 'extraPages'>,
  keep: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const desired = groupsForProfile(profile)
  const current = await listGroups(username)
  const { add, remove } = reconcileGroups(current, desired, keep)
  await applyGroupChanges(username, add, remove)
  return { added: add, removed: remove }
}

/**
 * The page grants no role handed out — the ones a role change must leave alone. A row
 * written before Step I carries no `extraPages`, so derive them once from what the login
 * actually holds minus what its PREVIOUS role granted; a login with no row at all keeps
 * every page it has.
 */
function extraPagesFor(current: string[], previousRole: string | null, stored: string[] | null): string[] {
  if (stored) return stored
  const fromRole = new Set(isRoleKey(previousRole) ? rolePagesFor(previousRole) : [])
  return current
    .filter((group) => PAGE_GROUP_RE.test(group))
    .map((group) => group.slice('page-'.length))
    .filter((key) => !fromRole.has(key))
}

// ── Profile store ────────────────────────────────────────────────────────────

async function getProfile(username: string): Promise<Row | null> {
  if (!USER_PROFILE_TABLE_NAME) return null
  const result = await dynamo.send(new GetItemCommand({
    TableName: USER_PROFILE_TABLE_NAME,
    Key: marshall({ id: username }),
  }))
  return result.Item ? (unmarshall(result.Item) as Row) : null
}

/** Tens of rows, no index, and every caller wants all of them. */
async function scanProfiles(): Promise<Row[]> {
  if (!USER_PROFILE_TABLE_NAME) return []
  const rows: Row[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: USER_PROFILE_TABLE_NAME,
      ExclusiveStartKey: startKey,
    }))
    for (const item of page.Items ?? []) rows.push(unmarshall(item) as Row)
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return rows
}

async function putProfile(item: Row): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: USER_PROFILE_TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(id)',
  }))
}

/**
 * SET every defined key, REMOVE every explicit null — a cleared field leaves no null
 * behind — and bump `version` so a concurrent edit is visible in the row itself.
 */
async function updateProfile(id: string, patch: Row, caller: string): Promise<Row | null> {
  const names: Record<string, string> = { '#version': 'version', '#updatedAt': 'updatedAt', '#updatedBy': 'updatedBy' }
  const values: Record<string, AttributeValue> = marshall({
    ':one': 1,
    ':zero': 0,
    ':updatedAt': nowIso(),
    ':updatedBy': caller,
  })
  const sets = [
    '#version = if_not_exists(#version, :zero) + :one',
    '#updatedAt = :updatedAt',
    '#updatedBy = :updatedBy',
  ]
  const removes: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    if (value === null) {
      removes.push(`#${key}`)
      continue
    }
    values[`:${key}`] = marshall({ [key]: value }, { removeUndefinedValues: true })[key]
    sets.push(`#${key} = :${key}`)
  }
  const result = await dynamo.send(new UpdateItemCommand({
    TableName: USER_PROFILE_TABLE_NAME,
    Key: marshall({ id }),
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }))
  return result.Attributes ? (unmarshall(result.Attributes) as Row) : null
}

/**
 * A profile's `id` IS the Cognito username, and a login can predate Step I, so every
 * write creates the row when it is missing instead of refusing.
 */
async function saveProfile(username: string, email: string, patch: Row, caller: string): Promise<Row | null> {
  if (!USER_PROFILE_TABLE_NAME) return null
  const existing = await getProfile(username)
  if (existing) return await updateProfile(username, patch, caller)

  const now = nowIso()
  const item: Row = {
    id: username,
    __typename: 'UserProfile',
    email: email || username,
    status: 'ACTIVE',
    createdBy: caller,
    updatedBy: caller,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) item[key] = value
  }
  await putProfile(item)
  return item
}

async function deleteProfile(username: string): Promise<void> {
  if (!USER_PROFILE_TABLE_NAME) return
  await dynamo.send(new DeleteItemCommand({
    TableName: USER_PROFILE_TABLE_NAME,
    Key: marshall({ id: username }),
  }))
}

/**
 * Best-effort and outside everything else, on purpose: a role that was granted but
 * could not write its audit row is still granted, and failing the action would leave
 * Cognito and the profile out of step instead.
 */
async function writeAudit(
  entityType: string,
  entityId: string,
  action: string,
  caller: string,
  changes: Row,
): Promise<void> {
  if (!AUDIT_LOG_TABLE_NAME) return
  const now = nowIso()
  try {
    await dynamo.send(new PutItemCommand({
      TableName: AUDIT_LOG_TABLE_NAME,
      Item: marshall({
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType,
        entityId,
        action,
        user: caller,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      }, { removeUndefinedValues: true }),
    }))
  } catch (err) {
    console.warn('[userManagement] audit log write failed:', String(err))
  }
}

// ── Directory (Cognito ⋈ profiles) ───────────────────────────────────────────

/** Cognito is the authority on whether a login works; the row is the authority on role. */
function statusFor(user: CognitoUser | undefined): UserStatus {
  if (!user) return 'PENDING'
  if (user.enabled === false) return 'INACTIVE'
  if (user.status === 'FORCE_CHANGE_PASSWORD' || user.status === 'RESET_REQUIRED') return 'PENDING'
  return 'ACTIVE'
}

interface Directory {
  byUsername: Map<string, CognitoUser>
  rows: Row[]
  profiles: UserProfileRecord[]
}

/**
 * The list `lockoutCheck` judges: every profile row, with the live Cognito enabled flag
 * folded into `status`, so a row that still says ACTIVE for a disabled login does not
 * count as one of the remaining admins.
 */
async function readDirectory(): Promise<Directory> {
  const [users, rows] = await Promise.all([listCognitoUsers(), scanProfiles()])
  const byUsername = new Map(users.map((u) => [u.username, u]))
  const profiles = rows.map((row) => {
    // The row IS a profile: it is the marshalled form of exactly this interface, and a
    // field-by-field rebuild would be a second copy of the model to keep in step.
    const record = row as unknown as UserProfileRecord
    const user = byUsername.get(String(row.id ?? ''))
    return { ...record, status: user ? statusFor(user) : record.status ?? null }
  })
  return { byUsername, rows, profiles }
}

function emailFor(directory: Directory, username: string): string {
  const fromCognito = stringOrNull(directory.byUsername.get(username)?.email)
  if (fromCognito) return fromCognito.toLowerCase()
  const row = directory.rows.find((r) => String(r.id ?? '') === username)
  const fromRow = stringOrNull(row?.email)
  if (fromRow) return fromRow.toLowerCase()
  return username.includes('@') ? username.toLowerCase() : ''
}

/**
 * The one way a role is written: refuse a lockout, keep the page grants no role gave,
 * write the row, then make the groups match the row. `setAdmin` goes through here too —
 * ADMIN is a role, and moving only its group left the row saying something else, so the
 * next claims or page edit rebuilt the groups from a stale profile and quietly undid a
 * decision that is the owner's alone.
 */
async function applyRoleChange(
  target: string,
  role: RoleKey,
  action: 'setRole' | 'setAdmin',
  caller: { email: string; isOwner: boolean },
): Promise<{ profile: Row | null; added: string[]; removed: string[] }> {
  const directory = await readDirectory()
  const targetEmail = emailFor(directory, target)
  const refusal = lockoutCheck(directory.profiles, {
    actorEmail: caller.email,
    actorIsOwner: caller.isOwner,
    targetId: target,
    targetEmail,
    nextRole: role,
    action,
  })
  if (refusal) throw new Error(refusal)

  const row = directory.rows.find((r) => String(r.id ?? '') === target)
  const current = await listGroups(target)
  const extraPages = extraPagesFor(current, stringOrNull(row?.role), stringList(row?.extraPages))

  const profile = await saveProfile(target, targetEmail, {
    role,
    extraPages,
    lastRoleChangeAt: nowIso(),
    lastRoleChangeBy: caller.email,
  }, caller.email)
  const desired = groupsForProfile({ role, claims: stringList(profile?.claims), extraPages })
  const { add, remove } = reconcileGroups(current, desired, KEEP_GROUPS)
  await applyGroupChanges(target, add, remove)
  return { profile, added: add, removed: remove }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: { arguments: Args; identity?: AppSyncIdentity | null }) => {
  console.log('[userManagement] action:', event.arguments?.action, '| pool:', USER_POOL_ID)

  // Server-side authorization. The data model's allow.authenticated() lets any signed-in
  // user reach this Lambda, so the real gate lives here (the client-side check in
  // UsersPage is just UX).
  //
  // Amplify sends the Cognito ACCESS token, which has NO `email` claim — so resolve
  // the caller's email from the username (which is the email for users created via
  // AdminCreateUser), and if that's a UUID, look up the email attribute via AdminGetUser.
  const claims = (event.identity?.claims ?? {}) as Record<string, unknown>
  let callerEmail = [claims.email, event.identity?.username, claims['cognito:username']]
    .map((v) => (typeof v === 'string' ? v : ''))
    .find((v) => v.includes('@'))?.toLowerCase().trim() ?? ''
  if (!callerEmail) {
    const lookup = event.identity?.username ?? event.identity?.sub
    if (lookup) {
      try {
        const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
        callerEmail = (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
      } catch (e: unknown) {
        console.warn('[userManagement] could not resolve caller email:', String(e))
      }
    }
  }

  const rawGroups = claims['cognito:groups']
  const callerGroups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : typeof rawGroups === 'string'
      ? rawGroups.split(',').map((s) => s.trim()).filter(Boolean)
      : []

  const isOwner = callerEmail === OWNER_EMAIL
  const isAdmin = isOwner || callerGroups.includes(ADMIN_GROUP)
  if (!isAdmin) {
    console.warn('[userManagement] forbidden caller:', callerEmail || '(unresolved)', '| identity:', JSON.stringify(event.identity))
    throw new Error(FORBIDDEN_NOT_ADMIN)
  }

  const { action, email, username, pages, isAdmin: makeAdmin } = event.arguments
  const ownerOnly = OWNER_ONLY_ACTIONS[action]
  if (ownerOnly && !isOwner) throw new Error(ownerOnly)

  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'list': {
      const users = await listCognitoUsers()
      const rows = await scanProfiles()
      const profiles = new Map(rows.map((row) => [String(row.id ?? ''), row]))
      // The owner never went through an invite, so their row has to be minted here —
      // otherwise the lockout check counts zero admins and refuses every demotion.
      const owner = users.find((u) => (u.email ?? u.username).toLowerCase().trim() === OWNER_EMAIL)
      if (owner && !profiles.has(owner.username)) {
        const created = await saveProfile(
          owner.username,
          owner.email ?? OWNER_EMAIL,
          { role: 'ADMIN', status: statusFor(owner) },
          callerEmail,
        )
        if (created) profiles.set(owner.username, created)
      }
      const groups = await Promise.all(users.map((u) => listGroups(u.username)))
      const result = users.map((user, i) => ({
        ...user,
        profile: profiles.get(user.username) ?? null,
        groups: groups[i],
      }))
      console.log('[list] returned', result.length, 'users from pool', USER_POOL_ID)
      return JSON.stringify(result)
    }
    case 'create': {
      if (!email) throw new Error('email is required')
      const role = stringOrNull(event.arguments.role ?? input.role)
      if (role !== null && !isRoleKey(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`)
      if (role === 'ADMIN' && !isOwner) throw new Error(FORBIDDEN_GRANT_ADMIN)
      const teamKeys = stringList(input.teamKeys)

      const created = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }))
      // The pool signs people in by e-mail but names them by a generated id, and that
      // id is what `list` joins profiles on and what the Users page sends back. A
      // profile keyed by the e-mail would be a row nobody ever reads.
      const target = created.User?.Username ?? email
      // Auto-assign the default group for internal grouping/role bookkeeping.
      // Page access is controlled exclusively by page-* groups; this default group
      // does not grant any menu or page access.
      await ensureGroup(DEFAULT_GROUP)
      try {
        await cognito.send(new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID, Username: target, GroupName: DEFAULT_GROUP,
        }))
      } catch (e: unknown) {
        console.warn('[create] could not add to default group:', String(e))
      }

      const now = nowIso()
      const profile = await saveProfile(target, email, {
        role: role ?? undefined,
        teamKeys: teamKeys ?? undefined,
        status: 'PENDING',
        invitedAt: now,
        invitedBy: callerEmail,
      }, callerEmail)
      const synced = role
        ? await syncGroups(target, { role, claims: null, extraPages: null }, KEEP_GROUPS)
        : { added: [], removed: [] }
      await writeAudit('UserProfile', target, 'CREATE_USER', callerEmail, {
        email, role, teamKeys, added: synced.added,
      })
      return JSON.stringify({ success: true, profile, added: synced.added, removed: synced.removed })
    }
    case 'disable': {
      const target = requireUsername(username)
      const directory = await readDirectory()
      const targetEmail = emailFor(directory, target)
      const refusal = lockoutCheck(directory.profiles, {
        actorEmail: callerEmail,
        actorIsOwner: isOwner,
        targetId: target,
        targetEmail,
        nextEnabled: false,
        action: 'disable',
      })
      if (refusal) throw new Error(refusal)
      await cognito.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      const profile = await saveProfile(target, targetEmail, { status: 'INACTIVE' }, callerEmail)
      await writeAudit('UserProfile', target, 'DISABLE_USER', callerEmail, { email: targetEmail })
      return JSON.stringify({ success: true, profile })
    }
    case 'enable': {
      const target = requireUsername(username)
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      const profile = await saveProfile(target, '', { status: 'ACTIVE' }, callerEmail)
      await writeAudit('UserProfile', target, 'ENABLE_USER', callerEmail, {})
      return JSON.stringify({ success: true, profile })
    }
    case 'delete': {
      // Gone from the user pool for good: sign-in, groups and page access. Rows they
      // wrote (loads, notes, uploads) keep their email as the author. The owner's own
      // account is never deletable from here.
      const target = requireUsername(username)
      const found = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      const targetEmail = (found.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
      if (targetEmail === OWNER_EMAIL || target.toLowerCase() === OWNER_EMAIL) throw new Error('The owner account cannot be deleted')
      const directory = await readDirectory()
      const refusal = lockoutCheck(directory.profiles, {
        actorEmail: callerEmail,
        actorIsOwner: isOwner,
        targetId: target,
        targetEmail: targetEmail || emailFor(directory, target),
        action: 'delete',
      })
      if (refusal) throw new Error(refusal)
      // The row goes first: if the Cognito delete then fails, the admin sees a login that
      // is still there and can retry, whereas a row orphaned by the other order is
      // invisible to `list` (which is driven by the pool) and only removable by hand.
      await deleteProfile(target)
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      await writeAudit('UserProfile', target, 'DELETE_USER', callerEmail, { email: targetEmail })
      console.log('[userManagement] user deleted', { by: callerEmail, username: target, email: targetEmail })
      return JSON.stringify({ success: true })
    }
    case 'getGroups': {
      const target = requireUsername(username)
      return JSON.stringify(await listGroups(target))
    }
    case 'setPageGroups': {
      const target = requireUsername(username)
      // Frontend sends bare keys (e.g. "dashboard"); any well-formed page-* key is
      // accepted (no fixed list). The page grid is allowed to change `page-*` groups and
      // nothing else: every non-page group the user already has goes into `keep`, so
      // `ADMIN`, `role-*` and `claim-*` survive untouched — and because the desired set
      // is built with `groupsForProfile`, the pages a role grants cannot be revoked here.
      const raw: string[] = pages ? JSON.parse(pages) : []
      const pageKeys = [...new Set(
        raw
          .map((p) => (typeof p === 'string' && p.startsWith('page-') ? p.slice('page-'.length) : p))
          .map(stringOrNull)
          .filter((key): key is string => key !== null && PAGE_GROUP_RE.test(`page-${key}`)),
      )]
      const existing = await getProfile(target)
      const existingRole = stringOrNull(existing?.role)
      const current = await listGroups(target)
      const desired = groupsForProfile({
        role: isRoleKey(existingRole) ? existingRole : null,
        claims: stringList(existing?.claims),
        extraPages: pageKeys,
      })
      const keep = [...KEEP_GROUPS, ...current.filter((g) => !PAGE_GROUP_RE.test(g))]
      const { add, remove } = reconcileGroups(current, desired, keep)
      await applyGroupChanges(target, add, remove)
      const profile = await saveProfile(target, '', { extraPages: pageKeys }, callerEmail)
      await writeAudit('UserProfile', target, 'SET_PAGE_GROUPS', callerEmail, { pages: pageKeys, added: add, removed: remove })
      return JSON.stringify({ success: true, profile, added: add, removed: remove })
    }
    case 'resetPassword': {
      const target = requireUsername(username)
      await cognito.send(new AdminResetUserPasswordCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      await writeAudit('UserProfile', target, 'RESET_PASSWORD', callerEmail, {})
      return JSON.stringify({ success: true })
    }
    case 'setAdmin': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      let role: RoleKey = 'ADMIN'
      if (!makeAdmin) {
        // Revoking hands the user back a plain role; the caller may name it.
        const replacement = stringOrNull(event.arguments.role ?? input.role)
        if (replacement !== null && !isRoleKey(replacement)) throw new Error(`role must be one of: ${ROLES.join(', ')}`)
        if (replacement === 'ADMIN') throw new Error('Revoking admin needs a role other than ADMIN.')
        role = replacement ?? 'NONE'
      }
      const { profile, added, removed } = await applyRoleChange(target, role, 'setAdmin', {
        email: callerEmail,
        isOwner,
      })
      await writeAudit('UserProfile', target, 'SET_ADMIN', callerEmail, {
        isAdmin: Boolean(makeAdmin), role, added, removed,
      })
      return JSON.stringify({ success: true, profile, added, removed })
    }
    case 'setRole': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      const role = stringOrNull(event.arguments.role ?? input.role)
      if (!isRoleKey(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`)
      if (role === 'ADMIN' && !isOwner) throw new Error(FORBIDDEN_GRANT_ADMIN)

      const { profile, added, removed } = await applyRoleChange(target, role, 'setRole', {
        email: callerEmail,
        isOwner,
      })
      await writeAudit('UserProfile', target, 'SET_ROLE', callerEmail, { role, added, removed })
      return JSON.stringify({ success: true, profile, added, removed })
    }
    case 'setTeams': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      const teamKeys = stringList(input.teamKeys) ?? []
      // Teams carry no page access of their own, so no group changes.
      const profile = await saveProfile(target, '', { teamKeys }, callerEmail)
      await writeAudit('UserProfile', target, 'SET_TEAMS', callerEmail, { teamKeys })
      return JSON.stringify({ success: true, profile })
    }
    case 'setClaims': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      const requested = stringList(input.claims) ?? []
      for (const claim of requested) {
        if (!isClaimKey(claim)) throw new Error(`claim must be one of: ${CLAIMS.join(', ')}`)
      }
      const existing = await getProfile(target)
      const current = await listGroups(target)
      const extraPages = extraPagesFor(current, stringOrNull(existing?.role), stringList(existing?.extraPages))
      const profile = await saveProfile(target, '', { claims: requested, extraPages }, callerEmail)
      const existingRole = stringOrNull(profile?.role)
      const desired = groupsForProfile({
        role: isRoleKey(existingRole) ? existingRole : null,
        claims: requested,
        extraPages,
      })
      const { add, remove } = reconcileGroups(current, desired, KEEP_GROUPS)
      await applyGroupChanges(target, add, remove)
      await writeAudit('UserProfile', target, 'SET_CLAIMS', callerEmail, { claims: requested, added: add, removed: remove })
      return JSON.stringify({ success: true, profile, added: add, removed: remove })
    }
    case 'updateProfile': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      const patch: Row = {
        name: optionalText(input.name, 'name'),
        title: optionalText(input.title, 'title'),
        phone: optionalText(input.phone, 'phone'),
        datEmail: optionalText(input.datEmail, 'datEmail'),
      }
      if (input.managerId !== undefined) {
        const managerId = optionalText(input.managerId, 'managerId') ?? null
        if (managerId) {
          if (managerId === target) throw new Error('A manager must be another user.')
          const manager = await getProfile(managerId)
          if (!manager) throw new Error('A manager must be another user.')
        }
        patch.managerId = managerId
      }
      const profile = await saveProfile(target, '', patch, callerEmail)
      await writeAudit('UserProfile', target, 'UPDATE_PROFILE', callerEmail, patch)
      return JSON.stringify({ success: true, profile })
    }
    case 'reinvite': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: target,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }))
      const profile = await saveProfile(target, '', {
        invitedAt: nowIso(),
        invitedBy: callerEmail,
      }, callerEmail)
      await writeAudit('UserProfile', target, 'REINVITE_USER', callerEmail, {})
      return JSON.stringify({ success: true, profile })
    }
    case 'forceSignOut': {
      const target = requireUsername(username ?? stringOrNull(input.username))
      await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: target }))
      await writeAudit('UserProfile', target, 'FORCE_SIGN_OUT', callerEmail, {})
      return JSON.stringify({ success: true })
    }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
