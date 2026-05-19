import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  CreateGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'

const cognito = new CognitoIdentityProviderClient({})
// Fall back to the production pool ID if the env var isn't set (e.g. deployment gap)
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

// All controllable page groups (must match frontend PAGE_OPTIONS keys)
const PAGE_GROUPS = [
  'page-dashboard', 'page-calendar', 'page-loads', 'page-drivers',
  'page-trucks', 'page-expenses', 'page-schedule', 'page-audit',
]

interface Args {
  action: 'list' | 'create' | 'disable' | 'enable' | 'getGroups' | 'setPageGroups' | 'resetPassword'
  email?: string
  username?: string
  pages?: string // JSON string: string[]
}

// AppSync Cognito User Pools identity shape
interface AppSyncIdentity {
  sub: string
  username: string
  claims: { email?: string; [key: string]: unknown }
}

// Ensure a Cognito group exists (no-op if already exists)
async function ensureGroup(name: string) {
  try {
    await cognito.send(new CreateGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: name }))
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'GroupExistsException') throw e
  }
}

export const handler = async (event: { arguments: Args; identity?: AppSyncIdentity | null }) => {
  // All callers are Cognito-authenticated users (AppSync enforces auth before
  // invoking this Lambda). Client-side ADMIN group check gates the UI.
  console.log('[userManagement] identity:', JSON.stringify(event.identity))
  console.log('[userManagement] USER_POOL_ID:', USER_POOL_ID)
  console.log('[userManagement] action:', event.arguments.action)

  const { action, email, username, pages } = event.arguments

  switch (action) {
    case 'list': {
      const result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID }))
      const users = (result.Users ?? []).map((u) => ({
        username: u.Username,
        email: u.Attributes?.find((a) => a.Name === 'email')?.Value,
        status: u.UserStatus,
        enabled: u.Enabled,
        createdAt: u.UserCreateDate?.toISOString(),
      }))
      return JSON.stringify(users)
    }
    case 'create': {
      if (!email) throw new Error('email is required')
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }))
      return JSON.stringify({ success: true })
    }
    case 'disable': {
      if (!username) throw new Error('username is required')
      await cognito.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }))
      return JSON.stringify({ success: true })
    }
    case 'enable': {
      if (!username) throw new Error('username is required')
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }))
      return JSON.stringify({ success: true })
    }
    case 'getGroups': {
      if (!username) throw new Error('username is required')
      const result = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }))
      const groups = (result.Groups ?? []).map((g) => g.GroupName ?? '')
      return JSON.stringify(groups)
    }
    case 'setPageGroups': {
      if (!username) throw new Error('username is required')
      const desired: string[] = pages ? JSON.parse(pages) : []
      // Ensure all page groups exist first
      await Promise.all(PAGE_GROUPS.map(ensureGroup))
      // Get current groups
      const current = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }))
      const currentPageGroups = (current.Groups ?? [])
        .map((g) => g.GroupName ?? '')
        .filter((g) => PAGE_GROUPS.includes(g))
      // Add missing
      const toAdd = desired.filter((g) => !currentPageGroups.includes(g))
      // Remove unwanted
      const toRemove = currentPageGroups.filter((g) => !desired.includes(g))
      await Promise.all([
        ...toAdd.map((g) => cognito.send(new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID, Username: username, GroupName: g,
        }))),
        ...toRemove.map((g) => cognito.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID, Username: username, GroupName: g,
        }))),
      ])
      return JSON.stringify({ success: true })
    }
    case 'resetPassword': {
      if (!username) throw new Error('username is required')
      await cognito.send(new AdminResetUserPasswordCommand({ UserPoolId: USER_POOL_ID, Username: username }))
      return JSON.stringify({ success: true })
    }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
