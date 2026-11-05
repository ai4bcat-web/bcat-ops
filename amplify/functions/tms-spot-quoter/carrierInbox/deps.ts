/**
 * Step AL — everything the carrier inbox reaches for, as one injectable object (the spot
 * `SpotDeps` shape). `createCarrierInboxDeps(spot)` wires the real thing on top of the
 * already-constructed spot deps (one DynamoDB client, the same SSM/S3/Gmail adapters);
 * tests build their own from `testkit.ts`.
 *
 * READ-ONLY MAILBOX: `portFor` returns a `GmailPort`, which has no send, draft or modify
 * method, and nothing in this directory imports one.
 */
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { AiAgentsSettings } from '../../../../src/types/tms'
import type { GmailPort } from '../../../../src/lib/spot/port'
import type { CarrierInboxMailbox } from '../../../../src/lib/carrierInbox/types'
import { simDevExtraction } from '../../_shared/gmail/simPort'
import type { OAuthPort, SimPorts, SpotDeps } from '../deps'
import { loadAiAgents, loadBlacklist } from '../pipeline'
import { createLambdaFiles, type CarrierInboxFiles } from './files'
import { realCarrierModel, type CarrierInboxModel } from './model'
import { createCarrierInboxStore, type CarrierInboxStore } from './store'

/** The sim inbox of a carrier-sales mailbox is `spot-sim/cs-<mailboxId>/…`, its token `…/users/cs-<mailboxId>`. */
export const csUserId = (mailboxId: string): string => `cs-${mailboxId}`

export interface CarrierInboxDeps {
  store: CarrierInboxStore
  model: CarrierInboxModel
  files: CarrierInboxFiles
  oauth: OAuthPort
  sim: SimPorts
  /** Dev stack only: the classification a harness stored beside a simulated message. */
  simDevExtraction(mailboxId: string, messageId: string): Promise<unknown | null>
  portFor(mailbox: Pick<CarrierInboxMailbox, 'id' | 'mode'>): GmailPort
  loadAiAgents(): Promise<AiAgentsSettings | null>
  loadBlacklist(): Promise<{ addresses: string[]; keywords: string[] }>
  providerModes(): Promise<{ gmail: 'STUB' | 'LIVE' }>
  writeAudit(entityType: string, entityId: string, action: string, actorEmail: string, changes: Record<string, unknown>): Promise<void>
  now(): Date
  /** Per model call; a slower answer is an error (the message is retried next run). */
  modelTimeoutMs?: number
  devStack: boolean
  portalOrigins: string[]
  /** Cognito username -> e-mail, for access tokens (no e-mail claim). Absent in tests. */
  resolveEmail?(username: string): Promise<string>
  /** The org's own mail domains (never a carrier; matched by the stage-1 filter). */
  ownDomains: string[]
}

let cognito: CognitoIdentityProviderClient | undefined

export function createCarrierInboxDeps(spot: SpotDeps): CarrierInboxDeps {
  return {
    store: createCarrierInboxStore(spot.store.db as DynamoDBDocumentClient),
    model: realCarrierModel,
    files: createLambdaFiles(),
    oauth: spot.oauth,
    sim: spot.sim,
    simDevExtraction: (mailboxId, messageId) => simDevExtraction(csUserId(mailboxId), messageId),
    portFor: (mailbox) => spot.portFor({ id: csUserId(mailbox.id), mode: mailbox.mode }),
    loadAiAgents: () => loadAiAgents(spot),
    loadBlacklist: () => loadBlacklist(spot),
    async providerModes() {
      return { gmail: (await spot.providerModes()).gmail }
    },
    writeAudit: (entityType, entityId, action, actorEmail, changes) => spot.store.writeAudit(entityType, entityId, action, actorEmail, changes),
    now: () => spot.now(),
    modelTimeoutMs: spot.modelTimeoutMs,
    devStack: spot.devStack,
    portalOrigins: spot.portalOrigins,
    ownDomains: spot.ownDomains,
    async resolveEmail(username) {
      const me = await (cognito ??= new CognitoIdentityProviderClient({})).send(
        new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID ?? '', Username: username }),
      )
      return me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? ''
    },
  }
}
