/**
 * Step AB §2.2 — where a rep's refresh token lives, and how an access token is minted.
 *
 * Refresh token: SSM SecureString `/bcat/gmail/<poolId>/users/<userId>` (env
 * GMAIL_TOKEN_PARAM_PATH = `/bcat/gmail/<poolId>/users`). Access tokens stay in module
 * memory, ≤ 50 minutes. The OAuth client id/secret are the Integrations page's
 * GMAIL_REP_OAUTH parameter, read here with a parameter-exact grant.
 */
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm'
import { GmailApiError, NeedsReconnect } from './errors'

const ssm = new SSMClient({})

export interface StoredGmailToken {
  refreshToken: string
  scope: string
  googleEmail: string
  obtainedAt: string
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
  /** The Workspace domain lives in the Integration row's settings; the caller supplies it. */
  allowedDomain: string
}

const ACCESS_TTL_MS = 50 * 60_000
const CLIENT_CACHE_MS = 60_000

const accessCache = new Map<string, { token: string; expiresAt: number }>()
let clientCache: { value: OAuthClient | null; expiresAt: number } | null = null

export function resetTokenCache(): void {
  accessCache.clear()
  clientCache = null
}

export function tokenParamName(userId: string): string {
  const base = (process.env.GMAIL_TOKEN_PARAM_PATH ?? '').replace(/\/+$/, '')
  // The user id is a Cognito username; keep the parameter name path-safe.
  return `${base}/${userId.replace(/[^A-Za-z0-9_.@-]/g, '_')}`
}

function notFound(err: unknown): boolean {
  return err instanceof Error && err.name === 'ParameterNotFound'
}

export async function putRefreshToken(userId: string, rec: StoredGmailToken): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: tokenParamName(userId),
      Value: JSON.stringify(rec),
      Type: 'SecureString',
      Overwrite: true,
    }),
  )
  accessCache.delete(userId)
}

export async function getRefreshToken(userId: string): Promise<StoredGmailToken | null> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: tokenParamName(userId), WithDecryption: true }))
    const parsed = JSON.parse(r.Parameter?.Value ?? '') as Partial<StoredGmailToken>
    if (!parsed.refreshToken) return null
    return {
      refreshToken: parsed.refreshToken,
      scope: parsed.scope ?? '',
      googleEmail: parsed.googleEmail ?? '',
      obtainedAt: parsed.obtainedAt ?? '',
    }
  } catch (err) {
    if (notFound(err)) return null
    throw err
  }
}

export async function deleteRefreshToken(userId: string): Promise<void> {
  accessCache.delete(userId)
  try {
    await ssm.send(new DeleteParameterCommand({ Name: tokenParamName(userId) }))
  } catch (err) {
    if (!notFound(err)) throw err
  }
}

/** The OAuth client from the Integrations page, or null while it is not connected (STUB). */
export async function readOAuthClient(): Promise<OAuthClient | null> {
  if (clientCache && clientCache.expiresAt > Date.now()) return clientCache.value
  const name = `${(process.env.INTEGRATION_PARAM_PATH ?? '').replace(/\/+$/, '')}/GMAIL_REP_OAUTH`
  let value: OAuthClient | null = null
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    const parsed = JSON.parse(r.Parameter?.Value ?? '') as Record<string, unknown>
    const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
    const clientSecret = typeof parsed.clientSecret === 'string' ? parsed.clientSecret.trim() : ''
    if (clientId && clientSecret && clientId !== 'disabled-on-dev' && clientSecret !== 'disabled-on-dev') {
      value = { clientId, clientSecret, allowedDomain: '' }
    }
  } catch (err) {
    if (!notFound(err)) throw err
  }
  clientCache = { value, expiresAt: Date.now() + CLIENT_CACHE_MS }
  return value
}

/** A bearer token for this rep. `invalid_grant` ⇒ NeedsReconnect; no retry storm. */
export async function getAccessToken(
  userId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const hit = accessCache.get(userId)
  if (hit && hit.expiresAt > now()) return hit.token

  const [client, stored] = await Promise.all([readOAuthClient(), getRefreshToken(userId)])
  if (!client) throw new GmailApiError(0, 'Gmail sign-in is not configured (the OAuth client is not entered).')
  if (!stored) throw new NeedsReconnect('No Gmail connection is stored for this user.')

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).toString(),
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = {}
  }
  if (!res.ok) {
    if (json.error === 'invalid_grant') {
      accessCache.delete(userId)
      throw new NeedsReconnect()
    }
    throw new GmailApiError(res.status, `Google would not refresh the Gmail token (HTTP ${res.status}).`)
  }
  const token = String(json.access_token ?? '')
  if (!token) throw new GmailApiError(res.status, 'Google returned no access token.')
  accessCache.set(userId, { token, expiresAt: now() + ACCESS_TTL_MS })
  return token
}

/** Drop a cached access token (after a 401) so the next call refreshes. */
export function forgetAccessToken(userId: string): void {
  accessCache.delete(userId)
}
