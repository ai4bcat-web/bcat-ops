/**
 * vehicle-quote-emailer Lambda — custom AppSync mutation handler `sendVehicleQuoteEmail`.
 *
 * Emails a customer their Best Care Auto Transport vehicle-transport quote as a
 * branded HTML email. The frontend builds the HTML (so the on-screen preview and the
 * sent message are byte-identical) and passes it here; this Lambda sends it via SES
 * from ruben@bcatcorp.com and always BCCs cars@bcatcorp.com.
 *
 * bcatcorp.com is verified in SES at the domain level, so ruben@bcatcorp.com sends
 * with no per-address verification.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ses = new SESv2Client({})

const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'ruben@bcatcorp.com'
const BCC_ADDRESS = process.env.BCC_ADDRESS ?? 'cars@bcatcorp.com'

interface Args {
  to: string
  subject: string
  html: string
  replyTo?: string
}

export const handler = async (event: { arguments: Args }) => {
  const a = event.arguments
  const to = (a.to ?? '').trim()
  const subject = (a.subject ?? '').trim() || 'Your Vehicle Transport Quote — Best Care Auto Transport'

  if (!to) return { sent: false, error: 'no-recipient' }
  if (!a.html?.trim()) return { sent: false, error: 'no-body' }

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      // BCC via the envelope (Destination) so it stays hidden from the recipient.
      Destination: {
        ToAddresses: [to],
        BccAddresses: BCC_ADDRESS ? [BCC_ADDRESS] : undefined,
      },
      ReplyToAddresses: a.replyTo?.trim() ? [a.replyTo.trim()] : undefined,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: a.html, Charset: 'UTF-8' } },
        },
      },
    }))
  } catch (err) {
    console.error('[vehicle-quote-emailer] send failed', err)
    return { sent: false, error: err instanceof Error ? err.message : 'send-failed' }
  }

  console.log('[vehicle-quote-emailer] sent to', to, 'bcc', BCC_ADDRESS)
  return { sent: true, to, bcc: BCC_ADDRESS }
}
