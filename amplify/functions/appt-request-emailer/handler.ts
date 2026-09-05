/**
 * appt-request-emailer Lambda — custom AppSync mutation `sendApptRequestEmail`.
 * Sends the appointment-request email the Appts page composes; replies go to Dennis.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ses = new SESv2Client({})
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'dennis@bcatcorp.com'

interface Args {
  to: string
  cc?: string | null
  subject: string
  body: string
  replyTo?: string | null
}

export const handler = async (event: { arguments: Args; identity?: { claims?: { email?: string } } }) => {
  const { to, cc, subject, body, replyTo } = event.arguments
  if (!to || !subject || !body) return { ok: false, error: 'to, subject and body are required' }
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: {
        ToAddresses: [to],
        ...(cc ? { CcAddresses: [cc] } : {}),
      },
      ReplyToAddresses: [replyTo || FROM_ADDRESS],
      Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } },
      } },
    }))
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[appt-request-emailer]', msg)
    return { ok: false, error: msg }
  }
}
