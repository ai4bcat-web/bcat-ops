/**
 * carrier-blast-webhook Lambda
 *
 * Public Function URL receiver for Instantly webhook events. Verifies the shared
 * `x-bcat-secret` header, then handles reply_received / email_bounced /
 * lead_unsubscribed / campaign_completed. Unknown events and parsing errors always
 * return 200 so Instantly stops retrying.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  makeReplyId,
  emailToReply,
  loadCampaignMapByInstantlyId,
  loadContactMapByLaneEmail,
  putReply,
  updateCampaign,
  updateContactStatus,
  type CarrierReply,
  type Lane,
} from '../carrier-blast-api/handler'
import { type InstantlyEmail } from '../carrier-blast-api/instantly'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const getSecret = () => process.env.INSTANTLY_WEBHOOK_SECRET!

interface FunctionUrlEvent {
  body: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string | string[]>
}

interface WebhookPayload {
  event_type?: string
  timestamp?: string
  campaign_id?: string
  campaign_name?: string
  lead_email?: string
  email_account?: string
  email_id?: string
  email_subject?: string
  reply_subject?: string
  reply_text?: string
  reply_html?: string
  reply_text_snippet?: string
  unibox_url?: string
}

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
}

export const handler = async (event: FunctionUrlEvent) => {
  const secret = getSecret()
  const provided = headerValue(event.headers ?? {}, 'x-bcat-secret')
  if (!secret || provided !== secret) {
    console.warn('[carrier-blast-webhook] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  let payload: WebhookPayload
  try {
    payload = JSON.parse(raw || '{}') as WebhookPayload
  } catch {
    return respond(200, { ok: true, ignored: true, reason: 'invalid JSON' })
  }

  const eventType = payload.event_type
  const campaignId = payload.campaign_id

  try {
    switch (eventType) {
      case 'reply_received': {
        if (!campaignId) {
          return respond(200, { ok: true, ignored: true, reason: 'missing campaign_id' })
        }
        const campaignMap = await loadCampaignMapByInstantlyId()
        if (!campaignMap[campaignId]) {
          return respond(200, { ok: true, ignored: true, reason: 'unknown campaign' })
        }
        if (!payload.email_id) {
          console.log('[carrier-blast-webhook] reply_received without email_id — falling back to cron sync')
          return respond(200, { ok: true, ignored: true, reason: 'no email_id' })
        }

        const email: InstantlyEmail = {
          id: payload.email_id,
          timestamp_email: payload.timestamp,
          subject: payload.reply_subject || payload.email_subject || '',
          from_address_email: payload.lead_email ?? null,
          eaccount: payload.email_account ?? '',
          campaign_id: campaignId,
          body: { text: payload.reply_text ?? '', html: payload.reply_html ?? '' },
          content_preview: payload.reply_text_snippet ?? null,
          thread_id: null,
          is_auto_reply: 0,
        }

        const lane = campaignMap[campaignId].lane
        const fromEmail = (payload.lead_email ?? '').toLowerCase().trim()
        const contactMap = fromEmail
          ? await loadContactMapByLaneEmail([{ lane, email: fromEmail }])
          : {}

        const reply = emailToReply(email, campaignMap, contactMap)
        if (payload.unibox_url) reply.uniboxUrl = payload.unibox_url
        await putReply(reply)
        return respond(200, { ok: true, replyId: reply.id })
      }

      case 'email_bounced':
      case 'lead_unsubscribed': {
        if (!campaignId || !payload.lead_email) {
          return respond(200, { ok: true, ignored: true, reason: 'missing campaign_id or lead_email' })
        }
        const campaignMap = await loadCampaignMapByInstantlyId()
        const campaign = campaignMap[campaignId]
        if (!campaign) {
          return respond(200, { ok: true, ignored: true, reason: 'unknown campaign' })
        }
        const status: 'bounced' | 'unsubscribed' = eventType === 'email_bounced' ? 'bounced' : 'unsubscribed'
        await updateContactStatus(payload.lead_email, campaign.lane, status)
        return respond(200, { ok: true })
      }

      case 'campaign_completed': {
        if (!campaignId) {
          return respond(200, { ok: true, ignored: true, reason: 'missing campaign_id' })
        }
        const campaignMap = await loadCampaignMapByInstantlyId()
        const campaign = campaignMap[campaignId]
        if (!campaign) {
          return respond(200, { ok: true, ignored: true, reason: 'unknown campaign' })
        }
        await updateCampaign(campaign.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
        return respond(200, { ok: true })
      }

      default:
        return respond(200, { ok: true, ignored: true, eventType })
    }
  } catch (err) {
    console.error('[carrier-blast-webhook] event handler error', err)
    return respond(200, { ok: true, ignored: true, error: (err as Error).message })
  }
}
