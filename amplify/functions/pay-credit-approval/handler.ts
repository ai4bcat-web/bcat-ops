import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { slackClient, type SlackClient } from '../_shared/slackApi'
import { authorize, decisionMessage, decisionPatch, periodLabel, requestMessage, type ApprovalAction, type Caller, type CreditRow } from './approval'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const cognito = new CognitoIdentityProviderClient({})

const CREDIT_TABLE = process.env.PAY_CREDIT_TABLE_NAME ?? ''
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? ''
const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL ?? 'https://ops.bcatcorp.com').replace(/\/$/, '')
const APPROVER_EMAIL = (process.env.APPROVER_EMAIL ?? 'ryne@bcatcorp.com').toLowerCase()
const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const PAGE_URL = `${PORTAL_BASE_URL}/driver-pay-box-trucks`

interface AppSyncIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}
interface Event {
  arguments: { action: string; creditId: string; reason?: string | null }
  identity?: AppSyncIdentity | null
}

function groupsOf(identity: AppSyncIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

async function callerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const found = [claims.email, identity.username, claims['cognito:username']]
    .find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup || !USER_POOL_ID) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[pay-credit-approval] could not resolve caller email:', String(err))
    return ''
  }
}

async function resolveCaller(identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await callerEmail(identity)
  return { email, isOwner: email === OWNER_EMAIL, isAdmin: groupsOf(identity).includes(ADMIN_GROUP) }
}

async function loadCredit(id: string): Promise<CreditRow> {
  const res = await ddb.send(new GetCommand({ TableName: CREDIT_TABLE, Key: { id } }))
  if (!res.Item) throw new Error(`Credit ${id} not found`)
  return res.Item as CreditRow
}

async function driverName(driverId: string): Promise<string> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: DRIVER_TABLE, Key: { id: driverId }, ProjectionExpression: '#n', ExpressionAttributeNames: { '#n': 'name' } }))
    return (res.Item?.name as string | undefined) ?? 'the driver'
  } catch { return 'the driver' }
}

/** DM a person by email; a Slack failure never fails the decision itself. */
async function dm(slack: SlackClient, email: string, text: string): Promise<boolean> {
  try {
    const u = await slack.call<{ user: { id: string } }>('users.lookupByEmail', { email })
    await slack.call('chat.postMessage', { channel: u.user.id, text })
    return true
  } catch (err) {
    console.warn('[pay-credit-approval] could not DM', email, String(err))
    return false
  }
}

export const handler = async (event: Event) => {
  const action = String(event.arguments.action ?? '').toUpperCase() as ApprovalAction
  if (action !== 'NOTIFY' && action !== 'APPROVE' && action !== 'REJECT') throw new Error(`Unknown action ${event.arguments.action}`)
  const caller = await resolveCaller(event.identity)
  authorize(action, caller)

  const credit = await loadCredit(event.arguments.creditId)
  const name = await driverName(credit.driverId)
  const label = periodLabel(credit.periodStart)
  const slack = slackClient(process.env.SLACK_BOT_TOKEN ?? '')

  if (action === 'NOTIFY') {
    if ((credit.approvalStatus ?? 'APPROVED') !== 'PENDING') return { ok: true, notified: false, reason: 'not pending' }
    const notified = await dm(slack, APPROVER_EMAIL, requestMessage({ credit, driverName: name, periodLabel: label, link: PAGE_URL }))
    return { ok: true, notified }
  }

  const nowIso = new Date().toISOString()
  const patch = decisionPatch(action, caller, nowIso, event.arguments.reason)
  await ddb.send(new UpdateCommand({
    TableName: CREDIT_TABLE,
    Key: { id: credit.id },
    UpdateExpression: 'SET approvalStatus = :s, approvedBy = :by, approvedAt = :at, rejectionReason = :r, updatedAt = :at',
    ExpressionAttributeValues: { ':s': patch.approvalStatus, ':by': patch.approvedBy, ':at': patch.approvedAt, ':r': patch.rejectionReason },
    ConditionExpression: 'attribute_exists(id)',
  }))
  const requester = (credit.requestedBy ?? credit.createdBy ?? '').toLowerCase()
  let notified = false
  if (requester && requester !== caller.email) {
    notified = await dm(slack, requester, decisionMessage({ action, credit, driverName: name, periodLabel: label, by: caller.email, reason: patch.rejectionReason }))
  }
  return { ok: true, ...patch, notified }
}
