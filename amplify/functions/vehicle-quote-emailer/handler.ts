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
import { LOGO_CID, LOGO_PNG_BASE64 } from './logo'

const ses = new SESv2Client({})

const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'ruben@bcatcorp.com'
const BCC_ADDRESS = process.env.BCC_ADDRESS ?? 'cars@bcatcorp.com'

interface Args {
  to: string
  subject: string
  html: string
  replyTo?: string
}

/** Split a base64 blob into 76-char MIME lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/** MIME encoded-word for subjects with non-ASCII characters. */
function encodeSubject(s: string): string {
  return /[^\x00-\x7F]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`
    : s
}

/**
 * Build a multipart/related raw message: the HTML (base64/UTF-8) plus the Best
 * Care logo as an inline image referenced by `cid:${LOGO_CID}` in the HTML.
 */
function buildRawWithLogo(from: string, to: string, subject: string, replyTo: string | undefined, html: string): Uint8Array {
  const boundary = `=_bcatquote_${Buffer.from(to).toString('hex').slice(0, 16)}`
  const raw =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    (replyTo ? `Reply-To: ${replyTo}\r\n` : '') +
    `Subject: ${encodeSubject(subject)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/related; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${wrap76(Buffer.from(html, 'utf-8').toString('base64'))}\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: image/png; name="best-care-logo.png"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-ID: <${LOGO_CID}>\r\n` +
    `Content-Disposition: inline; filename="best-care-logo.png"\r\n` +
    `\r\n` +
    `${wrap76(LOGO_PNG_BASE64)}\r\n` +
    `--${boundary}--\r\n`
  return new TextEncoder().encode(raw)
}

export const handler = async (event: { arguments: Args }) => {
  const a = event.arguments
  const to = (a.to ?? '').trim()
  const subject = (a.subject ?? '').trim() || 'Your Vehicle Transport Quote — Best Care Auto Transport'
  const replyTo = a.replyTo?.trim() || undefined

  if (!to) return { sent: false, error: 'no-recipient' }
  if (!a.html?.trim()) return { sent: false, error: 'no-body' }

  // Embed the logo inline only when the HTML actually references it; otherwise a
  // simple HTML send is lighter and equivalent.
  const usesLogo = a.html.includes(`cid:${LOGO_CID}`)

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      // BCC via the envelope (Destination) so it stays hidden from the recipient.
      Destination: {
        ToAddresses: [to],
        BccAddresses: BCC_ADDRESS ? [BCC_ADDRESS] : undefined,
      },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      Content: usesLogo
        ? { Raw: { Data: buildRawWithLogo(FROM_ADDRESS, to, subject, replyTo, a.html) } }
        : {
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

  console.log('[vehicle-quote-emailer] sent to', to, 'bcc', BCC_ADDRESS, 'logo', usesLogo)
  return { sent: true, to, bcc: BCC_ADDRESS }
}
