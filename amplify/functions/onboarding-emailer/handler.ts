/**
 * onboarding-emailer Lambda — custom AppSync mutation handler `sendOnboardingEmail`.
 *
 * Sends driver-facing onboarding emails via SES (invite, document-rejected, all-done).
 * Honors the GLOBAL portal-email kill switch (ComplianceSettings.portalEmailsPaused),
 * which DEFAULTS TO PAUSED — while paused this is a no-op so templates can be verified
 * in prod before any driver email goes out.
 *
 * Phase 4's escalation emails are sent by the compliance-scanner and gated by a
 * SEPARATE switch (escalationEmailsPaused).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const ses = new SESv2Client({})

const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
const INVITE_TABLE = process.env.INVITE_TABLE_NAME!
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const SETTINGS_TABLE = process.env.SETTINGS_TABLE_NAME!

type EmailType = 'invite' | 'rejected' | 'complete'

interface Args {
  type: EmailType
  driverId?: string
  inviteId?: string
  itemLabel?: string
  reason?: string
  portalBaseUrl?: string
}

async function scanFirst(table: string, filter: string, names: Record<string, string>, values: Record<string, unknown>) {
  const res = await ddb.send(new ScanCommand({
    TableName: table, FilterExpression: filter,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values, Limit: 25,
  }))
  return (res.Items ?? [])[0] as Record<string, unknown> | undefined
}

async function portalEmailsPaused(): Promise<boolean> {
  const settings = await scanFirst(SETTINGS_TABLE, 'settingsKey = :k', {}, { ':k': 'GLOBAL' })
  // Default to PAUSED when no settings row exists yet.
  if (!settings) return true
  return settings.portalEmailsPaused !== false
}

function buildEmail(type: EmailType, ctx: { firstName: string; link: string; expiresAt?: string; itemLabel?: string; reason?: string }) {
  switch (type) {
    case 'invite':
      return {
        subject: 'Ivan Cartage — start your driver onboarding',
        text:
`Hi ${ctx.firstName},

Welcome aboard! Please complete your driver onboarding using the secure link below:

${ctx.link}

You'll fill out your employment application and upload a few documents — most drivers finish in about 20 minutes on a phone.

${ctx.expiresAt ? `This link is valid until ${ctx.expiresAt}.` : ''}

If you have any questions, just reply to this email.

— Ivan Cartage`,
      }
    case 'rejected':
      return {
        subject: 'Action needed on your onboarding',
        text:
`Hi ${ctx.firstName},

One item on your onboarding needs another look:

  ${ctx.itemLabel ?? 'A document'}

Reason: ${ctx.reason ?? 'Please re-submit this item.'}

Please open your onboarding portal and re-upload it:

${ctx.link}

— Ivan Cartage`,
      }
    case 'complete':
      return {
        subject: "You're all set — onboarding complete",
        text:
`Hi ${ctx.firstName},

Great news — your onboarding is complete and everything has been approved. You're cleared to roll.

Welcome to the Ivan Cartage team!

— Ivan Cartage`,
      }
  }
}

export const handler = async (event: { arguments: Args }) => {
  const { type, driverId, inviteId, itemLabel, reason, portalBaseUrl } = event.arguments
  console.log('[onboarding-emailer]', { type, driverId, inviteId })

  if (await portalEmailsPaused()) {
    console.log('[onboarding-emailer] portal emails are PAUSED — skipping send')
    return { sent: false, paused: true }
  }

  // Resolve invite (for token/link + email + expiry) and driver (for first name).
  let invite: Record<string, unknown> | undefined
  if (inviteId) invite = await scanFirst(INVITE_TABLE, 'id = :id', {}, { ':id': inviteId })
  else if (driverId) invite = await scanFirst(INVITE_TABLE, 'driverId = :id', {}, { ':id': driverId })

  const resolvedDriverId = driverId ?? (invite?.driverId as string)
  const driver = resolvedDriverId ? await scanFirst(DRIVER_TABLE, 'id = :id', {}, { ':id': resolvedDriverId }) : undefined

  const to = (invite?.email as string) ?? (driver?.email as string)
  if (!to) {
    console.warn('[onboarding-emailer] no recipient email found')
    return { sent: false, error: 'no-recipient' }
  }

  const firstName = String(driver?.name ?? 'there').split(' ')[0]
  const base = portalBaseUrl ?? ''
  const link = invite?.token ? `${base}/onboard/${invite.token}` : base
  const expiresAt = invite?.expiresAt ? new Date(String(invite.expiresAt)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : undefined

  const { subject, text } = buildEmail(type, { firstName, link, expiresAt, itemLabel, reason })

  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM_ADDRESS,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
  }))

  console.log('[onboarding-emailer] sent', type, 'to', to)
  return { sent: true, to }
}
