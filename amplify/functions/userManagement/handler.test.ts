/**
 * userManagement handler tests.
 *
 * Both sides are small in-memory engines rather than scripted replies, because what
 * this Lambda has to get right is a *state* question, not a call count: after a role
 * change the user's Cognito groups must be exactly the ones the profile implies —
 * with `DISPATCHER` and anything another feature owns still on them — and the page
 * grid must not be able to take a role, a claim or admin away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

type Row = Record<string, unknown>

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_EMAIL = 'dennis@bcatcorp.com'

const TABLES = {
  profile: 'UserProfile-test',
  audit: 'AuditLog-test',
}

// ── Cognito mock ─────────────────────────────────────────────────────────────

interface PoolUser {
  username: string
  email: string
  enabled: boolean
  status: string
  createdAt: Date
}

const pool = vi.hoisted(() => {
  process.env.USER_POOL_ID = 'us-east-1_TEST'
  return {
    users: new Map<string, PoolUser>(),
    membership: new Map<string, Set<string>>(),
    groups: new Set<string>(),
    calls: [] as { type: string; input: Record<string, unknown> }[],
  }
})

const cognitoSend = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  class CognitoIdentityProviderClient {
    send = cognitoSend
  }
  return {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand: make('AdminCreateUser'),
    ListUsersCommand: make('ListUsers'),
    AdminDisableUserCommand: make('AdminDisableUser'),
    AdminDeleteUserCommand: make('AdminDeleteUser'),
    AdminEnableUserCommand: make('AdminEnableUser'),
    AdminListGroupsForUserCommand: make('AdminListGroupsForUser'),
    AdminAddUserToGroupCommand: make('AdminAddUserToGroup'),
    AdminRemoveUserFromGroupCommand: make('AdminRemoveUserFromGroup'),
    AdminResetUserPasswordCommand: make('AdminResetUserPassword'),
    AdminUserGlobalSignOutCommand: make('AdminUserGlobalSignOut'),
    AdminGetUserCommand: make('AdminGetUser'),
    CreateGroupCommand: make('CreateGroup'),
  }
})

// ── DynamoDB mock ────────────────────────────────────────────────────────────

const store = vi.hoisted(() => {
  process.env.USER_PROFILE_TABLE_NAME = 'UserProfile-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  return new Map<string, Map<string, Record<string, unknown>>>()
})

const send = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => {
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  class DynamoDBClient {
    send = send
  }
  return {
    DynamoDBClient,
    GetItemCommand: make('Get'),
    PutItemCommand: make('Put'),
    UpdateItemCommand: make('Update'),
    DeleteItemCommand: make('Delete'),
    ScanCommand: make('Scan'),
  }
})

import { handler } from './handler'
import { groupsForProfile, reconcileGroups } from '../../../src/lib/roles'

// ── Engines ──────────────────────────────────────────────────────────────────

interface MockCommand {
  __type: string
  input: Record<string, unknown>
}

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

/** `a = :a, b = if_not_exists(b, :zero) + :one` — commas inside the call are not separators. */
function splitClauses(clause: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of clause) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

interface UpdateSpec {
  TableName: string
  Key: Record<string, unknown>
  UpdateExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
}

