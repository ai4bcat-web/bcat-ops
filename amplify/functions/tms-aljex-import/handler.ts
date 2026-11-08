/**
 * tms-aljex-import Lambda handler — Aljex-exit Phase 0: AWS wiring for `createRouter`
 * (router.ts). Two entry shapes:
 *
 *  - AppSync mutation `tmsAljexImport(action, input)` — owner/ADMIN only;
 *  - the async worker: this same Lambda invoked with `InvocationType: 'Event'` and
 *    `{ kind: 'WORK'|'MCP_SYNC'|'RECONCILE', jobId, hops }`.
 *
 * Dispatch rule: an event with `arguments` is ALWAYS AppSync (never honours `kind`); an
 * event with `kind` and no `arguments` is the self-invoke (the only principal with
 * lambda:InvokeFunction on this function is this function's own role).
 */
import './tableEnv'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { randomBytes } from 'crypto'
import { parseInput } from '../_shared/actionInputs'
import { nowIso, type Row } from '../_shared/shipmentStore'
import type { AljexImportAction, TableSet } from '../../../src/types/tms'
import { DynamoStore, reconcile as engineReconcile, runSlice as engineRunSlice, seedProCounter as engineSeedProCounter } from './engine'
import { ACTIONS, authorize, PRESIGN_SECONDS, type AppSyncIdentity, createRouter, type EmailResolver, type McpBatchResponse, type Router, type RouterDeps } from './router'

// ── Lambda wiring ───────────────────────────────────────────────────────────

interface AppSyncEvent {
  arguments?: { action: string; input?: string | Record<string, unknown> | null }
  identity?: AppSyncIdentity | null
  kind?: string
  jobId?: string
  hops?: number
}

const env = process.env
const LIVE_TABLES: TableSet = {
  shipment: env.SHIPMENT_TABLE_NAME ?? '',
  order: env.ORDER_TABLE_NAME ?? '',
  load: env.LOAD_TABLE_NAME ?? '',
  loadCarrier: env.LOAD_CARRIER_TABLE_NAME ?? '',
  loadFinancials: env.LOAD_FINANCIALS_TABLE_NAME ?? '',
  loadCharge: env.LOAD_CHARGE_TABLE_NAME ?? '',
  customer: env.CUSTOMER_TABLE_NAME ?? '',
  location: env.LOCATION_TABLE_NAME ?? '',
  carrier: env.CARRIER_TABLE_NAME ?? '',
  invoice: env.INVOICE_TABLE_NAME ?? '',
  arPayment: env.AR_PAYMENT_TABLE_NAME ?? '',
  carrierBill: env.CARRIER_BILL_TABLE_NAME ?? '',
  apPayment: env.AP_PAYMENT_TABLE_NAME ?? '',
  proClaim: env.PRO_CLAIM_TABLE_NAME ?? '',
  settings: env.SETTINGS_TABLE_NAME ?? '',
  auditLog: env.AUDIT_LOG_TABLE_NAME ?? '',
  legacyAljexRow: env.LEGACY_ALJEX_ROW_TABLE_NAME ?? '',
  aljexImportJob: env.ALJEX_IMPORT_JOB_TABLE_NAME ?? '',
  aljexMappingProfile: env.ALJEX_MAPPING_PROFILE_TABLE_NAME ?? '',
  factoringItem: env.FACTORING_ITEM_TABLE_NAME ?? '',
  driver: env.DRIVER_TABLE_NAME ?? '',
  userProfile: env.USER_PROFILE_TABLE_NAME ?? '',
  ownershipDivision: env.OWNERSHIP_DIVISION_TABLE_NAME ?? '',
  ownershipRule: env.OWNERSHIP_RULE_TABLE_NAME ?? '',
  division: env.DIVISION_TABLE_NAME ?? '',
  integration: env.MCP_INTEGRATION_TABLE_NAME ?? '',
}

const USER_POOL_ID = env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'
const BUCKET = env.DATA_SAFETY_BUCKET ?? ''

let wired: { router: Router; resolveEmail: EmailResolver; setContext: (ms: () => number) => void } | null = null

