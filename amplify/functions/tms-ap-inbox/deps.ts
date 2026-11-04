/**
 * tms-ap-inbox — the real wiring: DynamoDB store, S3 objects, the Gmail / simulated mailbox, the
 * Anthropic model and the OAuth helpers. Tests build an `ApInboxDeps` from the memory store instead.
 */
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { AP_INBOX_USER_ID } from '../../../src/lib/apInbox/constants'
import { googlePort } from '../_shared/gmail/googlePort'
import { buildAuthUrl, exchangeCode, hasRequiredScopes, newState, parseIdToken, redirectUriAllowed, revokeToken } from '../_shared/gmail/oauth'
import { simDevExtraction, simInject, simPort, simPurgeTest, simReset } from '../_shared/gmail/simPort'
import { deleteRefreshToken, getRefreshToken, putRefreshToken, readOAuthClient } from '../_shared/gmail/tokens'
import type { ApInboxDeps } from './contract'
import { realApModel } from './model'
import { createDynamoStore, IS_DEV_STACK } from './store'

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

export function createApInboxDeps(): ApInboxDeps {
  const s3 = new S3Client({})
  const bucket = process.env.BUCKET_NAME ?? ''
  return {
    store: createDynamoStore(),
    mailboxFor: (mode) => (mode === 'SIMULATED' ? simPort(AP_INBOX_USER_ID) : googlePort(AP_INBOX_USER_ID)),
    model: realApModel,
    objects: {
      async put(key, body, contentType) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
      },
      async delete(key) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      },
    },
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
    now: () => new Date(),
    devStack: IS_DEV_STACK,
    portalOrigins: parseOrigins(process.env.PORTAL_ORIGINS),
    devExtraction: IS_DEV_STACK ? (id) => simDevExtraction(AP_INBOX_USER_ID, id) : undefined,
  }
}
