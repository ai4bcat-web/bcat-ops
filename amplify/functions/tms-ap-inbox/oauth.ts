/**
 * Step AG §5.5 — connecting the read-only mailbox. Reuses the shared Google OAuth helpers and token
 * store through `deps.oauth`; the refresh token is written to `ap-inbox` only after every check
 * passed (verified e-mail == the configured mailbox, `gmail.readonly` granted, refresh token present).
 * The callback state carries the `ap.` prefix so the one registered redirect URI can route here.
 * The OAuth client secret and `pendingState` never leave the Lambda.
 */
import { AP_INBOX_USER_ID } from '../../../src/lib/apInbox/constants'
import type { ApInboxConnection } from '../../../src/lib/apInbox/types'
import type { ApCaller } from './authorize'
import type { ApInboxDeps } from './contract'
import { patchConfig } from './settings'

export const AP_STATE_PREFIX = 'ap.'
const PENDING_MS = 10 * 60_000
const HOUR = 3_600_000

export function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  const t = v.trim()
  if (!t) throw new Error(`${name} is required`)
  if (t.length > max) throw new Error(`${name} is too long`)
  return t
}

function withoutPending(c: ApInboxConnection): ApInboxConnection {
  const { pendingState: _s, pendingStateExp: _e, ...rest } = c
  return rest
}

export async function oauthStart(deps: ApInboxDeps, _caller: ApCaller, input: Record<string, unknown>): Promise<{ url: string }> {
  const redirectUri = str(input.redirectUri, 'redirectUri', 500)
  const client = await deps.oauth.readClient().catch(() => null)
  if (!client) throw new Error('NOT_CONFIGURED: Gmail sign-in is not set up yet. An admin enters the Google client under Settings → Integrations → Google.')
  if (!deps.oauth.redirectUriAllowed(redirectUri, deps.portalOrigins ?? [])) throw new Error('That redirect address is not allowed.')
  const cfg = await deps.store.getConfig()
  const state = `${AP_STATE_PREFIX}${deps.oauth.newState()}`
  const conn = (await deps.store.getState()).connection
  await deps.store.patchState({
    connection: {
      ...conn,
      status: conn.status === 'NOT_CONNECTED' ? 'PENDING' : conn.status,
      pendingState: state,
      pendingStateExp: new Date(deps.now().getTime() + PENDING_MS).toISOString(),
    },
  })
  return { url: deps.oauth.buildAuthUrl({ clientId: client.clientId, redirectUri, state, loginHint: cfg.mailbox }) }
}