function wire() {
  if (wired) return wired
  const db = new DynamoDBClient({})
  const s3 = new S3Client({})
  const lambda = new LambdaClient({})
  const cognito = new CognitoIdentityProviderClient({})
  let remaining: () => number = () => 60_000

  async function resolveEmail(identity: AppSyncIdentity): Promise<string> {
    const claims = identity.claims ?? {}
    const candidates = [claims.email, identity.username, claims['cognito:username']]
    const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
    if (found) return found.toLowerCase().trim()
    const lookup = identity.username ?? identity.sub
    if (!lookup) return ''
    try {
      const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
      return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
    } catch (err) {
      console.warn('[tms-aljex-import] could not resolve caller email:', String(err))
      return ''
    }
  }

  const store = new DynamoStore({ db, s3, bucket: BUCKET, tables: LIVE_TABLES })
  const lambdaName = env.AWS_LAMBDA_FUNCTION_NAME ?? ''

  async function bodyText(key: string): Promise<string | null> {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      return (await r.Body?.transformToString('utf-8')) ?? null
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null
      throw err
    }
  }

  const deps: RouterDeps = {
    store,
    bucket: BUCKET,
    now: nowIso,
    devStack: env.BCAT_DEV_STACK === 'true',
    runSlice: engineRunSlice,
    seedProCounter: engineSeedProCounter,
    reconcile: engineReconcile,
    invokeSelf: async (payload) => {
      if (!lambdaName) throw new Error('AWS_LAMBDA_FUNCTION_NAME is not set')
      await lambda.send(new InvokeCommand({ FunctionName: lambdaName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }))
    },
    presignPut: (key, contentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: PRESIGN_SECONDS }),
    presignGet: (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: PRESIGN_SECONDS }),
    headObject: async (key) => {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
        return { size: Number(r.ContentLength ?? 0) }
      } catch (err) {
        const name = (err as { name?: string }).name
        if (name === 'NotFound' || name === 'NoSuchKey') return null
        throw err
      }
    },
    listObjects: async (prefix) => {
      const out: Array<{ key: string; size: number }> = []
      let token: string | undefined
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }))
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) })
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      return out
    },
    getText: bodyText,
    streamText: async function* (key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      const decoder = new TextDecoder('utf-8')
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) yield decoder.decode(chunk, { stream: true })
    },
    putText: async (key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: key.endsWith('.json') ? 'application/json' : 'text/csv' }))
    },
    invokeMcp: async (payload) => {
      const fn = env.MCP_SYNC_FUNCTION_NAME
      if (!fn) throw new Error('MCP_SYNC_FUNCTION_NAME is not set')
      const r = await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(payload)) }))
      if (r.FunctionError) throw new Error(`mcp-sync failed: ${r.FunctionError}`)
      return JSON.parse(Buffer.from(r.Payload ?? []).toString('utf-8')) as McpBatchResponse
    },
    remainingMs: () => remaining(),
    randomId: () => randomBytes(5).toString('hex'),
  }
  wired = { router: createRouter(deps), resolveEmail, setContext: (fn) => { remaining = fn } }
  return wired
}

export const handler = async (event: AppSyncEvent, context?: { getRemainingTimeInMillis?: () => number }): Promise<Row> => {
  const w = wire()
  if (context?.getRemainingTimeInMillis) w.setContext(() => context.getRemainingTimeInMillis!())
  // AppSync always carries `arguments`; only a bare `kind` event is the self-invoke.
  if (!event.arguments) {
    if (!event.kind || !event.jobId) throw new Error('Unrecognised event')
    return w.router.work({ kind: event.kind, jobId: event.jobId, hops: event.hops })
  }
  const action = event.arguments.action
  if (!ACTIONS.includes(action as AljexImportAction)) {
    throw new Error(`Unknown action: ${action}. Expected one of ${ACTIONS.join(', ')}`)
  }
  const caller = await authorize(event.identity, w.resolveEmail)
  return w.router.dispatch(action, parseInput(event.arguments.input), caller)
}
