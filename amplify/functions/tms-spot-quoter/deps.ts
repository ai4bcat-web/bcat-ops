/**
 * tms-spot-quoter — everything the pipeline, the poll loop and the actions reach out
 * for (read-only mailbox: no send, no draft, no door to tms-shipment-actions), as one injectable object. `createSpotDeps()` wires the real thing (DynamoDB, SSM,
 * S3, Gmail REST, Anthropic); tests build their
 * own from fakes. Nothing outside this file constructs an AWS client except store.ts.
 */
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  CrmContactRecord,
  GmailConnectionRecord,
} from '../../../src/types/tms'
import type { SenderMatch, UpsertContactInput, AddSystemActivityInput } from '../../../src/lib/crm/types'
import type { GmailPort } from '../../../src/lib/spot/port'
import { readPageCredentials } from '../_shared/integrationSecrets'
import {
  addSystemActivity,
  lookupSender,
  purgeEmailSubjects,
  upsertContact,
} from '../_shared/crmStore'
import { googlePort } from '../_shared/gmail/googlePort'
import {
  simInject,
  simPort,
  simPurgeTest,
  simReset,
  type SimInboxMessage,
} from '../_shared/gmail/simPort'
import {
  deleteRefreshToken,
  getRefreshToken,
  putRefreshToken,
  readOAuthClient,
  type OAuthClient,
  type StoredGmailToken,
} from '../_shared/gmail/tokens'
import { buildAuthUrl, exchangeCode, hasRequiredScopes, newState, parseIdToken, redirectUriAllowed, revokeToken } from '../_shared/gmail/oauth'
import { realModel, type SpotModel } from './model'
import { createDynamoStore, IS_DEV_STACK, type SpotStore } from './store'

export interface CrmPort {
  upsertContact(input: UpsertContactInput): Promise<CrmContactRecord>
  addSystemActivity(input: AddSystemActivityInput): Promise<void>
  lookupSender(address: string, authVerdict?: string | null): Promise<SenderMatch>
  /** Nulls the subject on a rep's e-mail activity rows; returns how many were changed. */
  purgeEmailSubjects(ownerId: string): Promise<number>
}

export interface OAuthPort {
  readClient(): Promise<OAuthClient | null>
  newState(): string
  buildAuthUrl(o: { clientId: string; redirectUri: string; state: string; loginHint: string; hd?: string }): string
  exchangeCode(o: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{
    refreshToken: string | null
    accessToken: string
    scope: string
    idToken: string | null
  }>
  parseIdToken(idToken: string): { email: string; emailVerified: boolean; hd: string | null }
  hasRequiredScopes(scope: string): boolean
  redirectUriAllowed(redirectUri: string, origins: string[]): boolean
  revoke(token: string): Promise<void>
  putToken(userId: string, rec: StoredGmailToken): Promise<void>
  getToken(userId: string): Promise<StoredGmailToken | null>
  deleteToken(userId: string): Promise<void>
}

export interface SimPorts {
  inject(userId: string, msg: SimInboxMessage): Promise<{ id: string }>
  reset(userId: string): Promise<{ deleted: number }>
  purgeTest(userId: string): Promise<{ deleted: number }>
}

export interface SpotDeps {
  store: SpotStore
  crm: CrmPort
  model: SpotModel
  oauth: OAuthPort
  sim: SimPorts
  portFor(conn: Pick<GmailConnectionRecord, 'id' | 'mode'>): GmailPort
  /** Registry-style provider modes: LIVE only when the credentials exist. */
  providerModes(): Promise<{ gmail: 'STUB' | 'LIVE'; dat: 'STUB' | 'LIVE' }>
  now(): Date
  /** Cognito username -> e-mail (an access token has no e-mail claim); '' when unknown. */
  resolveEmail?(username: string): Promise<string>
  /** Per model call; a slower answer is treated as an error (retried next run). */
  modelTimeoutMs?: number
  devStack: boolean
  portalOrigins: string[]
  /** This environment's own origin: the customer link is `${portalOrigin}/quote/<linkToken>`. */
  portalOrigin: string
  /** The org's own mail domains (never claimable, never a quote request). */
  ownDomains: string[]
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((o): o is string => typeof o === 'string')
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

let cognito: CognitoIdentityProviderClient | undefined

export function createSpotDeps(): SpotDeps {
  const store = createDynamoStore()
  const db = store.db as DynamoDBDocumentClient
  return {
    store,
    crm: {
      upsertContact: (input) => upsertContact(db, input),
      addSystemActivity: (input) => addSystemActivity(db, input),
      lookupSender: (address, verdict) => lookupSender(db, address, verdict),
      purgeEmailSubjects: (ownerId) => purgeEmailSubjects(db, ownerId),
    },
    model: realModel,
    oauth: {
      readClient: readOAuthClient,
      newState,
      buildAuthUrl,
      exchangeCode: (o) => exchangeCode(o),
      parseIdToken,
      hasRequiredScopes,
      redirectUriAllowed,
      revoke: (token) => revokeToken(token),
      putToken: putRefreshToken,
      getToken: getRefreshToken,
      deleteToken: deleteRefreshToken,
    },
    sim: {
      inject: (userId, msg) => simInject(userId, msg),
      reset: (userId) => simReset(userId),
      purgeTest: (userId) => simPurgeTest(userId),
    },
    portFor: (conn) => (conn.mode === 'SIMULATED' ? simPort(conn.id) : googlePort(conn.id)),
    async providerModes() {
      // A provider whose credentials cannot be read is not connected: STUB, never an error.
      const [client, dat] = await Promise.all([
        readOAuthClient().catch(() => null),
        readPageCredentials('DAT').catch(() => null),
      ])
      return { gmail: client ? 'LIVE' : 'STUB', dat: dat ? 'LIVE' : 'STUB' }
    },
    now: () => new Date(),
    async resolveEmail(username) {
      const me = await (cognito ??= new CognitoIdentityProviderClient({})).send(
        new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID ?? '', Username: username }),
      )
      return me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? ''
    },
    devStack: IS_DEV_STACK,
    portalOrigins: parseOrigins(process.env.PORTAL_ORIGINS),
    portalOrigin: process.env.PORTAL_ORIGIN ?? parseOrigins(process.env.PORTAL_ORIGINS).slice(-1)[0] ?? '',
    ownDomains: ['bcatcorp.com'],
  }
}
