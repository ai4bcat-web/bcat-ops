/**
 * tms-spot-quoter — everything the pipeline, the poll loop and the actions reach out
 * for, as one injectable object. `createSpotDeps()` wires the real thing (DynamoDB, SSM,
 * S3, Gmail REST, Anthropic, a Lambda invoke of tms-shipment-actions); tests build their
 * own from fakes. Nothing outside this file constructs an AWS client except store.ts.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  CrmContactRecord,
  GmailConnectionRecord,
} from '../../../src/types/tms'
import type { SenderMatch, UpsertContactInput, AddSystemActivityInput } from '../../../src/lib/crm/types'
import type { SpotAutoQuoteEvent, SpotAutoQuoteResult } from '../../../src/lib/spot/types'
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
  simMarkDraftSent,
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
  markSent(userId: string, draftId: string): Promise<{ messageId: string }>
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
  /** The SPOT_AUTO_QUOTE door: a direct Lambda invoke of tms-shipment-actions. */
  door(event: SpotAutoQuoteEvent): Promise<SpotAutoQuoteResult>
  /** Registry-style provider modes: LIVE only when the credentials exist. */
  providerModes(): Promise<{ gmail: 'STUB' | 'LIVE'; dat: 'STUB' | 'LIVE' }>
  now(): Date
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

export function createSpotDeps(): SpotDeps {
  const store = createDynamoStore()
  const db = store.db as DynamoDBDocumentClient
  const lambda = new LambdaClient({})
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
      markSent: (userId, draftId) => simMarkDraftSent(userId, draftId),
      reset: (userId) => simReset(userId),
      purgeTest: (userId) => simPurgeTest(userId),
    },
    portFor: (conn) => (conn.mode === 'SIMULATED' ? simPort(conn.id) : googlePort(conn.id)),
    async door(event) {
      const name = process.env.TMS_SHIPMENT_ACTIONS_FUNCTION_NAME
      if (!name) throw new Error('TMS_SHIPMENT_ACTIONS_FUNCTION_NAME is not configured')
      const out = await lambda.send(new InvokeCommand({
        FunctionName: name,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(event)),
      }))
      if (out.FunctionError) throw new Error('The quote door failed')
      const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : ''
      return JSON.parse(text) as SpotAutoQuoteResult
    },
    async providerModes() {
      // A provider whose credentials cannot be read is not connected: STUB, never an error.
      const [client, dat] = await Promise.all([
        readOAuthClient().catch(() => null),
        readPageCredentials('DAT').catch(() => null),
      ])
      return { gmail: client ? 'LIVE' : 'STUB', dat: dat ? 'LIVE' : 'STUB' }
    },
    now: () => new Date(),
    devStack: IS_DEV_STACK,
    portalOrigins: parseOrigins(process.env.PORTAL_ORIGINS),
    portalOrigin: process.env.PORTAL_ORIGIN ?? parseOrigins(process.env.PORTAL_ORIGINS).slice(-1)[0] ?? '',
    ownDomains: ['bcatcorp.com'],
  }
}
