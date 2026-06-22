/**
 * driver-pay-emailer Lambda — custom AppSync mutation handler `sendDriverPayEmail`.
 *
 * Emails a driver their weekly pay statement as a PDF attachment. The frontend
 * builds the branded PDF (jsPDF) and passes it as base64; this handler wraps it in
 * a multipart/mixed MIME message and sends it via SES (SendEmail → Raw content).
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ses = new SESv2Client({})
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'pay@bcatcorp.com'

interface Args {
  to: string
  cc?: string
  driverName?: string
  periodLabel?: string
  subject?: string
  bodyText?: string
  filename?: string
  pdfBase64: string
}

/** Split a base64 blob into 76-char MIME lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

export const handler = async (event: { arguments: Args }) => {
  const a = event.arguments
  const to = (a.to ?? '').trim()
  const cc = (a.cc ?? '').trim()
  if (!to) return { sent: false, error: 'no-recipient' }
  if (!a.pdfBase64) return { sent: false, error: 'no-pdf' }

  const driverName = a.driverName?.trim() || 'driver'
  const periodLabel = a.periodLabel?.trim() || ''
  const subject = a.subject?.trim() || `Your pay statement${periodLabel ? ` — ${periodLabel}` : ''}`
  const filename = (a.filename?.trim() || 'pay-statement.pdf').replace(/[\r\n"]/g, '')
  const body =
    a.bodyText?.trim() ||
    `Hi ${driverName.split(' ')[0]},\n\nAttached is your pay statement${periodLabel ? ` for ${periodLabel}` : ''}.\n\nReply to this email with any questions.\n\n— Ivan Cartage`

  const boundary = `=_bcatpay_${Date.now().toString(36)}`
  const raw =
    `From: ${FROM_ADDRESS}\r\n` +
    `To: ${to}\r\n` +
    (cc ? `Cc: ${cc}\r\n` : '') +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n` +
    `\r\n` +
    `${body}\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/pdf; name="${filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${filename}"\r\n` +
    `\r\n` +
    `${wrap76(a.pdfBase64)}\r\n` +
    `--${boundary}--\r\n`

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [to], CcAddresses: cc ? [cc] : undefined },
      Content: { Raw: { Data: new TextEncoder().encode(raw) } },
    }))
  } catch (err) {
    console.error('[driver-pay-emailer] send failed', err)
    return { sent: false, error: err instanceof Error ? err.message : 'send-failed' }
  }

  console.log('[driver-pay-emailer] sent to', to)
  return { sent: true, to }
}
