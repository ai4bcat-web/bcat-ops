import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  CreateGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'

const cognito = new CognitoIdentityProviderClient({})
const USER_POOL_ID = process.env.USER_POOL_ID!

// All controllable page groups (must match frontend PAGE_GROUPS keys)
const PAGE_GROUPS = ['page-calendar', 'page-grid', 'page-drivers', 'page-schedule', 'page-audit']

interface Args {
  action: 'list' | 'create' | 'disable' | 'enable' | 'getGroups' | 'setPageGroups'
  email?: string
  username?: string
  pages?: string // JSON string: string[]
}

// Ensure a Cognito group exists (no-op if already exists)
async function ensureGroup(name: string) {
  try {
    await cognito.send(new CreateGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: name }))
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'GroupExistsException') throw e
  }
}

export const handler = async (event: { arguments: Args }) => {
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
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
