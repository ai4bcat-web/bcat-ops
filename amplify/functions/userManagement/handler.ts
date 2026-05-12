import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'

const cognito = new CognitoIdentityProviderClient({})
const USER_POOL_ID = process.env.USER_POOL_ID!

interface Args {
  action: 'list' | 'create' | 'disable' | 'enable'
  email?: string
  username?: string
}

export const handler = async (event: { arguments: Args }) => {
  const { action, email, username } = event.arguments

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
      await cognito.send(new AdminDisableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }))
      return JSON.stringify({ success: true })
    }
    case 'enable': {
      if (!username) throw new Error('username is required')
      await cognito.send(new AdminEnableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }))
      return JSON.stringify({ success: true })
    }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
