/**
 * Dev-stack identity + API helpers shared by the dev verification scripts.
 * Dev only: every constant points at the dev Cognito pool / AppSync / public Lambda URL.
 * Passwords are generated here and never printed.
 */
import { randomBytes } from 'node:crypto'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  CreateGroupCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'

export const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
export const DEV_POOL = 'us-east-1_UKhMNVAG1'
export const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
export const PUBLIC_API = 'https://jk65s5nfkj2sfnnoang4huvbvq0bsruo.lambda-url.us-east-1.on.aws'
export const region = 'us-east-1'

export const outputs = {
  auth: {
    user_pool_id: DEV_POOL,
    user_pool_client_id: DEV_CLIENT,
    aws_region: region,
    username_attributes: ['email'],
  },
  data: { url: DEV_API, aws_region: region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

export const cognito = new CognitoIdentityProviderClient({ region })

export async function gql(token, query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}

export const routerAs = (token, field) => async (action, input) => {
  const data = await gql(
    token,
    `mutation($action:String!,$input:AWSJSON!){ ${field}(action:$action,input:$input) }`,
    { action, input: JSON.stringify(input ?? {}) },
  )
  const raw = data[field]
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

/** A throwaway dev login. The password is generated here and never printed. */
export async function mintIdentity(email, groups) {
  const password = `Aa1!${randomBytes(18).toString('base64url')}`
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: DEV_POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }))
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: DEV_POOL, Username: email, Password: password, Permanent: true }))
  for (const group of groups) {
    // The userManagement Lambda mints `page-*` groups lazily on first grant, so a pool only
    // holds the ones somebody has granted. Mirror that: create the group if it is missing.
    try { await cognito.send(new CreateGroupCommand({ UserPoolId: DEV_POOL, GroupName: group })) } catch (e) { if (e?.name !== 'GroupExistsException') throw e }
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: DEV_POOL, Username: email, GroupName: group }))
  }
  const { Amplify } = await import('aws-amplify')
  const { signIn, fetchAuthSession } = await import('aws-amplify/auth')
  const { defaultStorage } = await import('aws-amplify/utils')
  Amplify.configure(outputs)
  // NOT signOut(): it revokes the previous identity's refresh token server-side, which kills the
  // tokens a caller already holds for an identity minted earlier in the same run. Drop the local
  // session only.
  await defaultStorage.clear()
  await signIn({ username: email, password })
  const session = await fetchAuthSession({ forceRefresh: true })
  const username = session.tokens.idToken.payload['cognito:username']
  const prefix = `CognitoIdentityServiceProvider.${DEV_CLIENT}`
  const refreshToken = await defaultStorage.getItem(`${prefix}.${username}.refreshToken`)
  if (!refreshToken) throw new Error('Temporary dev login did not yield a refresh token')
  const storage = {
    [`${prefix}.${username}.refreshToken`]: refreshToken,
    [`${prefix}.LastAuthUser`]: username,
    [`${prefix}.${username}.idToken`]: session.tokens.idToken.toString(),
    [`${prefix}.${username}.accessToken`]: session.tokens.accessToken.toString(),
    [`${prefix}.${username}.clockDrift`]: '0',
  }
  return { token: session.tokens.idToken.toString(), password, storage }
}

/**
 * Delete a throwaway identity and re-read it to prove it is gone.
 * Returns true when the user no longer exists; never throws.
 */
export async function deleteIdentity(email) {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: email })).catch(() => {})
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: DEV_POOL, Username: email }))
    return false
  } catch (err) {
    return err?.name === 'UserNotFoundException'
  }
}
