/**
 * Step AB §2.3 — the Google OAuth web-server flow, as pure helpers over `fetch`.
 * The browser only navigates to `buildAuthUrl`'s result; the code is exchanged here with
 * the client secret, which never leaves the Lambda.
 */
import { randomBytes } from 'node:crypto'
import { GmailApiError } from './errors'

type FetchLike = typeof fetch

export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const

const REQUIRED_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]

/** 32 random bytes, hex. */
export function newState(): string {
  return randomBytes(32).toString('hex')
}

export function buildAuthUrl(o: {
  clientId: string
  redirectUri: string
  state: string
  loginHint: string
  hd?: string | null
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    login_hint: o.loginHint,
    state: o.state,
  })
  if (o.hd) q.set('hd', o.hd)
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`
}

/** `<allowed origin>/tms/rates/spot/callback`, exactly — nothing else may be sent to Google. */
export function redirectUriAllowed(redirectUri: string, origins: string[]): boolean {
  let u: URL
  try {
    u = new URL(redirectUri)
  } catch {
    return false
  }
  if (u.pathname !== '/tms/rates/spot/callback' || u.search || u.hash) return false
  return origins.some((o) => o.replace(/\/+$/, '') === u.origin)
}

export interface CodeExchange {
  refreshToken: string | null
  accessToken: string
  scope: string
  idToken: string | null
}

export async function exchangeCode(
  o: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<CodeExchange> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
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
    // The OAuth error code only — never the body, which can echo request values.
    const code = typeof json.error === 'string' ? json.error : 'unknown'
    throw new GmailApiError(res.status, `Google refused the sign-in (${code}). Try connecting again.`)
  }
  return {
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    accessToken: String(json.access_token ?? ''),
    scope: String(json.scope ?? ''),
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
  }
}

/** Both Gmail scopes must have been ticked on the consent screen. */
export function hasRequiredScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  return REQUIRED_GMAIL_SCOPES.every((s) => granted.has(s))
}

/**
 * The claims of an id token received directly from Google's token endpoint over TLS.
 * The signature is not re-verified: the token came from the code exchange we just made
 * with our own client secret, not from the browser.
 */
export function parseIdToken(idToken: string): { email: string; emailVerified: boolean; hd: string | null } {
  const part = idToken.split('.')[1]
  if (!part) throw new Error('Google returned no identity for this sign-in.')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Google returned no identity for this sign-in.')
  }
  return {
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : '',
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    hd: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : null,
  }
}

/** Best effort: a failure here must not stop a disconnect. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })
  } catch {
    // swallowed on purpose
  }
}
