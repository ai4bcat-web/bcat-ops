/**
 * twofa-intake Lambda
 *
 * Two-factor codes for the office. Providers text the Google Voice number; Google Voice
 * forwards each text to Gmail; the Apps Script bridge (scripts/twoFaEmailBridge.gs)
 * POSTs the email here; this posts the code to the Slack 2FA channel.
 *
 * Only texts that read like a verification code are posted; anything else that arrives
 * on the number is logged and dropped. Nothing is stored — the Slack channel is the record.
 */
import { parseGoogleVoiceEmail, extractVerificationCode, looksLikeVerification, slackMessage } from './twofa'

const SECRET = process.env.TWOFA_INTAKE_SECRET ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
// A channel id (C0…) or a name ("#2fa"); chat.postMessage takes either once the bot is a member.
const CHANNEL = process.env.TWO_FA_SLACK_CHANNEL || '#2fa'

interface FnUrlEvent { body: string | null; isBase64Encoded?: boolean }
interface Payload { secret?: string; messageId?: string; subject?: string; body?: string; receivedAt?: string }

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function postToSlack(text: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!json.ok) throw new Error(`Slack chat.postMessage: ${json.error ?? 'unknown'}`)
}

export const handler = async (event: FnUrlEvent) => {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf-8') : (event.body ?? '')
  let payload: Payload
  try { payload = JSON.parse(raw || '{}') as Payload } catch { return respond(400, { error: 'invalid JSON body' }) }
  if (!SECRET || payload.secret !== SECRET) return respond(401, { error: 'unauthorized' })
  if (!SLACK_BOT_TOKEN) return respond(500, { error: 'Slack is not configured' })

  const parsed = parseGoogleVoiceEmail(payload.subject ?? '', payload.body ?? '')
  if (!parsed) return respond(200, { ok: true, skipped: 'not a Google Voice text forward' })
  if (!looksLikeVerification(parsed.text)) {
    console.log('[twofa-intake] not a verification text, dropped', { messageId: payload.messageId, from: parsed.from })
    return respond(200, { ok: true, skipped: 'not a verification text' })
  }

  const code = extractVerificationCode(parsed.text)
  await postToSlack(slackMessage({ code, from: parsed.from, text: parsed.text, receivedAt: payload.receivedAt ?? null }))
  console.log('[twofa-intake] posted', { messageId: payload.messageId, from: parsed.from, code: code ? 'yes' : 'no' })
  return respond(200, { ok: true, code })
}
