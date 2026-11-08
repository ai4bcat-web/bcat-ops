/**
 * Owner / ADMIN gate for the data-safety actions, the same rule tms-aljex-import
 * applies. The UI gate is cosmetic; this is the one that counts.
 */
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'

export interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

export interface DataSafetyCaller {
  email: string
  sub: string
  groups: string[]
}

export interface EmailLookup {
  (username: string): Promise<string>
}

const cognito = new CognitoIdentityProviderClient({})

const cognitoEmailLookup: EmailLookup = async (username) => {
  try {
    const me = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9', Username: username }),
    )
    return me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? ''
  } catch (err) {
    console.warn('[tms-data-safety] could not resolve caller email:', String(err))
    return ''
  }
}

function groupsOf(identity: AppSyncIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export async function authorize(
  identity: AppSyncIdentity | null | undefined,
  lookup: EmailLookup = cognitoEmailLookup,
): Promise<DataSafetyCaller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  let email = (candidates.find((v): v is string => typeof v === 'string' && v.includes('@')) ?? '').toLowerCase().trim()
  if (!email) {
    const who = identity.username ?? identity.sub
    if (who) email = (await lookup(String(who))).toLowerCase().trim()
  }
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = groupsOf(identity)
  if (email !== OWNER_EMAIL && !groups.includes(ADMIN_GROUP)) {
    throw new Error('Forbidden: data export requires owner or ADMIN')
  }
  return { email, sub: identity.sub, groups }
}
