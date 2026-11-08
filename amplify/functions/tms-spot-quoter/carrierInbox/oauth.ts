/**
 * Step AL §5.4 — connecting a carrier-sales mailbox. Reuses the AB OAuth helpers and the SSM
 * token store unchanged (`_shared/gmail/{oauth,tokens}.ts`); only the bookkeeping differs:
 *
 *  - one token per MAILBOX at `…/users/cs-<mailboxId>` (not per rep);
 *  - the OAuth `state` is `cs.<mailboxId>.<nonce>`; only its sha256 and an expiry are stored,
 *    in `carrierInboxState` (the row is readable by every signed-in user);
 *  - the signed-in Google account must be the mailbox's configured account (consumer Gmail,
 *    no `hd`), verified by Google, else NOTHING is written;
 *  - the consent URL asks for `gmail.readonly` only.
 */
import { createHash } from 'node:crypto'
import type { CarrierInboxMailbox } from '../../../../src/lib/carrierInbox/types'
import type { CarrierInboxDeps } from './deps'
import { csUserId } from './deps'
import { emptyMailboxState } from './store'

export const OAUTH_STATE_TTL_MS = 10 * 60_000
const STATE_PREFIX = 'cs.'
const MAILBOX_ID = /^[A-Za-z0-9_-]{1,20}$/

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export function mailboxIdFromState(state: string): string | null {
  const parts = state.split('.')
  return parts.length === 3 && parts[0] + '.' === STATE_PREFIX && MAILBOX_ID.test(parts[1]) && parts[2] ? parts[1] : null
}

export async function oauthStart(
  deps: CarrierInboxDeps,
  mailbox: CarrierInboxMailbox,
  redirectUri: string,
): Promise<{ url: string }> {
  if (mailbox.mode === 'SIMULATED') throw new Error('A simulated mailbox does not connect to Google.')
  const client = await deps.oauth.readClient().catch(() => null)
  if (!client) {
    throw new Error('NOT_CONFIGURED: enter the Google client under Settings → Integrations → Google.')
  }
  if (!deps.oauth.redirectUriAllowed(redirectUri, deps.portalOrigins)) throw new Error('That redirect address is not allowed.')
  const state = `${STATE_PREFIX}${mailbox.id}.${deps.oauth.newState()}`
  const mstate = (await deps.store.getState()).mailboxes[mailbox.id]
  await deps.store.patchMailboxState(mailbox.id, {
    pendingStateHash: sha256(state),
    pendingStateExp: new Date(deps.now().getTime() + OAUTH_STATE_TTL_MS).toISOString(),
    // A connected or reconnecting mailbox keeps its status (and keeps polling) until the new grant lands.
    ...(!mstate || mstate.status === 'NOT_CONNECTED' ? { status: 'PENDING' as const } : {}),
  })
  // Consumer Gmail: a login hint for the configured account, never `hd`.
  return { url: deps.oauth.buildAuthUrl({ clientId: client.clientId, redirectUri, state, loginHint: mailbox.account }) }
}

export async function oauthFinish(
  deps: CarrierInboxDeps,
  mailbox: CarrierInboxMailbox,
  input: { code: string; state: string; redirectUri: string },
  actorEmail: string,
): Promise<{ mailboxId: string }> {
  if (!deps.oauth.redirectUriAllowed(input.redirectUri, deps.portalOrigins)) throw new Error('That redirect address is not allowed.')
  const mstate = (await deps.store.getState()).mailboxes[mailbox.id]
  const expired = !mstate?.pendingStateExp || new Date(mstate.pendingStateExp).getTime() < deps.now().getTime()
  if (!mstate || !mstate.pendingStateHash || mstate.pendingStateHash !== sha256(input.state) || expired) {
    throw new Error('This sign-in link is not valid or has expired. Start again.')
  }
  // Single use: the state is spent whether or not the rest succeeds.
  await deps.store.patchMailboxState(mailbox.id, { pendingStateHash: null, pendingStateExp: null })

  const client = await deps.oauth.readClient()
  if (!client) throw new Error('NOT_CONFIGURED: the Google client is not set up yet.')
  const exchange = await deps.oauth.exchangeCode({
    clientId: client.clientId, clientSecret: client.clientSecret, code: input.code, redirectUri: input.redirectUri,
  })
  if (!exchange.refreshToken || !deps.oauth.hasRequiredScopes(exchange.scope)) {
    throw new Error('Google did not grant read-only Gmail access or a refresh token; connect again and tick the Gmail box.')
  }
  if (!exchange.idToken) throw new Error('Google returned no identity for this sign-in.')
  const identity = deps.oauth.parseIdToken(exchange.idToken)
  if (!identity.emailVerified) throw new Error("Google has not verified this account's e-mail address.")
  if (identity.email !== mailbox.account.toLowerCase()) {
    throw new Error(`Sign in with the mailbox's own Google account (${mailbox.account}).`)
  }

  const at = deps.now().toISOString()
  await deps.oauth.putToken(csUserId(mailbox.id), {
    refreshToken: exchange.refreshToken,
    scope: exchange.scope,
    googleEmail: identity.email,
    obtainedAt: at,
  })
  await deps.store.patchMailboxState(mailbox.id, {
    status: 'CONNECTED',
    googleEmail: identity.email,
    scopes: exchange.scope.split(/\s+/).filter(Boolean),
    connectedAt: at,
    // First poll after (re)connect reads the look-back window.
    historyId: null,
    lastPollOk: null,
    lastError: null,
    held: 0,
  })
  await deps.writeAudit('CARRIER_INBOX', mailbox.id, 'CS_CONNECTED', actorEmail, { mailboxId: mailbox.id })
  return { mailboxId: mailbox.id }
}

/** Revoke (best effort), delete the token, reset the mailbox's state. Never throws on a missing token. */
export async function disconnectMailbox(deps: CarrierInboxDeps, mailboxId: string, actorEmail: string): Promise<void> {
  const userId = csUserId(mailboxId)
  const token = await deps.oauth.getToken(userId).catch(() => null)
  if (token) await deps.oauth.revoke(token.refreshToken).catch(() => undefined)
  await deps.oauth.deleteToken(userId).catch(() => undefined)
  await deps.store.patchMailboxState(mailboxId, emptyMailboxState())
  await deps.writeAudit('CARRIER_INBOX', mailboxId, 'CS_DISCONNECTED', actorEmail, { mailboxId })
}