function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)

  const expression = spec.UpdateExpression ?? ''
  const removeAt = expression.search(/\bREMOVE\b/)
  const setAt = expression.search(/\bSET\b/)
  const setClause = setAt < 0 ? '' : expression.slice(setAt + 3, removeAt < 0 ? undefined : removeAt)
  const removeClause = removeAt < 0 ? '' : expression.slice(removeAt + 6)

  const next: Row = { ...(existing ?? { id: key.id }) }
  for (const assignment of splitClauses(setClause)) {
    const bump = /^([#\w]+)\s*=\s*if_not_exists\(([#\w]+),\s*(:\w+)\)\s*\+\s*(:\w+)$/.exec(assignment)
    if (bump) {
      const field = resolve(bump[1])
      const base = typeof next[field] === 'number' ? (next[field] as number) : Number(values[bump[3]])
      next[field] = base + Number(values[bump[4]])
      continue
    }
    const simple = /^([#\w]+)\s*=\s*(:\w+)$/.exec(assignment)
    if (!simple) throw new Error(`unsupported assignment: ${assignment}`)
    next[resolve(simple[1])] = values[simple[2]]
  }
  for (const token of splitClauses(removeClause)) delete next[resolve(token)]

  t.set(key.id, next)
  return next
}

function runDynamo(cmd: MockCommand): unknown {
  const input = cmd.input
  const name = String(input.TableName)
  switch (cmd.__type) {
    case 'Get': {
      const key = unmarshall(input.Key as never) as { id: string }
      const item = table(name).get(key.id)
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'Put': {
      const row = unmarshall(input.Item as never) as Row
      const t = table(name)
      if (input.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(row.id))) {
        throw new Error(`ConditionalCheckFailedException: ${name}/${String(row.id)}`)
      }
      t.set(String(row.id), row)
      return {}
    }
    case 'Update':
      return { Attributes: marshall(applyUpdate(input as unknown as UpdateSpec), { removeUndefinedValues: true }) }
    case 'Delete': {
      const key = unmarshall(input.Key as never) as { id: string }
      table(name).delete(key.id)
      return {}
    }
    case 'Scan':
      return { Items: [...table(name).values()].map((row) => marshall(row, { removeUndefinedValues: true })) }
    default:
      throw new Error(`unexpected DynamoDB command ${cmd.__type}`)
  }
}

function notFound(): Error {
  const err = new Error('User does not exist.')
  err.name = 'UserNotFoundException'
  return err
}

function groupsOf(username: string): Set<string> {
  let set = pool.membership.get(username)
  if (!set) {
    set = new Set<string>()
    pool.membership.set(username, set)
  }
  return set
}

function runCognito(cmd: MockCommand): unknown {
  const input = cmd.input
  pool.calls.push({ type: cmd.__type, input })
  const asked = String(input.Username ?? '')
  // An e-mail is an alias the pool resolves to the generated username.
  const username = pool.users.has(asked)
    ? asked
    : ([...pool.users.values()].find((u) => u.email === asked)?.username ?? asked)
  switch (cmd.__type) {
    case 'CreateGroup': {
      const group = String(input.GroupName)
      if (pool.groups.has(group)) {
        const err = new Error('Group already exists')
        err.name = 'GroupExistsException'
        throw err
      }
      pool.groups.add(group)
      return {}
    }
    case 'ListUsers':
      return {
        Users: [...pool.users.values()].map((u) => ({
          Username: u.username,
          Attributes: [{ Name: 'email', Value: u.email }],
          UserStatus: u.status,
          Enabled: u.enabled,
          UserCreateDate: u.createdAt,
        })),
      }
    case 'AdminGetUser': {
      const user = pool.users.get(username)
      if (!user) throw notFound()
      return {
        Username: user.username,
        UserAttributes: [{ Name: 'email', Value: user.email }],
        Enabled: user.enabled,
        UserStatus: user.status,
      }
    }
    case 'AdminCreateUser': {
      if (input.MessageAction === 'RESEND') {
        if (!pool.users.has(username)) throw notFound()
        return { User: { Username: username } }
      }
      const email = String(input.Username ?? '')
      if ([...pool.users.values()].some((u) => u.email === email)) {
        const err = new Error('User account already exists')
        err.name = 'UsernameExistsException'
        throw err
      }
      // Like the real pool: people sign in by e-mail, the pool names them by a
      // generated id, and that id is the Username every later call sees.
      const minted = `sub-${pool.users.size + 1}`
      pool.users.set(minted, {
        username: minted,
        email,
        enabled: true,
        status: 'FORCE_CHANGE_PASSWORD',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      return { User: { Username: minted } }
    }
    case 'AdminListGroupsForUser':
      return { Groups: [...groupsOf(username)].map((g) => ({ GroupName: g })) }
    case 'AdminAddUserToGroup':
      if (!pool.groups.has(String(input.GroupName))) throw new Error(`group ${String(input.GroupName)} does not exist`)
      groupsOf(username).add(String(input.GroupName))
      return {}
    case 'AdminRemoveUserFromGroup':
      groupsOf(username).delete(String(input.GroupName))
      return {}
    case 'AdminDisableUser': {
      const user = pool.users.get(username)
      if (!user) throw notFound()
      user.enabled = false
      return {}
    }
    case 'AdminEnableUser': {
      const user = pool.users.get(username)
      if (!user) throw notFound()
      user.enabled = true
      return {}
    }
    case 'AdminDeleteUser':
      pool.users.delete(username)
      pool.membership.delete(username)
      return {}
    case 'AdminResetUserPassword':
    case 'AdminUserGlobalSignOut':
      if (!pool.users.has(username)) throw notFound()
      return {}
    default:
      throw new Error(`unexpected Cognito command ${cmd.__type}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface TestIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

function identity(email: string, groups: string[]): TestIdentity {
  return { sub: `sub-${email}`, username: email, claims: { email, 'cognito:groups': groups } }
}

const owner = identity(OWNER_EMAIL, ['ADMIN'])
const admin = identity(ADMIN_EMAIL, ['ADMIN', 'page-users'])
const staff = identity('sam@bcatcorp.com', ['DISPATCHER', 'page-dashboard'])

interface Args {
  action: string
  email?: string
  username?: string
  pages?: string
  isAdmin?: boolean
  role?: string
  input?: string
}

async function call(args: Args, who: TestIdentity = admin): Promise<Row> {
  const raw = await handler({ arguments: args as never, identity: who as never })
  return JSON.parse(String(raw)) as Row
}

function seedUser(email: string, groups: string[], options?: { enabled?: boolean; status?: string }): PoolUser {
  const user: PoolUser = {
    username: email,
    email,
    enabled: options?.enabled ?? true,
    status: options?.status ?? 'CONFIRMED',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  pool.users.set(email, user)
  pool.membership.set(email, new Set(groups))
  for (const group of groups) pool.groups.add(group)
  return user
}

function seedProfile(id: string, patch: Row): Row {
  const row: Row = {
    id,
    __typename: 'UserProfile',
    email: id,
    status: 'ACTIVE',
    createdBy: OWNER_EMAIL,
    updatedBy: OWNER_EMAIL,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
  table(TABLES.profile).set(id, row)
  return row
}

function profileOf(id: string): Row | undefined {
  return table(TABLES.profile).get(id)
}

function auditRows(): Row[] {
  return [...table(TABLES.audit).values()]
}

beforeEach(() => {
  store.clear()
  pool.users.clear()
  pool.membership.clear()
  pool.groups.clear()
  pool.calls.length = 0
  pool.groups.add('DISPATCHER')
  pool.groups.add('ADMIN')
  send.mockReset()
  send.mockImplementation((cmd: MockCommand) => Promise.resolve(runDynamo(cmd)))
  cognitoSend.mockReset()
  cognitoSend.mockImplementation((cmd: MockCommand) => Promise.resolve(runCognito(cmd)))
  seedUser(OWNER_EMAIL, ['ADMIN', 'DISPATCHER'])
  seedUser(ADMIN_EMAIL, ['ADMIN', 'DISPATCHER', 'page-users'])
})

// ── The gate ─────────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('refuses a signed-in user who is neither owner nor ADMIN', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    await expect(call({ action: 'list' }, staff)).rejects.toThrow('Forbidden: managing users requires owner or ADMIN.')
  })

  it('refuses an ADMIN who tries to grant the ADMIN role', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    await expect(call({ action: 'setRole', username: 'sam@bcatcorp.com', role: 'ADMIN' })).rejects.toThrow(
      'Forbidden: only the owner may grant the ADMIN role.',
    )
    expect([...(pool.membership.get('sam@bcatcorp.com') ?? [])]).not.toContain('ADMIN')
  })

  it('refuses an ADMIN who tries to delete a user', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    await expect(call({ action: 'delete', username: 'sam@bcatcorp.com' })).rejects.toThrow(
      'Forbidden: only the owner may delete a user.',
    )
    expect(pool.users.has('sam@bcatcorp.com')).toBe(true)
  })
})

// ── Lockout ──────────────────────────────────────────────────────────────────

describe('lockout', () => {
  it("refuses to demote the owner", async () => {
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })
    await expect(call({ action: 'setRole', username: OWNER_EMAIL, role: 'CUSTOMER_REP' })).rejects.toThrow(
      "The owner's role cannot be changed.",
    )
    expect(profileOf(OWNER_EMAIL)?.role).toBe('ADMIN')
  })

  it('refuses to demote the last admin', async () => {
    // The owner acts by e-mail and has no profile row yet, so Dennis is the only
    // admin the directory knows about.
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })
    await expect(
      call({ action: 'setRole', username: ADMIN_EMAIL, role: 'CUSTOMER_REP' }, owner),
    ).rejects.toThrow(`${ADMIN_EMAIL} is the last admin — promote somebody else first.`)
    expect(profileOf(ADMIN_EMAIL)?.role).toBe('ADMIN')
  })

  it('refuses to demote yourself', async () => {
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    await expect(call({ action: 'setRole', username: ADMIN_EMAIL, role: 'CUSTOMER_REP' })).rejects.toThrow(
      'You cannot change your own role.',
    )
  })
})

// ── Invite + role ────────────────────────────────────────────────────────────

describe('create and setRole', () => {
  it('lets an ADMIN invite a user and give them a role', async () => {
    const created = await call({
      action: 'create',
      email: 'newrep@bcatcorp.com',
      input: JSON.stringify({ role: 'CUSTOMER_REP', teamKeys: ['east'] }),
    })

    expect(created.success).toBe(true)
    const minted = [...pool.users.values()].find((u) => u.email === 'newrep@bcatcorp.com')?.username
    expect(minted).toBeDefined()
    expect(minted).not.toBe('newrep@bcatcorp.com')

    // The profile is keyed by the username the pool assigned, so `list` finds it.
    const profile = profileOf(minted!)
    expect(profile).toMatchObject({
      email: 'newrep@bcatcorp.com',
      role: 'CUSTOMER_REP',
      status: 'PENDING',
      teamKeys: ['east'],
      invitedBy: ADMIN_EMAIL,
      createdBy: ADMIN_EMAIL,
      version: 1,
    })
    expect(profile?.invitedAt).toEqual(expect.any(String))
    expect(profileOf('newrep@bcatcorp.com')).toBeUndefined()
    const listed = (await call({ action: 'list' })) as unknown as { email?: string; profile: Row | null }[]
    expect(listed.find((u) => u.email === 'newrep@bcatcorp.com')?.profile).toMatchObject({ role: 'CUSTOMER_REP' })

    const groups = [...(pool.membership.get(minted!) ?? [])]
    expect(groups).toContain('DISPATCHER')
    expect(groups).toEqual(expect.arrayContaining(groupsForProfile({ role: 'CUSTOMER_REP' })))

    expect(auditRows().map((row) => row.entityType)).toContain('UserProfile')
  })

  it('adds and removes exactly the groups reconcileGroups names, and never DISPATCHER', async () => {
    const current = ['DISPATCHER', 'ADMIN', 'role-CARRIER_REP', 'page-carriers', 'page-handpicked']
    seedUser('sam@bcatcorp.com', current)
    seedProfile('sam@bcatcorp.com', { role: 'CARRIER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })

    // `page-handpicked` is in no role's set — a hand grant the role change keeps, so it
    // is part of the desired set rather than something to take away.
    const desired = groupsForProfile({ role: 'CUSTOMER_REP', extraPages: ['handpicked'] })
    const expected = reconcileGroups(current, desired, ['DISPATCHER'])

    const result = await call({ action: 'setRole', username: 'sam@bcatcorp.com', role: 'CUSTOMER_REP' })

    expect(result.added).toEqual(expected.add)
    expect(result.removed).toEqual(expected.remove)
    expect(expected.remove).toContain('role-CARRIER_REP')

    const after = [...(pool.membership.get('sam@bcatcorp.com') ?? [])].sort()
    expect(after).toContain('DISPATCHER')
    expect(after).toEqual([...new Set([...desired, 'DISPATCHER'])].sort())
    expect(profileOf('sam@bcatcorp.com')).toMatchObject({ role: 'CUSTOMER_REP', lastRoleChangeBy: ADMIN_EMAIL })
  })

  it('keeps the page grants no role handed out', async () => {
    // Fuel and trucks belong to no role's set: somebody granted them by hand, and the
    // row written before this change says nothing about them.
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'page-fuel', 'page-trucks', 'page-carriers'])
    seedProfile('sam@bcatcorp.com', { role: 'CARRIER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })

    await call({ action: 'setRole', username: 'sam@bcatcorp.com', role: 'CUSTOMER_REP' })

    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect(after.has('page-fuel')).toBe(true)
    expect(after.has('page-trucks')).toBe(true)
    for (const group of groupsForProfile({ role: 'CUSTOMER_REP' })) expect(after.has(group)).toBe(true)
    // `page-carriers` came from the old role, so it goes with it.
    expect(after.has('page-carriers')).toBe(false)
    expect(profileOf('sam@bcatcorp.com')?.extraPages).toEqual(['fuel', 'trucks'])
  })

  it('keeps every page a login with no profile row holds', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'page-fuel', 'page-dashboard'])
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    seedProfile(ADMIN_EMAIL, { role: 'ADMIN' })

    await call({ action: 'setRole', username: 'sam@bcatcorp.com', role: 'AR_AP' })

    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect(after.has('page-fuel')).toBe(true)
    expect(after.has('page-dashboard')).toBe(true)
    expect(profileOf('sam@bcatcorp.com')?.extraPages).toEqual(['fuel', 'dashboard'])
  })
})

// ── Admin is a role ──────────────────────────────────────────────────────────

describe('setAdmin', () => {
  it('writes ADMIN on the profile and reconciles the groups from it', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'role-CUSTOMER_REP', 'page-loads'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })

    await call({ action: 'setAdmin', username: 'sam@bcatcorp.com', isAdmin: true }, owner)

    expect(profileOf('sam@bcatcorp.com')).toMatchObject({ role: 'ADMIN', lastRoleChangeBy: OWNER_EMAIL })
    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect(after.has('ADMIN')).toBe(true)
    expect(after.has('role-CUSTOMER_REP')).toBe(false)
  })

  it('refuses to revoke the last admin and changes nothing', async () => {
    // The owner acts by e-mail and has no row, so Sam is the only admin the directory
    // knows about.
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'ADMIN'])
    seedProfile('sam@bcatcorp.com', { role: 'ADMIN' })

    await expect(
      call({ action: 'setAdmin', username: 'sam@bcatcorp.com', isAdmin: false }, owner),
    ).rejects.toThrow('sam@bcatcorp.com is the last admin — promote somebody else first.')

    expect(pool.membership.get('sam@bcatcorp.com')?.has('ADMIN')).toBe(true)
    expect(profileOf('sam@bcatcorp.com')?.role).toBe('ADMIN')
  })

  it('survives a later claims edit by an admin who is not the owner', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'role-CUSTOMER_REP'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })

    await call({ action: 'setAdmin', username: 'sam@bcatcorp.com', isAdmin: true }, owner)
    await call({
      action: 'setClaims',
      username: 'sam@bcatcorp.com',
      input: JSON.stringify({ claims: ['AR_POSTING'] }),
    }, admin)

    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect(after.has('ADMIN')).toBe(true)
    expect(after.has('claim-AR_POSTING')).toBe(true)
  })
})

// ── Pages, claims, sessions ──────────────────────────────────────────────────

describe('setPageGroups', () => {
  it('records extraPages and leaves role-*, claim-* and ADMIN alone', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'ADMIN', 'role-MANAGER', 'claim-AR_POSTING', 'page-stale'])
    seedProfile('sam@bcatcorp.com', { role: 'MANAGER', claims: ['AR_POSTING'] })

    await call({ action: 'setPageGroups', username: 'sam@bcatcorp.com', pages: JSON.stringify(['tasks']) })

    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect([...after]).toEqual(expect.arrayContaining(['ADMIN', 'role-MANAGER', 'claim-AR_POSTING', 'DISPATCHER']))
    expect(after.has('page-tasks')).toBe(true)
    expect(after.has('page-stale')).toBe(false)
    // Every page the role grants survives the grid.
    for (const group of groupsForProfile({ role: 'MANAGER' })) expect(after.has(group)).toBe(true)
    expect(profileOf('sam@bcatcorp.com')?.extraPages).toEqual(['tasks'])
  })
})

describe('setTeams', () => {
  it('writes the team keys and changes no group', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'role-CUSTOMER_REP'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })

    await call({
      action: 'setTeams',
      username: 'sam@bcatcorp.com',
      input: JSON.stringify({ teamKeys: ['east', 'reefer'] }),
    })

    expect(profileOf('sam@bcatcorp.com')?.teamKeys).toEqual(['east', 'reefer'])
    expect([...(pool.membership.get('sam@bcatcorp.com') ?? [])].sort()).toEqual(['DISPATCHER', 'role-CUSTOMER_REP'])
  })
})

describe('setClaims', () => {
  it('mints the claim-* groups', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'role-AR_AP'])
    seedProfile('sam@bcatcorp.com', { role: 'AR_AP' })

    const result = await call({
      action: 'setClaims',
      username: 'sam@bcatcorp.com',
      input: JSON.stringify({ claims: ['AR_POSTING', 'AP_POSTING'] }),
    })

    expect(result.added).toEqual(expect.arrayContaining(['claim-AP_POSTING', 'claim-AR_POSTING']))
    expect(pool.groups.has('claim-AR_POSTING')).toBe(true)
    const after = pool.membership.get('sam@bcatcorp.com') ?? new Set<string>()
    expect(after.has('claim-AR_POSTING')).toBe(true)
    expect(after.has('claim-AP_POSTING')).toBe(true)
    expect(after.has('role-AR_AP')).toBe(true)
    expect(profileOf('sam@bcatcorp.com')?.claims).toEqual(['AR_POSTING', 'AP_POSTING'])
  })

  it('refuses a claim that is not a claim', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    await expect(
      call({ action: 'setClaims', username: 'sam@bcatcorp.com', input: JSON.stringify({ claims: ['WHATEVER'] }) }),
    ).rejects.toThrow('claim must be one of:')
  })
})

describe('forceSignOut', () => {
  it('signs the user out of every session', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    const result = await call({ action: 'forceSignOut', username: 'sam@bcatcorp.com' })
    expect(result.success).toBe(true)
    expect(pool.calls).toContainEqual({
      type: 'AdminUserGlobalSignOut',
      input: { UserPoolId: 'us-east-1_TEST', Username: 'sam@bcatcorp.com' },
    })
  })
})

// ── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('joins the profile and the groups, and mints the owner profile when it is missing', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER', 'page-dashboard'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP', name: 'Sam Rep' })

    const raw = await handler({ arguments: { action: 'list' } as never, identity: owner as never })
    const users = JSON.parse(String(raw)) as { username: string; profile: Row | null; groups: string[] }[]

    const sam = users.find((u) => u.username === 'sam@bcatcorp.com')
    expect(sam?.profile).toMatchObject({ role: 'CUSTOMER_REP', name: 'Sam Rep' })
    expect(sam?.groups.sort()).toEqual(['DISPATCHER', 'page-dashboard'])

    const ownerRow = users.find((u) => u.username === OWNER_EMAIL)
    expect(ownerRow?.profile).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', email: OWNER_EMAIL })
    expect(profileOf(OWNER_EMAIL)).toMatchObject({ role: 'ADMIN' })
  })

  it('leaves an existing owner profile alone', async () => {
    seedProfile(OWNER_EMAIL, { role: 'ADMIN', name: 'Ryne', version: 7 })
    await call({ action: 'list' }, owner)
    expect(profileOf(OWNER_EMAIL)).toMatchObject({ name: 'Ryne', version: 7 })
  })
})

// ── The original actions ─────────────────────────────────────────────────────

describe('the original actions still work for the owner', () => {
  it('disables, enables and deletes, mirroring status onto the profile', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })

    await call({ action: 'disable', username: 'sam@bcatcorp.com' }, owner)
    expect(pool.users.get('sam@bcatcorp.com')?.enabled).toBe(false)
    expect(profileOf('sam@bcatcorp.com')?.status).toBe('INACTIVE')

    await call({ action: 'enable', username: 'sam@bcatcorp.com' }, owner)
    expect(pool.users.get('sam@bcatcorp.com')?.enabled).toBe(true)
    expect(profileOf('sam@bcatcorp.com')?.status).toBe('ACTIVE')

    await call({ action: 'delete', username: 'sam@bcatcorp.com' }, owner)
    expect(pool.users.has('sam@bcatcorp.com')).toBe(false)
    expect(profileOf('sam@bcatcorp.com')).toBeUndefined()
  })

  it('leaves no profile row behind when the pool delete fails', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })
    cognitoSend.mockImplementation((cmd: MockCommand) =>
      cmd.__type === 'AdminDeleteUser'
        ? Promise.reject(new Error('Rate exceeded'))
        : Promise.resolve(runCognito(cmd)),
    )

    await expect(call({ action: 'delete', username: 'sam@bcatcorp.com' }, owner)).rejects.toThrow('Rate exceeded')
    // The login is still there to retry the delete on; a row for a login `list` can no
    // longer show is what nobody could clean up.
    expect(pool.users.has('sam@bcatcorp.com')).toBe(true)
    expect(profileOf('sam@bcatcorp.com')).toBeUndefined()
  })

  it('never deletes the owner', async () => {
    await expect(call({ action: 'delete', username: OWNER_EMAIL }, owner)).rejects.toThrow(
      'The owner account cannot be deleted',
    )
    expect(pool.users.has(OWNER_EMAIL)).toBe(true)
  })

  it('reads and sets groups, resets a password and toggles admin', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    // Demoting Sam needs another admin on record, or the lockout check refuses it.
    seedProfile(OWNER_EMAIL, { role: 'ADMIN' })

    expect(await call({ action: 'getGroups', username: 'sam@bcatcorp.com' }, owner)).toEqual(['DISPATCHER'])

    await call({ action: 'resetPassword', username: 'sam@bcatcorp.com' }, owner)
    expect(pool.calls.some((c) => c.type === 'AdminResetUserPassword')).toBe(true)

    await call({ action: 'setAdmin', username: 'sam@bcatcorp.com', isAdmin: true }, owner)
    expect(pool.membership.get('sam@bcatcorp.com')?.has('ADMIN')).toBe(true)

    await call({ action: 'setAdmin', username: 'sam@bcatcorp.com', isAdmin: false }, owner)
    expect(pool.membership.get('sam@bcatcorp.com')?.has('ADMIN')).toBe(false)
  })
})

// ── Profile edits ────────────────────────────────────────────────────────────

describe('updateProfile and reinvite', () => {
  it('trims the fields and refuses a self-referencing manager', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })
    seedProfile('boss@bcatcorp.com', { role: 'MANAGER' })

    await call({
      action: 'updateProfile',
      username: 'sam@bcatcorp.com',
      input: JSON.stringify({ name: '  Sam Rep ', title: 'Rep', managerId: 'boss@bcatcorp.com' }),
    })
    expect(profileOf('sam@bcatcorp.com')).toMatchObject({ name: 'Sam Rep', title: 'Rep', managerId: 'boss@bcatcorp.com' })

    await expect(
      call({
        action: 'updateProfile',
        username: 'sam@bcatcorp.com',
        input: JSON.stringify({ managerId: 'sam@bcatcorp.com' }),
      }),
    ).rejects.toThrow('A manager must be another user.')
  })

  it('clears a field instead of storing a null', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'])
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP', phone: '555-0100' })

    await call({
      action: 'updateProfile',
      username: 'sam@bcatcorp.com',
      input: JSON.stringify({ phone: '' }),
    })
    expect(profileOf('sam@bcatcorp.com')).not.toHaveProperty('phone')
  })

  it('resends the invite and stamps who sent it', async () => {
    seedUser('sam@bcatcorp.com', ['DISPATCHER'], { status: 'FORCE_CHANGE_PASSWORD' })
    seedProfile('sam@bcatcorp.com', { role: 'CUSTOMER_REP' })

    await call({ action: 'reinvite', username: 'sam@bcatcorp.com' })

    expect(pool.calls.some((c) => c.type === 'AdminCreateUser' && c.input.MessageAction === 'RESEND')).toBe(true)
    expect(profileOf('sam@bcatcorp.com')).toMatchObject({ invitedBy: ADMIN_EMAIL })
  })
})