export async function oauthFinish(deps: ApInboxDeps, caller: ApCaller, input: Record<string, unknown>): Promise<{ connected: true }> {
  const code = str(input.code, 'code', 2000)
  const state = str(input.state, 'state', 200)
  const redirectUri = str(input.redirectUri, 'redirectUri', 500)
  if (!deps.oauth.redirectUriAllowed(redirectUri, deps.portalOrigins ?? [])) throw new Error('That redirect address is not allowed.')
  const st = await deps.store.getState()
  const conn = st.connection
  const bad = 'This sign-in link is not valid any more. Start the connection again.'
  if (!state.startsWith(AP_STATE_PREFIX) || !conn.pendingState || conn.pendingState !== state) throw new Error(bad)
  const expired = !conn.pendingStateExp || new Date(conn.pendingStateExp).getTime() < deps.now().getTime()

  // Single use: the state is spent before anything is exchanged, whatever happens next.
  const settled: ApInboxConnection = withoutPending(conn)
  const revertStatus = conn.status === 'PENDING' ? 'NOT_CONNECTED' : conn.status
  await deps.store.patchState({ connection: { ...settled, status: revertStatus } })
  if (expired) throw new Error(bad)

  const client = await deps.oauth.readClient()
  if (!client) throw new Error('NOT_CONFIGURED: Gmail sign-in is not set up yet.')
  const exchange = await deps.oauth.exchangeCode({ clientId: client.clientId, clientSecret: client.clientSecret, code, redirectUri })
  if (!exchange.refreshToken || !deps.oauth.hasRequiredScopes(exchange.scope)) {
    throw new Error('Google did not grant read-only Gmail access or a refresh token; connect again and tick the Gmail box.')
  }
  if (!exchange.idToken) throw new Error('Google returned no identity for this sign-in.')
  const identity = deps.oauth.parseIdToken(exchange.idToken)
  const cfg = await deps.store.getConfig()
  if (!identity.emailVerified) throw new Error('Google has not verified this account\'s e-mail address.')
  if (identity.email.toLowerCase() !== cfg.mailbox) throw new Error(`Sign in with ${cfg.mailbox}; Google returned a different account.`)

  const now = deps.now()
  const at = now.toISOString()
  await deps.oauth.putToken(AP_INBOX_USER_ID, { refreshToken: exchange.refreshToken, scope: exchange.scope, googleEmail: identity.email.toLowerCase(), obtainedAt: at })
  const keepCursor = conn.status === 'NEEDS_RECONNECT' && st.cursor != null
  await deps.store.patchState({
    connection: { status: 'CONNECTED', googleEmail: identity.email.toLowerCase(), connectedAt: at, scopes: exchange.scope.split(/\s+/).filter(Boolean), lastError: null },
    cursor: keepCursor ? st.cursor : { afterMs: now.getTime() - cfg.lookbackHours * HOUR, boundaryIds: [] },
    retry: [],
  })
  if (cfg.mode !== 'GOOGLE') await patchConfig(deps, { mode: 'GOOGLE' })
  await deps.store.writeAudit({ entityType: 'ApInboxItem', entityId: 'connection', action: 'AP_INBOX_CONNECTED', actor: caller.email, changes: { mailbox: identity.email.toLowerCase() } })
  return { connected: true }
}

export async function oauthDisconnect(deps: ApInboxDeps, caller: ApCaller): Promise<Record<string, never>> {
  const st = await deps.store.getState()
  if (st.connection.status !== 'SIMULATED') {
    const token = await deps.oauth.getToken(AP_INBOX_USER_ID).catch(() => null)
    if (token) await deps.oauth.revoke(token.refreshToken).catch(() => undefined)
    await deps.oauth.deleteToken(AP_INBOX_USER_ID)
  }
  await deps.store.patchState({
    connection: { status: 'NOT_CONNECTED', googleEmail: null, connectedAt: null, scopes: [], lastError: null },
    cursor: null,
    retry: [],
  })
  await patchConfig(deps, { enabled: false })
  await deps.store.writeAudit({ entityType: 'ApInboxItem', entityId: 'connection', action: 'AP_INBOX_DISCONNECTED', actor: caller.email, changes: { was: st.connection.status } })
  return {}
}

/** Dev only (authorize enforces): the S3-backed simulated mailbox, enabled, cursor `lookbackHours` back. */
export async function connectSimulated(deps: ApInboxDeps, caller: ApCaller, input: Record<string, unknown>): Promise<Record<string, never>> {
  if (!deps.devStack) throw new Error('AP_INBOX_CONNECT_SIMULATED is only available on the dev stack')
  const hours = typeof input.lookbackHours === 'number' && Number.isFinite(input.lookbackHours) ? Math.min(168, Math.max(1, Math.round(input.lookbackHours))) : 72
  const now = deps.now()
  await deps.store.patchState({
    connection: { status: 'SIMULATED', googleEmail: null, connectedAt: now.toISOString(), scopes: [], lastError: null },
    cursor: { afterMs: now.getTime() - hours * HOUR, boundaryIds: [] },
    retry: [],
  })
  await patchConfig(deps, { mode: 'SIMULATED', enabled: true })
  await deps.store.writeAudit({ entityType: 'ApInboxItem', entityId: 'connection', action: 'AP_INBOX_CONNECTED', actor: caller.email, changes: { mode: 'SIMULATED' } })
  return {}
}
